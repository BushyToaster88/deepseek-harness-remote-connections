/**
 * Host Remote owner for the bridge's connection registry.
 *
 * Two nouns travel over this namespace, matching the registry's own split:
 *
 *   - a **connection** is an ssh-reachable host (Settings → Remote manages these)
 *   - a **workspace** is one directory on one connection, discovered by browsing that host
 *     (`listRemoteDirectory`) and exposed as a local anchor (`addWorkspace`)
 *
 * The browser cannot register either by itself: the registry is a Host service, and the GUI
 * must not gain an unauthenticated HTTP surface for it (a plugin-registered webserver route
 * sits outside the connection's cookie fence and would be CSRF-reachable). So this controller
 * carries the wire verbs over the authenticated Remote channel.
 *
 * A connection is test-then-register: it is only recorded once its host has answered the same
 * readiness check the carrier performs, so a typo cannot leave a dead entry behind. Changes
 * take effect immediately — the driver and the filesystem decorator both resolve the registry
 * per call — and the complete configuration is written back into the active profile's patch
 * through the config editor before a mutation succeeds. Unavailable persistence rejects the
 * mutation; write failures restore the prior runtime configuration so the caller can retry.
 *
 * Module-level helpers rather than private methods: a Cordis service is reached through a
 * proxy, and any method touching a `#private` member throws "Receiver must be an instance of
 * class" when the wire invokes it. Every `@Remote` verb is spelled identically to its method
 * name, because the gateway resolves the method by that name.
 */
import { Context, symbols } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  RemoteConnectionDescription,
  RemoteConnectionDraft,
  RemoteDirectoryListing,
  RemoteDirectoryRequest,
  RemoteServerRemoveValue,
  RemoteServerTestValue,
  RemoteWorkspaceDescription,
  RemoteWorkspaceRequest,
} from './types.ts'

export type * from './types.ts'

/** One connection row, as the bridge's `dsh-remote-servers` plugin exposes it. */
export interface RemoteConnectionEntry {
  readonly name: string
  readonly host: string
  readonly port?: string
  readonly identityFile?: string
  readonly remoteRoot?: string
  readonly carrier?: string
  readonly sshConfig?: string
}

/** One workspace row, as that plugin exposes it. */
export interface RemoteWorkspaceEntry {
  readonly name: string
  readonly connection: string
  readonly remoteDir: string
  readonly anchor: string
}

/** The Loader entry a plugin was composed from; only its identity is used here. */
export interface RemoteLoaderEntry {
  readonly id?: string
}

/** One connection as the registry persists it. */
export interface RemoteConnectionConfig {
  readonly host: string
  readonly port?: string
  readonly identityFile?: string
  readonly remoteRoot?: string
  readonly carrier?: string
  readonly sshConfig?: string
}

/** One workspace as the registry persists it. */
export interface RemoteWorkspaceConfig {
  readonly connection: string
  readonly remoteDir: string
}

/** The configuration the registry writes back to the profile patch. */
export interface RemoteRegistryConfig {
  readonly anchorRoot: string
  readonly carrier?: string
  readonly servers: Record<string, RemoteConnectionConfig>
  readonly workspaces: Record<string, RemoteWorkspaceConfig>
}

/** The structural slice of the bridge registry this controller drives. */
export interface RemoteServerRegistry {
  /** The Loader entry the registry plugin was composed from. */
  readonly ownerEntry: RemoteLoaderEntry | undefined
  list(): readonly RemoteConnectionEntry[]
  listWorkspaces(): readonly RemoteWorkspaceEntry[]
  addServer(input: RemoteConnectionDraft): RemoteConnectionEntry
  removeServer(name: string): boolean
  addWorkspace(input: RemoteWorkspaceRequest): RemoteWorkspaceEntry
  listRemoteDirectory(input: RemoteDirectoryRequest): Promise<RemoteDirectoryListing>
  testServer(input: RemoteConnectionDraft): Promise<RemoteServerTestValue>
  configFor(): RemoteRegistryConfig
  /**
   * Restore a prior configFor snapshot after a failed profile edit; anchor directories remain.
   * @param config - the detached snapshot captured before the edit.
   */
  restoreConfig(config: RemoteRegistryConfig): void
}

