/**
 * Remote workspaces: the connection list in Settings, and the Add-workspace flow that picks
 * from it.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the SlotMap merge declaring `settings.section`.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `remote` service merge (ctx.remote.$mount).
import type {} from '@deepseek-ai/dsh-api-gateway/client'
// The generated namespace contribution this plugin mounts for itself.
import remoteServersRemote from '@deepseek-ai/dsh-api-remote-servers/remote'
import type { RemoteConnectionSummary, RemoteDirectoryListing } from './types.ts'
import type { RemoteConnectionsInjected } from './RemoteConnections.tsx'
import { RemoteConnections } from './RemoteConnections.tsx'
import type { RemoteWorkspaceFlowInjected } from './RemoteWorkspaceFlow.tsx'
import { RemoteWorkspaceFlow } from './RemoteWorkspaceFlow.tsx'

/**
 * Required services (cordis fiber inject): the slot registry, the workspace UI service whose
 * listing primitives the local branch drives, and the typed Remote assembly the namespace is
 * mounted on.
 *
 * `remote.remoteServers` is deliberately *not* here: this plugin provides that namespace, so
 * a fiber-level dependency on it could never be satisfied — both surfaces register from a
 * scope that declares it instead (see below).
 */
export const inject = ['slots', 'uiWorkspace', 'remote']

/**
 * Client plugin body: a Remote page in Settings, and the Local-vs-Remote Add-workspace flow.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // The effect owns setup and teardown even when unloading starts before the mount settles.
  // Keep apply synchronous; namespace consumers await readiness below.
  const namespace = ctx.effect(async () => {
    try {
      return await ctx.remote.$mount(remoteServersRemote)
    } catch (error) {
      console.error('ui-remote-workspaces: could not mount the remoteServers namespace', error)
      throw error
    }
  }, 'ui-remote-workspaces: remoteServers namespace')

  // The Remote assembly gates namespace access on the *caller's* inject list ("cannot get
  // property remote.remoteServers without inject"), so both surfaces register from a scope
  // that declares the namespace this plugin just mounted. The key is the assembly's own:
  // `remoteServiceKey(namespace)` is `remote.<namespace>`.
  ctx.inject(['remote.remoteServers'], (scoped) => {
    const listServers = async (): Promise<RemoteConnectionSummary[]> => {
      await namespace
      const result = await scoped.remote.remoteServers.list()
      if (!result.ok) throw new Error(result.error.message)
      return result.value.map((connection) => ({
        name: connection.name,
        host: connection.host,
        ...(connection.port === undefined ? {} : { port: connection.port }),
        ...(connection.identityFile === undefined ? {} : { identityFile: connection.identityFile }),
        ...(connection.remoteRoot === undefined ? {} : { remoteRoot: connection.remoteRoot }),
        ...(connection.sshConfig === undefined ? {} : { sshConfig: connection.sshConfig }),
      }))
    }

    const connections = (): RemoteConnectionsInjected => ({
      listServers,
      testServer: async (draft) => {
        await namespace
        const result = await scoped.remote.remoteServers.test(draft)
        // The Remote face folds carrier failures into the error branch; only assembly
        // faults still reject.
        return result.ok
          ? { ok: result.value.ok, detail: result.value.detail }
          : { ok: false, detail: result.error.message }
      },
      addServer: async (draft) => {
        await namespace
        const result = await scoped.remote.remoteServers.add(draft)
        if (!result.ok) throw new Error(result.error.message)
        const { name, warning } = result.value
        return warning === undefined ? { name } : { name, warning }
      },
      removeServer: async (name) => {
        await namespace
        const result = await scoped.remote.remoteServers.removeServer(name)
        if (!result.ok) throw new Error(result.error.message)
        return result.value.removed
      },
    })

    const flow = (): RemoteWorkspaceFlowInjected => ({
      // The browse backend's listing primitives, the same calls the shipped picker makes.
      listLocal: (path) => scoped.uiWorkspace.listDirectory(path),
      listConnections: listServers,
      listRemote: async (connection, path): Promise<RemoteDirectoryListing> => {
        await namespace
        const result = await scoped.remote.remoteServers.listRemoteDirectory({
          connection,
          ...(path === undefined ? {} : { path }),
        })
        if (!result.ok) throw new Error(result.error.message)
        return {
          path: result.value.path,
          ...(result.value.parent === undefined ? {} : { parent: result.value.parent }),
          entries: result.value.entries.map((entry) => ({ name: entry.name, path: entry.path })),
        }
      },
      useRemoteDirectory: async (connection, remoteDir) => {
        await namespace
        const result = await scoped.remote.remoteServers.addWorkspace({ connection, remoteDir })
        if (!result.ok) throw new Error(result.error.message)
        return result.value.anchor
      },
    })

    scoped.slots.inject('settings.section', () =>
      scoped.slots.register(
        {
          name: 'settings.section',
          id: 'remote',
          order: 40,
          label: () => 'Remote',
          inject: connections,
        },
        RemoteConnections,
      ))

    scoped.slots.inject('conversation.hero.workspace.directoryFlow', () =>
      scoped.slots.inject('sidebar.workspaces.directoryFlow', function* () {
        yield scoped.slots.register(
          { name: 'conversation.hero.workspace.directoryFlow', inject: flow },
          RemoteWorkspaceFlow,
        )
        yield scoped.slots.register(
          { name: 'sidebar.workspaces.directoryFlow', inject: flow },
          RemoteWorkspaceFlow,
        )
      }))
  })
}
