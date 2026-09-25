/**
 * Settings → Remote: the connection list the Add-workspace flow selects from.
 *
 * Connections are managed here and only *picked* when a workspace is created, so the
 * operator enters a host's coordinates once. Every action goes through the bridge's
 * `remoteServers` namespace, which tests a candidate before registering it and writes the
 * resulting list back into the profile patch.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconPlusOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteConnectionInput, RemoteConnectionSummary } from './types.ts'
import css from './RemoteConnections.module.css'

/** Injected face: the namespace calls this page drives (bound in apply's closure). */
export interface RemoteConnectionsInjected {
  listServers: () => Promise<RemoteConnectionSummary[]>
  testServer: (input: RemoteConnectionInput) => Promise<{ ok: boolean; detail: string }>
  addServer: (input: RemoteConnectionInput) => Promise<{ name: string; warning?: string }>
  removeServer: (name: string) => Promise<boolean>
}

type Props = PropsRuntime<'settings.section'> & InjectFace<RemoteConnectionsInjected>

const BLANK: RemoteConnectionInput = { name: '', host: '', remoteRoot: '' }

/**
 * @param props - the settings section's owner props and this page's injected face.
 * @returns the remote-connection manager.
 */
export function RemoteConnections(props: Props): ReactElement {
  const { listServers, testServer, addServer, removeServer } = props
  const [servers, setServers] = useState<RemoteConnectionSummary[] | null>(null)
  const [form, setForm] = useState<RemoteConnectionInput>(BLANK)
  const [busy, setBusy] = useState<string | null>('load')
  const lifecycle = useRef<{ busy: boolean } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    const current = { busy: true }
    lifecycle.current = current
    setBusy('load')
    setFailure(null)
    setServers(null)
    void (async () => {
      try {
        const listed = await listServers()
        if (lifecycle.current === current) setServers(listed)
      } catch (reason) {
        if (lifecycle.current === current) {
          setFailure(reason instanceof Error ? reason.message : String(reason))
        }
      } finally {
        if (lifecycle.current === current) {
          current.busy = false
          setBusy(null)
        }
      }
    })()
    return () => { lifecycle.current = null }
  }, [listServers])

  const begin = (name: string): typeof lifecycle.current => {
    const current = lifecycle.current
    if (current === null || current.busy) return null
    current.busy = true
    setBusy(name)
    setNotice(null)
    setFailure(null)
    return current
  }

  const finish = (current: NonNullable<typeof lifecycle.current>): void => {
    if (lifecycle.current !== current) return
    current.busy = false
    setBusy(null)
  }

  const draft = (): RemoteConnectionInput => ({
    name: form.name.trim(),
    host: form.host.trim(),
    ...(form.port === undefined || form.port.trim() === '' ? {} : { port: form.port.trim() }),
    ...(form.identityFile === undefined || form.identityFile.trim() === ''
      ? {}
      : { identityFile: form.identityFile.trim() }),
    ...(form.remoteRoot === undefined || form.remoteRoot.trim() === ''
      ? {}
      : { remoteRoot: form.remoteRoot.trim() }),
    ...(form.sshConfig === undefined || form.sshConfig.trim() === ''
      ? {}
      : { sshConfig: form.sshConfig.trim() }),
  })

  const complete = draft().name !== '' && draft().host !== ''

  const runTest = async (name: string, input: RemoteConnectionInput): Promise<void> => {
    const current = begin(`test:${name}`)
    if (current === null) return
    try {
      const probe = await testServer(input)
      if (lifecycle.current !== current) return
      if (probe.ok) setNotice(`${name}: ${probe.detail}`)
      else setFailure(`${name}: ${probe.detail}`)
    } catch (reason) {
      if (lifecycle.current === current) {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      finish(current)
    }
  }

  const submit = async (): Promise<void> => {
    const current = begin('add')
    if (current === null) return
    try {
      const added = await addServer(draft())
      if (lifecycle.current !== current) return
      setForm(BLANK)
      setAdding(false)
      setNotice(
        added.warning === undefined
          ? `connected: ${added.name}`
          : `connected for this session only — ${added.warning}`,
      )
      const listed = await listServers()
      if (lifecycle.current === current) setServers(listed)
    } catch (reason) {
      if (lifecycle.current === current) {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      finish(current)
    }
  }

  const remove = async (name: string): Promise<void> => {
    const current = begin(`remove:${name}`)
    if (current === null) return
    try {
      const removed = await removeServer(name)
      if (lifecycle.current !== current) return
      setNotice(removed ? `removed ${name}` : `${name} was not registered`)
      const listed = await listServers()
      if (lifecycle.current === current) setServers(listed)
    } catch (reason) {
      if (lifecycle.current === current) {
        setFailure(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      finish(current)
    }
  }

  const field = (
    key: 'name' | 'host' | 'port' | 'identityFile' | 'remoteRoot' | 'sshConfig',
    label: string,
    placeholder: string,
  ): ReactElement => (
    <label className={css.field} htmlFor={`remote-connection-${key}`}>
      <span className={css.label}>{label}</span>
      <Input
        className={css.input as string}
        id={`remote-connection-${key}`}
        value={form[key] ?? ''}
        placeholder={placeholder}
        disabled={busy !== null}
        onChange={(event) => {
          setForm((current) => ({ ...current, [key]: event.target.value }))
        }}
      />
    </label>
  )

  return (
    <section className={css.section}>
      <h2 className={css.title}>Remote connections</h2>
      <p className={css.intro}>
        Connect an SSH host, then choose a remote folder when adding a workspace. Remote
        sessions use that host’s tools and credentials.
      </p>

      {servers === null && busy === 'load' && <p className={css.empty}>Loading connections…</p>}
      {servers !== null && servers.length === 0 && (
        <p className={css.empty}>No connections yet.</p>
      )}
      <ul className={css.rows}>
        {(servers ?? []).map((server) => (
          <li key={server.name} className={css.rowCard}>
            <div className={css.rowHead}>
              <div className={css.rowIdentity}>
                <span className={css.rowName}>{server.name}</span>
                <span className={css.rowTag}>ssh</span>
              </div>
              <div className={css.rowActions}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    void runTest(server.name, { ...server })
                  }}
                >
                  {busy === `test:${server.name}` ? 'Testing…' : 'Test'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={css.removeButton as string}
                  disabled={busy !== null}
                  onClick={() => {
                    void remove(server.name)
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
            <div className={css.rowMeta}>
              {server.host}
              {server.port === undefined ? '' : `:${server.port}`}
              {server.remoteRoot === undefined ? '' : ` · starts at ${server.remoteRoot}`}
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className={css.form}>
          <p className={css.formTitle}>New connection</p>
          {field('name', 'Name', 'abyss')}
          {field('host', 'ssh host or alias', 'abyss')}
          {field('port', 'ssh port (optional)', '22')}
          {field('identityFile', 'ssh key file (optional)', '~/.ssh/id_ed25519 — empty uses the ssh default')}
          {field('remoteRoot', 'Starting directory for the browser (optional)', '/home/abyss')}
          {field('sshConfig', 'ssh config file (optional)', 'leave empty for the ssh default')}
          <div className={css.formActions}>
            <Button
              variant="outline"
              size="md"
              disabled={busy !== null}
              onClick={() => {
                setAdding(false)
                setForm(BLANK)
                setFailure(null)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={!complete || busy !== null}
              onClick={() => {
                void submit()
              }}
            >
              {busy === 'add' ? 'Testing…' : 'Connect'}
            </Button>
          </div>
        </div>
      ) : (
        <div className={css.actions}>
          <Button
            variant="outline"
            size="md"
            className={css.addButton as string}
            disabled={busy !== null}
            icon={<IconPlusOutlineRegular size={14} />}
            onClick={() => {
              setAdding(true)
              setNotice(null)
              setFailure(null)
            }}
          >
            Add connection
          </Button>
        </div>
      )}

      {notice !== null && (
        <p className={css.notice} role="status">
          {notice}
        </p>
      )}
      {failure !== null && (
        <p className={css.failure} role="alert">
          {failure}
        </p>
      )}
    </section>
  )
}
