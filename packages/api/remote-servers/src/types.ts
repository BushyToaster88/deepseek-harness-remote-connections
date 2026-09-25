/** Wire vocabulary for the `remoteServers` namespace. */

// The protocol's failure codes are a closed map: a namespace declares the codes it
// answers with here, and the generated codecs validate against them.
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The draft is incomplete, or carries a field the registry refuses. */
    'remote-servers/invalid': { readonly field?: string }
    /** The candidate host did not answer its readiness check. */
    'remote-servers/unreachable': { readonly host: string }
    /** The remote directory could not be listed. */
    'remote-servers/unreadable': { readonly connection: string; readonly path: string }
  }
}

/**
 * One connection as the Settings form collects it: a host, and how to reach it. A connection
 * deliberately carries no workspace directory — that is chosen per workspace.
 */
export interface RemoteConnectionDraft {
  /** Registry key. */
  readonly name: string
  /** ssh alias or hostname. */
  readonly host: string
  /** ssh port; absent uses the ssh default (22, or whatever the config says). */
  readonly port?: string
  /** Local private key for this connection; absent uses the ssh default identities. */
  readonly identityFile?: string
  /** Explicit ssh config for callers that need one. */
  readonly sshConfig?: string
  /** Where the workspace browser starts; absent starts at the remote home directory. */
  readonly remoteRoot?: string
}

/** One registered connection. */
export interface RemoteConnectionDescription {
  readonly name: string
  readonly host: string
  readonly port?: string
  readonly identityFile?: string
  readonly remoteRoot?: string
  readonly sshConfig?: string
  /**
   * Set when the connection is live for this session but could not be written to the profile
   * patch (it will not survive a restart). It is usable either way, so this is a caveat on a
   * success rather than a failure.
   */
  readonly warning?: string
}

/** One remote workspace: a directory on a connection, exposed to the GUI as a local anchor. */
export interface RemoteWorkspaceDescription {
  /** Anchor name; also the local directory name under the anchor root. */
  readonly name: string
  readonly connection: string
  /** Absolute directory on the connection that this workspace opens. */
  readonly remoteDir: string
  /** Local anchor directory the GUI adopts as the workspace. */
  readonly anchor: string
}

/** One subdirectory of a connection's filesystem. */
export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
}

/** One listed directory level of a connection. */
export interface RemoteDirectoryListing {
  /** The listed directory, or `~` when the remote home directory was listed. */
  readonly path: string
  /** Parent directory, absent at the root. */
  readonly parent?: string
  readonly entries: readonly RemoteDirectoryEntry[]
}

/** Request one directory level from a connection. */
export interface RemoteDirectoryRequest {
  readonly connection: string
  /** Absolute directory to list; absent lists the remote home directory. */
  readonly path?: string
}

/** Request one directory on a connection be exposed as a workspace. */
export interface RemoteWorkspaceRequest {
  readonly connection: string
  readonly remoteDir: string
}

/** Outcome of a readiness check. */
export interface RemoteServerTestValue {
  readonly ok: boolean
  /** Remote dsh version, when the host answered. */
  readonly version?: string
  /** One-line, operator-facing explanation. */
  readonly detail: string
}

/** Outcome of unregistering one connection. */
export interface RemoteServerRemoveValue {
  readonly removed: boolean
}
