/** ACP-backed remote agent. The remote runtime owns tools, credentials and policy. */
import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import * as acp from '@agentclientprotocol/sdk'
import { symbols } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, LlmAttemptId, ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'

export const name = 'remote-acp-driver'
export const inject = ['agents', 'sessions']
const log = (message) => process.stderr.write(`[remote-acp-driver] ${message}\n`)
const home = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')
const pairingPath = (id) => join(home(), 'remote-acp-sessions', `${createHash('sha256').update(id).digest('hex')}.json`)

// One atomic file per local session avoids lost updates between independent GUI processes.
// Read the old aggregate sidecar only for compatibility; never hide a corrupt pairing.
function validPairing(value) {
  if (value === undefined || typeof value === 'string' && value.length > 0) return value
  if (value && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.route && typeof value.route === 'object') return value
  throw new Error('Remote session pairing is invalid; repair the pairing before resuming this conversation')
}
function readPairing(id) {
  try { return validPairing(JSON.parse(readFileSync(pairingPath(id), 'utf8'))) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  try { return validPairing(JSON.parse(readFileSync(join(home(), 'remote-acp-sessions.json'), 'utf8'))[id]) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
function writePairing(id, value) {
  const dir = join(home(), 'remote-acp-sessions')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, pairingPath(id))
  } finally { rmSync(temporary, { force: true }) }
}
const DEFAULTS = {
  // Resolved relative to this plugin, so a checkout works wherever it was cloned; the profile
  // may still override it with an absolute path.
  command: fileURLToPath(new URL('../bin/dsh-remote-carrier', import.meta.url)),
  args: ['--profile', 'acp'], provider: 'remote-acp', model: 'remote',
  connectTimeoutMs: 30000, cancelTimeoutMs: 1500,
}
const failure = (error) => ({ message: String(error?.message ?? error), code: 'UNKNOWN' })
const canceled = (signal) => ({ kind: 'aborted', reason: signal.reason ?? { kind: 'user' } })
async function bounded(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
async function during(promise, signal) {
  signal.throwIfAborted()
  let listener
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = () => reject(signal.reason)
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) listener()
    })])
  } finally { signal.removeEventListener('abort', listener) }
}
function validateMessage(message) {
  if (!message?.id || !Array.isArray(message.content) || message.content.some((block) => block.type !== 'text')) {
    throw new Error('remote-acp-driver currently accepts text input only; attachments are not supported')
  }
}