/** The optional profile-patch writer, owned by the config editor plugin. */
interface ConfigEditorLike {
  edit(
    entry: RemoteLoaderEntry,
    change: (
      current: RemoteRegistryConfig,
      inherited: RemoteRegistryConfig,
    ) => RemoteRegistryConfig,
  ): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host connection registry, owned by the bridge's servers plugin. */
    remoteServers: RemoteServerRegistry
    /** Host Remote namespace owner for that registry. */
    remoteServersController: RemoteServersController
  }
}

/**
 * Project a connection row onto its wire description.
 * @param entry - one registry row.
 * @returns its wire description.
 */
function toConnection(entry: RemoteConnectionEntry): RemoteConnectionDescription {
  return {
    name: entry.name,
    host: entry.host,
    ...(entry.port === undefined ? {} : { port: entry.port }),
    ...(entry.identityFile === undefined ? {} : { identityFile: entry.identityFile }),
    ...(entry.remoteRoot === undefined ? {} : { remoteRoot: entry.remoteRoot }),
    ...(entry.sshConfig === undefined ? {} : { sshConfig: entry.sshConfig }),
  }
}

/**
 * Project a workspace row onto its wire description.
 * @param entry - one registry row.
 * @returns its wire description.
 */
function toWorkspace(entry: RemoteWorkspaceEntry): RemoteWorkspaceDescription {
  return {
    name: entry.name,
    connection: entry.connection,
    remoteDir: entry.remoteDir,
    anchor: entry.anchor,
  }
}

/**
 * Reject an obviously incomplete connection draft. The registry owns the strict validation
 * (it is the side that quotes values into a remote shell).
 * @param draft - the caller's payload.
 */
function requireDraft(draft: RemoteConnectionDraft): void {
  if (draft === null || typeof draft !== 'object') {
    throw new Error('a connection description is required')
  }
  for (const field of ['name', 'host'] as const) {
    if (typeof draft[field] !== 'string' || draft[field].trim() === '') {
      throw new Error(`${field} is required`)
    }
  }
}

/**
 * One-line failure text for a thrown value.
 * @param error - the thrown value.
 * @returns its message.
 */
function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const mutationQueues = new WeakMap<Context, Promise<void>>()

/**
 * Apply one runtime edit and save its detached configuration before reporting success.
 * Profile reconciliation can replace both services, so the queue belongs to the root and
 * each operation resolves the current registry only after the preceding write settles.
 * @param ctx - Host context carrying the registry and profile editor.
 * @param change - synchronous registry mutation and its resulting wire value.
 * @returns the mutation result after the profile write completes.
 */
function editRegistry<T>(ctx: Context, change: (registry: RemoteServerRegistry) => T): Promise<T> {
  const pending = (mutationQueues.get(ctx.root) ?? Promise.resolve()).then(async () => {
    // A queued call may have come through the controller that the previous edit unloaded.
    const registry = ctx.get('remoteServers')
    const editor = ctx.get('configEditor') as ConfigEditorLike | undefined
    if (registry === undefined || registry.ownerEntry === undefined || editor === undefined) {
      throw new RemoteError('gateway/internal',
        'Remote connections cannot be saved: the active profile configuration editor is unavailable.', {})
    }
    const entry = registry.ownerEntry
    const before = registry.configFor()
    let result: T
    try {
      result = change(registry)
    } catch (error) {
      throw new RemoteError('remote-servers/invalid', explain(error), {}, { cause: error })
    }
    // ConfigEditor reconciles saved profile patches before invoking this callback.
    const requested = registry.configFor()
    try {
      await editor.edit(entry, () => requested)
    } catch (error) {
      const active = ctx.get('remoteServers')
      const original: unknown = Reflect.get(registry, symbols.original) ?? registry
      if (active !== undefined && (Reflect.get(active, symbols.original) ?? active) === original) {
        registry.restoreConfig(before)
      }
      throw new RemoteError('gateway/internal',
        `Remote changes could not be saved to the profile. Retry after fixing the save error: ${explain(error)}`,
        {}, { cause: error })
    }
    return result
  })
  // A rejected edit must not prevent the next retry from entering the queue.
  mutationQueues.set(ctx.root, pending.then(() => {}, () => {}))
  return pending
}

