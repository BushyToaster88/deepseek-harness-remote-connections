# Milestone 2/3 design note — from delegation to attach

Status: milestone 1 complete and verified; the delegation route works today; attach (a live
remote session rendered in the local GUI) is designed here but not yet built.

## What is already proven

| Capability | Evidence |
|---|---|
| Carrier: local process → ssh → remote DSH, no listening ports | SDK + ACP probes, and `bin/dsh-remote-carrier --version` returning the remote version |
| Remote agent executes tools remotely | SDK answer and ACP `bash` tool call, both returning `Linux 6.8.0-137-generic` |
| Streaming | ACP `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` |
| Session list / resume / close | `session/list` (9 sessions), `session/close`, and a resume across a runtime restart returning `4173` |
| Local cwd → remote workspace | carrier rewrites `cwd`; without it every tool call fails and `session/list` matches nothing |
| Model + reasoning selection | advertised by `newSession` as ACP config options |
| Delegation from a real DSH session | `subagent_abyss` called from `remote-headless`; remote kernel returned |

Remote coordinates: DSH `0.1.7-alpha.2` at `~/.local/share/dsh-bridge`, workspace
`~/dsh-workspace`, key at `~/.dsh/deepseek-api-key` (0600), sessions under
`~/.dsh/sessions/--home-HOST-dsh-workspace--/`.

## Option A — delegation (implemented, zero bridge code)

`dsh-subagent-acp` + `dsh-tool-subagent` rows point at the carrier. The local agent hands a task
to the remote agent and gets its final answer.

- **Pros**: works now; no new code; remote tools and model are genuinely remote; the remote's own
  sandbox and permission preset apply; failures are reported honestly.
- **Cons**: this is delegation, not attach. The child's intermediate messages and tool traffic
  stay out of the parent conversation by design, so there is no live remote session in the GUI and
  no session resume from the GUI. `permission: allow|reject` is a policy, not a prompt to a human.

Use it for: "run this on the production box and tell me the result".

## Option B — attach via an ACP-backed agent driver (the real target)

`dsh-agent` provides `ctx.agents`, whose `create()`/`resume()` "delegate to the registered
factory"; the shipped driver is `dsh-agent-loop`. An out-of-tree plugin could register a driver
whose agents are backed by the remote ACP session, which is what the GUI's session controller
already calls. Then the existing browser client renders remote sessions with its normal
components.

Interface obligations to satisfy, in order of difficulty:

1. **Agent lifecycle** — `create`/`resume`/`get`/`list`, `AgentHandle` ownership, `whenIdle`,
   cancel. Mostly mechanical against `session/new`, `session/resume`, `session/close`, `cancel`.
2. **Durable session events** — the session controller serves history and live frames as
   `SessionWireEvent` records, and the Client validates them before rendering. The driver must
   translate ACP `session/update` payloads into that event vocabulary, including tool calls and
   results, and keep `seq` continuity. This is the substantive work.
3. **Projections** — the GUI reads registered projection keys (inbox, todos, plan, title, token
   meter). Remote sessions have no local source for these; each needs either a mapping or an
   explicit "unavailable" path.
4. **Presenters** — tool results are rendered through per-tool presenters. Remote tool names
   (`bash`, `read`, `write`) match local ones, so this is likely the easiest layer.
5. **Fetch routes** — file previews and workspace browsing are exact Fetch routes registered
   against the *local* filesystem. Remote bytes need forwarding or a remote-aware provider.
   Note the local `openWorkspacePath` refuses unmapped remote paths by design.

Open questions to settle before coding:

- Does a second driver coexist with `dsh-agent-loop`, or does the factory slot accept only one?
  (If one, the `remote` profile must not compose the default loop, which may break other UI.)
- Does the Client's event validation accept a driver-authored event stream that never went through
  the local loop, in particular `assistant/message` with provider metadata and `request/header`?
- Should remote sessions be distinguishable in the session list, and can a session id collision
  between hosts happen? (Remote ACP ids are UUIDs; local SDK ids are `session-<hex>`.)

### Driver swap mechanics (verified)

The first question is answered, and the answer shapes the whole option:

- The factory slot is **single-occupancy**. `dsh-agent` documents that registering a factory
  "Throws if a factory is already registered", and the slot is registered via `setFactory`.