/** Durable inbox: exactly the core splice vocabulary, also folded when resuming. */
class RemoteInbox {
  constructor(agent) {
    this.agent = agent
    this.lists = { 'next-turn': [], 'next-step': [] }
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'agent/inbox/spliced') {
        const { target, start, removedCount = 0, inserted } = event.data
        this.lists[target].splice(start, removedCount, ...inserted)
      }
    }
  }
  get nextTurn() { return Object.freeze([...this.lists['next-turn']]) }
  get nextStep() { return Object.freeze([...this.lists['next-step']]) }
  get hasPending() { return this.nextTurn.length > 0 || this.nextStep.length > 0 }
  clear() {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }
  append(target, message) { this.splice(target, Infinity, 0, [message]) }
  prepend(target, message) { this.splice(target, 0, 0, [message]) }
  replace(id, message) {
    for (const target of ['next-turn', 'next-step']) {
      const index = this.lists[target].findIndex((item) => item.id === id)
      if (index >= 0) { this.splice(target, index, 1, [message]); return true }
    }
    return false
  }
  remove(id) {
    for (const target of ['next-turn', 'next-step']) {
      const index = this.lists[target].findIndex((item) => item.id === id)
      if (index >= 0) { this.splice(target, index, 1, []); return true }
    }
    return false
  }
  splice(target, start, deleteCount, inserted) { return this.mutate(target, start, deleteCount, inserted, true) }
  mutate(target, start, deleteCount, inserted, discard) {
    const list = this.lists[target]
    if (!list) throw new Error(`unknown inbox target: ${target}`)
    inserted.forEach(validateMessage)
    const offset = Math.trunc(start) || 0
    const index = offset < 0 ? Math.max(0, list.length + offset) : Math.min(list.length, offset)
    const count = Math.min(Math.max(Math.trunc(deleteCount) || 0, 0), list.length - index)
    if (count === 0 && inserted.length === 0) return []
    const candidate = list.toSpliced(index, count, ...inserted)
    const all = [...candidate, ...this.lists[target === 'next-step' ? 'next-turn' : 'next-step']]
    if (new Set(all.map((message) => message.id)).size !== all.length) throw new Error('message is already pending')
    const event = this.agent.session.append('agent/inbox/spliced', {
      target, start: index, ...(count ? { removedCount: count } : {}), inserted,
      ...(discard && count ? { outcome: 'canceled' } : {}),
    })
    const removed = list.splice(index, count, ...event.data.inserted)
    if (discard) for (const message of removed) this.agent.emit('agent/inbox/discarded', { message })
    for (const message of event.data.inserted) this.agent.emit('agent/inbox/inserted', { message })
    return removed
  }
  claim(turn) {
    const messages = [
      ...this.mutate('next-step', 0, this.nextStep.length, [], false),
      ...this.mutate('next-turn', 0, 1, [], false),
    ]
    for (const message of messages) this.agent.emit('agent/inbox/claimed', { message, turn })
    return messages
  }
}
class DriverClient {
  constructor(agent) { this.agent = agent }
  async requestPermission(params) {
    // A remote runtime asking for approval must never get an implicit local approval.
    // The remote's configured allow preset handles pre-authorized work itself.
    log(`remote permission request canceled: ${params.toolCall?.title ?? 'tool'}`)
    return { outcome: { outcome: 'cancelled' } }
  }
  async sessionUpdate(params) {
    if (params.sessionId === this.agent.acpSessionId) this.agent.onUpdate(params.update)
  }
  async readTextFile() { throw new Error('client fs is unsupported: the remote agent owns the filesystem') }
  async writeTextFile() { throw new Error('client fs is unsupported: the remote agent owns the filesystem') }
}
class RemoteAgent {
  constructor(ctx, session, options, config, registryOf) {
    this.id = session.id
    this.options = options.agentOptions ?? {}
    this.session = session
    this.scope = createScope(ctx, this)
    this.ctx = this.scope.ctx
    this.config = { ...DEFAULTS, ...config }
    this.status = 'idle'
    this.inbox = new RemoteInbox(this)
    this.turn = session.snapshotEvents().reduce((turn, event) => event.type === 'turn/start' ? Math.max(turn, event.data.turn) : turn, 0)
    this.step = 0
    this.stepOpen = false
    this.activity = null
    this.abort = null
    this.wakeRequested = false
    this.ready = false
    this.disposed = false
    this.connection = null
    this.child = null
    this.childDone = null
    this.acpSessionId = null
    this.currentRun = null
    this.store = null
    this.cwd = session.header.cwd ?? process.cwd()
    this.requiresPairing = options.resumeSessionId !== undefined && session.snapshotEvents().some((event) => event.type === 'step/start')
    this.registryOf = registryOf
    this.streamRevision = 0
  }
  emit(event, payload) {
    try { emitAgentEvent(this.ctx, this, event, payload) }
    catch (error) { log(`${event} listener failed: ${error?.message ?? error}`) }
  }
  async openStore() {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence !== undefined) this.store = {
      handle: await persistence.create(this.session.header, { inheritedEventCount: this.session.inheritedEventCount }), storedCount: 0,
    }
  }
  async storeSuffix() {
    if (this.store === null) return
    const suffix = this.session.snapshotEvents(SessionLogOffset(this.store.storedCount))
    if (suffix.length > 0) await this.store.handle.append(suffix)
    this.store.storedCount += suffix.length
    await this.store.handle.flush()
  }
  send(message, target, wakeup) {
    if (this.disposed) throw new Error(`agent "${this.id}" is disposed`)
    this.inbox.append(wakeup && this.abort?.signal.aborted ? 'next-turn' : target, message)
    if (wakeup) this.wake()
  }
  followup(message) { this.send(message, 'next-turn', true) }
  // ACP has no step injection: pending steering is delivered at the next prompt boundary.
  steer(message) { this.send(message, 'next-step', true) }
  inject(message) { this.send(message, 'next-step', false) }
  setStatus(status) {
    if (this.status === status) return
    this.status = status
    this.emit('agent/status', { status })
  }
  start() { this.ready = true; if (this.wakeRequested) this.wake() }
  wake() {
    if (this.disposed) return
    this.wakeRequested = true
    if (!this.ready || this.activity !== null) return
    this.wakeRequested = false
    this.abort = new AbortController()
    // Reserve before publishing running: status listeners may synchronously cancel/send.
    this.activity = Promise.resolve().then(() => this.ctx.agents.withInitiator(this, () => this.drain())).catch((error) => {
      this.emit('agent/error', { turn: this.turn, step: this.step, error })
      log(`driver failed: ${error?.message ?? error}`)
    }).finally(() => {
      const replay = this.wakeRequested && this.inbox.hasPending && !this.disposed
      this.activity = null
      this.abort = null
      this.setStatus('idle')
      if (replay) this.wake()
    })
    this.setStatus('running')
  }
  cancel(cause = { kind: 'user' }, options = {}) {
    if (!options.keepInbox) { this.inbox.clear(); this.wakeRequested = false }
    if (this.abort === null || this.abort.signal.aborted) return
    this.wakeRequested = false
    this.abort.abort(cause)
    if (this.acpSessionId !== null && this.connection !== null) {
      void this.connection.cancel({ sessionId: this.acpSessionId }).catch((error) => log(`remote cancel failed: ${error.message}`))
    }
  }
  async whenIdle() {
    let activity
    do { activity = this.activity; await activity } while (this.activity !== null && this.activity !== activity)
  }
  runMaintenance(task) {
    if (this.disposed || this.activity !== null || !this.ready) throw new Error(`agent "${this.id}" already has active work`)
    this.abort = new AbortController()
    this.wakeRequested = false
    let finish
    this.activity = new Promise((resolve) => { finish = resolve })
    let result
    try { result = task(this.abort.signal) } catch (error) { result = Promise.reject(error) }
    return Promise.resolve(result).finally(() => {
      const replay = this.wakeRequested && this.inbox.hasPending && !this.disposed
      this.activity = null
      this.abort = null
      if (replay) this.wake()
      finish()
    })
  }
  async connect(signal) {
    signal.throwIfAborted()
    const registry = this.registryOf?.()
    const workspace = registry?.forPath(this.cwd)
    if (registry !== undefined && workspace === undefined) throw new Error('This profile runs remote workspaces only. Choose a registered remote workspace, or open this local folder in a local profile.')
    const server = workspace === undefined ? undefined : registry.connection(workspace.connection)
    const command = server?.carrier ?? this.config.command
    const args = this.config.args
    const sourceEnv = workspace === undefined ? { ...process.env } : registry.carrierEnv(workspace)
    if (workspace !== undefined) {
      sourceEnv.DSH_REMOTE_CWD = registry.toRemotePath(this.cwd)
      sourceEnv.DSH_REMOTE_WS = sourceEnv.DSH_REMOTE_CWD
    }
    const env = Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => key === 'DSH_REMOTE_KEYFILE' || !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
    const route = { command, args, cwd: this.cwd, host: server?.host ?? env.DSH_REMOTE_HOST ?? null, remoteRoot: env.DSH_REMOTE_CWD ?? null, port: env.DSH_REMOTE_PORT ?? null, sshConfig: env.DSH_REMOTE_SSH_CONFIG ?? null, identity: env.DSH_REMOTE_IDENTITY ?? null }
    const known = readPairing(this.id)
    if (this.requiresPairing && known === undefined) throw new Error('No remote pairing exists for this saved session; refusing to replace its conversation with an empty remote session')
    if (known?.route && JSON.stringify(known.route) !== JSON.stringify(route)) throw new Error('The remote connection or workspace for this session has changed; refusing to resume on a different route')
    const knownId = typeof known === 'string' ? known : known?.sessionId
    if (this.connection !== null) return this.connection
    log(`spawning remote runtime for ${this.id}: ${command}`)
    const child = this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env })
    let spawnError
    child.on('error', (error) => { spawnError = error })
    this.childDone = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, error: spawnError })))
    child.stdin.on('error', () => {})
    // Keep pipes referenced while initializing/driving. Idle remote processes must not
    // prevent a headless host exiting; the explicit disposer still waits for close.
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
    const connection = new acp.ClientSideConnection(() => new DriverClient(this), stream)
    const exited = this.childDone.then(({ code, error }) => { throw error ?? new Error(`remote runtime exited (code ${code})`) })
    let abortListener
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(signal.reason)
      signal.addEventListener('abort', abortListener, { once: true })
      if (signal.aborted) abortListener()
    })
    try {
      await bounded(Promise.race([(async () => {
        await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
        if (knownId) {
          // Failure is terminal. Starting an empty replacement silently loses context.
          const resumed = await connection.resumeSession({ sessionId: knownId, cwd: this.cwd, mcpServers: [] })
          this.configOptions = resumed.configOptions ?? []
          this.acpSessionId = knownId
          if (typeof known === 'string') writePairing(this.id, { sessionId: knownId, route })
        } else {
          const created = await connection.newSession({ cwd: this.cwd, mcpServers: [] })
          this.acpSessionId = created.sessionId
          this.configOptions = created.configOptions ?? []
          writePairing(this.id, { sessionId: created.sessionId, route })
        }
      })(), exited, aborted]), this.config.connectTimeoutMs, 'remote connection')
      signal.throwIfAborted()
      this.connection = connection
      this.requiresPairing = true
      return connection
    } catch (error) {
      await this.stopChild()
      throw spawnError ?? error
    } finally { signal.removeEventListener('abort', abortListener) }
  }
  refChild(ref) {
    const method = ref ? 'ref' : 'unref'
    this.child?.[method]?.()
    this.child?.stdin?.[method]?.()
    this.child?.stdout?.[method]?.()
  }
  async stopChild() {
    const child = this.child
    if (child === null) return
    this.refChild(true)
    child.kill('SIGTERM')
    try { await bounded(this.childDone, this.config.cancelTimeoutMs, 'remote process shutdown') }
    catch { child.kill('SIGKILL'); await this.childDone }
    this.connection = null
    this.acpSessionId = null
    this.child = null
    this.childDone = null
  }
  onUpdate(update) {
    const run = this.currentRun
    if (run === null) return
    try {
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk':
          if (update.content?.type === 'text') this.appendChunk(run, update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text', update.content.text)
          break
        case 'tool_call':
          this.flushText(run)
          if (!run.seenTools.has(update.toolCallId)) this.appendToolCall(run, update)
          this.updateTool(run, update)
          break
        case 'tool_call_update': this.updateTool(run, update); break
      }
    } catch (error) {
      run.error ??= error
      this.cancel({ kind: 'hook', reason: 'remote update could not be recorded' }, { keepInbox: true })
    }
  }
  appendChunk(run, type, text) {
    if (run.segment === null) {
      run.segment = { accumulator: new AssistantStreamAccumulator(), content: [], index: 0, attemptId: LlmAttemptId(randomUUID()) }
      this.streamFrame(run.segment, { type: 'start', turn: this.turn, step: this.step })
    }
    const segment = run.segment
    let block = segment.content.at(-1)
    if (block?.type !== type) { block = { type, text: '' }; segment.content.push(block) }
    block.text += text
    const chunk = { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: segment.content.length - 1, text }
    const time = Date.now()
    segment.accumulator.push({ time, chunk })
    this.streamFrame(segment, { type: 'chunk', index: segment.index++, time, chunk })
  }
  streamFrame(segment, frame) {
    this.emit('agent/assistant-stream', { frame: { ...frame, attemptId: segment.attemptId, revision: ++this.streamRevision } })
  }
  flushText(run) {
    const segment = run.segment
    if (segment === null) return
    const event = this.session.append('assistant/message', {
      turn: this.turn, step: this.step,
      ...(run.interrupted ? { interrupted: true } : {}),
      message: createAssistantMessage({ content: segment.content, source: { provider: this.config.provider, model: this.config.model } }),
      stream: segment.accumulator.snapshot(),
    }, { surfaceOp: 'append' })
    run.segment = null
    this.streamFrame(segment, { type: 'end', index: segment.index, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } })
  }
  appendToolCall(run, update) {
    const name = update.title ?? update.kind ?? 'tool'
    const args = JSON.stringify(update.rawInput ?? {})
    const callId = ToolCallId(update.toolCallId)
    this.session.append('assistant/message', {
      turn: this.turn, step: this.step,
      message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name, arguments: args }], source: { provider: this.config.provider, model: this.config.model } }), stream: [],
    }, { surfaceOp: 'append' })
    this.session.append('tool/call', { turn: this.turn, step: this.step, callId, name, arguments: args })
    run.seenTools.add(update.toolCallId)
    run.toolCalls.set(update.toolCallId, {})
  }
  updateTool(run, update) {
    const call = run.toolCalls.get(update.toolCallId)
    if (call === undefined) return
    Object.assign(call, Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)))
    if (call.status === 'completed' || call.status === 'failed') this.appendToolResult(run, update.toolCallId, call)
  }
  appendToolResult(run, id, update) {
    const text = update.rawOutput == null
      ? (update.content ?? []).map((item) => item?.content?.text ?? item?.text ?? JSON.stringify(item)).filter(Boolean).join('\n')
      : typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)
    this.session.append('tool/result', {
      turn: this.turn, step: this.step,
      message: createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text: text || '(no output)' }], isError: update.status === 'failed' }),
    }, { surfaceOp: 'append' })
    run.toolCalls.delete(id)
  }
  async configureModel(connection, signal) {
    const selected = this.session.snapshotEvents().findLast((event) => event.type === 'model/selection')?.data ?? this.options
    if (!selected.provider || !selected.model) return
    const set = async (id, value) => {
      const option = this.configOptions.find((item) => item.id === id)
      const choices = option?.options?.flatMap((item) => item.options ?? [item]) ?? []
      if (!option || !choices.some((item) => item.value === value)) throw new Error(`The remote session does not advertise the selected ${id}: ${value}`)
      if (option.currentValue === value) return
      const response = await during(bounded(connection.setSessionConfigOption({ sessionId: this.acpSessionId, configId: id, value }), this.config.connectTimeoutMs, 'remote model selection'), signal)
      this.configOptions = response.configOptions
      signal.throwIfAborted()
    }
    await set('model', JSON.stringify([selected.provider, selected.model]))
    const effort = this.configOptions.find((item) => item.id === 'reasoning_effort')
    if (selected.reasoningEffort !== undefined || effort?.options?.some((item) => item.value === '')) await set('reasoning_effort', selected.reasoningEffort ?? '')
    this.config.provider = selected.provider
    this.config.model = selected.model
  }
  async prompt(connection, prompt, signal) {
    let timer, listener
    const abort = new Promise((_, reject) => {
      listener = () => { timer = setTimeout(() => reject(signal.reason), this.config.cancelTimeoutMs) }
      signal.addEventListener('abort', listener, { once: true })
      if (signal.aborted) listener()
    })
    try { return await Promise.race([connection.prompt({ sessionId: this.acpSessionId, prompt }), abort]) }
    finally { clearTimeout(timer); signal.removeEventListener('abort', listener) }
  }
  async drain() {
    const signal = this.abort.signal
    do {
      this.wakeRequested = false
      await this.runTurn(signal)
    } while (!signal.aborted && this.inbox.hasPending && !this.disposed)
  }
  async runTurn(signal) {
    this.turn += 1
    this.step = 0
    this.session.append('turn/start', { turn: this.turn })
    const messages = this.inbox.claim(this.turn)
    const prompt = messages.flatMap((message) => message.content.map((block) => ({ type: 'text', text: block.text })))
    let reason = { kind: 'completed' }
    const run = { segment: null, toolCalls: new Map(), seenTools: new Set(), error: null }
    try {
      for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
      signal.throwIfAborted()
      const connection = await this.connect(signal)
      signal.throwIfAborted()
      this.refChild(true)
      await this.configureModel(connection, signal)
      signal.throwIfAborted()
      this.step = 1
      this.session.append('step/start', { turn: this.turn, step: this.step })
      this.stepOpen = true
      this.currentRun = run
      const result = await this.prompt(connection, prompt, signal)
      if (run.error) throw run.error
      if (signal.aborted || result.stopReason === 'cancelled') reason = signal.aborted ? canceled(signal) : { kind: 'aborted', reason: { kind: 'user' } }
      else if (result.stopReason === 'max_tokens') reason = { kind: 'max-tokens' }
      else if (result.stopReason === 'refusal') reason = { kind: 'blocked' }
      else if (result.stopReason !== 'end_turn') reason = { kind: 'error', error: failure(`Remote stopped: ${result.stopReason}`) }
      if (run.toolCalls.size > 0 && reason.kind === 'completed') reason = { kind: 'error', error: failure('Remote prompt ended with unfinished tool calls') }
    } catch (error) {
      reason = signal.aborted && !run.error ? canceled(signal) : { kind: 'error', error: failure(error) }
      if (reason.kind === 'error') this.emit('agent/error', { turn: this.turn, step: this.step, error })
      // A broken connection must be gone before another queued turn can resume it.
      await this.stopChild()
    } finally {
      this.currentRun = null
      if (this.stepOpen) {
        run.interrupted = reason.kind !== 'completed'
        this.flushText(run)
        for (const [id] of run.toolCalls) this.appendToolResult(run, id, { status: 'failed', rawOutput: 'Remote tool outcome unknown: the prompt ended before its result arrived.' })
        this.session.append('step/end', { turn: this.turn, step: this.step })
        this.stepOpen = false
      }
      this.session.append('turn/end', { turn: this.turn, reason })
      await this.ctx.sessions.flush(this.session)
      this.refChild(false)
    }
  }
  dispose() {
    return this.disposal ??= (async () => {
      this.disposed = true
      const errors = []
      try { this.cancel({ kind: 'disposed' }) } catch (error) { errors.push(error) }
      try { await this.whenIdle() } catch (error) { errors.push(error) }
      if (this.connection !== null && this.acpSessionId !== null) {
        this.refChild(true)
        try { await bounded(this.connection.closeSession({ sessionId: this.acpSessionId }), this.config.cancelTimeoutMs, 'remote session close') }
        catch (error) { log(error.message) }
      }
      try { await this.stopChild() } catch (error) { errors.push(error) }
      try { await this.store?.handle.close() } catch (error) { errors.push(error) }
      try { await this.scope.dispose() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Remote resources failed to close')
    })()
  }
}

