/**
 * Add-workspace flow occupant: pick where the workspace lives.
 *
 * `Local folder` browses this machine through the workspace UI service — the same listing
 * primitives the shipped picker uses. `Remote connection` lists the connections managed in
 * Settings → Remote, and then **browses the chosen host** so the workspace names its own
 * directory: the selected folder is registered as a remote workspace by the bridge and its
 * local anchor is adopted here.
 *
 * This occupant exists because the directory-flow holes are `single`: a profile that wants
 * this choice owns the flow, and composes the bridge's browse backend instead of the auto
 * chooser, whose client half would otherwise occupy the same hole.
 *
 * Each open reports at most one picked path or cancellation. Withdrawing `open` discards
 * pending results and resets the next interaction. Browse and registration failures stay
 * inside the dialog so the operator can retry without losing the selection.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { isAbsoluteWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import {
  Button, IconChevronRightOutlineRegular, IconFolderCloseRegular, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocalListing, RemoteConnectionSummary, RemoteDirectoryListing } from './types.ts'
import css from './RemoteWorkspaceFlow.module.css'

/** Injected face: the calls the flow drives (bound in apply's closure). */
export interface RemoteWorkspaceFlowInjected {
  /** List one local directory level; absent lists the home directory. */
  listLocal: (path?: string) => Promise<LocalListing>
  /** The connections managed in Settings → Remote. */
  listConnections: () => Promise<RemoteConnectionSummary[]>
  /** List one directory on a connection; absent lists that host's home directory. */
  listRemote: (connection: string, path?: string) => Promise<RemoteDirectoryListing>
  /** Register the chosen directory as a workspace and resolve its local anchor. */
  useRemoteDirectory: (connection: string, remoteDir: string) => Promise<string>
}

type Props = PropsRuntime<'sidebar.workspaces.directoryFlow'> &
  InjectFace<RemoteWorkspaceFlowInjected>

type Step = 'choose' | 'local' | 'remote' | 'browse'

/**
 * @param props - the hole's owner conversation plus this flow's injected face.
 * @returns the Add-workspace dialog.
 */
export function RemoteWorkspaceFlow(props: Props): ReactElement | null {
  return props.open ? <OpenRemoteWorkspaceFlow {...props} /> : null
}

