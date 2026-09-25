/**
 * remote-fs — serve one or more remote workspaces through the composed `ctx.fs`.
 *
 * The service is single-occupancy (a second `FileSystem` registration throws, and
 * `ctx.set('fs', …)` is refused), so this *decorates* the composed provider rather than
 * replacing it. Paths under a configured server's anchor directory are served from that
 * server over ssh; every other path delegates to the original method untouched.
 *
 * Mappings come from `ctx.remoteServers` when that registry is composed, so one decorator
 * serves every server; a single `{ host, remoteRoot, localRoot }` config is still honoured
 * for a profile that predates the registry.
 *
 * Remote targets reject writes, edits and watches. Local targets retain the composed
 * provider's behaviour; process paths identify the local workspace anchor.
 */
import { resolve, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { createSshFs } from './ssh-fs.js'

export const name = 'remote-fs'

/** The composed filesystem we decorate; the service must already exist. */
export const inject = ['fs']

const log = (message) => process.stderr.write(`[remote-fs] ${message}\n`)

export function apply(ctx, config = {}) {
  const base = ctx.get('fs')
  if (base === undefined) {
    log('no composed ctx.fs to decorate; nothing to do')
    return
  }
  const dbg = (message) => { if (config.debug === true) log(message) }

  // Resolved per call, not captured here: the registry is a separate plugin, and an
  // HMR reload of it replaces the service instance — a captured one would keep serving
  // the mapping set from before the edit.
  const registryOf = () => ctx.get('remoteServers')
  const registry = registryOf()
  // Legacy routing is enabled only when it was selected at composition time.
  if (registry === undefined && config.remoteRoot !== undefined && !posix.isAbsolute(config.remoteRoot)) {
    throw new Error('remoteRoot must be an absolute remote path')
  }
  const legacy = registry === undefined ? {
    host: config.host,
    remoteRoot: config.remoteRoot === undefined ? undefined : posix.resolve(config.remoteRoot),
    localRoot: resolve(config.localRoot ?? process.cwd()),
    sshConfig: config.sshConfig,
    port: config.port,
    identityFile: config.identityFile,
  } : undefined
  const anchorRoots = new Set()
  let registrySeen = registry !== undefined
  const within = (parent, child) => child === parent || child.startsWith(`${parent.replace(/\/+$/, '')}/`)
  const coordinates = (connection) => ({
    host: connection.host, sshConfig: connection.sshConfig,
    port: connection.port, identityFile: connection.identityFile,
  })
  const connectionKey = (connection) => JSON.stringify(coordinates(connection))

  // SSH aliases alone are not identities: two connections can select different ports or keys.
  const transports = new Map()
  const transportFor = (remote) => {
    const key = connectionKey(remote)
    let transport = transports.get(key)
    if (transport === undefined) {
      transport = createSshFs({ ...coordinates(remote), root: '/', timeoutMs: config.timeoutMs })
      transports.set(key, transport)
    }
    return transport
  }

  const unavailable = (path) => new FsError(`Remote workspace is no longer registered: ${path}`, 'FS_NOT_FOUND')
  const serverFor = (localPath) => {
    const registry = registryOf()
    if (registry !== undefined) {
      registrySeen = true
      if (registry.anchorRoot) anchorRoots.add(resolve(registry.anchorRoot))
      const workspace = registry.forPath(localPath)
      if (workspace !== undefined) {
        const connection = registry.connection(workspace.connection)
        if (connection === undefined) throw unavailable(localPath)
        const remotePath = registry.toRemotePath(localPath)
        if (typeof remotePath !== 'string' || !posix.isAbsolute(remotePath)) {
          throw new FsError(`Remote workspace needs an absolute directory: ${localPath}`, 'FS_IO_ERROR')
        }
        return { ...coordinates(connection), remotePath: posix.normalize(remotePath) }
      }
    } else if (!registrySeen && legacy !== undefined && within(legacy.localRoot, localPath)) {
      const relative = localPath.slice(legacy.localRoot.length).replace(/^\/+/, '')
      return { ...coordinates(legacy), remotePath: posix.join(legacy.remoteRoot, relative) }
    }
    // Removed anchors remain on disk. Never mistake them for a local workspace.
    if ([...anchorRoots].some((root) => localPath !== root && within(root, localPath))) throw unavailable(localPath)
    return undefined
  }
  if (registry?.anchorRoot) anchorRoots.add(resolve(registry.anchorRoot))

  const minted = new Map()
  const absolute = (path, cwd) => resolve(cwd ?? (legacy?.localRoot ?? process.cwd()), path)
  const mint = (localPath, remote) => {
    const target = {
      targetKey: FsTargetKey(`remote:${JSON.stringify([connectionKey(remote), remote.remotePath])}`),
      displayPath: localPath,
    }
    minted.set(target.targetKey, remote)
    return target
  }
  const remoteOf = (target) => {
    const previous = minted.get(target?.targetKey)
    const current = typeof target?.displayPath === 'string' ? serverFor(absolute(target.displayPath)) : undefined
    if (previous !== undefined && (current === undefined ||
      connectionKey(previous) !== connectionKey(current) || previous.remotePath !== current.remotePath)) {
      throw unavailable(target.displayPath)
    }
    // A local parent directory listing can supply a target for a remote anchor.
    return current
  }

  const patched = []
  const patch = (method, wrap) => {
    const original = base[method]
    if (typeof original !== 'function') {
      log(`cannot decorate missing method ${method}`)
      return
    }
    base[method] = wrap(original.bind(base))
    patched.push([method, original])
    dbg(`patched ${method}`)
  }

  // Identity resolution stays local: minting a target costs no round trip, and
  // stat/lstat are what report absence.
  patch('resolve', (original) => async (path, opts) => {
    const localPath = absolute(String(path), opts?.cwd)
    const server = serverFor(localPath)
    if (server !== undefined && opts?.signal?.aborted) throw new FsError('Remote resolution aborted.', 'FS_ABORTED')
    dbg(
      `resolve ${localPath} -> ${server === undefined ? 'LOCAL' : `${server.host}:${server.remotePath}`}`,
    )
    return server === undefined
      ? original(path, opts)
      : mint(localPath, server)
  })

  patch('stat', (original) => async (target, signal) => {
    const remote = remoteOf(target)
    if (remote === undefined) return original(target, signal)
    const info = await transportFor(remote).stat(remote.remotePath, { signal })
    if (info === undefined) return undefined
    return {
      version: FsVersion(info.version),
      type: info.type,
      ...(info.type === 'file' ? { size: info.size } : {}),
    }
  })

  patch('lstat', (original) => async (path, opts, signal) => {
    const localPath = absolute(String(path), opts?.cwd)
    const server = serverFor(localPath)
    if (server === undefined) return original(path, opts, signal)
    const info = await transportFor(server).stat(server.remotePath, { follow: false, signal })
    if (info === undefined) return undefined
    return {
      version: FsVersion(info.version),
      type: info.type,
      ...(info.type === 'file' ? { size: info.size } : {}),
    }
  })

  patch('listDir', (original) => async (target, signal) => {
    const remote = remoteOf(target)
    dbg(`listDir ${target?.targetKey} -> ${remote === undefined ? 'LOCAL' : remote.host}`)
    if (remote === undefined) return original(target, signal)
    const entries = await transportFor(remote).listDir(remote.remotePath, { signal })
    const basePath = target.displayPath.replace(/\/+$/, '')
    const baseRemote = remote.remotePath.replace(/\/+$/, '')
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.type,
      target: mint(`${basePath}/${entry.name}`, { ...remote, remotePath: `${baseRemote}/${entry.name}` }),
      version: FsVersion(entry.version),
      ...(entry.type === 'file' ? { size: entry.size } : {}),
    }))
  })

  patch('readBytes', (original) => async (target, signal, maxBytes) => {
    const remote = remoteOf(target)
    if (remote === undefined) return original(target, signal, maxBytes)
    return new Uint8Array(await transportFor(remote).readBytes(remote.remotePath, maxBytes, { signal }))
  })

  patch('readByteRange', (original) => async (target, range, signal) => {
    const remote = remoteOf(target)
    if (remote === undefined) return original(target, range, signal)
    return new Uint8Array(await transportFor(remote).readByteRange(remote.remotePath, range, { signal }))
  })

  patch('readText', (original) => async (target, signal) => {
    const remote = remoteOf(target)
    if (remote === undefined) return original(target, signal)
    const bytes = Buffer.from(
      await transportFor(remote).readBytes(remote.remotePath, 8 * 1024 * 1024, { signal }),
    )
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new FsError(`Not a UTF-8 text file: ${target.displayPath}`, 'FS_NOT_TEXT', { cause: error })
    }
    if (text.includes('\u0000')) throw new FsError(`Binary file: ${target.displayPath}`, 'FS_NOT_TEXT')
    return text
  })

  patch('streamText', (original) => async (target, signal) => {
    if (remoteOf(target) === undefined) return original(target, signal)
    const text = await base.readText(target, signal)
    return (async function* yieldWhole() {
      if (signal?.aborted) throw new FsError('Remote text stream aborted.', 'FS_ABORTED')
      yield text
    })()
  })

  patch('contains', (original) => (parent, child) => {
    const parentRemote = remoteOf(parent)
    const childRemote = remoteOf(child)
    if (parentRemote === undefined && childRemote === undefined) return original(parent, child)
    if (parentRemote === undefined || childRemote === undefined) return false
    if (connectionKey(parentRemote) !== connectionKey(childRemote)) return false
    return (
      childRemote.remotePath === parentRemote.remotePath ||
      childRemote.remotePath.startsWith(`${parentRemote.remotePath.replace(/\/+$/, '')}/`)
    )
  })

  // Minted targets must stay coherent for consumers that are not file reads. The
  // session header takes its cwd from these, so delegating them hands back our opaque
  // target key and the session refuses to start ("cwd must be an absolute path"). The
  // execution world here is the local anchor path, which is also what the bridge
  // records as the session cwd.
  patch('processPath', (original) => (target) =>
    remoteOf(target) === undefined ? original(target) : target.displayPath)

  patch('fileUrl', (original) => (target) =>
    remoteOf(target) === undefined ? original(target) : pathToFileURL(target.displayPath).href)

  for (const method of ['writeText', 'editText', 'watch']) {
    patch(method, (original) => async (target, ...args) => {
      if (remoteOf(target) === undefined) return original(target, ...args)
      throw new FsError(`Remote file previews do not support ${method}: ${target.displayPath}`, 'FS_PERMISSION_DENIED')
    })
  }

  ctx.effect(() => async () => {
    for (const [method, original] of patched) base[method] = original
    minted.clear()
    const activeTransports = [...transports.values()]
    transports.clear()
    await Promise.all(activeTransports.map((transport) => transport.dispose()))
    log('read decorator removed')
  })

  const initial = registryOf()
  const mappingCount = initial === undefined ? (legacy === undefined ? 0 : 1) : initial.list().length
  log(
    `decorating ${base.constructor?.name ?? 'ctx.fs'}: ${mappingCount} mapping(s)` +
      (legacy === undefined
        ? ''
        : ` (legacy single: ${legacy.localRoot} -> ${legacy.host}:${legacy.remoteRoot})`),
  )
}