export function apply(ctx, config = {}) {
  const active = new Set()
  const registryOf = () => ctx.get('remoteServers')
  async function publish(ownerCtx, options, session, store) {
    ownerCtx.fiber.assertActive()
    ctx.fiber.assertActive()
    options.signal?.throwIfAborted()
    const agent = new RemoteAgent(ctx, session, options, config, registryOf)
    agent.store = store ?? null
    let detachSession, detachAgent, disposal, publishing = null
    let released
    const initializing = new Promise((resolve) => { released = resolve })
    let ownerDisposed = false
    const lifecycle = new AbortController()
    const callerAbort = () => lifecycle.abort(options.signal.reason)
    options.signal?.addEventListener('abort', callerAbort, { once: true })
    const dispose = () => disposal ??= (async () => {
      ownerDisposed = true
      lifecycle.abort(new Error('Remote agent owner was disposed during initialization'))
      options.signal?.removeEventListener('abort', callerAbort)
      await initializing
      if (publishing) await publishing.catch(() => {})
      const errors = []
      try { await agent.dispose() } catch (error) { errors.push(error) }
      try { await detachAgent?.() } catch (error) { errors.push(error) }
      try { detachSession?.() } catch (error) { errors.push(error) }
      active.delete(dispose)
      if (errors.length) throw new AggregateError(errors, 'Remote agent disposal failed')
    })()
    active.add(dispose)
    ownerCtx.effect(() => dispose, `remoteAcpDriver.owner(${agent.id})`)
    try {
      const setup = await during(Promise.resolve(options.setup?.(agent.ctx, agent)), lifecycle.signal)
      ownerCtx.fiber.assertActive()
      ctx.fiber.assertActive()
      options.signal?.throwIfAborted()
      if (ownerDisposed) throw new Error('Remote agent owner was disposed during setup')
      if (agent.store === null) await agent.openStore()
      ownerCtx.fiber.assertActive()
      ctx.fiber.assertActive()
      options.signal?.throwIfAborted()
      setup?.commit()
      await agent.storeSuffix()
      ownerCtx.fiber.assertActive()
      ctx.fiber.assertActive()
      options.signal?.throwIfAborted()
      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = ctx.agents.enter(agent, options.parentAgent)
      agent.ctx.sessions.announce(session)
      publishing = ctx.agents.announce(agent, options.resumeSessionId === undefined ? 'startup' : 'resume', lifecycle.signal)
      await publishing
      ownerCtx.fiber.assertActive()
      ctx.fiber.assertActive()
      options.signal?.throwIfAborted()
      if (ownerDisposed) throw new Error('Remote agent owner was disposed during publication')
      agent.start()
      options.signal?.removeEventListener('abort', callerAbort)
      released()
      return { agent, dispose }
    } catch (error) {
      released()
      try { await dispose() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Remote agent creation and rollback failed') }
      throw error
    }
  }
  const factory = {
    async createAgent(ownerCtx, options) {
      if (options.seed?.length || options.meta?.isSeeded) throw new Error('Remote conversation forks are not supported by ACP; create a new remote session instead.')
      const session = ctx.sessions.prepare(options.sessionId, {
        ...(options.meta ? { meta: options.meta } : {}),
        ...(options.seed ? { seed: options.seed } : {}),
        ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
      })
      return publish(ownerCtx, options, session)
    },
    async resume(ownerCtx, options) {
      const persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) throw new Error('remote-acp-driver: cannot resume without sessionPersistence')
      const handle = await persistence.open(options.resumeSessionId, 'write')
      try {
        const coldRead = await handle.read(0, undefined, {})
        const closers = interruptedTurnClosers(coldRead.events)
        if (closers.length > 0) await handle.append(closers)
        const session = ctx.sessions.prepare(options.resumeSessionId, {
          seed: [...coldRead.events, ...closers], meta: structuredClone(handle.header),
          inheritedEventCount: handle.inheritedEventCount, eventState: coldRead.eventState,
        })
        return await publish(ownerCtx, options, session, { handle, storedCount: coldRead.events.length + closers.length })
      } catch (error) { await handle.close(); throw error }
    },
  }
  ctx.effect(() => async () => {
    const results = await Promise.allSettled([...active].map((dispose) => dispose()))
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Remote agent teardown failed')
  }, 'remoteAcpDriver.agents()')
  if (config.mode !== 'hybrid') {
    ctx.effect(() => ctx.agents.setFactory(factory), 'remoteAcpDriver.setFactory()')
    return
  }
  // Keep the standard local agent factory. The public entry points already carry
  // their caller's Context, which must survive routing for disposal and setup.
  const registry = ctx.agents[symbols.original] ?? ctx.agents
  const createDescriptor = Object.getOwnPropertyDescriptor(registry, 'create')
  const resumeDescriptor = Object.getOwnPropertyDescriptor(registry, 'resume')
  const originalCreate = registry.create
  const originalResume = registry.resume
  const roots = new Set()
  const observe = () => {
    const remote = registryOf()
    if (remote?.anchorRoot) roots.add(resolve(remote.anchorRoot))
    return remote
  }
  if (config.anchorRoot) roots.add(resolve(config.anchorRoot))
  observe()
  const remotePath = (cwd, knownRemote = false) => {
    const remote = observe()
    const path = typeof cwd === 'string' ? resolve(cwd) : undefined
    if (path !== undefined && remote?.forPath(path) !== undefined) return true
    if (knownRemote || path !== undefined && [...roots].some((root) => path === root || path.startsWith(`${root}${sep}`))) {
      throw new Error('This remote workspace is no longer registered. Restore its connection before resuming it.')
    }
    return false
  }
  const create = function (options) {
    return remotePath(options.meta?.cwd)
      ? factory.createAgent(this.ctx, options)
      : originalCreate.call(this, options)
  }
  const resume = async function (options) {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return originalResume.call(this, options)
    const snapshot = await persistence.stat(options.resumeSessionId, { signal: options.signal })
    return remotePath(snapshot?.header.cwd, readPairing(options.resumeSessionId) !== undefined)
      ? factory.resume(this.ctx, options)
      : originalResume.call(this, options)
  }
  ctx.effect(() => {
    registry.create = create
    registry.resume = resume
    return () => {
      if (registry.create === create) {
        if (createDescriptor) Object.defineProperty(registry, 'create', createDescriptor)
        else delete registry.create
      }
      if (registry.resume === resume) {
        if (resumeDescriptor) Object.defineProperty(registry, 'resume', resumeDescriptor)
        else delete registry.resume
      }
    }
  }, 'remoteAcpDriver.hybridRouting()')
}
