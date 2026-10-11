import { useEffect, useMemo, useState } from 'react'
import type { AppState, SessionView } from '../../main/state'
import type { SidecarApi } from '../../preload'
import { Term } from './Term'

declare global {
  interface Window {
    sidecar: SidecarApi
  }
}

type Theme = 'auto' | 'light' | 'dark'
type View = 'projects' | 'open'
type Note = { text: string; tone: 'ok' | 'muted' }

// Small per-device preferences. Wrapped because storage can be unavailable.
function stored<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) ?? fallback
  } catch {
    return fallback
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const Chevron = () => (
  <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
)
const ShushIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="m22 9-6 6M16 9l6 6" />
  </svg>
)
const KeyboardIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" />
  </svg>
)

const SHORTCUTS: [string, string[]][] = [
  ['Projects tab', ['⌘', '1']],
  ['Open tab', ['⌘', '2']],
  ['Move', ['↑', '↓']],
  ['Open', ['↵']],
  ['Open all', ['A']],
  ['Shush', ['S']],
  ['Show this', ['?']]
]

export function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [view, setView] = useState<View>('projects')
  const [openHosts, setOpenHosts] = useState<string[]>([])
  const [focusHost, setFocusHost] = useState<string | null>(null)
  const [shushed, setShushed] = useState(() => stored('shush', 'off') === 'on')
  // Hand-twirled exceptions: projects closed while not shushed, or opened while shushed.
  const [closed, setClosed] = useState<Set<number>>(new Set())
  const [opened, setOpened] = useState<Set<number>>(new Set())
  const [cursor, setCursor] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [rowNote, setRowNote] = useState<{ id: string; note: Note } | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [foot, setFoot] = useState<'paused' | 'ideas' | null>(null)
  const [keysOpen, setKeysOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => stored('theme', 'auto'))

  useEffect(() => {
    window.sidecar.getState().then((s) => s && setState(s as AppState))
    return window.sidecar.onState((s) => setState(s as AppState))
  }, [])

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    store('theme', theme)
  }, [theme])

  useEffect(() => {
    store('shush', shushed ? 'on' : 'off')
    setClosed(new Set())
    setOpened(new Set())
  }, [shushed])

  const allSessions = useMemo(() => (state?.projects ?? []).flatMap((p) => p.sessions.map((s) => ({ s, project: p.name }))), [state])
  const hosted = allSessions.filter(({ s }) => s.host)

  // Drop windows whose session has ended (give a just-started one a moment to show up).
  useEffect(() => {
    if (!state) return
    const alive = new Set(hosted.map(({ s }) => s.host))
    setOpenHosts((hs) => hs.filter((h) => alive.has(h) || h === focusHost))
  }, [state])

  const isOpen = (id: number) => (shushed ? opened.has(id) : !closed.has(id))
  const visibleRows = useMemo(() => (state?.projects ?? []).flatMap((p) => (isOpen(p.id) ? p.sessions : [])), [state, shushed, closed, opened])

  const flashNote = (n: Note) => {
    setNote(n)
    setTimeout(() => setNote((cur) => (cur === n ? null : cur)), 3500)
  }
  const flashRow = (id: string, n: Note) => {
    setRowNote({ id, note: n })
    setTimeout(() => setRowNote((cur) => (cur?.id === id ? null : cur)), 1800)
  }

  const showHosts = (hosts: string[]) => {
    if (!hosts.length) return
    setOpenHosts((hs) => [...new Set([...hs, ...hosts])])
    setFocusHost(hosts[0])
    setView('open')
  }

  const open = async (s: SessionView) => {
    setCursor(s.id)
    if (s.host) return showHosts([s.host])
    const r = await window.sidecar.open(s.id)
    if (r.host) showHosts([r.host])
    else flashRow(s.id, r.ok ? { text: 'Brought its Terminal window to the front ✓', tone: 'ok' } : { text: 'Couldn’t find its Terminal window', tone: 'muted' })
  }
  const openAll = (sessions: SessionView[]) => showHosts(sessions.flatMap((s) => (s.host ? [s.host] : [])))
  const handle = (r: { host?: string; error?: string }) => (r.host ? showHosts([r.host]) : r.error && flashNote({ text: r.error, tone: 'muted' }))
  const newSession = async (projectId: number) => handle(await window.sidecar.newSession(projectId))
  const resume = async (id: string) => handle(await window.sidecar.resume(id))
  const move = async (id: string) => {
    flashRow(id, { text: 'Moving into Sidecar…', tone: 'muted' })
    handle(await window.sidecar.move(id))
  }
  const end = async (s: SessionView) => {
    setConfirming(null)
    if (s.host) setOpenHosts((hs) => hs.filter((h) => h !== s.host))
    await window.sidecar.end(s.id)
    if (!s.id.startsWith('tmux:')) flashNote({ text: `Ended “${s.title}”. It’s in paused if you want it back.`, tone: 'muted' })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && (e.key === '1' || e.key === '2')) {
        e.preventDefault()
        if (e.key === '2' && !openHosts.length) return
        return setView(e.key === '1' ? 'projects' : 'open')
      }
      // In the Open tab every key belongs to the terminal (Claude uses Esc, arrows, etc.).
      if (view === 'open' || e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (e.key === '?') return e.preventDefault(), setKeysOpen((v) => !v)
      if (e.key === 'Escape') return setKeysOpen(false), setCursor(null), setConfirming(null)
      if (k === 's') return setShushed((v) => !v)
      if (k === 'a') return openAll(allSessions.map(({ s }) => s))
      const sel = visibleRows.find((s) => s.id === cursor)
      if (e.key === 'Enter' && sel && !(e.target as Element).closest?.('button, summary')) return e.preventDefault(), open(sel)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || k === 'j' || k === 'k') {
        e.preventDefault()
        if (!visibleRows.length) return
        const dir = e.key === 'ArrowDown' || k === 'j' ? 1 : -1
        const i = visibleRows.findIndex((s) => s.id === cursor)
        const next = i < 0 ? (dir > 0 ? 0 : visibleRows.length - 1) : Math.min(visibleRows.length - 1, Math.max(0, i + dir))
        setCursor(visibleRows[next].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visibleRows, cursor, view, openHosts, allSessions])

  useEffect(() => {
    if (!keysOpen) return
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.keys-pop, .keys-btn')) setKeysOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [keysOpen])

  const toggleProject = (id: number, open: boolean) => {
    if (open === isOpen(id)) return // React re-rendering the open state, not a click
    const flip = (prev: Set<number>) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    }
    shushed ? setOpened(flip) : setClosed(flip)
  }

  // Windows in the Open tab, always in the same project order as the list.
  const windows = useMemo(() => {
    const known = allSessions.filter(({ s }) => s.host && openHosts.includes(s.host))
    const pending = openHosts.filter((h) => !known.some(({ s }) => s.host === h)).map((h) => ({ host: h, project: '', title: 'Starting…' }))
    return [...known.map(({ s, project }) => ({ host: s.host!, project, title: s.title })), ...pending]
  }, [allSessions, openHosts])
  const cols = windows.length <= 1 ? 1 : windows.length === 2 || windows.length === 4 ? 2 : 3

  return (
    <div className={`app view-${view}`}>
      <div className="dragbar" aria-hidden="true" />
      <nav className="tabs" role="tablist">
        <button className="tab" role="tab" type="button" aria-selected={view === 'projects'} onClick={() => setView('projects')}>
          Projects
        </button>
        <button className="tab" role="tab" type="button" aria-selected={view === 'open'} disabled={!windows.length} onClick={() => setView('open')}>
          Open <span className="count">{windows.length}</span>
        </button>
        <button className="keys-btn" type="button" aria-expanded={keysOpen} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setKeysOpen((v) => !v)}>
          <KeyboardIcon />
        </button>
        {keysOpen && (
          <div className="keys-pop" role="dialog" aria-label="Keyboard shortcuts">
            {SHORTCUTS.map(([label, keys]) => (
              <div key={label}>
                <span>{label}</span>
                <span>
                  {keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        )}
      </nav>

      {/* Kept mounted (just hidden) so terminals don't reconnect every time you switch tabs. */}
      <section className="desk" hidden={view !== 'open'}>
        <div className="wins" style={{ ['--cols' as string]: cols }}>
          {windows.map((w) => (
            <div className="win" key={w.host}>
              <div className="win-bar">
                <b>
                  {w.project && <span className="wp">{w.project}</span>}
                  {w.title}
                </b>
                <button className="x" type="button" aria-label="Close this window (the session keeps running)" title="Close window · session keeps running" onClick={() => setOpenHosts((hs) => hs.filter((h) => h !== w.host))}>
                  ×
                </button>
              </div>
              <Term name={w.host} focus={view === 'open' && focusHost === w.host} />
            </div>
          ))}
        </div>
      </section>

      <main className="col" hidden={view !== 'projects'}>
        <div className="top">
          {note && <p className={`note ${note.tone}`}>{note.text}</p>}
          <div className="tools">
            {hosted.length > 0 && (
              <button className="pill" type="button" onClick={() => openAll(hosted.map(({ s }) => s))}>
                Open all {hosted.length}
              </button>
            )}
            <button className="pill" type="button" aria-pressed={shushed} onClick={() => setShushed((v) => !v)}>
              <ShushIcon />
              <span>{shushed ? 'Shushed' : 'Shush'}</span>
            </button>
          </div>
        </div>

        {!state ? (
          <p className="empty">Reading your sessions…</p>
        ) : state.projects.length === 0 ? (
          <p className="empty">No Claude sessions are running right now. Resume one from paused below.</p>
        ) : (
          <div>
            {state.projects.map((p) => {
              const waiting = p.sessions.filter((s) => s.status === 'needs').length
              const moving = p.sessions.some((s) => s.status === 'working')
              const inSidecar = p.sessions.filter((s) => s.host)
              return (
                <details key={p.id} className="proj" open={isOpen(p.id)} onToggle={(e) => toggleProject(p.id, (e.target as HTMLDetailsElement).open)}>
                  <summary>
                    <Chevron />
                    <span className="proj-name serif">{p.name}</span>
                    {waiting ? (
                      <span className="hint wait">
                        <span className="dot needs" />
                        {waiting} waiting
                      </span>
                    ) : (
                      <span className="hint">
                        <span className={`dot ${moving ? 'working' : ''}`} />
                        {p.sessions.length} session{p.sessions.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </summary>
                  {state.canHost && (
                    <div className="projacts">
                      <button className="link" type="button" onClick={() => newSession(p.id)}>
                        + New session
                      </button>
                      {inSidecar.length > 1 && (
                        <button className="link" type="button" onClick={() => openAll(inSidecar)}>
                          Open all {inSidecar.length}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="body">
                    {p.sessions.map((s) => (
                      <Row
                        key={s.id}
                        s={s}
                        cursor={cursor === s.id}
                        note={rowNote?.id === s.id ? rowNote.note : null}
                        confirming={confirming === s.id}
                        canHost={!!state.canHost}
                        onOpen={() => open(s)}
                        onMove={() => move(s.id)}
                        onEnd={() => setConfirming(s.id)}
                        onConfirmEnd={() => end(s)}
                        onCancelEnd={() => setConfirming(null)}
                      />
                    ))}
                  </div>
                </details>
              )
            })}
          </div>
        )}

        {state && (state.paused.length > 0 || state.ideas.length > 0) && (
          <div className="foot">
            <div className="foot-links">
              {state.paused.length > 0 && (
                <button className="foot-btn" type="button" aria-expanded={foot === 'paused'} onClick={() => setFoot(foot === 'paused' ? null : 'paused')}>
                  {state.paused.length} paused
                </button>
              )}
              {state.ideas.length > 0 && (
                <button className="foot-btn" type="button" aria-expanded={foot === 'ideas'} onClick={() => setFoot(foot === 'ideas' ? null : 'ideas')}>
                  {state.ideas.length} ideas saved
                </button>
              )}
            </div>
            {foot === 'paused' && (
              <div className="foot-panel">
                {state.paused.map((p) => (
                  <div className="mini" key={p.id}>
                    <div className="mini-text">
                      <span className="mini-title">
                        {p.title}
                        <small>
                          {p.project} · {ago(p.lastActivity)}
                        </small>
                      </span>
                      {p.pickUp && (
                        <span className="mini-sub" title={p.pickUp}>
                          Last: {p.pickUp}
                        </span>
                      )}
                    </div>
                    {state.canHost && (
                      <span className="acts">
                        <button type="button" onClick={() => resume(p.id)}>
                          Resume
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {foot === 'ideas' && (
              <div className="foot-panel">
                {state.ideas.map((i) => (
                  <div className="mini" key={i.id}>
                    <div className="mini-text">
                      <span className="mini-sub wrap">{i.body}</span>
                      <span className="mini-sub">from {i.from}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {state && !state.canHost && <p className="note muted">Install tmux (brew install tmux) to open sessions inside Sidecar.</p>}

        <footer className="meta">
          <span>Sidecar 0.2</span>
          <span className="theme" role="group" aria-label="Theme">
            {(['auto', 'light', 'dark'] as Theme[]).map((t) => (
              <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </span>
        </footer>
      </main>
    </div>
  )
}

type RowProps = {
  s: SessionView
  cursor: boolean
  note: Note | null
  confirming: boolean
  canHost: boolean
  onOpen: () => void
  onMove: () => void
  onEnd: () => void
  onConfirmEnd: () => void
  onCancelEnd: () => void
}

function Row({ s, cursor, note, confirming, canHost, onOpen, onMove, onEnd, onConfirmEnd, onCancelEnd }: RowProps) {
  const inTerminal = !s.host
  return (
    <div className={`item ${cursor ? 'cursor' : ''}`}>
      <div className="row">
        <button className="main-btn" type="button" onClick={onOpen} title={inTerminal ? 'Bring its Terminal window to the front' : 'Open'}>
          <span className="title">
            <span className={`dot ${s.status}`} />
            {s.title}
            {s.status === 'needs' && <span className="tag">waiting</span>}
            {inTerminal && <span className="where">in Terminal</span>}
          </span>
          {note ? <span className={`toast ${note.tone}`}>{note.text}</span> : s.now && <span className="now">{s.now}</span>}
        </button>
        {confirming ? (
          <span className="acts confirming">
            <span className="ask">End it?</span>
            <button className="yes" type="button" onClick={onConfirmEnd}>
              End
            </button>
            <button type="button" onClick={onCancelEnd}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="acts">
            {inTerminal && canHost && (
              <button type="button" onClick={onMove} title="Stop it in Terminal and continue the same conversation inside Sidecar">
                Move here
              </button>
            )}
            <button className="end" type="button" onClick={onEnd}>
              End
            </button>
          </span>
        )}
      </div>
    </div>
  )
}
