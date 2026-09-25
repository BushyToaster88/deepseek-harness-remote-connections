/** Read-only GNU filesystem commands carried over a connection's SSH coordinates. */
import { execFile } from 'node:child_process'
import { posix } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

function shellQuote(value) {
  if (String(value).includes('\u0000')) throw new Error('path contains NUL')
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function byteCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function versionFor(time, size) {
  const [seconds, fraction = ''] = time.split('.')
  return `${seconds}.${fraction.replace(/0+$/, '') || '0'}-${size}`
}

function aborted(signal) {
  if (signal?.aborted) throw new FsError('Remote filesystem operation aborted.', 'FS_ABORTED')
}

/**
 * Create a read-only transport. Paths are absolute remote paths or relative to root.
 * @param options - host, root, optional sshConfig, port, identityFile and command timeoutMs.
 * @returns stat, directory listing and bounded byte-read operations.
 */
export function createSshFs({ host, root, sshConfig, port, identityFile, timeoutMs = 30_000 }) {
  if (host === undefined || host === '') throw new Error('createSshFs needs a host')
  if (!root || !posix.isAbsolute(root)) throw new Error('createSshFs requires an absolute remote root')
  if (typeof host !== 'string' || host === '' || /^-/.test(host) || /[\s\0]/.test(host)) {
    throw new Error('invalid SSH host')
  }
  if (port !== undefined && (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)) {
    throw new Error('invalid SSH port')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer')
  const sshArgs = [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(sshConfig === undefined ? [] : ['-F', String(sshConfig)]),
    ...(port === undefined ? [] : ['-p', String(port)]),
    ...(identityFile === undefined ? [] : ['-i', String(identityFile)]),
    '--', host,
  ]

  function toRemotePath(path) {
    if (path === '' || path === undefined) return posix.normalize(root)
    return posix.resolve(root, path)
  }

  const active = new Map()
  let disposed = false

  function run(command, { maxBytes = DEFAULT_MAX_BYTES, encoding, signal } = {}) {
    aborted(signal)
    if (disposed) throw new FsError('Remote filesystem transport is closed.', 'FS_ABORTED')
    return new Promise((resolve, reject) => {
      // Keep diagnostics readable even for an empty/short requested byte window.
      const child = execFile('ssh', [...sshArgs, command], {
        encoding: 'buffer', maxBuffer: Math.max(maxBytes, 64 * 1024),
        timeout: timeoutMs, killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        signal?.removeEventListener('abort', cancel)
        if (signal?.aborted || disposed) {
          reject(new FsError('Remote filesystem operation aborted.', 'FS_ABORTED'))
          return
        }
        if (error) {
          const detail = stderr.toString('utf8').trim() || error.message
          const code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'FS_TOO_LARGE'
            : /Permission denied/i.test(detail) ? 'FS_PERMISSION_DENIED'
            : error.code !== 255 && /No such file or directory|Not a directory/i.test(detail) ? 'FS_NOT_FOUND'
            : 'FS_IO_ERROR'
          reject(new FsError(`Remote filesystem on ${host}: ${detail}`, code, { cause: error }))
          return
        }
        if (stdout.length > maxBytes) {
          reject(new FsError(`Remote response exceeds ${maxBytes} bytes.`, 'FS_TOO_LARGE'))
          return
        }
        resolve(encoding === 'utf8' ? stdout.toString('utf8') : stdout)
      })
      const done = new Promise((resolve) => child.once('close', resolve))
      active.set(child, done)
      child.once('close', () => active.delete(child))
      const cancel = () => child.kill('SIGKILL')
      // execFile's callback runs after close; aborted operations only settle once SSH exits.
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      child.stdin.end()
    })
  }

  async function stat(path, { follow = true, signal } = {}) {
    const flag = follow ? '-Lc' : '-c'
    try {
      const out = await run(`LC_ALL=C stat ${flag} '%F|%s|%Y|%y' -- ${shellQuote(toRemotePath(path))}`, {
        encoding: 'utf8', signal,
      })
      const [kind, size, mtime, preciseTime] = out.trim().split('|')
      const type = kind === 'regular file' || kind === 'regular empty file' ? 'file' : kind === 'directory' ? 'directory' : 'other'
      if (!Number.isSafeInteger(Number(size)) || Number(size) < 0 || !Number.isFinite(Number(mtime))) {
        throw new FsError('Malformed remote stat output.', 'FS_IO_ERROR')
      }
      return { type, size: Number(size), mtime: Number(mtime), version: versionFor(`${mtime}.${preciseTime?.match(/\.(\d+)/)?.[1] ?? '0'}`, size) }
    } catch (error) {
      if (error.code === 'FS_NOT_FOUND') return undefined
      throw error
    }
  }

  async function regularFile(path, signal) {
    const info = await stat(path, { signal })
    if (info === undefined) throw new FsError(`Remote file not found: ${path}`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`Not a regular remote file: ${path}`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  return {
    host, root, toRemotePath, stat,

    /** Cancel in-flight SSH commands and wait until every child is reaped. */
    async dispose() {
      disposed = true
      const pending = [...active.values()]
      for (const child of active.keys()) child.kill('SIGKILL')
      await Promise.all(pending)
    },

    /** List direct children without losing filenames containing tabs or newlines. */
    async listDir(path, { signal } = {}) {
      const info = await stat(path, { signal })
      if (info === undefined) throw new FsError(`Remote directory not found: ${path}`, 'FS_NOT_FOUND')
      if (info.type !== 'directory') throw new FsError(`Not a remote directory: ${path}`, 'FS_NOT_DIRECTORY')
      const out = await run(
        `LC_ALL=C find -H ${shellQuote(toRemotePath(path))} -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0%T@\\0'`,
        { encoding: 'utf8', signal },
      )
      const fields = out.split('\u0000')
      fields.pop()
      if (fields.length % 4 !== 0) throw new FsError('Malformed remote directory listing.', 'FS_IO_ERROR')
      const entries = []
      for (let i = 0; i < fields.length; i += 4) {
        const [name, kind, size, mtime] = fields.slice(i, i + 4)
        const type = kind === 'f' ? 'file' : kind === 'd' ? 'directory' : 'other'
        entries.push({ name, type, size: Number(size), version: versionFor(mtime, size) })
      }
      return entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    },

    /** Read the complete regular file, rejecting oversize content rather than truncating. */
    async readBytes(path, maxBytes = DEFAULT_MAX_BYTES, { signal } = {}) {
      byteCount(maxBytes, 'maxBytes')
      const info = await regularFile(path, signal)
      if (info.size > maxBytes) throw new FsError(`Remote file exceeds ${maxBytes} bytes: ${path}`, 'FS_TOO_LARGE')
      return run(`cat -- ${shellQuote(toRemotePath(path))}`, { maxBytes, signal })
    },

    /** Read a byte window; GNU dd preserves read failures instead of hiding them in a pipeline. */
    async readByteRange(path, { offset, length }, { signal } = {}) {
      byteCount(offset, 'offset')
      byteCount(length, 'length')
      await regularFile(path, signal)
      if (length === 0) return Buffer.alloc(0)
      return run(
        `dd if=${shellQuote(toRemotePath(path))} bs=65536 iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none`,
        { maxBytes: length, signal },
      )
    },
  }
}