- A profile can therefore express the swap by disabling the shipped row and mounting an ACP driver
  in its place. The patch mechanism was verified with a throwaway overlay:

  ```yaml
  - id: agent-loop
    disabled: true
  ```

  Booting with that overlay fails exactly as designed — `dsh: no agent factory registered (load an
  agent-loop plugin)` — and the same profile without the overlay still answers normally, so the
  syntax is right and nothing was left broken.
- **Consequence**: in the `remote` profile *every* agent becomes remote. The local model route and
  the local `agent-loop` go unused there, which is consistent with the decision that the remote
  host supplies its own model access. It also means the driver, not the loop, owns turn/step
  orchestration, cancellation, inbox semantics and the durable event stream the GUI validates.


## Option C — client-side remote surface

A new client plugin that talks to the carrier directly and renders its own remote-session view,
bypassing the session controller. Lower risk, less integration, but it duplicates chat/tool
rendering and gets none of the existing components for free.

## Recommendation

Ship A now (done), then attempt B in a spike *before* committing to it: register a minimal ACP
driver, mount it in the `remote` profile, and see whether one remote session renders in the GUI
with streaming text and a tool call. If B stalls on events or projections, fall back to C, which
can reuse the same carrier and ACP client.

### Feasibility of B: yes, with bounded obligations

The blocking question was whether an out-of-tree driver can author the durable log the GUI
renders. It can — `dsh-session` exposes this publicly:

- `session.append(type, data, opts?)` "commits one typed event — it snapshots and freezes the
  payload, validates it as lossless JSON, and notifies observers", and surface events
  (`system/message`, `developer/message`, `user/message`, `assistant/message`, `tool/result`)
  take a required `surfaceOp`.
- `ctx.sessions.flush(session)` is the awaited durability barrier, so a driver can commit and
  flush without assuming a write-behind drain.
- `ctx.sessions.registerMessageProjection()` lets a plugin own content-changing events, which is
  how projections the GUI reads can be supplied rather than inherited.

Concrete obligations this leaves, none of them open-ended:

1. Synthesize the compact timed provider stream that `assistant/message` must embed (ACP delivers
   ordered chunks, so this is a mapping, not a reconstruction).
2. Supply the embedded assistant provider metadata and the request-header behaviour the Client's
   journal validates; a driver that never calls a local model still has to present a coherent
   envelope.
3. Decide, per projection the GUI reads, whether to map it or report it unavailable.

So B is a real but bounded piece of work, and the fallback C reuses the same carrier and ACP client.

### Seam proof (verified)

The riskiest assumption — that an out-of-tree plugin can take over agent creation at all — is now
verified against a running harness. `dsh-remote/plugin/` holds a stub driver that occupies the
factory slot and refuses every call, mounted via `dsh-remote/driver-stub.patch.yml`:

```
[remote-acp-driver] factory registered
[remote-acp-driver] createAgent called:
  {"sessionId":"session-57c0410e-7a31-4955-a3ba-f652e5eae5da","hasAgentOptions":true,
   "parentAgent":null,"optionKeys":["sessionId","meta","agentOptions","setup"]}
dsh: remote-acp-driver: createAgent is not implemented yet — this plugin only proves the factory seam
```

So the profile boots with the loop disabled, our factory registers, and the harness delivers a real
`createAgent(ownerCtx, { sessionId, meta, agentOptions, setup })` call whose failure surfaces
cleanly with exit 1. Nothing simulated.

### Stage 1 verified: driver-authored sessions render

`dsh-remote/plugin/index.js` now implements the factory for real (echo stage): it creates a
session, registers an agent, and on a prompt authors `turn/start` → `assistant/message` (with a
synthesized compact provider stream) → `turn/end`, then flushes.

```
[remote-acp-driver] factory registered
[remote-acp-driver] createAgent sessionId=session-f2cf8790-e28b-4226-ae69-325ba77f9b99
[remote-acp-driver] agent session-f2cf8790-… registered
[remote-acp-driver] turn 1 committed
stdout: echo: hello driver          (exit 0)
```

No validation errors, no warnings: the session log accepted every event, the harness surfaced the
message, and the headless run returned it as the answer. So the shapes in the table above are
correct as written, and the make-or-break question for option B — *can a driver author the durable
record the GUI renders?* — is answered by working code.

