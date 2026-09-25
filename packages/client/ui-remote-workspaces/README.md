# Remote workspace UI

Settings → Remote manages SSH connections. The sidebar and conversation workspace flows
offer local folders and remote directories using the host registry. Each flow owns a
primitive Modal and reports exactly one owner outcome per open.

Compose `dsh-remote-servers`, `@deepseek-ai/dsh-api-remote-servers` and the browse directory
picker backend. Disable `directory-picker-auto` in this profile because its client flow
would occupy the same single-occupancy slots. Keep the built-in agent loop enabled and use
the external ACP driver's `mode: hybrid` to run local and remote sessions in one GUI.

The synchronous client `apply` mounts its Remote namespace inside an owned Cordis effect.
Slot props carry injected functions and types from the slot contracts. Reopening a flow
resets its state and ignores results from the previous open.

Build from the workspace root after building the API:

```bash
pnpm exec tsc -b packages/client/ui-remote-workspaces
pnpm --dir packages/client/ui-remote-workspaces exec tsdown
pnpm exec vitest run packages/client/ui-remote-workspaces/tests
```

Copy the built `lib/` and package manifest into the desired profile package directory.
Verify settings, local/remote browsing, cancel/reopen, light/dark themes and plugin
activation in that runtime. Source rc.2 uses nine theme tokens absent from alpha.2;
the current installed profile has an explicitly approved runtime token supplement.
