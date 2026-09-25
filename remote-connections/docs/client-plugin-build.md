# Building a client (browser) plugin for DSH

Notes from adding the Add-workspace flow. `docs/user/develop` covers host-side plugins only; a
browser plugin needs the source checkout and its bundler, which the npx install does not carry.

## Pick the source revision that matches the running app

```bash
node -e "console.log(require('<install>/node_modules/@deepseek-ai/dsh/package.json').version)"
```

The clone's `master` was `0.1.7-rc.2` while the running install was `0.1.7-alpha.2`. A client bundle
built from a newer revision is loaded into an older app, so a **release candidate's build is not a
safe drop-in**. Fetch tags and check out the matching one (`dsh-v0.1.7-alpha.2` exists) before
building anything that ships into that install.

## Package shape

A client plugin is a normal workspace package with a node half and a browser half:

```
packages/client/ui-<name>/
  package.json      # exports "." -> lib/index.js, "./client" -> lib/client.js,
                    # dsh.client.inject = client packages it extends, platform: "web"
  tsconfig.json     # extends tsconfig.base.client.json; references the packages it uses
  tsdown.config.ts  # clientBundle('@deepseek-ai/dsh-client-ui-<name>', ['lib/types/index.js'])
  src/index.ts      # node half: usually an empty apply
  src/client/index.ts
```

The browser half exports exactly `apply` and `inject`; the built artifact is a closure registered on
`window.__ModuleLoader__.load({ id, factory })`. UI attaches through typed **slots**:

```ts
export const inject = ['slots', 'uiWorkspace']
ctx.slots.inject('sidebar.workspaces.directoryFlow', () =>
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', function* () {
    yield ctx.slots.register({ name: 'sidebar.workspaces.directoryFlow', inject }, Component)
  }))
```

## Build

```bash
pnpm install
pnpm exec tsc -b packages/client/ui-<name>          # emits lib/types/*.js (the bundler's input)
pnpm --dir packages/client/ui-<name> exec tsdown    # emits lib/index.js + lib/client.js
```

`tsc` is not optional: tsdown bundles *from* `lib/types`, and skipping it fails with
`[UNRESOLVED_ENTRY] Cannot resolve entry module lib/types/index.js`.

Install into a profile by copying `lib/` and `package.json` into the profile's `node_modules` and
adding a row to the profile patch. The host then serves the bundle and the shell lists it in the
module table — verifiable without a browser by grepping the served index for the module id.

## Host→client calls without touching a core package

The shared client assembly (`@deepseek-ai/dsh-api-remotes`) imports every namespace artifact and
mounts it with `ctx.remote.$mount(...)`. Editing that assembly means shadowing a core package built
for a possibly different release. It is not necessary: **a client plugin can mount its own
namespace** with the same call, from its own package:

```ts
import contribution from '@deepseek-ai/dsh-api-remote-servers/remote'
export const inject = ['slots', 'uiWorkspace', 'remote']
export function apply(ctx) {
  ctx.effect(async () => await ctx.remote.$mount(contribution), 'remote namespace')
}
```

Generated `/remote` imports are explicitly inline-safe in the client bundler's purity gate
(`^@deepseek-ai/dsh-…/remote$`), so this needs no `dsh.client.external` entry. The browser bundle embeds the generated codecs, including Zod from the API package. Keep the
API package declared as a UI development dependency so that generated contribution resolves.

## Artifact generation (the typert FaceModel)

The new API package uses a scoped `WorkspaceTypertGenerator` build hook. It analyzes only
`@deepseek-ai/dsh-api-remote-servers` on the host face, emitting the Host and Remote client
artifacts. Its public `generate([packageName], ['host'])` API avoids the generic package-mode
plugin's validation of unrelated contributors.

Build the API before the UI, since the browser bundle embeds its generated codecs:

```bash
pnpm exec tsc -b packages/api/remote-servers
pnpm --dir packages/api/remote-servers exec tsdown
pnpm exec tsc -b packages/client/ui-remote-workspaces
pnpm --dir packages/client/ui-remote-workspaces exec tsdown
```

Do not add `./typert` exports to unrelated packages. The earlier 299 manifest edits declared
nonexistent artifacts and broke ordinary web boot; all were reverted. Do not hand-edit
generated codecs. Regenerate them whenever a wire declaration changes, and check that all
seven namespace methods are present in both generated contributions.

## Four traps the browser found that no host-side test could