Stage 2 replaces the echo with the remote path: drive the carrier's ACP session, map
`session/update` chunks into the same accumulator, map tool calls to `tool/call`/`tool/result`,
route `cancel` to ACP `cancel`, and close the remote session on dispose.

### Stage 2 verified: the local session IS the remote agent

`dsh-remote/plugin/index.js` now spawns the carrier, initializes ACP, opens a remote session, and
drives it. One turn, exit 0, six seconds start to finish:

```
[remote-acp-driver] registered → spawning remote runtime → initialized: protocol v1
[remote-acp-driver] remote session 0e8297d5-… (local session-15b8ba92-…)
[remote-acp-driver] tool call: bash [in_progress]
[remote-acp-driver] tool update: call_00_… -> completed
[remote-acp-driver] turn 1 remote stopReason=end_turn → committed locally
answer: Linux 6.8.0-137-generic          ← executed on HOST by the remote agent
```

And the durable local log for that session, read back with the debug flag:

```
local log (8 events): permission/preset, sandbox/mode, approval/policy,
                      turn/start, tool/call, tool/result, assistant/message, turn/end
```

So streaming text, tool calls and tool results all reach the local durable record in order, with the
surrounding plugins' policy events present — the session behaves like any other session.

Two operational notes found the hard way:

- **The carrier must not hold the host process open.** A spawned child with pipes keeps Node's event
  loop alive, so a one-shot run hung after printing its answer (exit 124). `unref()` on the child and
  its stdio, plus a bounded `closeSession` during teardown, turned that into a clean exit 0.
- **`ctx.sessions.create()` is memory-only.** Unless a persistence backend is engaged, nothing is
  written under `~/.dsh/sessions/`, which is where the GUI's session list reads stored headers. The
  shipped loop creates stored sessions; the driver does not yet, which is the next gap.

### The `remote` profile now runs the driver

`~/.dsh/profiles/remote/cordis.patch.yml` disables `agent-loop` and mounts the driver, so that GUI's
agents *are* the remote agent:

```yaml
- id: agent-loop
  disabled: true
- insert:
    - id: remote-acp-driver
      name: dsh-remote-acp-driver
      config:
        command: …/dsh-remote/bin/dsh-remote-carrier
        args: ["--profile", "acp"]
```

It boots clean on port 3131 with no activation warnings. `remote-headless` carries the same rows, so
the identical configuration can be exercised from a script.

### Stage 3 verified: sessions persist and are listable

`ctx.sessions.create()` alone is memory-only, so the driver now binds the same store the shipped loop
does, and — this is the subtle part — flushes the **pre-publication prefix before any live append**:

```js
const persistence = ctx.get('sessionPersistence')
const handle = await persistence.create(session.header, { inheritedEventCount: session.inheritedEventCount })
// then, before the first turn: append the prefix (policy records) and flush
```

Without that prefix flush the backend's own live writer rejects the first turn event with
`append seq mismatch … expected 0 at index 0, got 3`: the stored log must be contiguous from seq 0,
and the three policy events other plugins append during setup occupy seqs 0–2.

Two further details that matter:

- **Pass `meta` through to the session**, or the stored session lands under `_no-cwd` where the GUI
  cannot group it under a workspace. With `ctx.sessions.create(id, { meta: options.meta })` it stores
  under the workspace-keyed directory the session list reads.
- After the prefix is written, the backend's live writer persists later events by itself, so the
  driver must **not** append suffixes again — `ctx.sessions.flush(session)` is the durability barrier.

Verified: a driver turn now writes
`--home-connor-Documents-deepseek-harness-Default~0020workspace--/session-…/session.v4.jsonl.zstd`
containing the session header plus seqs 0–7 (`permission/preset`, `sandbox/mode`, `approval/policy`,
`turn/start`, `tool/call`, `tool/result`, `assistant/message`, `turn/end`), and the run still exits 0
with the remote answer.

Remaining for v1: **resume** (load the persisted local session and re-bind it to a remote ACP session,
which needs the remote session id durably associated with the local one) and **file previews**.
### Stage 4 verified: resume across processes

