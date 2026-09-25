/**
 * remote-servers — connections, and the remote workspaces built from them.
 *
 * Two different things live here, deliberately:
 *
 *   - a **connection** is an ssh-reachable host running the same DSH build, plus how to reach
 *     it. It knows nothing about directories.
 *   - a **workspace** is one directory on one connection, exposed to the GUI as a local
 *     *anchor* directory (`<anchorRoot>/<name>`). The anchor path is what carries identity:
 *     the driver picks a session's carrier from its workspace's anchor, and the filesystem
 *     decorator maps that anchor onto the chosen remote directory.
 *
 * So the operator connects a host once in Settings, and every workspace names its own
 * directory by browsing that host when the workspace is created.
 *
 * A connection's optional `remoteRoot` is only a starting point for that browser, and is
 * adopted as a workspace at startup so a hand-written configuration keeps working.
 *
 * Config:
 *   anchorRoot: local directory holding one subdirectory per remote workspace
 *   carrier:    path to the ssh carrier (the driver's own configured command by default)
 *   servers:    connections, keyed by name: { host, remoteRoot?, carrier?, keyFile?, sshConfig? }
 *   workspaces: keyed by anchor name: { connection, remoteDir }
 */
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  probeServer,
  safeRemotePath,
  safePort,
  safeLocalPath,
  safeHost,
  listRemoteDirectories,
} from './ssh-probe.js'

export const name = 'remote-servers'

const log = (message) => process.stderr.write(`[remote-servers] ${message}\n`)

function safeName(value) {
  const name = String(value ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.length > 240) {
    throw new Error('name must be at most 240 characters, start with a letter or digit and use letters, digits, dot, dash or underscore only')
  }
  return name
}

function remoteDirectory(value, field) {
  const path = safeRemotePath(value, field)
  if (!path.startsWith('/')) throw new Error(`${field} must be an absolute path; use the directory browser to resolve $HOME`)
  return path.replace(/\/+$/, '') || '/'
}

/** Anchor name for one (connection, directory) pair: safe, readable, and stable. */
export function anchorName(connection, remoteDir) {
  const slug = String(remoteDir)
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug === '' ? connection : `${connection}-${slug}`
}

export class RemoteServers extends Service {
  static Config = z.object({
    anchorRoot: z.string().default(join(homedir(), 'dsh-remotes')),
    carrier: z.string(),
    servers: z
      .dict(
        z.object({
          host: z.string().required(),
          remoteRoot: z.string(),
          port: z.union([z.string(), z.number()]),
          identityFile: z.string(),
          carrier: z.string(),
          sshConfig: z.string(),
        }),
      )
      .default({}),
    workspaces: z
      .dict(z.object({ connection: z.string().required(), remoteDir: z.string().required() }))
      .default({}),
  })

  constructor(ctx, config) {
    super(ctx, 'remoteServers', config)
    // The Loader entry this plugin was composed from, so a config edit made from the GUI can
    // be persisted back into the active profile's patch.
    this.ownerEntry = ctx.fiber?.entry
    this.restoreConfig(config)
    // A connection that names a directory offers it as a workspace without a GUI round trip.
    for (const connection of this.connections) {
      if (connection.remoteRoot === undefined) continue
      if (this.workspaces.some((workspace) => workspace.connection === connection.name && workspace.remoteDir === connection.remoteRoot)) continue
      const name = this.workspaceName(connection.name, connection.remoteRoot)
      this.workspaces.push({
        name,
        connection: connection.name,
        remoteDir: connection.remoteRoot,
        anchor: join(this.anchorRoot, name),
      })
    }
    // Compatibility: a workspace the operator added before connections and directories were
    // separated lives at `<anchorRoot>/<connection>` and still routes to the connection's
    // starting directory. Only an anchor directory that already exists is adopted, so a fresh
    // configuration gains no extra anchors.
    for (const connection of this.connections) {
      if (connection.remoteRoot === undefined) continue
      const legacy = { name: connection.name, anchor: join(this.anchorRoot, connection.name) }
      if (this.workspaces.some((workspace) => workspace.name === legacy.name)) continue
      try {
        if (!existsSync(legacy.anchor)) continue
      } catch {
        continue
      }
      this.workspaces.push({
        name: legacy.name,
        connection: connection.name,
        remoteDir: connection.remoteRoot,
        anchor: legacy.anchor,
      })
      log(`adopted existing anchor ${legacy.anchor} as workspace "${legacy.name}"`)
    }
    this.workspaces.sort((left, right) => right.anchor.length - left.anchor.length)
  }

  /** Every configured connection. */
  list() {
    return this.connections.map((connection) => ({ ...connection }))
  }

  /** Every remote workspace, longest anchor first. */
  listWorkspaces() {
    return this.workspaces.map((workspace) => ({ ...workspace }))
  }

  /** One connection by name. */
  connection(name) {
    return this.connections.find((candidate) => candidate.name === name)
  }

