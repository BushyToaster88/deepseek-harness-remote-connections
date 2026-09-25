/** Vocabulary shared by the workspace flow and the Remote settings page. */

/**
 * One connection as the Settings form collects it: a host, and how to reach it. The
 * workspace's own directory is chosen per workspace, not here.
 */
export interface RemoteConnectionInput {
  /** Registry key. */
  name: string
  /** ssh alias or hostname. */
  host: string
  /** ssh port; empty uses the ssh default. */
  port?: string
  /** Local private key for this connection; empty uses the ssh default identities. */
  identityFile?: string
  /** Where the workspace browser starts; empty starts at the remote home directory. */
  remoteRoot?: string
  /** Explicit ssh config for callers that need one. */
  sshConfig?: string
}

/** One registered connection, as the settings list and the workspace picker show it. */
export interface RemoteConnectionSummary {
  name: string
  host: string
  port?: string
  identityFile?: string
  remoteRoot?: string
  sshConfig?: string
}

/** One subdirectory of a connection's filesystem. */
export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
}

/** One listed directory level of a connection. */
export interface RemoteDirectoryListing {
  /** The listed directory, always absolute. */
  readonly path: string
  /** Parent directory, absent at the root. */
  readonly parent?: string
  readonly entries: readonly RemoteDirectoryEntry[]
}

/** One directory level of the local machine, as the local branch renders it. */
export interface LocalListing {
  readonly path: string
  readonly home: string
  readonly crumbs: readonly { readonly name: string; readonly path: string }[]
  readonly entries: readonly {
    readonly name: string
    readonly path: string
    readonly hidden: boolean
  }[]
}

/** Outcome of a readiness check, as the settings page shows it. */
export interface RemoteServerProbe {
  readonly ok: boolean
  readonly detail: string
}
