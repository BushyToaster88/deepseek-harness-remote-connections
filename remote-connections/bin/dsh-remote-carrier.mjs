#!/usr/bin/env node
/**
 * Carry DSH's stdio protocol over SSH. Credentials are read only by the remote
 * shell and never enter argv. Session cwd fields map local anchors to the remote
 * workspace; all other protocol bytes are forwarded unchanged.
 *
 * Overrides:
 *   DSH_REMOTE_HOST       ssh alias or user@host (required; the driver sets it per session)
 *   DSH_REMOTE_DSH        remote executable (default: $HOME/.local/share/dsh-bridge/node_modules/.bin/dsh)
 *   DSH_REMOTE_WS         remote process cwd (default: $HOME/dsh-workspace)
 *   DSH_REMOTE_CWD        session cwd to rewrite incoming session cwds to (optional; unset
 *                         disables rewriting, which is right when the driver already passes
 *                         the workspace directory)
 *   DSH_REMOTE_KEYFILE    remote key file (unset: optional $HOME/.dsh/deepseek-api-key; empty: skip)
 *   DSH_REMOTE_KEY_ENV    environment name (default: DEEPSEEK_API_KEY)
 *   DSH_REMOTE_SSH_CONFIG local ssh config path
 *   DSH_REMOTE_PORT       ssh port (1–65535)
 *   DSH_REMOTE_IDENTITY   local identity path
 *   DSH_REMOTE_MAX_FRAME_BYTES  incoming frame limit (default: 64 MiB, excluding newline)
 *
 * Remote paths expand only a leading $HOME/ or ~/. All other text is literal.
 */
import { spawn } from 'node:child_process'
import { planSync } from '../config-sync/index.js'
import { isUtf8 } from 'node:buffer'
import { constants } from 'node:os'
import { pipeline } from 'node:stream'

const CWD_METHODS = new Set(['initialize', 'session/new', 'session/resume', 'session/list', 'session/load'])
const NEWLINE = Buffer.from('\n')
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`
const diagnostic = (message) => `printf '%s\\n' ${quote(`[dsh-remote-carrier] ${message}`)} >&2`

function shellPath(value) {
  if (value === '$HOME' || value === '~') return '"$HOME"'
  const prefix = value.startsWith('$HOME/') ? '$HOME/' : value.startsWith('~/') ? '~/' : undefined
  return prefix ? `"$HOME"/${quote(value.slice(prefix.length))}` : quote(value)
}

function environment(name, fallback, allowEmpty = false) {
  const value = process.env[name] ?? fallback
  if ((!allowEmpty && value === '') || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must ${allowEmpty ? '' : 'be nonempty and '}not contain newlines or NUL`)
  }
  return value
}

function configuration() {
  const host = environment('DSH_REMOTE_HOST', undefined)
  if (host === undefined || host === '') {
    throw new Error(
      'DSH_REMOTE_HOST is required: name the ssh host (or user@host) this carrier should reach. ' +
        'The driver sets it from the workspace\'s connection, so a manual run must pass it.',
    )
  }
  if (host.startsWith('-') || /\s/.test(host)) throw new Error('DSH_REMOTE_HOST must be an SSH destination, without options or whitespace')
  const keyEnvName = environment('DSH_REMOTE_KEY_ENV', 'DEEPSEEK_API_KEY')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnvName)) throw new Error('DSH_REMOTE_KEY_ENV must be a valid environment variable name')
  const port = environment('DSH_REMOTE_PORT', '', true)
  if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('DSH_REMOTE_PORT must be a number between 1 and 65535')
  }
  const limit = environment('DSH_REMOTE_MAX_FRAME_BYTES', String(64 * 1024 * 1024))
  if (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1) {
    throw new Error('DSH_REMOTE_MAX_FRAME_BYTES must be a positive integer')
  }
  return {
    host, keyEnvName, port, maxFrameBytes: Number(limit),
    remoteDsh: environment('DSH_REMOTE_DSH', '$HOME/.local/share/dsh-bridge/node_modules/.bin/dsh'),
    remoteWs: environment('DSH_REMOTE_WS', '$HOME/dsh-workspace'),
    cwdMap: environment('DSH_REMOTE_CWD', undefined, true),
    remoteKeyFile: environment('DSH_REMOTE_KEYFILE', '$HOME/.dsh/deepseek-api-key', true),
    sshConfig: environment('DSH_REMOTE_SSH_CONFIG', '', true),
    identity: environment('DSH_REMOTE_IDENTITY', '', true),
  }
}

