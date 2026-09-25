/**
 * Non-interactive ssh helpers for the connection registry: a readiness probe, and the
 * directory listing the workspace browser drives.
 *
 * Both run fixed commands with every operator-supplied value **shell-quoted**; nothing is
 * interpolated raw. A leading `$HOME` is kept outside the quotes so the remote shell expands
 * it, and the remainder is quoted literally, so a directory with spaces (or a quote) cannot
 * change the command. Paths are still checked for the characters that cannot survive the wire
 * at all (newlines, NUL) and for being absolute.
 */
import { spawn } from 'node:child_process'

/** The release this bridge is built and verified against; the install advice pins it. */
export const DSH_VERSION = '0.1.7-alpha.2'
/** Where DSH lives on a provisioned host, matching the carrier's own default. */
export const DEFAULT_REMOTE_DSH = '$HOME/.local/share/dsh-bridge/node_modules/.bin/dsh'
/** Where the remote API key lives, matching the carrier's own default. */
export const DEFAULT_REMOTE_KEYFILE = '$HOME/.dsh/deepseek-api-key'

/**
 * Validate one operator-supplied remote path.
 * @param value - the path as typed.
 * @param field - field name for the refusal message.
 * @returns the path, unchanged.
 */
export function safeRemotePath(value, field) {
  const text = String(value ?? '')
  if (text.trim() === '') throw new Error(`${field} is required`)
  if (/[\n\r\0]/.test(text)) throw new Error(`${field} must not contain newlines`)
  if (!text.startsWith('/') && text !== '$HOME' && !text.startsWith('$HOME/')) {
    throw new Error(`${field} must be an absolute path (or start with $HOME/)`)
  }
  return text
}

/**
 * Quote one path for a remote shell, keeping a leading `$HOME` expandable.
 * @param value - a validated path.
 * @returns the shell fragment.
 */
