/**
 * Automatic remote configuration sync.
 *
 * Two artifacts are global by nature — the working agreements and the MCP server list — and a
 * remote runtime cannot inherit them from this machine: it reads its own `$DSH_HOME/AGENTS.md`
 * and its own `$DSH_HOME/cordis.patch.yml`. This module produces a self-contained POSIX shell
 * script that keeps them current, so it can ride inside an ssh command that is already being
 * opened. The carrier runs it immediately before `exec`, which makes propagation automatic with
 * no daemon and no extra round-trip; `dsh-sync-config` reuses the same script for manual runs.
 *
 * Properties:
 *   - hash-gated: one `cat` of a stamp file decides whether anything is written, and the gate
 *     also requires both files to still exist, so a deleted file heals on the next start;
 *   - idempotent: the stamp records what this tool last wrote, so an unchanged source is a no-op;
 *   - drift-safe: a host copy without our appendix marker is backed up beside itself before
 *     being replaced, so an owner's own file is never lost silently. An owner edit made *after*
 *     a sync is left alone until the source changes or `--force` is used — the stamp records the
 *     source we wrote, not the file's current bytes;
 *   - credential-free: the MCP rows carry no secrets, and `.credentials.yaml` is never touched;
 *   - optional: `DSH_REMOTE_SYNC=0` disables it for a session.
 *
 * The per-host appendix (hostname, OS, node, remote dsh) is regenerated on every write, because
 * parts of the shared agreements describe *this* machine and would otherwise read as fact on
 * another host. Mark host-specific prose of your own with
 * `<!-- dsh-sync: local-only -->` … `<!-- /dsh-sync: local-only -->` and it will not ship.
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MCP_FRAGMENT = join(HERE, '..', 'portable', 'mcp-servers.patch.yml')

export const STAMP_FILE = '.dsh-sync-stamp'
export const PATCH_START = '# >>> dsh-sync: MCP servers >>>'
export const PATCH_END = '# <<< dsh-sync: MCP servers <<<'
export const APPENDIX_START = '<!-- dsh-sync: host appendix -->'
export const APPENDIX_END = '<!-- /dsh-sync: host appendix -->'

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
/** POSIX single-quote a value. */
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`

/**
 * Read MCP bearer tokens from this machine's own global patch.
 *
 * The local file is the source of truth and is never copied verbatim: only the two values the
 * fragment names as placeholders are pulled, and only when a caller opts in.
 */
export function localMcpTokens(dshHome) {
  const path = join(dshHome, 'cordis.patch.yml')
  if (!existsSync(path)) return {}
  const text = readFileSync(path, 'utf8')
  const tokens = {}
  for (const name of ['HUGGINGFACE_TOKEN', 'GITHUB_TOKEN']) {
    const server = name === 'HUGGINGFACE_TOKEN' ? 'huggingface' : 'github'
    const match = new RegExp(`serverName:\\s*${server}\\b[\\s\\S]{0,600}?Authorization:\\s*"Bearer\\s+([^"@][^"]*)"`).exec(text)
    if (match !== null) tokens[name] = match[1].trim()
  }
  return tokens
}

/** Strip regions the author marked local-only, and any appendix a previous sync wrote. */
export function portableAgents(text) {
  return text
    .replace(/<!--\s*dsh-sync:\s*local-only\s*-->[\s\S]*?<!--\s*\/dsh-sync:\s*local-only\s*-->/g, '')
    .replace(new RegExp(`${APPENDIX_START}[\\s\\S]*${APPENDIX_END}`, 'g'), '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s*$/, '')
}

/**
 * Build the sync script for a host.
 *
 * @param options - `dshHome` (defaults to `$DSH_HOME`), `force` (write even if current),
 *   `quiet` (print nothing when it writes), `agents`/`mcp` (select artifacts).
 * @returns `script` (POSIX shell), the hashes it is keyed on, and the server names it ships.
 */
export function planSync(options = {}) {
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const agentsPath = join(dshHome, 'AGENTS.md')
  const agentsText = existsSync(agentsPath) ? portableAgents(readFileSync(agentsPath, 'utf8')) : ''
  // The operator's own list lives in $DSH_HOME, never in the repository; the shipped file is a
  // template so a fresh clone still shows the shape.
  const localFragment = join(dshHome, 'mcp-servers.patch.yml')
  const fragmentPath = existsSync(localFragment) ? localFragment : MCP_FRAGMENT
  const rawPatch = readFileSync(fragmentPath, 'utf8').trim()
  // The fragment holds `@TOKEN@` placeholders, never literals. Tokens are shipped only when the
  // caller opts in, and then they are read from this machine's own global patch — so a repository
  // copy of the fragment can never carry one, and a host that does not receive a token simply
  // loses that server's tools instead of failing.
  const tokens = options.withTokens === true ? localMcpTokens(dshHome) : {}
  const shipped = []
  const patchText = rawPatch.replace(/^.*Authorization:\s*"Bearer\s+@(\w+)@".*$/gm, (line, name) => {
    const token = tokens[name]
    if (token === undefined) return null
    shipped.push(name)
    return line.replace(`@${name}@`, token)
  })
  const servers = [...patchText.matchAll(/serverName:\s*(\S+)/g)].map(([, name]) => name)

  const agentsPayload = Buffer.from(`${agentsText}\n`, 'utf8').toString('base64')
  const patchPayload = Buffer.from(`${patchText}\n`, 'utf8').toString('base64')
  // A forced run simply asks for a state the stamp can never already hold.
  const want = `agents=${sha(agentsText)} patch=${sha(patchText)}${options.force === true ? ` force=${Date.now()}` : ''}`
  const banner =
    options.quiet === true
      ? ''
      : `  printf '[dsh-sync] %s: AGENTS.md + %s MCP servers installed\\\\n' "$(hostname 2>/dev/null || echo remote)" "${servers.length}" >&2\n`

  const script = `set -e
DSH_SYNC_HOME="\${DSH_HOME:-$HOME/.dsh}"
# Origin guard: a harness that fakes ssh by running the command locally would otherwise write
# into this machine's own DSH_HOME. Skip when the executing host and directory are the origin.
if [ "$(hostname 2>/dev/null)" = ${quote(hostname())} ] &&
   [ "$DSH_SYNC_HOME" = ${quote(dshHome)} ]; then
  : # same machine as the origin: nothing to sync
else
DSH_SYNC_WANT=${quote(want)}
mkdir -p "$DSH_SYNC_HOME"
DSH_SYNC_STAMP="$DSH_SYNC_HOME/${STAMP_FILE}"
if [ "$(cat "$DSH_SYNC_STAMP" 2>/dev/null)" = "$DSH_SYNC_WANT" ] &&
   [ -f "$DSH_SYNC_HOME/AGENTS.md" ] && [ -f "$DSH_SYNC_HOME/cordis.patch.yml" ]; then
  : # already current: the stamp matches and both files are present
else
if [ -f "$DSH_SYNC_HOME/AGENTS.md" ] && ! grep -qF ${quote(APPENDIX_START)} "$DSH_SYNC_HOME/AGENTS.md" 2>/dev/null; then
  cp "$DSH_SYNC_HOME/AGENTS.md" "$DSH_SYNC_HOME/AGENTS.md.dsh-sync.bak" 2>/dev/null || true
fi
umask 077
printf '%s' ${quote(agentsPayload)} | base64 -d > "$DSH_SYNC_HOME/.agents.in" 2>/dev/null || true
if [ -s "$DSH_SYNC_HOME/.agents.in" ]; then
  {
    cat "$DSH_SYNC_HOME/.agents.in"
    printf '\\n\\n%s\\n' ${quote(APPENDIX_START)}
    printf '## This host (generated by dsh-sync)\\n\\n'
    printf -- '- host: %s\\n' "$(hostname 2>/dev/null || echo unknown)"
    printf -- '- os: %s\\n' "$(. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME")"
    printf -- '- node: %s\\n' "$(node --version 2>&1 | head -1)"
    printf -- '- remote dsh: %s\\n' "$(dsh --version 2>&1 | head -1)"
    printf '\\nThe agreements above are shared with the source machine; this block is per host and is\\nrewritten on every sync.\\n%s\\n' ${quote(APPENDIX_END)}
  } > "$DSH_SYNC_HOME/.agents.out"
  mv "$DSH_SYNC_HOME/.agents.out" "$DSH_SYNC_HOME/AGENTS.md"
  rm -f "$DSH_SYNC_HOME/.agents.in"
  chmod 600 "$DSH_SYNC_HOME/AGENTS.md" 2>/dev/null || true