function remoteCommand({ host, remoteDsh, remoteWs, remoteKeyFile, keyEnvName }) {
  const dsh = shellPath(remoteDsh)
  const steps = [
    `cd -- ${shellPath(remoteWs)}`,
    `if ! command -v ${dsh} >/dev/null 2>&1 && [ ! -x ${dsh} ]; then ` +
      `${diagnostic(`no DSH on ${host} at ${remoteDsh}`)}; ` +
      `${diagnostic(`install it there: ssh ${host} 'mkdir -p ~/.local/share/dsh-bridge && cd ~/.local/share/dsh-bridge && npm install --no-fund --no-audit @deepseek-ai/dsh@0.1.7-alpha.2'`)}; exit 79; fi`,
  ]
  if (remoteKeyFile !== '') {
    const key = shellPath(remoteKeyFile)
    const failure = `${diagnostic(`remote key file is missing, unreadable or empty: ${remoteKeyFile}`)}; ` +
      `${diagnostic(`create it with mode 0600 on ${host}, or set DSH_REMOTE_KEYFILE='' to skip injection`)}; exit 78`
    // An assignment has cat's exit status; `export KEY=$(cat ...)` would hide a
    // failed read. The validated identifier is the only unquoted shell operand.
    const inject = `if ! ${keyEnvName}=$(cat -- ${key}) || [ -z "$${keyEnvName}" ]; then ${failure}; fi; export ${keyEnvName}`
    if (process.env.DSH_REMOTE_KEYFILE !== undefined) {
      steps.push(`if [ ! -s ${key} ]; then ${failure}; fi`)
      steps.push(inject)
    } else {
      steps.push(`if [ -s ${key} ]; then ${inject}; else ` +
        `${diagnostic(`no ${remoteKeyFile} on ${host}; using the remote DSH's own stored credentials`)}; fi`)
    }
  }
  // Keep the host's shared configuration current inside this same ssh session. The working
// agreements and the MCP server list are global by nature, and a remote runtime reads its own
// copies; syncing here means propagation is automatic with no daemon and no extra round-trip.
// Hash-gated, so an unchanged source costs one `cat`. DSH_REMOTE_SYNC=0 skips it for a session.
if (process.env.DSH_REMOTE_SYNC !== '0') {
  // Wrapped in a subshell: the script is multi-line and sets `-e`, and this whole step list is
  // joined with `&&`. A subshell keeps both from touching the chain that goes on to exec.
  steps.push(`( ${planSync({ quiet: true }).script} )`)
}

steps.push(`exec ${dsh} ${process.argv.slice(2).map(quote).join(' ')}`)
  return steps.join(' && ')
}

/** Return the original bytes unless this is a session request with a cwd to map. */
function rewrite(line, cwdMap) {
  if (cwdMap === '' || !isUtf8(line)) return line
  let message
  try {
    message = JSON.parse(line.toString('utf8'))
  } catch {
    return line
  }
  const method = message?.method
  const params = message?.params
  if (process.env.DSH_REMOTE_DEBUG === '1' && typeof method === 'string') {
    process.stderr.write(`[dsh-remote-carrier] seen ${method} cwd=${params?.cwd ?? '-'}\n`)
  }
  if (!CWD_METHODS.has(method) || !params || typeof params.cwd !== 'string' || params.cwd === cwdMap) return line
  params.cwd = cwdMap
  return Buffer.from(JSON.stringify(message))
}

/** A bounded frame buffer; pipeline pulls the next frame only when SSH can write it. */
async function* rewriteFrames(source, { cwdMap, maxFrameBytes }) {
  let parts = []
  let size = 0
  for await (const chunk of source) {
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(offset, end)
      size += part.length
      if (size > maxFrameBytes) {
        throw Object.assign(new Error(`protocol frame exceeds ${maxFrameBytes} bytes`), { code: 'DSH_FRAME_TOO_LARGE' })
      }
      parts.push(part)
      if (newline >= 0) {
        const frame = parts.length === 1 ? part : Buffer.concat(parts, size)
        yield Buffer.concat([rewrite(frame, cwdMap), NEWLINE])
        parts = []
        size = 0
      }
      offset = end + 1
    }
  }
  if (size !== 0) yield rewrite(Buffer.concat(parts, size), cwdMap)
}