Each of these was invisible in every host test and only appeared when the real GUI loaded the
plugin. They are worth reading before writing another client plugin.

1. **A namespace method name can be reserved.** `remove` collides with a member of the namespace
   service (`method in RemoteNamespaceService.prototype`), and the failure is at *mount* time, so
   the whole namespace is refused: `client api: method "remoteServers/remove" conflicts with its
   namespace service`. Renaming the verb is the only fix — and if the artifact is generated, the
   rename must land in **both** the contribution `id` and the bare `method:` field of every entry.
2. **Client plugins must activate synchronously.** An `async apply` never settles into the active
   state: `web boot: 1 entry did not activate`, which renders the **entire GUI** as a blank
   "Failed to load plugins" page. The one async `apply` in the tree is marked `immediately: true`.
   Start the work and keep `apply` sync; and never let a plugin's failure escape into the boot.
3. **Namespace access is gated by the dotted service key.** `ctx.remote.<namespace>` throws
   `cannot get property "remote.remoteServers" without inject` unless the *calling* context declares
   `remoteServiceKey(namespace)`, which is `` `remote.${namespace}` `` — the dotted form.
4. **A flow occupant gets no layout.** The owner measures the hole, not the dialog, so raw markup
   renders into a zero-sized container: the component is present in the DOM and clipped away, and
   clicks silently miss it. An occupant must own its surface (a centered modal over a backdrop).

## The directory-flow holes are single-occupancy

`directory-picker-auto` *loads* its backend and surface packages at runtime, so it cannot be
partially disabled: composing it pulls a client picker that occupies the same hole your flow wants
(`sidebar.workspaces.directoryFlow` is `kind: 'single'`). A profile that wants its own flow must
therefore disable that row and compose the backend directly
(`@deepseek-ai/dsh-host-directory-picker-browse`), which registers `ctx.directoryPicker` and pulls
no client surface. Local browsing then rides the same primitives the shipped picker uses:
`ctx.uiWorkspace.listDirectory(path)`.

## Verify in a browser before believing any of it

Playwright is already a dependency of `apps/web` and browsers are cached, so a script can drive the
real UI from the repository:

```
pnpm --dir apps/web exec node gui-clickthrough.mjs   # writes /tmp/clickthrough.png
```

Console errors from the page are the fastest signal: `page.on('console')` surfaced both the
namespace collision and the activation failure verbatim.


`sidebar.workspaces.directoryFlow` and `conversation.hero.workspace.directoryFlow` are `kind:
'single'` and are filled by whichever directory-picker client plugin the profile composes. The
occupant receives the owner contract and must report **exactly one outcome per open**:

```ts
interface DirectoryFlowOwnerProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void   // absolute path the owner adopts as the workspace
  onCancel: () => void
  onError: (message: string) => void
}
```

`ctx.uiWorkspace.pickDirectory()` opens the composed chooser as a single call, so a custom occupant
can keep offering the local path without reimplementing a directory browser. The picker packages
expose no extension holes of their own, so a "Local vs Remote" choice means occupying this slot.

## A `@Remote` verb and its method name must match

The gateway resolves a namespace method by the **class method name**, not by the decorator
argument. Declaring `@Remote('removeServer')` on a method called `remove` compiles, mounts, and
then fails at call time:

```
typert gateway: remoteServers/removeServer:
active Service "remoteServersController" has no callable method "removeServer"
```

Keep them identical.

## The FaceModel analyser cannot resolve `unknown`

A type that reaches the analysed declarations must have a real declaration:
`configFor(): Record<string, unknown>` and `ownerEntry: unknown` both abort generation with
`type symbol unknown has no declaration`. Give the registry slice concrete interfaces.

## Current regression commands

From the source checkout:

```bash
pnpm exec vitest run packages/api/remote-servers/tests/controller.host.spec.ts
pnpm exec vitest run packages/client/ui-remote-workspaces/tests
```

The controller tests include real Loader/ConfigEditor writes and restart persistence. UI tests
cover once-only outcomes, stale async responses, absolute local paths and namespace teardown.
The bridge's separate `npm test` suite covers actual local-agent/remote-driver composition with
fake ACP and SSH processes.

The source checkout is rc.2 while the installed GUI is alpha.2. The approved runtime theme
supplement supplies nine missing tokens; do not overwrite that installed theme accidentally.
Verify both light and dark appearance and ordinary plugin activation in the installed GUI.