Resume mirrors the shipped loop's sequence — `persistence.open(id,'write')` → `handle.read(0)` →
`interruptedTurnClosers` → `ctx.sessions.prepare(id, { seed, meta, inheritedEventCount, eventState })`
— plus three things that only surfaced by testing:

1. **A prepared session must be published.** `prepare()` builds it but leaves it out of the live
   store, so `ctx.sessions.enter(session)` then `ctx.sessions.announce(session)` are required;
   without them every append fails with `session "…" is not live in this store`.
2. **The setup-window suffix needs an explicit write.** The creation dispatch appends events (the
   policy records) and the backend's live writer only picks up appends made after it attaches, so
   without a `storeSuffix()` right after `announce()` the stored log sits one event short and the
   next append fails a seq check (`expected 10 …, got 11`).
3. **The remote session is paired in a sidecar.** ACP generates its own session id and `session/new`
   accepts no client-chosen one, so the local→remote pairing is written to
   `$DSH_HOME/remote-acp-sessions.json`. On resume the driver calls ACP `session/resume` with it, and
   falls back to a fresh remote session if that fails (for example when the remote session is still
   active, which ACP refuses).

Also fixed by testing: per-turn events need `step/start`/`step/end` around the step's events, and the
claimed prompt must be logged as a `user/message` surface event. The step omission was invisible at
append time and only appeared on **read-back** as
`SessionFormatError: assistant/message does not match an open turn and step` — append validation and
restore validation are not the same gate.

Verified across three processes: process A created the session and taught the remote agent `4173`;
process B adopted the persisted local session (10 stored events), resumed the remote ACP session, and
the remote agent answered `4173`.

### Milestone 3 (files): transport verified, provider not yet mounted

File previews and workspace browsing do not go through the driver. The browser reads them through
`ctx.fs`, and `dsh-api-workspace-files` says so plainly: reads "use the backend's read authority",
and every answer "is derived from `ctx.fs` and the sandbox policy at call time". Serving remote files
therefore means providing `ctx.fs` in that profile.

Three routes, in descending order of blast radius:

1. **`dsh-fs-ssh` + `dsh-ssh`** — the shipped answer, and the right long-term one. It needs the helper
   installed on the remote host, which is a mutating step on a production box and needs explicit
   approval before it can be attempted.
2. **A bridge-owned provider** — implement the `FileSystem` seam over this bridge's own ssh transport
   (`remote-fs/`). It replaces `ctx.fs` in that profile, so local-only consumers (attachments, skills,
   AGENTS.md, deliverables) degrade unless the provider *delegates* local paths to `node:fs`. That
   delegation is the intended shape: remote for workspace paths, local for everything else.
3. **Mount the remote workspace locally** (sshfs) so the existing local provider serves it — no code,
   but a system-level mount plus a local path mirroring the remote one.

The transport is written and verified. `remote-fs/ssh-fs.js` implements read-only `stat`, `listDir`,
`readBytes` and `readByteRange` over the same ssh path the carrier uses, and
`remote-fs/selftest.mjs` exercises it against `HOST`: it creates one file inside the approved
workspace, reads it back three ways, refuses an over-cap read, and removes the fixture — PASS.

A bug the harness caught immediately: GNU `stat -c` does **not** interpret backslash escapes in its
format the way `find -printf` does, so a `\t` separator arrives literally and parses to `NaN-NaN`.
`stat` now uses a pipe separator; `find` keeps tabs.

Not yet done: the `FileSystem` subclass itself, and the decision about which profile mounts it.
Mounting in `remote` changes that GUI's file behaviour, so it should be a deliberate choice rather
than a side effect of the spike.

### Milestone 3 (files) — resolved: a read decorator, because the service is single-occupancy

A probe settled the design question empirically:

```
1. composed provider: SandboxedFileSystem                    (reachable as a delegate)
2. ctx.set('fs', …) refused: cannot set property "fs" in multiple fibers
3. constructing a FileSystem subclass threw:
   service "fs" has been registered at <SandboxedFileSystem>
```

So a second provider is impossible and "replace + delegate" is out. `remote-fs/` therefore
**decorates** the composed provider: it wraps `resolve`, `stat`, `lstat`, `listDir`, `readBytes`,
`readByteRange`, `readText`, `streamText`, `contains`, `processPath` and `fileUrl`, serving paths
under `localRoot` from `remoteRoot` over ssh and delegating every other path to the original method.
Writes, edits and watches are untouched — this previews remote files, it does not mirror them.