  /** Restore a complete configFor() snapshot after a failed durable edit, without touching anchors. */
  restoreConfig(config) {
    const anchorRoot = resolve(String(config?.anchorRoot ?? join(homedir(), 'dsh-remotes')))
    const carrier = config?.carrier === undefined ? undefined : String(config.carrier)
    const connections = Object.entries(config?.servers ?? {}).map(([entryName, server]) => ({
      name: safeName(entryName),
      host: safeHost(server.host),
      remoteRoot: server.remoteRoot === undefined ? undefined : remoteDirectory(server.remoteRoot, 'starting directory'),
      port: safePort(server.port),
      identityFile: safeLocalPath(server.identityFile, 'ssh key file'),
      carrier: server.carrier === undefined ? carrier : String(server.carrier),
      sshConfig: safeLocalPath(server.sshConfig, 'ssh config file'),
    }))
    const workspaces = Object.entries(config?.workspaces ?? {}).map(([entryName, workspace]) => {
      const name = safeName(entryName)
      const connection = String(workspace.connection)
      if (!connections.some((entry) => entry.name === connection)) throw new Error(`unknown connection "${connection}" for workspace "${name}"`)
      return {
        name,
        connection,
        remoteDir: remoteDirectory(workspace.remoteDir, 'remote directory'),
        anchor: join(anchorRoot, name),
      }
    })
    workspaces.sort((left, right) => right.anchor.length - left.anchor.length)
    Object.assign(this, { anchorRoot, carrier, connections, workspaces })
  }

  /** Keep existing readable anchors, adding a stable suffix only when names collide. */
  workspaceName(connection, remoteDir) {
    const base = anchorName(connection, remoteDir)
    if (base.length <= 240 && !this.workspaces.some((workspace) => workspace.name === base)) return base
    const suffix = createHash('sha256').update(JSON.stringify([connection, remoteDir])).digest('hex').slice(0, 16)
    const name = `${base.slice(0, 220)}-${suffix}`
    if (this.workspaces.some((workspace) => workspace.name === name)) throw new Error(`workspace anchor "${name}" is already configured`)
    return name
  }

  /** The workspace owning one local path, by anchor prefix. */
  forPath(localPath) {
    if (typeof localPath !== 'string' || localPath === '') return undefined
    localPath = resolve(localPath)
    return this.workspaces.find(
      (workspace) =>
        localPath === workspace.anchor || localPath.startsWith(`${workspace.anchor}/`),
    )
  }

  /** Map one local anchor path onto its connection's remote path. */
  toRemotePath(localPath) {
    const workspace = this.forPath(localPath)
    if (workspace === undefined) return undefined
    const relative = resolve(localPath).slice(workspace.anchor.length).replace(/^\/+/, '')
    return relative === '' ? workspace.remoteDir : `${workspace.remoteDir.replace(/\/+$/, '')}/${relative}`
  }

  /**
   * Register one connection while the process runs.
   * @param input - name, host, and optional ssh config / key file / starting directory.
   * @returns the created connection.
   */
  addServer(input) {
    const name = safeName(String(input.name ?? '').trim())
    if (this.connections.some((connection) => connection.name === name)) {
      throw new Error(`connection "${name}" is already configured`)
    }
    const host = safeHost(input.host)
    const connection = {
      name,
      host,
      port: safePort(input.port),
      identityFile: safeLocalPath(input.identityFile, 'ssh key file'),
      remoteRoot:
        input.remoteRoot === undefined || String(input.remoteRoot).trim() === ''
          ? undefined
          : remoteDirectory(input.remoteRoot, 'starting directory'),
      carrier: input.carrier === undefined ? this.carrier : String(input.carrier),
      sshConfig: safeLocalPath(input.sshConfig, 'ssh config file'),
    }
    this.connections.push(connection)
    log(`added connection ${name} -> ${host}`)
    return { ...connection }
  }

  /**
   * Forget one connection. Its workspaces go with it, and anchor directories stay on disk:
   * they are mount points the operator may hold files under.
   * @param name - the connection key to drop.
   * @returns whether a connection was removed.
   */
  removeServer(name) {
    const index = this.connections.findIndex((connection) => connection.name === name)
    if (index === -1) return false
    const agents = this.ctx.get('agents')
    if (agents?.list().some((agent) => this.forPath(agent.session.meta.cwd)?.connection === name)) {
      throw new Error(`connection "${name}" still has an open session; close its sessions before removing it`)
    }
    const [connection] = this.connections.splice(index, 1)
    this.workspaces = this.workspaces.filter((workspace) => workspace.connection !== name)
    log(`removed connection ${connection.name} (anchors left in place)`)
    return true
  }