function OpenRemoteWorkspaceFlow(props: Props): ReactElement {
  const {
    open,
    busy: ownerBusy,
    listLocal,
    listConnections,
    listRemote,
    useRemoteDirectory,
  } = props
  const [step, setStep] = useState<Step>('choose')
  const [listings, setListings] = useState<LocalListing | null>(null)
  const [typedPath, setTypedPath] = useState<string | null>(null)
  const [connections, setConnections] = useState<RemoteConnectionSummary[] | null>(null)
  const [active, setActive] = useState<RemoteConnectionSummary | null>(null)
  const [remote, setRemote] = useState<RemoteDirectoryListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const lifecycle = useRef<{ busy: boolean; settled: boolean } | null>(null)
  const owner = useRef(props)
  useLayoutEffect(() => { owner.current = props })
  useLayoutEffect(() => {
    lifecycle.current = { busy: false, settled: false }
    return () => { lifecycle.current = null }
  }, [])

  const pending = busy || ownerBusy
  const typedAbsolute = typedPath !== null && isAbsoluteWorkspacePath(typedPath.trim())
  const begin = (): typeof lifecycle.current => {
    const current = lifecycle.current
    if (current === null || current.busy || current.settled || owner.current.busy) return null
    current.busy = true
    setFailure(null)
    setBusy(true)
    return current
  }
  const finish = (current: NonNullable<typeof lifecycle.current>): void => {
    if (lifecycle.current !== current) return
    current.busy = false
    setBusy(current.settled)
  }
  const complete = (path?: string): void => {
    const current = lifecycle.current
    if (current === null || current.busy || current.settled || owner.current.busy) return
    current.settled = true
    setBusy(true)
    try {
      if (path === undefined) owner.current.onCancel()
      else owner.current.onPicked(path)
    } catch (error) {
      // The outcome has already reached its owner; callback failure cannot become another outcome.
      console.error('ui-remote-workspaces: directory flow callback failed', error)
    }
  }
  const explain = (reason: unknown): string =>
    reason instanceof Error ? reason.message : String(reason)

  const openListing = async (path?: string): Promise<void> => {
    const current = begin()
    if (current === null) return
    setStep('local')
    try {
      const listing = await listLocal(path)
      if (lifecycle.current !== current) return
      setListings(listing)
      setTypedPath(null)
    } catch (reason) {
      if (lifecycle.current !== current) return
      // Keep manual path entry available when directory browsing is unavailable.
      setListings(null)
      setTypedPath(path ?? '')
      setFailure(explain(reason))
    } finally {
      finish(current)
    }
  }

  const openConnections = async (): Promise<void> => {
    const current = begin()
    if (current === null) return
    setStep('remote')
    try {
      const listed = await listConnections()
      if (lifecycle.current === current) setConnections(listed)
    } catch (reason) {
      if (lifecycle.current !== current) return
      setConnections([])
      setFailure(explain(reason))
    } finally {
      finish(current)
    }
  }

  const openRemote = async (connection: RemoteConnectionSummary, path?: string): Promise<void> => {
    const current = begin()
    if (current === null) return
    setActive(connection)
    setStep('browse')
    try {
      const listing = await listRemote(connection.name, path)
      if (lifecycle.current === current) setRemote(listing)
    } catch (reason) {
      if (lifecycle.current !== current) return
      setRemote(null)
      setFailure(explain(reason))
    } finally {
      finish(current)
    }
  }

  const adoptRemoteDirectory = async (): Promise<void> => {
    if (active === null || remote === null) return
    const current = begin()
    if (current === null) return
    let anchor: string
    try {
      anchor = await useRemoteDirectory(active.name, remote.path)
    } catch (reason) {
      if (lifecycle.current === current) setFailure(explain(reason))
      return
    } finally {
      finish(current)
    }
    if (lifecycle.current === current) complete(anchor)
  }

  const restart = (): void => {
    setStep('choose')
    setListings(null)
    setTypedPath(null)
    setConnections(null)
    setActive(null)
    setRemote(null)
    setFailure(null)
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        complete()
      }}
      title="Add workspace"
      className={css.dialog as string}
      headless
    >
      <div className={css.header}>
        <h2 className={css.title}>Add workspace</h2>
        <div className={css.subtitle}>
          {step === 'local'
            ? (listings?.path ?? typedPath ?? 'This machine')
            : step === 'browse' && active !== null
              ? `${active.name}: ${remote?.path ?? '…'}`
              : step === 'remote'
                ? 'Remote connections'
                : 'Local folder or a remote connection'}
        </div>
        {step === 'local' && listings !== null && (
          <div className={css.crumbs}>
            {listings.crumbs.map((crumb, index) => (
              <span key={crumb.path} className={css.crumbSeat}>
                {index > 0 && <IconChevronRightOutlineRegular size={12} className={css.crumbChevron} />}
                <Button
                  variant="ghost"
                  size="sm"
                  className={css.crumb as string}
                  disabled={pending}
                  title={crumb.path}
                  onClick={() => {
                    void openListing(crumb.path)
                  }}
                >
                  {crumb.name}
                </Button>
              </span>
            ))}
          </div>
        )}
        {step === 'browse' && active !== null && (
          <div className={css.crumbs}>
            <Button
              variant="ghost"
              size="sm"
              className={css.crumb as string}
              disabled={pending}
              onClick={() => {
                setStep('remote')
                setRemote(null)
                setFailure(null)
              }}
            >
              {active.name}
            </Button>
            {remote?.parent !== undefined && (
              <>
                <IconChevronRightOutlineRegular size={12} className={css.crumbChevron} />
                <Button
                  variant="ghost"
                  size="sm"
                  className={css.crumb as string}
                  disabled={pending}
                  title={remote.parent}
                  onClick={() => {
                    void openRemote(active, remote.parent)
                  }}
                >
                  ↑ {remote.parent}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <div className={css.content}>
        {step === 'choose' && (
          <>
            <div className={css.lead}>Where should this workspace live?</div>
            <div className={css.choices}>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  void openListing()
                }}
              >
                Local folder…
              </Button>
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  void openConnections()
                }}
              >
                Remote connection…
              </Button>
            </div>
          </>
        )}

        {step === 'local' && (
          <>
            <div className={css.lead}>Choose a local folder</div>
            {listings !== null && (
              <div className={css.list}>
                {listings.entries.length === 0 && (
                  <p className={css.empty}>No subfolders here.</p>
                )}
                {listings.entries.map((entry) => (
                  <Button
                    key={entry.path}
                    variant="ghost"
                    size="sm"
                    className={css.row as string}
                    disabled={pending}
                    title={entry.name}
                    onClick={() => {
                      void openListing(entry.path)
                    }}
                  >
                    <IconFolderCloseRegular size={16} className={css.rowIcon} />
                    <span className={css.rowName}>{entry.name}</span>
                    <IconChevronRightOutlineRegular size={12} className={css.rowChevron} />
                  </Button>
                ))}
              </div>
            )}
            {typedPath !== null && (
              <Input
                value={typedPath}
                placeholder="/home/username/project"
                aria-invalid={typedPath.trim() !== '' && !typedAbsolute}
                disabled={pending}
                onChange={(event) => {
                  setTypedPath(event.target.value)
                }}
              />
            )}
          </>
        )}

        {step === 'remote' && (
          <>
            <div className={css.lead}>Choose a connection</div>
            {connections !== null && connections.length === 0 && (
              <p className={css.empty}>
                No connections yet. Add one in Settings → Remote, then it appears here.
              </p>
            )}
            {connections !== null && connections.length > 0 && (
              <div className={css.connectionList}>
                {connections.map((connection) => (
                  <div key={connection.name} className={css.connection}>
                    <div className={css.connectionMain}>
                      <div className={css.connectionName}>{connection.name}</div>
                      <div className={css.connectionMeta}>{connection.host}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        void openRemote(connection, connection.remoteRoot)
                      }}
                    >
                      Browse…
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {step === 'browse' && active !== null && (
          <>
            <div className={css.lead}>Choose a folder to open as a workspace</div>
            {remote !== null && (
              <div className={css.list}>
                {remote.entries.length === 0 && (
                  <p className={css.empty}>No subfolders here.</p>
                )}
                {remote.entries.map((entry) => (
                  <Button
                    key={entry.path}
                    variant="ghost"
                    size="sm"
                    className={css.row as string}
                    disabled={pending}
                    title={entry.name}
                    onClick={() => {
                      void openRemote(active, entry.path)
                    }}
                  >
                    <IconFolderCloseRegular size={16} className={css.rowIcon} />
                    <span className={css.rowName}>{entry.name}</span>
                    <IconChevronRightOutlineRegular size={12} className={css.rowChevron} />
                  </Button>
                ))}
              </div>
            )}
          </>
        )}

        {failure !== null && (
          <p className={css.notice} role="alert">
            {failure}
          </p>
        )}
      </div>

      <div className={css.footerBar}>
        {step !== 'choose' && (
          <Button variant="ghost" disabled={pending} onClick={restart}>
            Back
          </Button>
        )}
        <div className={css.footerGap} />
        <Button variant="outline" className={css.footerAction as string} disabled={pending} onClick={() => { complete() }}>
          Cancel
        </Button>
        {step === 'local' && listings !== null && (
          <Button
            variant="primary"
            className={css.footerAction as string}
            disabled={pending}
            onClick={() => {
              complete(listings.path)
            }}
          >
            Use this folder
          </Button>
        )}
        {step === 'local' && typedPath !== null && (
          <Button
            variant="primary"
            className={css.footerAction as string}
            disabled={pending || !typedAbsolute}
            onClick={() => {
              if (typedAbsolute) complete(typedPath.trim())
            }}
          >
            Use this path
          </Button>
        )}
        {step === 'browse' && remote !== null && (
          <Button
            variant="primary"
            className={css.footerAction as string}
            disabled={pending}
            onClick={() => {
              void adoptRemoteDirectory()
            }}
          >
            Use this folder
          </Button>
        )}
      </div>
    </Modal>
  )
}
