# remote-connections

Run a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) workspace on **another
machine** and drive it from the harness GUI you already have. The agent runs over there — with that
host's files, tools, credentials and network position — while the session behaves like a local one.

This directory is the out-of-tree half of that feature. The browser and host-side packages it talks
to live elsewhere in **this same repository**, because they can only be built inside the harness
tree (they are pnpm workspace members compiled by the harness's own build):

```
packages/api/remote-servers/           the authenticated `remoteServers` namespace
packages/client/ui-remote-workspaces/  Settings → Remote, and the Add-workspace browser
remote-connections/                    ← you are here: carrier, driver, registry, filesystem, sync
```

So this repository is a **fork of the upstream project**: everything upstream has, plus the two
packages and this directory. If you want the DSH project itself, read
[its README](https://github.com/deepseek-ai/deepseek-harness) — that is the canonical introduction,
and the sections below only describe what this fork adds.

## How it works

DSH can drive an agent over **ACP**. Point an ACP client at `ssh host dsh --profile acp` and the
remote runtime becomes a session in your sidebar. Three decisions turn that into something usable:

- **Connections and workspaces are separate.** A *connection* is an ssh-reachable host, nothing
  more. A *workspace* is one directory on one connection, chosen by browsing that host in the GUI.
  One host can back as many workspaces as you like.
- **Routing is by anchor.** Each (connection, directory) pair gets a small local directory — its
  anchor — which is what the GUI registers as a workspace. The driver resolves a session's anchor
  to a connection and remote directory; the filesystem decorator maps the same anchor onto that
  directory's files over ssh. Local paths and local sessions are untouched.
- **Credentials stay on the remote host.** The local side holds no remote key and proxies no tool
  call. The remote runtime authenticates itself.

```
GUI session ──► dsh-remote-acp-driver          local plugin: resolves anchor → connection + directory
                     │
                     ▼
                bin/dsh-remote-carrier          opens ssh: syncs shared config, execs the runtime
                     │
                     ▼
                remote DSH over ACP             agent loop, tools, model calls — all on that host
                     │
                     └─ stdout/stderr ⟶ the local session log
```

## Requirements

- **Local** — a working DSH install, Node 20 or newer, and `pnpm` for the build.
- **Remote** — ssh access with key authentication (`BatchMode`; no password prompts), Node 20 or
  newer, and DSH installed at the same release as your local one. A DSH that installs but cannot
  run (an old Node) is reported explicitly rather than failing later.

## Install

**1. Get the tree and build the two packages.** They are workspace members, so build them in place:

```bash
git clone https://github.com/BushyToaster88/deepseek-harness-remote-connections
cd deepseek-harness-remote-connections
pnpm install
pnpm exec tsc -b packages/api/remote-servers && pnpm --dir packages/api/remote-servers exec tsdown
pnpm exec tsc -b packages/client/ui-remote-workspaces && pnpm --dir packages/client/ui-remote-workspaces exec tsdown
```

**2. Install both halves into a profile** (this is how the harness loads plugins — profile packages
shadow the installation's own copies):

```bash
P="$DSH_HOME/profiles/<your-profile>/node_modules"

# the two built packages from this tree
for pkg in api/remote-servers client/ui-remote-workspaces; do
  name="@deepseek-ai/dsh-$(basename $pkg)"
  mkdir -p "$P/$name" && cp -r "packages/$pkg/lib" "packages/$pkg/package.json" "$P/$name/"
done

# the three plugins from remote-connections/, under the names the profile rows use
cp -r remote-connections/servers   "$P/dsh-remote-servers"
cp -r remote-connections/plugin    "$P/dsh-remote-acp-driver"
cp -r remote-connections/remote-fs "$P/dsh-remote-fs"
```

Each of those directories needs a `package.json` — `servers/`, `plugin/` and `remote-fs/` already
contain one. The profile loads a plugin by the `name` in its row, resolving it inside the profile's
`node_modules`, which is why the copies are renamed to match.

**3. Add the profile rows.** `<checkout>` is where you cloned this fork:

```yaml
- id: remote-servers                 # the connection/workspace registry
  name: dsh-remote-servers
  config:
    anchorRoot: ~/dsh-remotes        # where workspace anchors live locally
    servers: {}                      # connections are added from the GUI; see below
    workspaces: {}                   # workspaces are created by browsing a host in the GUI
- id: remote-acp-driver              # the driver; `mode: hybrid` keeps local sessions local
  name: dsh-remote-acp-driver
  config:
    mode: hybrid
    command: <checkout>/remote-connections/bin/dsh-remote-carrier
- id: remote-fs                      # maps anchor paths onto remote files
  name: dsh-remote-fs
- id: api-remote-servers
  name: "@deepseek-ai/dsh-api-remote-servers"
- id: ui-remote-workspaces
  name: "@deepseek-ai/dsh-client-ui-remote-workspaces"
```

`agent-loop` must stay **enabled** (`disabled: false`): local folders use DSH's own agent loop and
only registered remote anchors route through ACP. If your profile has the automatic directory
picker, replace it with `@deepseek-ai/dsh-host-directory-picker-browse` — the Add-workspace flow is
a single-occupancy slot and would otherwise collide with a second picker.

**4. Provision each remote host** (once per host):

```bash
ssh HOST 'mkdir -p ~/.local/share/dsh-bridge && \
  npm install --prefix ~/.local/share/dsh-bridge --no-fund --no-audit @deepseek-ai/dsh@<same release as your GUI>'
```

Then put that host's model credentials **on that host**: either store the key through DSH there, or
write `~/.dsh/deepseek-api-key` (mode 600). The readiness check reports which it found and refuses
to call a host ready when neither is present.

**5. Use it.** Restart the profile and open the GUI: **Settings → Remote** adds a connection (name,
ssh host or alias, and optionally a port, an ssh key file, an ssh config, and a starting directory
for the browser). **Add workspace → Remote connection…** then browses that host and adopts the
folder you pick.

## Shared configuration, shipped per host

A remote runtime reads its own `$DSH_HOME/AGENTS.md` and its own global patch, so it cannot inherit
your working agreements or MCP servers. The carrier keeps them current **inside the ssh session it
already opens**, immediately before `exec`:

- hash-gated — one `cat` of a stamp file decides whether anything is written, and the gate also
  requires both files to still exist, so a deleted file heals on the next start;
- non-destructive — the MCP rows are spliced into a marked region of the host's global patch, so a
  host's own overrides survive; a file it did not write is backed up beside itself first;
- credential-free by default — rows needing a token hold a `@NAME@` placeholder and lose their
  `Authorization` header unless you opt in with `--with-tokens`, which reads the value from your own
  global patch and writes the host file mode 600;
- opt-out — `DSH_REMOTE_SYNC=0` for a session, or `dsh-sync-config HOST --agents-only` / `--mcp-only`
  for a manual run (`--dry-run`, `--force`, `--json` also exist).

**Your MCP list lives outside the repository.** `config-sync` reads
`$DSH_HOME/mcp-servers.patch.yml` when it exists and otherwise falls back to
`remote-connections/portable/mcp-servers.patch.yml`, which is a generic template. Keep your real
list in `$DSH_HOME` and it never needs to be committed. Copy the template to start.

## Verifying an install

The working copy carries a five-step harness — carrier, remote filesystem reads, a driver turn,
session persistence, and resume — which you run against a host you control. It also has a quick mode
that reads a fixture without making model calls:

```bash
cd remote-connections
npm test          # unit tests over fake subprocesses; no model calls, no host needed
node verify.mjs --quick
```

## Limits

Worth stating plainly, because "one GUI, two machines" invites the assumption of full parity:

- remote input is **text-only** — attachments and conversation forks are rejected explicitly;
- steering applies on the next remote prompt, not mid-turn;
- an unexpected interactive permission request from the remote is cancelled (no approval forwarding
  UI yet); the remote's own preset governs pre-authorized tools;
- ACP delivers semantic chunks, not provider token deltas;
- native plans, terminals and other features without an ACP mapping are not implemented.

MCP servers are network endpoints: a host that cannot reach one simply contributes no tools from it,
and does not fail to start. Reachability is a property of the host, not of this configuration.

## Layout

| Path | Role |
| --- | --- |
| `bin/dsh-remote-carrier.mjs` | The carrier: spawns ssh, injects the remote key through the environment (never argv), rewrites session `cwd` when asked, honours `-p`/`-i`, syncs shared config, then `exec`s the runtime. |
| `bin/dsh-sync-config` | Manual/forced form of that sync, with `--dry-run`, `--with-tokens` and `--json`. |
| `plugin/` | The ACP driver: hybrid factory routing, prompts and steering, resume, and the local session log. |
| `remote-fs/` | The filesystem decorator and its ssh transport (stat, listDir, bounded byte reads). |
| `servers/` | The connection/workspace registry, the readiness probe, and the remote directory browser. |
| `config-sync/` | Builds the hash-gated sync script. |
| `portable/mcp-servers.patch.yml` | The MCP server template. |
| `docs/milestone-2-design.md` | How the design was reached, including the invariants and the false leads. |
| `docs/client-plugin-build.md` | Building a DSH client plugin, and the traps the browser exposes. |

## Licence

The upstream project is MIT (`Copyright (c) 2026 DeepSeek`); this fork keeps that licence and adds
these files under the same terms.