export function shellPath(value) {
  const text = String(value)
  const literal = (part) => `'${part.replaceAll("'", `'\\''`)}'`
  if (text === '$HOME') return '"$HOME"'
  if (text.startsWith('$HOME/')) return `"$HOME"/${literal(text.slice('$HOME/'.length))}`
  return literal(text)
}

/**
 * Validate an ssh port as typed in the connection form.
 * @param value - the port as typed (number, string, or absent).
 * @returns the normalized port string, or undefined when absent.
 */
export function safePort(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const text = String(value).trim()
  if (!/^[0-9]{1,5}$/.test(text)) throw new Error('ssh port must be a number between 1 and 65535')
  const port = Number(text)
  if (port < 1 || port > 65535) throw new Error('ssh port must be a number between 1 and 65535')
  return String(port)
}

/**
 * Validate a local identity (private key) file path.
 * @param value - the path as typed.
 * @param field - field name for the refusal message.
 * @returns the path, unchanged.
 */
export function safeLocalPath(value, field) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  if (/[\n\r\0]/.test(text)) throw new Error(`${field} must not contain newlines`)
  return text
}

/** A destination must remain one ssh argument and must never become an ssh option. */
export function safeHost(value) {
  const host = String(value ?? '').trim()
  if (host === '') throw new Error('host is required')
  if (host.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(host)) throw new Error('host must be an ssh alias or hostname, not options or whitespace')
  return host
}

/**
 * Run one command over non-interactive ssh.
 * @param host - ssh alias or hostname.
 * @param command - the shell command to run.
 * @param options - optional ssh config, port, and identity file.
 * @returns exit code, stdout and stderr; a spawn failure reports code -1.
 */
export function runRemote(host, command, options = {}) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']
  const sshConfig = safeLocalPath(options.sshConfig, 'ssh config file')
  const port = safePort(options.port)
  const identity = safeLocalPath(options.identity, 'ssh key file')
  if (sshConfig !== undefined) args.push('-F', sshConfig)
  if (port !== undefined) args.push('-p', port)
  if (identity !== undefined) args.push('-i', identity)
  args.push('--', safeHost(host), command)
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('ssh timeout must be positive')
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('ssh output limit must be positive')
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let bytes = 0
    let timedOut = false
    let outputLimitExceeded = false
    let spawnError
    let killTimer
    const stop = () => {
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const collect = (chunks, chunk) => {
      const remaining = Math.max(0, maxOutputBytes - bytes)
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      bytes += chunk.length
      if (bytes > maxOutputBytes && !outputLimitExceeded) {
        outputLimitExceeded = true
        stop()
      }
    }
    child.stdout.on('data', (chunk) => collect(stdout, chunk))
    child.stderr.on('data', (chunk) => collect(stderr, chunk))
    child.on('error', (error) => { spawnError = error?.message ?? String(error) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      const detail = timedOut ? `ssh command timed out after ${timeoutMs}ms`
        : outputLimitExceeded ? `ssh output exceeded ${maxOutputBytes} bytes` : spawnError
      resolve({
        code: timedOut || outputLimitExceeded || spawnError ? -1 : code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: [Buffer.concat(stderr).toString('utf8'), detail].filter(Boolean).join('\n'),
        timedOut,
        outputLimitExceeded,
        signal,
      })
    })
  })
}

/**
 * List the subdirectories of one directory on a host, for the workspace browser.
 * @param host - ssh alias or hostname.
 * @param path - absolute directory to list; absent lists the home directory.
 * @param options - optional explicit ssh config.
 * @returns the level's path, its parent (absent at the root), and its subdirectories.
 */
export async function listRemoteDirectories(host, path, options = {}) {
  const target = path === undefined || String(path).trim() === ''
    ? '$HOME'
    : safeRemotePath(path, 'directory')
  // NUL records preserve quotes, spaces and tabs without ls's locale-dependent escaping.
  // Globs include hidden directories and directory symlinks on POSIX shells.
  const command = `CDPATH= cd ${shellPath(target)} && ` +
    `{ [ -r . ] || { printf '%s\\n' 'directory is not readable' >&2; exit 1; }; } && ` +
    `printf '%s\\0' "$(pwd -P)" && ` +
    `for dir in ./*/ ./.[!.]*/ ./..?*/; do ` +
    `[ -d "$dir" ] || continue; name=\${dir#./}; printf '%s\\0' "\${name%/}"; done`
  const result = await runRemote(host, command, options)
  if (result.code !== 0) {
    const reason = result.stderr.trim().split('\n').filter(Boolean).pop() ?? `exit ${result.code}`
    throw new Error(`cannot list ${target} on ${host}: ${reason}`)
  }
  const records = result.stdout.split('\0')
  const resolved = records.shift()
  if (!result.stdout.endsWith('\0') || !resolved?.startsWith('/') || /[\n\r]/.test(resolved)) {
    throw new Error(`cannot list ${target} on ${host}: invalid directory response`)
  }
  const entries = records.filter((name) => name !== '' && name !== '.' && name !== '..' && !/[\n\r/]/.test(name)).sort((left, right) => left.localeCompare(right))
  const parent =
    resolved === '' || resolved === '/'
      ? undefined
      : resolved.replace(/\/[^/]+$/, '') || '/'
  return {
    path: resolved,
    parent,
    entries: entries.map((name) => ({
      name,
      path: `${resolved === '/' ? '' : resolved}/${name}`,
    })),
  }
}

/**
 * Check one connection end to end, short of a model call.
 * @param input - host, and optional remote workspace, key file, dsh path and ssh config.
 * @returns whether the host is ready, the remote dsh version when it answered, and a
 *   one-line detail suitable for showing in the dialog.
 */
export async function probeServer(input) {
  const host = safeHost(input.host)
  const keyFile =
    input.keyFile === undefined || String(input.keyFile).trim() === ''
      ? DEFAULT_REMOTE_KEYFILE
      : safeRemotePath(input.keyFile, 'key file')
  const dshBin =
    input.dshBin === undefined || String(input.dshBin).trim() === ''
      ? DEFAULT_REMOTE_DSH
      : safeRemotePath(input.dshBin, 'remote dsh path')
  const remoteRoot =
    input.remoteRoot === undefined || String(input.remoteRoot).trim() === ''
      ? undefined
      : safeRemotePath(input.remoteRoot, 'remote workspace path')
  const storeFile = '$HOME/.dsh/.credentials.yaml'
  const keyEnvName = 'DEEPSEEK_API_KEY'
  // Use the installed runtime's own schema. Grepping for a key name and an unrelated
  // `secret:` field both rejects valid refs and accepts browser-only stores. Never print
  // the document or parser errors: either can include credentials.
  const credentialCheck = `
    import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    try {
      const [dsh, keyFile, storeFile] = process.argv.slice(1);
      if (existsSync(keyFile) && readFileSync(keyFile, 'utf8').trim()) {
        console.log('CREDENTIAL=keyfile');
      } else if (process.env.DEEPSEEK_API_KEY?.trim()) {
        console.log('CREDENTIAL=environment');
      } else if (existsSync(storeFile)) {
        if (statSync(storeFile).mode & 0o077) throw new Error('permissions');
        const require = createRequire(realpathSync(dsh));
        const { parseCredentialsDocument } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')).href);
        const document = parseCredentialsDocument(readFileSync(storeFile, 'utf8'), storeFile);
        const key = document.refs.get('DEEPSEEK_API_KEY');
        const grant = document.records.get('deepseek-account-platform/default');
        const payload = grant?.kind === 'grant' ? grant.payload : undefined;
        const hasGrant = payload?.version === 1 && typeof payload.token === 'string' && payload.token.trim() && typeof payload.issuer === 'string';
        if ((typeof key === 'string' && key.trim()) || hasGrant) console.log('CREDENTIAL=store');
        else { console.log('CREDENTIAL_MISSING'); process.exitCode = 3; }
      } else { console.log('CREDENTIAL_MISSING'); process.exitCode = 3; }
    } catch { console.log('CREDENTIAL_INVALID'); process.exitCode = 3; }
  `

  // Every check reports its own marker so the failure can name the real problem: a missing
  // runtime, a runtime that will not start (usually the wrong Node), or missing credentials.
  const command = [
    `echo "NODE=$(node --version 2>&1 | head -1)"`,
    ...(remoteRoot === undefined ? [] : [`cd ${shellPath(remoteRoot)}`]),
    `if [ -x ${shellPath(dshBin)} ]; then ` +
      `if V=$(${shellPath(dshBin)} --version 2>&1); then echo "DSH_VERSION=$V"; ` +
      `else echo "DSH_UNRUNNABLE=$V"; exit 4; fi; ` +
      `else echo "DSH_ABSENT"; exit 4; fi`,
    `node --input-type=module -e ${shellPath(credentialCheck)} ${shellPath(dshBin)} ${shellPath(keyFile)} ${shellPath(storeFile)}`,
  ].join(' && ')

  const result = await runRemote(host, command, {
    sshConfig: input.sshConfig,
    port: input.port,
    identity: input.identity,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
  })
  const lines = result.stdout.split('\n').map((line) => line.trim())
  const marker = (prefix) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length)
  const node = marker('NODE=')
  // Mention node when it is missing or too old: that is the usual reason a successful `npm
  // install` still cannot run the runtime.
  const nodeMajor = Number((node ?? '').replace(/^v/, '').split('.')[0])
  const nodeNote =
    node === undefined
      ? ''
      : Number.isFinite(nodeMajor) && nodeMajor >= 20
        ? ` (node ${node})`
        : ` (node ${node}; DSH needs Node 20 or newer)`
  const resolvedDsh = dshBin.replace(/^\$HOME/, `~`)

  if (marker('DSH_ABSENT') !== undefined) {
    return {
      ok: false,
      version: undefined,
      detail:
        `DSH is not installed on ${host} at ${resolvedDsh}${nodeNote}. Install it there: ` +
        `ssh ${host} 'mkdir -p ~/.local/share/dsh-bridge && ` +
        `npm install --prefix ~/.local/share/dsh-bridge --no-fund --no-audit ` +
        `@deepseek-ai/dsh@${DSH_VERSION}'` + ` (both ends should run the same release)`,
    }
  }
  const unrunnable = marker('DSH_UNRUNNABLE=')
  if (unrunnable !== undefined) {
    return {
      ok: false,
      version: undefined,
      detail:
        `DSH is installed on ${host} at ${resolvedDsh} but will not run${nodeNote}: ` +
        `${unrunnable === '' ? 'no output' : unrunnable}`,
    }
  }
  const version = marker('DSH_VERSION=') ?? ''
  const fromStore = marker('CREDENTIAL=') === 'store'
  if (marker('CREDENTIAL_INVALID') !== undefined) {
    return { ok: false, version: version || undefined, detail: `cannot read credentials on ${host}: check the host's credential store format and owner-only permissions` }
  }
  if (marker('CREDENTIAL_MISSING') !== undefined) {
    return {
      ok: false,
      version: undefined,
      detail:
        `no ${keyEnvName} on ${host}: store it there through DSH (its Models page writes ` +
        `${storeFile}), or place a key file at ${keyFile}`,
    }
  }
  if (result.code === 255) {
    const reason = result.stderr.trim().split('\n').filter(Boolean).pop() ?? 'ssh failed'
    return { ok: false, version: undefined, detail: `ssh to ${host} failed: ${reason}` }
  }
  if (result.code !== 0 || version === '' || marker('CREDENTIAL=') === undefined) {
    const reason = result.stderr.trim().split('\n').filter(Boolean).pop() ?? `exit ${result.code}`
    return { ok: false, version: undefined, detail: `cannot check ${host}: ${reason}` }
  }
  if (version !== DSH_VERSION) {
    return { ok: false, version, detail: `remote dsh ${version} does not match this bridge's ${DSH_VERSION}; both ends should run the same release` }
  }
  return {
    ok: true,
    version,
    detail: fromStore
      ? `ready: remote dsh ${version}, using the host's own stored credentials`
      : marker('CREDENTIAL=') === 'environment'
        ? `ready: remote dsh ${version}, using the host's environment credentials`
        : `ready: remote dsh ${version}, using ${keyFile}`,
  }
}