fi
printf '%s' ${quote(patchPayload)} | base64 -d > "$DSH_SYNC_HOME/.patch.in" 2>/dev/null || true
if [ -s "$DSH_SYNC_HOME/.patch.in" ]; then
  {
    printf '%s\n' ${quote(PATCH_START)}
    printf '# Managed by dsh-sync: shared by every profile on this host. Keep host-local\n'
    printf '# overrides outside this region — they are preserved.\n'
    cat "$DSH_SYNC_HOME/.patch.in"
    printf '%s\n' ${quote(PATCH_END)}
  } > "$DSH_SYNC_HOME/.patch.block"
  if [ -f "$DSH_SYNC_HOME/cordis.patch.yml" ]; then
    if grep -qF ${quote(PATCH_START)} "$DSH_SYNC_HOME/cordis.patch.yml" 2>/dev/null; then
      awk -v s=${quote(PATCH_START)} -v e=${quote(PATCH_END)} -v b="$DSH_SYNC_HOME/.patch.block" '
        index($0, s) { while ((getline line < b) > 0) print line; skipping = 1; next }
        index($0, e) { skipping = 0; next }
        !skipping { print }
      ' "$DSH_SYNC_HOME/cordis.patch.yml" > "$DSH_SYNC_HOME/.patch.out"
    else
      cp "$DSH_SYNC_HOME/cordis.patch.yml" "$DSH_SYNC_HOME/cordis.patch.yml.dsh-sync.bak" 2>/dev/null || true
      { printf '# Host-local overrides, kept below the managed region by dsh-sync.\n'
        cat "$DSH_SYNC_HOME/cordis.patch.yml"
        printf '\n'
        cat "$DSH_SYNC_HOME/.patch.block"
      } > "$DSH_SYNC_HOME/.patch.out"
    fi
  else
    cat "$DSH_SYNC_HOME/.patch.block" > "$DSH_SYNC_HOME/.patch.out"
  fi
  mv "$DSH_SYNC_HOME/.patch.out" "$DSH_SYNC_HOME/cordis.patch.yml"
  rm -f "$DSH_SYNC_HOME/.patch.in" "$DSH_SYNC_HOME/.patch.block"
  chmod ${options.withTokens === true ? '600' : '644'} "$DSH_SYNC_HOME/cordis.patch.yml" 2>/dev/null || true
fi
printf '%s\\n' "$DSH_SYNC_WANT" > "$DSH_SYNC_STAMP"
${banner}fi
fi
true
`
  return {
    script,
    want,
    servers,
    fragmentPath,
    shippedTokens: shipped,
    agentsBytes: agentsText.length,
    patchBytes: patchText.length,
  }
}