Two mistakes worth recording, both caught by running it rather than by reading types:

- **Minted targets need coherent execution-world coordinates.** Leaving `processPath` delegated made
  the session fail to start: `session header cwd must be an absolute path, got
  "remote:/home/HOST/dsh-workspace"` — the base provider handed back the opaque target key. Minted
  targets now report the local path (and its `file:` URL), matching what the bridge records as cwd.
- **Load-time calls and request-time calls behave differently.** A probe that ran during plugin load
  saw `resolve` return an *unminted* target and `listDir` fall through to the local directory, which
  looked like a broken decorator; the same calls made after boot — which is when the GUI actually
  reads files — were intercepted correctly. The lesson is about the measurement, not the decorator,
  but a probe that runs at the wrong time will happily report a false negative.

Verified post-boot through the real `ctx.fs` service, with a probe mounted beside the decorator:
`resolve` mints `remote:/home/HOST/dsh-workspace`, `listDir` returns the *remote* workspace's
`fs-probe-target.txt` (the local directory contains a different entry entirely, so this cannot be a
local read), `stat`/`readText`/`readBytes` return the remote file's metadata and content, and
`/etc/hostname` still reads locally. `HOST` was left clean, the fixture removed.

Side effect to know about: in the mounted profile, workspace-scoped lookups by *other* consumers
(agent skills, git discovery) also resolve through the mapping, so they read the remote host. That is
coherent for a profile whose agent is remote, but it is a behaviour change, not just an added route.

### The tool lifecycle is a format invariant, and getting it wrong corrupts sessions

Emitting `tool/call` + `tool/result` for the remote agent's tool activity looked reasonable and passed
every append-time check. It made the sessions **unreadable on restore**:

```
dsh: stored session "session-…" is corrupt: stored log is corrupt:
SessionFormatError: tool/call call_00_… has no advertised tool lifecycle
```

The reader enforces a strict lifecycle: an `assistant/message` whose content contains a `tool-call`
block *advertises* that call (`{name, arguments}`); a later `tool/call` must match the advertised
`name` and `arguments` **exactly** and inside an open step; `tool/result` must then answer that
lifecycle. A bare `tool/call` is invalid.

Consequences worth remembering:

- The failure is invisible at write time and only appears when something *reads* the log — so it shows
  up as broken resume or a corrupt-session error, long after the turn that caused it.
- The driver now gives each remote tool call its own step: close the open step, open a new one,
  `assistant/message` advertising the call, `tool/call` with identical name and arguments, then
  `tool/result` on completion; the final answer gets its own step. That mirrors what the shipped loop
  writes for a real tool-using turn.

### One-command verification

`dsh-remote/verify.mjs` exercises the whole chain in dependency order and prints PASS/FAIL with
evidence: carrier → remote fs reads → driver turn (remote `uname -sr`) → persistence → resume in a
second process. `--quick` stops after the fs step and makes no model calls. Current result:

```
PASS 1 carrier   PASS 2 remote fs   PASS 3 driver turn   PASS 4 persistence   PASS 5 resume
ALL PASS (5 steps)
```

It also fails honestly: the run that first exposed the fixture bug (`printf '%s'` writing a literal
`\n`) reported FAIL with the bytes it actually read, which is how the test bug was caught rather than
being papered over.


### Verification status, and what is still unproven

Everything below the browser is verified. Attempting the browser's own wire by hand got partway and
is worth recording so the next attempt starts from the facts:

- The launch-token exchange works exactly as documented: `GET /?token=…` answers `303` and installs
  the signed cookie.
- Unary RPC uses a JSON envelope `{ type: 'client-request', rpcId, method, payload }`, and the
  endpoint grammar is `<namespace>/<method>` — `workspace-files` is composed in the profile and its
  generated name is `workspaceFiles/list`.