/** Host service backing the generated `ctx.remote.remoteServers` namespace. */
export class RemoteServersController extends TypertRemoteService {
  static inject = ['remoteServers']

  /** @param ctx - Host context carrying the bridge's connection registry. */
  constructor(ctx: Context) {
    super(ctx, 'remoteServersController', { namespace: 'remoteServers' })
  }

  /**
   * Every configured connection.
   * @returns the registered connections.
   */
  @Remote('list')
  async list(): Promise<RemoteConnectionDescription[]> {
    return this.ctx.remoteServers.list().map(toConnection)
  }

  /**
   * Every remote workspace known to the registry (hand-written ones included).
   * @returns the registered workspaces.
   */
  @Remote('listWorkspaces')
  async listWorkspaces(): Promise<RemoteWorkspaceDescription[]> {
    return this.ctx.remoteServers.listWorkspaces().map(toWorkspace)
  }

  /**
   * Check one candidate connection without changing anything, locally or remotely.
   * @param draft - host, and optional starting directory / key file / ssh config.
   * @returns whether it is ready, with one line of explanation.
   */
  @Remote('test')
  async test(draft: RemoteConnectionDraft): Promise<RemoteServerTestValue> {
    try {
      requireDraft(draft)
    } catch (error) {
      throw new RemoteError('remote-servers/invalid', explain(error), { field: 'name' }, { cause: error })
    }
    return await this.ctx.remoteServers.testServer(draft)
  }

  /**
   * Test, then register and persist a connection. A connection is a host: the workspace's
   * directory is chosen later, by browsing.
   * @param draft - the connection to add.
   * @returns the registered connection after the profile write succeeds.
   */
  @Remote('add')
  async add(draft: RemoteConnectionDraft): Promise<RemoteConnectionDescription> {
    const probe = await this.test(draft)
    if (!probe.ok) {
      throw new RemoteError('remote-servers/unreachable', probe.detail, { host: String(draft.host) })
    }
    return await editRegistry(this.ctx, registry => toConnection(registry.addServer(draft)))
  }

  /**
   * Unregister one connection. Its workspaces go with it; their anchor directories stay on
   * disk, because unregistering is not a delete.
   * @param name - the connection key to drop.
   * @returns whether a connection was removed after the profile write succeeds.
   */
  @Remote('removeServer')
  async removeServer(name: string): Promise<RemoteServerRemoveValue> {
    return await editRegistry(this.ctx, registry => ({ removed: registry.removeServer(name) }))
  }

  /**
   * List one directory level on a connection, for the workspace browser.
   * @param request - connection name and the directory to list (absent: the remote home).
   * @returns the level's path, parent, and subdirectories.
   */
  @Remote('listRemoteDirectory')
  async listRemoteDirectory(request: RemoteDirectoryRequest): Promise<RemoteDirectoryListing> {
    try {
      return await this.ctx.remoteServers.listRemoteDirectory(request)
    } catch (error) {
      throw new RemoteError(
        'remote-servers/unreadable',
        explain(error),
        { connection: String(request?.connection ?? ''), path: String(request?.path ?? '~') },
        { cause: error },
      )
    }
  }

  /**
   * Expose one directory on one connection as a workspace: the registry creates its anchor
   * (or returns the existing one) and the caller adopts that path.
   * @param request - connection name and the chosen absolute remote directory.
   * @returns the durably registered workspace, including the anchor path.
   */
  @Remote('addWorkspace')
  async addWorkspace(request: RemoteWorkspaceRequest): Promise<RemoteWorkspaceDescription> {
    return await editRegistry(this.ctx, registry => toWorkspace(registry.addWorkspace(request)))
  }
}

export default RemoteServersController