function start(config) {
  const child = spawn('ssh', [
    ...(config.sshConfig ? ['-F', config.sshConfig] : []),
    ...(config.port ? ['-p', config.port] : []),
    ...(config.identity ? ['-i', config.identity] : []),
    '-T', // A configured RequestTTY must never turn the JSON protocol into terminal traffic.
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=12',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '--', config.host, remoteCommand(config),
  ], { stdio: ['pipe', 'pipe', 'inherit'] })

  let inputStopped = false
  let childExited = false
  let killTimer
  let forcedExitCode
  let outputAborted = false
  const report = (message) => process.stderr.write(`[dsh-remote-carrier] ${message}\n`)
  const stopInput = () => {
    inputStopped = true
    process.stdin.destroy()
    child.stdin.destroy()
  }
  const terminate = (signal = 'SIGTERM') => {
    stopInput()
    // Normal exit drains stdout, but a cancelled/broken transport cannot wait
    // forever for a consumer that stopped reading its queued output.
    outputAborted = true
    child.stdout.unpipe(process.stdout)
    child.stdout.destroy()
    if (childExited) process.exit(forcedExitCode ?? 1)
    if (child.pid === undefined) return
    child.kill(signal)
    // Forwarding a signal alone can leave the carrier and ssh alive forever.
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000)
  }

  // Keep stdout byte-for-byte and respect downstream backpressure. Do not call
  // process.exit on child 'exit': buffered tail frames still need to drain.
  child.stdout.pipe(process.stdout, { end: false })
  child.stdout.on('error', (error) => {
    forcedExitCode ??= 1
    report(`failed to read ssh output: ${error.message}`)
    terminate()
  })
  process.stdout.on('error', (error) => {
    forcedExitCode ??= 1
    if (error.code !== 'EPIPE') report(`failed to forward ssh output: ${error.message}`)
    terminate()
  })

  pipeline(process.stdin, (source) => rewriteFrames(source, config), child.stdin, (error) => {
    if (!error || inputStopped || error.code === 'EPIPE' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return
    forcedExitCode ??= error.code === 'DSH_FRAME_TOO_LARGE' ? 65 : 1
    report(`failed to forward protocol input: ${error.message}`)
    terminate()
  })

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      // Cancellation is unsuccessful even when ssh traps the signal and exits 0.
      forcedExitCode ??= 128 + constants.signals[signal]
      process.exitCode = forcedExitCode
      terminate(signal)
    })
  }
  child.on('error', (error) => {
    forcedExitCode ??= 127
    report(`failed to spawn ssh: ${error.message}`)
    stopInput()
  })
  child.on('exit', () => {
    childExited = true
    clearTimeout(killTimer)
    stopInput()
  })
  child.on('close', (code, signal) => {
    childExited = true
    clearTimeout(killTimer)
    stopInput()
    process.exitCode = forcedExitCode ?? (signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1))
    // stdout is a special process-owned stream: destroy() does not close its
    // pending writes. Once SSH is reaped, cancellation must discard them.
    if (outputAborted) process.exit(process.exitCode)
  })
}

try {
  start(configuration())
} catch (error) {
  process.stderr.write(`[dsh-remote-carrier] ${error.message}\n`)
  process.stdin.destroy()
  process.exitCode = 64
}