- Posting that envelope by hand answers `not found` rather than `401`, so the cookie is accepted and
  the request reaches routing — but the route/envelope the bridge actually accepts is built by the
  generated client, not by the literal strings alone. A faithful check needs the real client face
  (the repo's "whole-client test tier" composes one in Node) rather than more curl guessing.

So the remaining unproven step is precisely the browser's transport hop and its rendering, not the
driver, the filesystem mapping, persistence, or resume — each of which was exercised through the
real services.






### What the real driver must implement

`AgentFactory` is small; the `Agent` it must return is not. The interface is assembled by
**declaration merging** across packages (`dsh-agent/lib/types/runtime-types.d.ts` and others), so
read the augmentations rather than one file. From `dsh-agent` alone:

| Member | Obligation |
|---|---|
| `id`, `options`, `session`, `ctx` | identity, route, the live session whose log is the source of truth, agent-scoped context |
| `inbox` | `nextTurn`/`nextStep` lists with `append`/`prepend`/`replace`/`remove`/`clear`/`splice` |
| `status` | `idle`/`running`, mirrored on every `agent/status` transition |
| `send(message, target, wakeup)` | durable inbox routing, with wake semantics |
| `followup(message)` | queue and wake a turn |
| `steer`/`inject` | step-boundary delivery |
| `cancel(cause, options?)` | first-cause-wins, `keepInbox`, cancel-convergence wake latch |
| `whenIdle()` | quiescence of the whole agent, not one message |
| `runMaintenance(task)` | non-turn maintenance from the true idle phase |

Recommended v1 scope: implement the path the GUI actually drives (create → prompt → stream →
cancel → dispose), appending durable events via `session.append`, and *refuse explicitly* for
semantics we do not yet honour rather than silently degrading them. Cancellation convergence and
maintenance ownership are the two places where a half-implementation would corrupt state, so they
should refuse first and be implemented deliberately.

### Implementation map (all of it public — verified)

Every API the driver needs is on a public surface; none of the loop's internal helpers
(`SessionPreparation`, `createStoredSession`, `setupAndPublish`, ownership tracking) are required.

| Need | Public API | Verified shape |
|---|---|---|
| take the slot | `ctx.effect(() => ctx.agents.setFactory(factory), label)` | throws if occupied |
| factory | `createAgent(ownerCtx, options)` / `resume(ownerCtx, options)` | `options` = `{ sessionId, meta, agentOptions, setup, signal?, parentAgent?, seed? }` |
| create the session | `ctx.sessions.create(id, options?)`, or `prepare()` | in-memory unless a persistence backend is composed |
| register + announce | `await ctx.agents.register(agent)` | internally `enter(agent, undefined)` then `announce(agent, 'startup')`; returns an awaitable disposer |
| turn boundaries | `session.append('turn/start', { turn })`, `session.append('turn/end', { turn, reason })` | `TurnEndReason` member still to confirm |
| assistant message | `session.append('assistant/message', { turn, step, message, stream }, { surfaceOp: 'append' })` | surface events require `surfaceOp` |
| the message | `createAssistantMessage({ content, source })` from `dsh-llm` | caller supplies everything except `id`/`role`/`source.kind` |
| the required stream | `new AssistantStreamAccumulator()` → `push({ time, chunk })` → `snapshot()` | "detached immutable record list suitable for a durable event" |
| durability | `await ctx.sessions.flush(session)` | awaited checkpoint across persistence listeners |

Sketch:

```js
const session = ctx.sessions.create(options.sessionId)
const agent = { id: session.id, options: options.agentOptions ?? {}, session, ctx, inbox, status: 'idle', ... }
const disposeRegistration = await ctx.agents.register(agent)   // enter + announce

// on a prompt:
const accumulator = new AssistantStreamAccumulator()
session.append('turn/start', { turn })
for (const chunk of remoteChunks) accumulator.push({ time, chunk })
session.append('assistant/message', {
  turn, step,
  message: createAssistantMessage({ content, source: { provider, model } }),
  stream: accumulator.snapshot(),
}, { surfaceOp: 'append' })
session.append('turn/end', { turn, reason: 'completed' })
await ctx.sessions.flush(session)
```

Open items for the implementation round: the exact `TurnEndReason` member for a normal completion;
the correct agent-scoped context for `agent.ctx` (`register` does not hand one back, and the loop
builds its own); and how much persistence to compose so `resume` can work rather than refuse.


The `remote` profile (web, port 3131) and `remote-headless` are deliberately separate from the
live `web` profile.