  /**
   * Expose one directory on one connection as a workspace.
   * @param input - connection name and the chosen absolute remote directory.
   * @returns the created workspace, including the local anchor to adopt.
   */
  addWorkspace(input) {
    const connection = this.connection(String(input.connection ?? ''))
    if (connection === undefined) throw new Error(`unknown connection "${input.connection}"`)
    const remoteDir = remoteDirectory(input.remoteDir, 'remote directory')
    const existing = this.workspaces.find(
      (workspace) =>
        workspace.connection === connection.name && workspace.remoteDir === remoteDir,
    )
    if (existing !== undefined) return { ...existing }
    const name = this.workspaceName(connection.name, remoteDir)
    const workspace = {
      name,
      connection: connection.name,
      remoteDir,
      anchor: join(this.anchorRoot, name),
    }
    mkdirSync(workspace.anchor, { recursive: true })
    this.workspaces.push(workspace)
    this.workspaces.sort((left, right) => right.anchor.length - left.anchor.length)
    log(`added workspace ${name} -> ${connection.host}:${remoteDir}`)
    return { ...workspace }
  }

  /**
   * List one directory on a connection, for the workspace browser.
   * @param input - connection name, and the directory to list (absent lists the home directory).
   * @returns the level's path, its parent, and its subdirectories.
   */
  async listRemoteDirectory(input) {
    const connection = this.connection(String(input.connection ?? ''))
    if (connection === undefined) throw new Error(`unknown connection "${input.connection}"`)
    return listRemoteDirectories(connection.host, input.path, {
      sshConfig: connection.sshConfig,
      port: connection.port,
      identity: connection.identityFile,
    })
  }

  /**
   * Check a connection before (or after) registering it: ssh reachable, an optional directory
   * present, API key readable, remote dsh runnable. Runs no model call and writes nothing there.
   * @param input - the same fields `addServer` accepts.
   * @returns probe outcome with a one-line detail for the dialog.
   */
  async testServer(input) {
    return probeServer({
      host: input.host,
      remoteRoot: input.remoteRoot,
      port: input.port === undefined ? undefined : safePort(input.port),
      identity: input.identityFile === undefined ? undefined : safeLocalPath(input.identityFile, 'ssh key file'),
      sshConfig: input.sshConfig,
      dshBin: input.dshBin,
    })
  }

  /** The configuration this registry would persist. */
  configFor() {
    const servers = {}
    for (const connection of this.connections) {
      servers[connection.name] = {
        host: connection.host,
        ...(connection.remoteRoot === undefined ? {} : { remoteRoot: connection.remoteRoot }),
        ...(connection.port === undefined ? {} : { port: connection.port }),
        ...(connection.identityFile === undefined ? {} : { identityFile: connection.identityFile }),
        ...(connection.carrier === undefined || connection.carrier === this.carrier
          ? {}
          : { carrier: connection.carrier }),
        ...(connection.sshConfig === undefined ? {} : { sshConfig: connection.sshConfig }),
      }
    }
    const workspaces = {}
    for (const workspace of this.workspaces) {
      // Persist anchor identity too: an explicit alias or legacy anchor cannot be rebuilt
      // from the connection's starting directory alone.
      workspaces[workspace.name] = {
        connection: workspace.connection,
        remoteDir: workspace.remoteDir,
      }
    }
    return {
      anchorRoot: this.anchorRoot,
      ...(this.carrier === undefined ? {} : { carrier: this.carrier }),
      servers,
      workspaces,
    }
  }

  /** Environment the carrier needs for one workspace; the carrier reads nothing else. */
  carrierEnv(workspace) {
    const connection = this.connection(workspace.connection)
    const env = { ...process.env }
    if (connection === undefined) throw new Error(`unknown connection "${workspace.connection}"`)
    delete env.DSH_REMOTE_PORT
    delete env.DSH_REMOTE_IDENTITY
    delete env.DSH_REMOTE_SSH_CONFIG
    env.DSH_REMOTE_HOST = connection.host
    env.DSH_REMOTE_CWD = workspace.remoteDir
    env.DSH_REMOTE_WS = workspace.remoteDir
    if (connection.port !== undefined) env.DSH_REMOTE_PORT = connection.port
    if (connection.identityFile !== undefined) env.DSH_REMOTE_IDENTITY = connection.identityFile
    if (connection.sshConfig !== undefined) env.DSH_REMOTE_SSH_CONFIG = connection.sshConfig
    return env
  }

  /** Create the anchors so the GUI's workspace picker can offer them. */
  async [Service.init]() {
    for (const workspace of this.workspaces) {
      try {
        mkdirSync(workspace.anchor, { recursive: true })
        log(
          `anchor ready: ${workspace.anchor} -> ${this.connection(workspace.connection)?.host}:${workspace.remoteDir}`,
        )
      } catch (error) {
        log(`could not create anchor ${workspace.anchor}: ${error?.message ?? error}`)
      }
    }
    if (this.connections.length === 0) log('no connections configured')
  }
}

export default RemoteServers
