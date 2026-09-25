# Remote workspace API

Authenticated Host Remote namespace for the external `dsh-remote-servers` registry.
It lists/tests connections, saves connection changes, browses remote directories and
registers workspace anchors. It adds no HTTP endpoint or credentials to the client.

Compose the registry, profile ConfigEditor and this package. The browser plugin mounts
the generated `./remote` contribution. GUI mutations require durable profile storage;
failed saves reject and restore the active registry for retry. Mutations serialize across
registry reloads, using a detached configuration snapshot.

Build from the workspace root:

```bash
pnpm exec tsc -b packages/api/remote-servers
pnpm --dir packages/api/remote-servers exec tsdown
pnpm exec vitest run packages/api/remote-servers/tests/controller.host.spec.ts
```

The package build scopes FaceModel generation to this namespace. Rebuild its codecs before
the UI when changing wire declarations. Never add fake `./typert` artifacts to unrelated
packages to work around generator validation. Controller tests exercise actual profile
writes and restart persistence, rollback, service replacement and concurrent edits.
