import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppState, FoundView, SessionView } from '../../main/state'
import type { MasonApi } from '../../preload'
import { Term } from './Term'

declare global {
  interface Window {
    mason: MasonApi
  }
}

type Theme = 'auto' | 'light' | 'dark'
type View = 'projects' | 'open'
type Sort = 'project' | 'waiting' | 'recent' | 'custom'
type Layout = 'grid' | 'side' | 'stack' | 'one'
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
const PinIcon = ({ filled = false }: { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </svg>
)
const RenameIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7V4h16v3M9 20h6M12 4v16" />
  </svg>
)
const NoteIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 21h8" />
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  </svg>
)
const StarIcon = ({ filled = false }: { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
  </svg>
)
const PeekIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </svg>
)
const FocusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.5" />
  </svg>
)
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)

const SHORTCUTS: [string, [string, string[]][]][] = [
  [
    'Anywhere',
    [
      ['Projects tab', ['⌘', '1']],
      ['Open tab', ['⌘', '2']]
    ]
  ],
  [
    'Projects',
    [
      ['Move', ['↑', '↓']],
      ['Open', ['↵']],
      ['Open all', ['A']],
      ['Open starred', ['⇧', 'A']],
      ['Rename', ['R']],
      ['Pin', ['P']],
      ['Star', ['*']],
      ['Peek (answer it right here)', ['Space']],
      ['Close Peek', ['⌘', '⇧', 'W']],
      ['Find', ['/']],
      ['Note on a session', ['N']],
      ['Shush', ['S']],
      ['Show this', ['?']]
    ]
  ],
  [
    'Open tab',
    [
      ['Next window', ['⌘', ']']],
      ['Previous window', ['⌘', '[']],
      ['Move window later', ['⌘', '⇧', ']']],
      ['Move window earlier', ['⌘', '⇧', '[']],
      ['Focus this window', ['⌘', '⇧', 'F']],
      ['One at a time', ['⌘', '↵']],
      ['Change layout', ['⌘', 'L']],
      ['Change order', ['⌘', 'O']],
      ['Next project', ['⌘', 'P']],
      ['Note on this session', ['⌘', 'N']],
      ['New terminal here', ['⌘', 'T']],
      ['Hide window', ['⌘', '⇧', 'W']],
      ['End session (twice)', ['⌘', '⇧', 'K']]
    ]
  ]
]

// The help card: the things you can't discover by looking (commands typed inside Claude, the global hotkey,
// what the colours mean), then the keyboard shortcuts.
const DOTS: [string, string][] = [
  ['working', 'Claude is working'],
  ['needs', 'Waiting on you: a question or a permission prompt'],
  ['idle', 'Quiet: done for now, or waiting for your next message']
]
const IN_CLAUDE: [string, string][] = [
  ['/stash', 'Keep Claude’s last reply in Saved'],
  ['/stash 2', 'Keep the reply before that'],
  ['/stash idea …', 'Park a thought to come back to'],
  ['/stash later …', 'A note for future you'],
  ['/pause', 'Claude writes a handoff, then the session stops']
]

const SORTS: [Sort, string][] = [
  ['project', 'by project'],
  ['waiting', 'waiting first'],
  ['recent', 'by recent activity'],
  ['custom', 'by hand']
]
const LAYOUTS: [Layout, string][] = [
  ['grid', 'in a grid'],
  ['side', 'side by side'],
  ['stack', 'stacked'],
  ['one', 'one at a time']
]
const cycle = <T,>(list: [T, string][], cur: T): T => list[(list.findIndex(([v]) => v === cur) + 1) % list.length][0]

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
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingProject, setRenamingProject] = useState<number | null>(null)
  const [ending, setEnding] = useState<string | null>(null) // Open-tab window asking "End this session?"
  const [rowNote, setRowNote] = useState<{ id: string; note: Note } | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  // Peek: a session enlarged over the list, live, so you can answer it without leaving Projects.
  const [peeking, setPeeking] = useState<{ host: string; id: string } | null>(null)
  const [foot, setFoot] = useState<'paused' | 'saved' | 'done' | 'scratch' | null>(null)
  // Notes you've tucked away ('s:<id>' / 'p:<id>'); the pen brings them back. Remembered on this Mac.
  const [tucked, setTucked] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('tucked') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  useEffect(() => store('tucked', JSON.stringify([...tucked])), [tucked])
  const tuck = (key: string, on: boolean) =>
    setTucked((t) => {
      const next = new Set(t)
      on ? next.add(key) : next.delete(key)
      return next
    })
  const [noting, setNoting] = useState<string | null>(null) // 's:<id>' or 'p:<id>' while its note is being edited
  const [keysOpen, setKeysOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(() => stored('theme', 'auto'))
  // How the Open tab is arranged. Custom order is whatever you last dragged or nudged.
  const [sort, setSort] = useState<Sort>(() => stored('sort', 'project'))
  const [layout, setLayout] = useState<Layout>(() => stored('openLayout', 'stack'))
  const lastMulti = useRef<Layout>(layout === 'one' ? 'stack' : layout)
  const [only, setOnly] = useState<string>(() => stored('openProject', '')) // '' = every project
  const [order, setOrder] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('order') ?? '[]')
    } catch {
      return []
    }
  })
  const [tick, setTick] = useState(0) // bumps to hand focus back to the terminal after using a control
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ host: string; after: boolean } | null>(null)

  useEffect(() => {
    window.mason.getState().then((s) => s && setState(s as AppState))
    return window.mason.onState((s) => setState(s as AppState))
  }, [])

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
    store('theme', theme)
  }, [theme])

  useEffect(() => store('sort', sort), [sort])
  useEffect(() => {
    store('openLayout', layout)
    if (layout !== 'one') lastMulti.current = layout
  }, [layout])
  useEffect(() => store('order', JSON.stringify(order)), [order])
  useEffect(() => store('openProject', only), [only])

  useEffect(() => {
    store('shush', shushed ? 'on' : 'off')
    setClosed(new Set())
    setOpened(new Set())
    if (shushed) setFoot(null)
  }, [shushed])

  const allSessions = useMemo(() => (state?.projects ?? []).flatMap((p) => p.sessions.map((s) => ({ s, project: p.name }))), [state])
  const hosted = allSessions.filter(({ s }) => s.host)

  // Drop windows whose session has ended. A just-started one isn't in the state yet, so only drop hosts we've seen.
  const seenHosts = useRef(new Set<string>())
  useEffect(() => {
    if (!state) return
    const alive = new Set(hosted.map(({ s }) => s.host!))
    alive.forEach((h) => seenHosts.current.add(h))
    setOpenHosts((hs) => hs.filter((h) => alive.has(h) || !seenHosts.current.has(h)))
  }, [state])

  // The Open tab comes back the way you left it: same windows, same focus, same tab. Each window is saved with
  // the conversation it shows, so after a Mac restart (when Mason reopens them under new names) they still match.
  type SavedWindow = { host: string; sid: string | null }
  const restored = useRef(false)
  const convOf = (h: string) => {
    const s = allSessions.find((x) => x.s.host === h)?.s
    return s ? (s.sid ?? (s.id.startsWith('tmux:') ? null : s.id)) : null
  }
  useEffect(() => {
    if (restored.current || !state) return
    restored.current = true
    let saved: SavedWindow[] = []
    try {
      saved = JSON.parse(localStorage.getItem('openWindows') ?? '[]')
    } catch {}
    const alive = new Set(hosted.map(({ s }) => s.host!))
    const hostOfConv = new Map(hosted.flatMap(({ s }) => (s.sid ?? s.id).startsWith('tmux:') ? [] : [[s.sid ?? s.id, s.host!] as const]))
    const now = new Map<string, string>() // saved name -> today's name
    for (const w of saved) {
      const h = alive.has(w.host) ? w.host : w.sid ? hostOfConv.get(w.sid) : undefined
      if (h) now.set(w.host, h)
    }
    const hosts = [...new Set(now.values())]
    if (!hosts.length) return
    setOpenHosts(hosts)
    setOrder((o) => o.map((h) => now.get(h) ?? h))
    const f = stored('openFocus', '')
    setFocusHost(now.get(f) ?? hosts[0])
    if (stored('openView', 'projects') === 'open') setView('open')
  }, [state])
  useEffect(() => {
    if (!restored.current) return
    let prev: SavedWindow[] = []
    try {
      prev = JSON.parse(localStorage.getItem('openWindows') ?? '[]')
    } catch {}
    // A window still starting has no conversation yet; keep the one saved before rather than forgetting it.
    store('openWindows', JSON.stringify(openHosts.map((h) => ({ host: h, sid: convOf(h) ?? prev.find((w) => w.host === h)?.sid ?? null }))))
  }, [openHosts, allSessions])
  useEffect(() => {
    if (restored.current) store('openFocus', focusHost ?? '')
  }, [focusHost])
  useEffect(() => {
    if (restored.current) store('openView', view)
  }, [view])

  // Find: filters the live list as you type, and searches every past conversation below it.
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<FoundView[]>([])
  const q = query.trim()
  useEffect(() => {
    if (!q) return setFound([])
    const t = setTimeout(() => window.mason.search(q).then(setFound), 150)
    return () => clearTimeout(t)
  }, [q, state])
  const closeFind = () => (setFinding(false), setQuery(''))

  const projects = useMemo(() => {
    let list = state?.projects ?? []
    if (q) {
      const words = q.toLowerCase().split(/\s+/)
      const starredOnly = words.includes('*')
      const terms = words.filter((w) => w !== '*')
      const hit = (s: SessionView, p: (typeof list)[number]) =>
        (!starredOnly || s.starred) && terms.every((w) => [s.title, s.now, p.name, s.myNote ?? '', p.myNote ?? ''].join(' ').toLowerCase().includes(w))
      list = list.map((p) => ({ ...p, sessions: p.sessions.filter((s) => hit(s, p)) })).filter((p) => p.sessions.length)
    }
    return list
  }, [state, q])

  const isOpen = (id: number) => !!q || (shushed ? opened.has(id) : !closed.has(id))
  const visibleRows = useMemo(() => projects.flatMap((p) => (isOpen(p.id) ? p.sessions : [])), [projects, shushed, closed, opened, q])

  // The menu bar can ask to peek at a waiting session (or, for one in Terminal, bring it forward).
  useEffect(() => {
    const offPeek = window.mason.onPeek((target, id) => {
      setView('projects')
      if (target) setPeeking(target)
      else window.mason.open(id)
    })
    const offNotice = window.mason.onNotice((text) => flashNote({ text, tone: 'ok' }))
    return () => {
      offPeek()
      offNotice()
    }
  }, [])

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
    reveal.current = true
    setFocusHost(hosts[0])
    setView('open')
  }

  const open = async (s: SessionView) => {
    setCursor(s.id)
    if (s.host) return showHosts([s.host])
    const r = await window.mason.open(s.id)
    if (r.host) showHosts([r.host])
    else flashRow(s.id, r.ok ? { text: 'Brought its Terminal window to the front ✓', tone: 'ok' } : { text: 'Couldn’t find its Terminal window', tone: 'muted' })
  }
  const openAll = (sessions: SessionView[]) => showHosts(sessions.flatMap((s) => (s.host ? [s.host] : [])))
  // Every starred conversation in the Open tab: ones in Mason open, paused ones resume here. A starred session
  // running in a Terminal window stays put (taking it over means stopping it), so you're told instead.
  const starredLive = allSessions.filter(({ s }) => s.starred)
  const starredPaused = (state?.paused ?? []).filter((p) => p.starred)
  const starredCount = new Set([...starredLive.map(({ s }) => s.sid ?? s.id), ...starredPaused.map((p) => p.id)]).size
  const openStarred = async () => {
    const hosts = starredLive.flatMap(({ s }) => (s.host ? [s.host] : []))
    const inTerminal = starredLive.filter(({ s }) => !s.host).length
    const resumed = await Promise.all(starredPaused.map((p) => window.mason.resume(p.id)))
    showHosts([...hosts, ...resumed.flatMap((r) => (r.host ? [r.host] : []))])
    if (inTerminal)
      flashNote({ text: `${inTerminal} starred session${inTerminal > 1 ? 's are' : ' is'} in a Terminal window. Use “Move here” to bring ${inTerminal > 1 ? 'them' : 'it'} in.`, tone: 'muted' })
  }
  const handle = (r: { host?: string; error?: string }) => (r.host ? showHosts([r.host]) : r.error && flashNote({ text: r.error, tone: 'muted' }))
  const newSession = async (projectId: number) => handle(await window.mason.newSession(projectId))
  const newTerminal = async (projectId: number) => handle(await window.mason.newTerminal(projectId))
  const addProject = async () => {
    const r = await window.mason.addProject()
    if (r.error) flashNote({ text: r.error, tone: 'muted' })
  }
  const resume = async (id: string) => handle(await window.mason.resume(id))
  const fresh = async (id: string) => handle(await window.mason.fresh(id))
  const [editingHandoff, setEditingHandoff] = useState<string | null>(null)
  const move = async (id: string) => {
    flashRow(id, { text: 'Moving into Mason…', tone: 'muted' })
    handle(await window.mason.move(id))
  }
  const end = async (s: SessionView) => {
    setConfirming(null)
    if (s.host) setOpenHosts((hs) => hs.filter((h) => h !== s.host))
    await window.mason.end(s.id)
    if (!s.id.startsWith('tmux:')) flashNote({ text: `Ended “${s.title}”. It’s in paused if you want it back.`, tone: 'muted' })
  }

  // Stacked windows scroll; bring the focused one into view when ⌘[ / ⌘] (or opening a session) moves focus there.
  // Clicking into a window never scrolls: the window you clicked stays exactly where it was.
  const reveal = useRef(false)
  useEffect(() => {
    if (view !== 'open' || !focusHost || !reveal.current) return
    reveal.current = false
    document.querySelector(`.win[data-host="${focusHost}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusHost, layout, view])

  // End from the Open tab: stops the session and closes its window. A window still starting up can only be hidden.
  const endWindow = (host: string) => {
    setEnding(null)
    const s = allSessions.find(({ s }) => s.host === host)?.s
    if (s) end(s)
    else setOpenHosts((hs) => hs.filter((h) => h !== host))
  }

  // Windows in the Open tab. "Project" keeps the same order as the list; the sorts are stable, so ties stay in it.
  // Focus (Open tab): one window you're working in leads, and the others dim. Remembered on this Mac.
  const [spotlight, setSpotlight] = useState<string | null>(() => stored('spotlight', '') || null)
  useEffect(() => store('spotlight', spotlight ?? ''), [spotlight])
  const recentSnap = useRef<{ sort: string; at: Map<string, number> }>({ sort: '', at: new Map() })
  const sortedWindows = useMemo(() => {
    // One window per host, whatever the list says: a repeated React key would leave stray copies on screen.
    const known = allSessions.filter(({ s }, i) => s.host && openHosts.includes(s.host) && allSessions.findIndex((x) => x.s.host === s.host) === i)
    const pending = openHosts
      .filter((h) => !known.some(({ s }) => s.host === h))
      .map((h) => ({ host: h, project: '', title: 'Starting…', needs: false, last: Infinity, sid: null as string | null, myNote: undefined as string | undefined }))
    const list = [
      ...known.map(({ s, project }) => ({
        host: s.host!,
        project,
        title: s.title,
        needs: s.status === 'needs',
        last: s.lastActivity,
        sid: s.sid ?? (s.id.startsWith('tmux:') ? null : s.id), // notes belong to the conversation, whichever copy this is
        myNote: s.myNote
      })),
      ...pending
    ]
    const rank = (h: string) => (order.includes(h) ? order.indexOf(h) : order.length + openHosts.indexOf(h))
    if (sort !== 'recent') recentSnap.current.sort = sort // so picking "recent" again sorts afresh
    if (sort === 'waiting') return list.sort((a, b) => Number(b.needs) - Number(a.needs))
    // Sorted when you pick it (or a window opens), then held still, so the window you're typing in doesn't jump.
    if (sort === 'recent') {
      if (recentSnap.current.sort !== sort) recentSnap.current = { sort, at: new Map() }
      const at = recentSnap.current.at
      for (const w of list) if (!at.has(w.host)) at.set(w.host, w.last)
      return list.sort((a, b) => (at.get(b.host)! === at.get(a.host)! ? 0 : at.get(b.host)! > at.get(a.host)! ? 1 : -1))
    }
    if (sort === 'custom') return list.sort((a, b) => rank(a.host) - rank(b.host))
    return list
  }, [allSessions, openHosts, sort, order])
  const windows = useMemo(
    () => (spotlight && sortedWindows.some((w) => w.host === spotlight) ? [...sortedWindows].sort((a, b) => Number(b.host === spotlight) - Number(a.host === spotlight)) : sortedWindows),
    [sortedWindows, spotlight]
  )
  const spot = windows.length > 1 && windows.some((w) => w.host === spotlight) ? spotlight : null
  const toggleSpotlight = (host: string) => setSpotlight((cur) => (cur === host ? null : host))

  useEffect(() => {
    if (view === 'open' && !windows.length) setView('projects')
  }, [windows, view])

  // "From one project": the others stay mounted but hidden, so their terminals don't reconnect.
  const openProjects = useMemo(() => [...new Set(windows.map((w) => w.project).filter(Boolean))], [windows])
  useEffect(() => {
    if (only && !openProjects.includes(only)) setOnly('')
  }, [openProjects, only])
  const shown = useMemo(() => (only ? windows.filter((w) => w.project === only || !w.project) : windows), [windows, only])

  const one = layout === 'one'
  const n = shown.length
  // "By project" puts each project under its own small heading and starts it on a fresh row.
  const groups = useMemo(() => {
    const g: { project: string; hosts: string[] }[] = []
    for (const w of shown) {
      const last = g.at(-1)
      if (last && last.project === w.project) last.hosts.push(w.host)
      else g.push({ project: w.project, hosts: [w.host] })
    }
    return g
  }, [shown])
  const grouped = sort === 'project' && !one && !only && groups.length > 1
  const widest = grouped ? Math.max(...groups.map((g) => g.hosts.length)) : n
  const cols = one || layout === 'stack' ? 1 : layout === 'side' ? Math.max(1, widest) : widest <= 1 ? 1 : widest === 2 || widest === 4 ? 2 : 3
  const rows = grouped ? groups.map((g) => `auto repeat(${Math.ceil(g.hosts.length / cols)}, var(--row))`).join(' ') : undefined
  const headingFor = new Map(grouped ? groups.map((g) => [g.hosts[0], g.project || 'Starting']) : [])

  const closeWindow = (host: string) => setOpenHosts((hs) => hs.filter((h) => h !== host))
  const step = (dir: number) => {
    if (!n) return
    const i = shown.findIndex((w) => w.host === focusHost)
    reveal.current = true
    setFocusHost(shown[(i < 0 ? 0 : i + dir + n) % n].host)
  }
  const showProject = (p: string) => {
    setOnly(p)
    const first = (p ? windows.filter((w) => w.project === p) : windows)[0]
    if (first && p && windows.find((w) => w.host === focusHost)?.project !== p) setFocusHost(first.host)
    setTick((t) => t + 1)
  }
  // Any manual arrangement becomes the custom order.
  const arrange = (hosts: string[]) => {
    setOrder(hosts)
    setSort('custom')
  }
  const nudge = (dir: number) => {
    const hosts = shown.map((w) => w.host)
    const i = hosts.indexOf(focusHost ?? '')
    const j = i + dir
    if (i < 0 || j < 0 || j >= hosts.length) return
    ;[hosts[i], hosts[j]] = [hosts[j], hosts[i]]
    arrange(hosts)
  }
  const dropOn = (target: string, after: boolean) => {
    if (!dragging || dragging === target) return
    const hosts = shown.map((w) => w.host).filter((h) => h !== dragging)
    hosts.splice(hosts.indexOf(target) + (after ? 1 : 0), 0, dragging)
    arrange(hosts)
  }
  const toggleOne = (host = focusHost ?? shown[0]?.host) => {
    if (!host) return
    setFocusHost(host)
    setLayout((l) => (l === 'one' ? lastMulti.current : 'one'))
  }

  // Name, pin, star, and notes belong to the conversation. A Mason shell row carries the conversation it holds
  // (another copy, or one still starting); a bare shell with no conversation has none.
  const prefId = (s: SessionView) => s.sid ?? (s.id.startsWith('tmux:') ? null : s.id)
  const hasPrefs = (s: SessionView) => !!prefId(s)
  const rename = (s: SessionView, name: string) => {
    setRenaming(null)
    if (name.trim() !== s.title && prefId(s)) window.mason.rename(prefId(s)!, name)
  }
  const pin = (s: SessionView) => hasPrefs(s) && window.mason.pin(prefId(s)!, !s.pinned)
  const star = (s: SessionView) => hasPrefs(s) && window.mason.star(prefId(s)!, !s.starred)
  // The pen: brings back a tucked note, otherwise starts writing (or editing) one.
  const openNote = (key: string) => (tucked.has(key) ? tuck(key, false) : setNoting(key))
  const saveNote = (target: string, body: string | null) => {
    setNoting(null)
    if (body !== null) window.mason.setNote(target, body)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (peeking) {
        // Keys typed into the peeked terminal belong to Claude; only these close Peek.
        const inTerm = (e.target as Element).closest?.('.xterm')
        if ((e.metaKey && e.shiftKey && e.code === 'KeyW') || (e.key === 'Escape' && !inTerm)) {
          e.preventDefault()
          setPeeking(null)
        }
        return
      }
      if (e.metaKey && (e.key === '1' || e.key === '2')) {
        e.preventDefault()
        if (e.key === '2' && !openHosts.length) return
        return setView(e.key === '1' ? 'projects' : 'open')
      }
      if (view === 'open' && e.metaKey && windows.length) {
        const c = e.code
        if (c === 'BracketLeft' || c === 'BracketRight') {
          e.preventDefault()
          const dir = c === 'BracketRight' ? 1 : -1
          return e.shiftKey ? nudge(dir) : step(dir)
        }
        if (c === 'Enter') return e.preventDefault(), toggleOne()
        if (c === 'KeyL') return e.preventDefault(), setLayout((v) => cycle(LAYOUTS, v))
        if (c === 'KeyO') return e.preventDefault(), setSort((v) => cycle(SORTS, v))
        if (c === 'KeyP' && openProjects.length > 1) {
          e.preventDefault()
          const all = ['', ...openProjects]
          return showProject(all[(all.indexOf(only) + 1) % all.length])
        }
        if (c === 'KeyW' && e.shiftKey && focusHost) return e.preventDefault(), closeWindow(focusHost)
        if (c === 'KeyT' && !e.shiftKey && focusHost) {
          e.preventDefault()
          return void window.mason.terminalHere(focusHost).then(handle)
        }
        if (c === 'KeyN' && !e.shiftKey) {
          e.preventDefault()
          const sid = windows.find((w) => w.host === focusHost)?.sid
          return sid && openNote(`s:${sid}`)
        }
        if (c === 'KeyF' && e.shiftKey && focusHost) return e.preventDefault(), toggleSpotlight(focusHost)
        if (c === 'KeyK' && e.shiftKey && focusHost) return e.preventDefault(), ending === focusHost ? endWindow(focusHost) : setEnding(focusHost)
      }
      // In the Open tab every key belongs to the terminal (Claude uses Esc, arrows, etc.).
      if (view === 'open' || e.metaKey || e.ctrlKey || e.altKey) return
      if (view === 'projects' && (e.key === '/' || (e.metaKey && e.code === 'KeyF')) && !(e.target as Element).closest?.('input, textarea')) {
        e.preventDefault()
        return setFinding(true)
      }
      if ((e.target as Element).closest?.('input, textarea')) return
      const k = e.key.toLowerCase()
      if (e.key === '?') return e.preventDefault(), setKeysOpen((v) => !v)
      if (e.key === 'Escape') return setKeysOpen(false), setCursor(null), setConfirming(null)
      if (k === 's') return setShushed((v) => !v)
      if (k === 'a' && e.shiftKey) return starredCount ? openStarred() : undefined
      if (k === 'a') return openAll(allSessions.map(({ s }) => s))
      const sel = visibleRows.find((s) => s.id === cursor)
      if (k === 'r' && sel && hasPrefs(sel)) return e.preventDefault(), setRenaming(sel.id)
      if (k === 'p' && sel) return pin(sel)
      if (e.key === '*' && sel) return star(sel)
      if (e.key === ' ' && sel?.host) return e.preventDefault(), setPeeking({ host: sel.host, id: sel.id })
      if (k === 'n' && sel && hasPrefs(sel)) return e.preventDefault(), openNote(`s:${prefId(sel)}`)
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
  }, [visibleRows, cursor, view, openHosts, allSessions, windows, focusHost, layout, ending, shown, only, openProjects, peeking])

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

  return (
    <div className={`app view-${view}`}>
      {peeking && (() => {
        const hit = allSessions.find(({ s }) => s.host === peeking.host)
        if (!hit) return null
        return (
          <div className="peek-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPeeking(null)}>
            <div className="peek" role="dialog" aria-label={`Peek at ${hit.s.title}`}>
              <div className="peek-bar">
                <span className={`dot ${hit.s.status}`} />
                <b>
                  <span className="wp">{hit.project}</span>
                  {hit.s.title}
                </b>
                <span className="peek-hint">⌘⇧W or click outside to close</span>
                <button type="button" className="peek-open" onClick={() => (setPeeking(null), open(hit.s))}>
                  Open
                </button>
                <button type="button" className="x" aria-label="Close Peek" onClick={() => setPeeking(null)}>
                  ×
                </button>
              </div>
              <Term name={peeking.host} focus tick={0} peek />
            </div>
          </div>
        )
      })()}
      <div className="dragbar" aria-hidden="true" />
      <nav className="tabs" role="tablist">
        <button className="tab" role="tab" type="button" aria-selected={view === 'projects'} onClick={() => setView('projects')}>
          Projects
        </button>
        <button className="tab" role="tab" type="button" aria-selected={view === 'open'} disabled={!windows.length} onClick={() => setView('open')}>
          Open <span className="count">{windows.length}</span>
        </button>
        <button className="keys-btn" type="button" aria-expanded={keysOpen} aria-label="Help and shortcuts" title="Help and shortcuts (?)" onClick={() => setKeysOpen((v) => !v)}>
          <span className="help-q">?</span>
        </button>
        {keysOpen && (
          <div className="keys-pop" role="dialog" aria-label="Help and keyboard shortcuts">
            <h4>The dots</h4>
            {DOTS.map(([kind, label]) => (
              <div key={kind} className="help-row">
                <span className="help-dot">
                  <span className={`dot ${kind}`} />
                </span>
                <span>{label}</span>
              </div>
            ))}
            <h4>Type these in any Claude session</h4>
            {IN_CLAUDE.map(([cmd, label]) => (
              <div key={cmd} className="help-row">
                <code>{cmd}</code>
                <span>{label}</span>
              </div>
            ))}
            <p className="help-note">They’re saved without Claude taking a turn. Find them under Saved, at the bottom of Projects.</p>
            <h4>From any app</h4>
            <div>
              <span>Bring Mason forward</span>
              <span>
                <kbd>⌃</kbd>
                <kbd>⌥</kbd>
                <kbd>M</kbd>
              </span>
            </div>
            <div>
              <span>Quick capture a thought</span>
              <span>
                <kbd>⌃</kbd>
                <kbd>⌥</kbd>
                <kbd>N</kbd>
              </span>
            </div>
            {SHORTCUTS.map(([section, rows]) => (
              <Fragment key={section}>
                <h4>{section}</h4>
                {rows.map(([label, keys]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <span>
                      {keys.map((k, i) => (
                        <kbd key={i}>{k}</kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </Fragment>
            ))}
          </div>
        )}
      </nav>

      {/* Kept mounted (just hidden) so terminals don't reconnect every time you switch tabs. */}
      <section className="desk" hidden={view !== 'open'}>
        {(n > 1 || openProjects.length > 1) && (
          <p className="desk-bar">
            {n} sessions{' '}
            {openProjects.length > 1 && (
              <>
                from <Pick label="Project" value={only} options={[['', 'all projects'], ...openProjects.map((p): [string, string] => [p, p])]} onChange={showProject} />{' '}
              </>
            )}
            viewed <Pick label="Layout" value={layout} options={LAYOUTS} onChange={(v) => (setLayout(v), setTick((t) => t + 1))} /> organized{' '}
            <Pick label="Order" value={sort} options={SORTS} onChange={(v) => (setSort(v), setTick((t) => t + 1))} />
          </p>
        )}
        <div className={`wins ${cols === 1 ? 'col1' : ''} layout-${layout}`} style={{ ['--cols' as string]: cols, gridTemplateRows: rows }}>
          {windows.flatMap((w) => {
            const hidden = only && w.project && w.project !== only
            const focused = focusHost === w.host
            const drop = dropAt?.host === w.host ? (dropAt.after ? 'drop-after' : 'drop-before') : ''
            const heading = headingFor.get(w.host)
            return [
              heading && (
                <p className="group-name" key={`group:${heading}`}>
                  {heading}
                </p>
              ),
              <div
                key={w.host}
                data-host={w.host}
                className={`win ${focused && n > 1 && !one ? 'focused' : ''} ${spot && !one ? (spot === w.host ? 'spot' : 'dim') : ''} ${(one && !focused) || hidden ? 'gone' : ''} ${dragging === w.host ? 'dragging' : ''} ${drop}`}
                onFocusCapture={() => setFocusHost(w.host)}
                onDragOver={(e) => {
                  if (!dragging || dragging === w.host) return
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  const after = cols === 1 ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2
                  if (dropAt?.host !== w.host || dropAt.after !== after) setDropAt({ host: w.host, after })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dropAt?.host === w.host) dropOn(w.host, dropAt.after)
                  setDragging(null)
                  setDropAt(null)
                }}
              >
                <div
                  className="win-bar"
                  draggable={!one && n > 1}
                  title={one || n < 2 ? undefined : 'Drag to rearrange · double-click for one at a time'}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', w.title)
                    setDragging(w.host)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                    setDropAt(null)
                  }}
                  onDoubleClick={(e) => n > 1 && !(e.target as Element).closest('button') && toggleOne(w.host)}
                >
                  {w.needs && <span className="dot needs" title="Waiting on you" />}
                  <b>
                    {w.project && !grouped && !only && <span className="wp">{w.project}</span>}
                    {w.title}
                  </b>
                  {ending === w.host ? (
                    <>
                      <span className="ask">End this session?</span>
                      <button className="yes" type="button" onClick={() => endWindow(w.host)} title="Stop it and close the window. The conversation goes to paused so you can resume it.">
                        End
                      </button>
                      <button className="no" type="button" onClick={() => setEnding(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {n > 1 && (
                        <button
                          className={`x spot-x ${spot === w.host ? 'on' : ''}`}
                          type="button"
                          aria-label={spot === w.host ? 'Stop focusing on this window' : 'Focus on this window'}
                          title={spot === w.host ? 'Stop focusing (⌘⇧F)' : 'Focus on this window: it goes first and the others dim (⌘⇧F)'}
                          onClick={() => toggleSpotlight(w.host)}
                        >
                          <FocusIcon />
                        </button>
                      )}
                      {w.sid && (
                        <button
                          className={`x note-x ${w.myNote && tucked.has(`s:${w.sid}`) ? 'has-note' : ''}`}
                          type="button"
                          aria-label={w.myNote ? (tucked.has(`s:${w.sid}`) ? 'Show note' : 'Edit note') : 'Add a note'}
                          title={w.myNote ? (tucked.has(`s:${w.sid}`) ? 'Show note (⌘N)' : 'Edit note (⌘N)') : 'Add a note (⌘N)'}
                          onClick={() => openNote(`s:${w.sid}`)}
                        >
                          <NoteIcon />
                        </button>
                      )}
                      <button className="x" type="button" aria-label="Hide this window (the session keeps running)" title="Hide window · the session keeps running, reopen it from Projects (⌘⇧W)" onClick={() => closeWindow(w.host)}>
                        –
                      </button>
                      <button className="x" type="button" aria-label="End this session and close its window" title="End session · stops it and closes the window; it goes to paused (⌘⇧K)" onClick={() => setEnding(w.host)}>
                        ×
                      </button>
                    </>
                  )}
                </div>
                {w.sid && noting === `s:${w.sid}` ? (
                  <NoteEdit
                    initial={w.myNote ?? ''}
                    label={`Note on ${w.title}`}
                    onDone={(body) => {
                      saveNote(`s:${w.sid}`, body)
                      setFocusHost(w.host)
                      setTick((t) => t + 1) // straight back to typing in the terminal
                    }}
                  />
                ) : (
                  w.myNote &&
                  !tucked.has(`s:${w.sid}`) && <NoteView body={w.myNote} className="win-note" onEdit={() => setNoting(`s:${w.sid}`)} onTuck={() => tuck(`s:${w.sid}`, true)} />
                )}
                <Term name={w.host} focus={view === 'open' && focused && noting !== `s:${w.sid}`} tick={tick} />
              </div>
            ]
          })}
        </div>
      </section>

      <main className="col" hidden={view !== 'projects'}>
        {finding ? (
          <div className="top find">
            <SearchIcon />
            <input
              className="find-input"
              autoFocus
              value={query}
              placeholder="Find a session, live or past…  (* for starred)"
              aria-label="Find a session"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') return closeFind()
                if (e.key === 'Enter') {
                  const live = visibleRows[0]
                  if (live) return open(live)
                  if (found[0]) return resume(found[0].id)
                }
                if (e.key === 'ArrowDown' && visibleRows[0]) {
                  e.preventDefault()
                  setCursor(visibleRows[0].id)
                  e.currentTarget.blur()
                }
              }}
            />
            <button className="link" type="button" onClick={closeFind}>
              Close
            </button>
          </div>
        ) : (
        <div className="top">
          {note && <p className={`note ${note.tone}`}>{note.text}</p>}
          <div className="tools">
            {hosted.length > 0 && (
              <button className="pill" type="button" onClick={() => openAll(hosted.map(({ s }) => s))}>
                Open all {hosted.length}
              </button>
            )}
            {state?.canHost && starredCount > 0 && (
              <button className="pill" type="button" onClick={openStarred} title="Open every starred session here; paused ones resume (⇧A)">
                <StarIcon filled />
                <span>Open starred {starredCount}</span>
              </button>
            )}
            <button className="pill" type="button" onClick={() => setFinding(true)} title="Find a session, live or past (/)">
              <SearchIcon />
              <span>Find</span>
            </button>
            <button className="pill" type="button" aria-pressed={shushed} onClick={() => setShushed((v) => !v)}>
              <ShushIcon />
              <span>{shushed ? 'Shushed' : 'Shush'}</span>
            </button>
          </div>
        </div>
        )}

        {!state ? (
          <p className="empty">Reading your sessions…</p>
        ) : q && !projects.length ? (
          !found.length && <p className="empty">Nothing matches “{q}”.</p>
        ) : state.projects.length === 0 ? (
          <p className="empty">Nothing is running right now. Resume a session from paused below, or add a project.</p>
        ) : (
          <div>
            {projects.map((p) => {
              const waiting = p.sessions.filter((s) => s.status === 'needs').length
              const moving = p.sessions.some((s) => s.status === 'working')
              const inMason = p.sessions.filter((s) => s.host)
              return (
                <details key={p.id} className="proj" open={isOpen(p.id)} onToggle={(e) => toggleProject(p.id, (e.target as HTMLDetailsElement).open)}>
                  <summary>
                    <Chevron />
                    {renamingProject === p.id ? (
                      <ProjectName
                        initial={p.name}
                        onDone={(name) => {
                          setRenamingProject(null)
                          if (name !== null && name.trim() !== p.name) window.mason.renameProject(p.id, name)
                        }}
                      />
                    ) : (
                      <>
                        <span className="proj-name serif">{p.name}</span>
                        <button
                          className="proj-rename"
                          type="button"
                          aria-label={`Rename ${p.name}`}
                          title="Rename this project"
                          onClick={(e) => {
                            e.preventDefault() // don't fold the project
                            setRenamingProject(p.id)
                          }}
                        >
                          <RenameIcon />
                        </button>
                      </>
                    )}
                    {waiting ? (
                      <span className="hint wait">
                        <span className="dot needs" />
                        {waiting} waiting
                      </span>
                    ) : (
                      <span className="hint">
                        <span className={`dot ${moving ? 'working' : ''}`} />
                        {p.sessions.length ? `${p.sessions.length} session${p.sessions.length > 1 ? 's' : ''}` : 'nothing running'}
                      </span>
                    )}
                  </summary>
                  <div className="projacts">
                    {state.canHost && (
                      <button className="link" type="button" onClick={() => newSession(p.id)}>
                        + New session
                      </button>
                    )}
                    {state.canHost && (
                      <button className="link" type="button" onClick={() => newTerminal(p.id)} title="A plain terminal in this project’s folder, kept inside Mason">
                        + New terminal
                      </button>
                    )}
                    {p.kept && !p.sessions.length && (
                      <button className="link" type="button" onClick={() => window.mason.forgetProject(p.id)} title="Take it off the list (the folder isn’t touched)">
                        Remove
                      </button>
                    )}
                    {state.canHost && inMason.length > 1 && (
                      <button className="link" type="button" onClick={() => openAll(inMason)}>
                        Open all {inMason.length}
                      </button>
                    )}
                    {noting !== `p:${p.id}` && (!p.myNote || tucked.has(`p:${p.id}`)) && (
                      <button className={`link pen-link ${p.myNote ? 'has-note' : ''}`} type="button" onClick={() => openNote(`p:${p.id}`)} title={p.myNote ? 'Show note' : 'Add a note'}>
                        <NoteIcon />
                        Note
                      </button>
                    )}
                  </div>
                  {noting === `p:${p.id}` ? (
                    <NoteEdit initial={p.myNote ?? ''} label={`Note on ${p.name}`} onDone={(body) => saveNote(`p:${p.id}`, body)} />
                  ) : (
                    p.myNote &&
                    !tucked.has(`p:${p.id}`) && <NoteView body={p.myNote} className="my-note proj-note" onEdit={() => setNoting(`p:${p.id}`)} onTuck={() => tuck(`p:${p.id}`, true)} />
                  )}
                  <div className="body">
                    {p.sessions.map((s) => (
                      <Row
                        key={s.id}
                        s={s}
                        cursor={cursor === s.id}
                        note={rowNote?.id === s.id ? rowNote.note : null}
                        confirming={confirming === s.id}
                        renaming={renaming === s.id}
                        canHost={!!state.canHost}
                        onRename={hasPrefs(s) ? () => setRenaming(s.id) : undefined}
                        onRenamed={(name) => (name === null ? setRenaming(null) : rename(s, name))}
                        onPin={hasPrefs(s) ? () => pin(s) : undefined}
                        onStar={hasPrefs(s) ? () => star(s) : undefined}
                        onPeek={s.host ? () => setPeeking({ host: s.host!, id: s.id }) : undefined}
                        noting={noting === `s:${prefId(s)}`}
                        tucked={tucked.has(`s:${prefId(s)}`)}
                        onTuck={(on) => tuck(`s:${prefId(s)}`, on)}
                        onEditNote={() => setNoting(`s:${prefId(s)}`)}
                        onNote={hasPrefs(s) ? () => openNote(`s:${prefId(s)}`) : undefined}
                        onNoted={(body) => saveNote(`s:${prefId(s)}`, body)}
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
        {state?.canHost && !q && (
          <button className="link new-project" type="button" onClick={addProject} title="Pick or create a folder to work in">
            + New project
          </button>
        )}

        {q && found.length > 0 && (
          <div className="past">
            <h3>Past conversations</h3>
            {found.map((f) => (
              <button className="mini resumable" type="button" key={f.id} disabled={!state?.canHost} onClick={() => resume(f.id)} title="Resume it inside Mason">
                <div className="mini-text">
                  <span className="mini-title">
                    {f.title}
                    {f.starred && (
                      <span className="starred" title="Starred">
                        <StarIcon filled />
                      </span>
                    )}
                    <small>
                      {f.project} · {ago(f.lastActivity)}
                    </small>
                  </span>
                  {f.pickUp && (
                    <span className="mini-sub" title={f.pickUp}>
                      Last: {f.pickUp}
                    </span>
                  )}
                </div>
                {state?.canHost && <span className="acts resume-hint">Resume</span>}
              </button>
            ))}
          </div>
        )}

        {state && !q && (
          <div className="foot">
            <div className="foot-links">
              {state.paused.length > 0 && (
                <button className="foot-btn" type="button" aria-expanded={foot === 'paused'} onClick={() => setFoot(foot === 'paused' ? null : 'paused')}>
                  {state.paused.length} paused
                </button>
              )}
              {state.doneToday.length > 0 && (
                <button className="foot-btn" type="button" aria-expanded={foot === 'done'} onClick={() => setFoot(foot === 'done' ? null : 'done')}>
                  {state.doneToday.length} done today
                </button>
              )}
              <button
                className="foot-btn"
                type="button"
                aria-expanded={foot === 'saved'}
                onClick={() => setFoot(foot === 'saved' ? null : 'saved')}
                title="Things you parked with /stash in Claude, or ⌃⌥N from any app"
              >
                {state.saved.length ? `${state.saved.length} saved` : 'Saved'}
              </button>
              <button className="foot-btn" type="button" aria-expanded={foot === 'scratch'} onClick={() => setFoot(foot === 'scratch' ? null : 'scratch')}>
                Scratchpad
              </button>
            </div>
            {foot === 'scratch' && <Scratch initial={state.scratch} />}
            {foot === 'paused' && (
              <div className="foot-panel">
                {state.paused.map((p) => (
                  <div className="mini-wrap" key={p.id}>
                    <button className="mini resumable" type="button" disabled={!state.canHost} onClick={() => resume(p.id)} title="Resume it inside Mason">
                    <div className="mini-text">
                      <span className="mini-title">
                        {p.title}
                        {p.starred && (
                          <span className="starred" title="Starred">
                            <StarIcon filled />
                          </span>
                        )}
                        <small>
                          {p.project} · {ago(p.lastActivity)}
                        </small>
                      </span>
                      {p.pickUp && (
                        <span className="mini-sub" title={p.pickUp}>
                          {p.handoff ? `Paused at: ${p.pickUp}` : p.next ? p.pickUp : `Last: ${p.pickUp}`}
                        </span>
                      )}
                      {p.next && (
                        <span className="mini-sub next" title={p.next}>
                          Next: {p.next}
                        </span>
                      )}
                      {p.myNote && (
                        <span className="mini-sub my-note-line" title={p.myNote}>
                          <NoteIcon />
                          {p.myNote}
                        </span>
                      )}
                    </div>
                    {state.canHost && <span className="acts resume-hint">Resume</span>}
                    </button>
                    {p.handoff &&
                      (editingHandoff === p.id ? (
                        <NoteEdit
                          initial={p.handoff.brief}
                          label="Handoff brief for a fresh session"
                          onDone={(brief) => {
                            setEditingHandoff(null)
                            if (brief !== null) window.mason.editHandoff(p.id, brief)
                          }}
                        />
                      ) : (
                        <div className="mini-acts">
                          {state.canHost && p.handoff.brief && (
                            <button className="link" type="button" onClick={() => fresh(p.id)} title="Start a brand-new Claude briefed by the handoff, instead of reopening the whole long conversation">
                              Fresh start
                            </button>
                          )}
                          <button className="link" type="button" onClick={() => setEditingHandoff(p.id)} title="Change the brief a fresh session starts from">
                            Edit handoff
                          </button>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            )}
            {foot === 'saved' && (
              <div className="foot-panel">
                {state.saved.length === 0 && (
                  <p className="empty-help">
                    Nothing parked yet. Type <code>/stash</code> in any Claude session to keep its last reply, or <code>/stash idea …</code> for a
                    thought to come back to. From any app, <kbd>⌃</kbd><kbd>⌥</kbd><kbd>N</kbd> opens a quick capture box.
                  </p>
                )}
                {state.saved.map((i) => (
                  <SavedRow key={i.id} item={i} />
                ))}
              </div>
            )}
            {foot === 'done' && (
              <div className="foot-panel">
                {state.doneToday.map((d) => (
                  <div className="mini" key={d.id}>
                    <div className="mini-text">
                      <span className="mini-title">
                        {d.title}
                        <small>{d.project}</small>
                      </span>
                      {d.what && <span className="mini-sub" title={d.what}>{d.what}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {state && !state.canHost && <p className="note muted">Install tmux (brew install tmux) to open sessions inside Mason.</p>}

        <footer className="meta">
          <span>Mason 0.3</span>
          {state && (
            <span className="theme">
              <button
                type="button"
                aria-pressed={state.summaries}
                onClick={() => window.mason.setSummaries(!state.summaries)}
                title={
                  state.summaries
                    ? 'Summaries are on: Claude names each session and notes where you were. This sends a short excerpt of each conversation to Claude. Click to turn off.'
                    : 'Summaries are off. Click to let Claude name each session and note where you were.'
                }
              >
                Summaries {state.summaries ? 'on' : 'off'}
              </button>
            </span>
          )}
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
  renaming: boolean
  canHost: boolean
  onRename?: () => void
  onRenamed: (name: string | null) => void // null: cancelled
  onPin?: () => void
  onStar?: () => void
  onPeek?: () => void
  noting: boolean
  tucked: boolean
  onTuck: (on: boolean) => void
  onEditNote: () => void
  onNote?: () => void
  onNoted: (body: string | null) => void // null: cancelled
  onOpen: () => void
  onMove: () => void
  onEnd: () => void
  onConfirmEnd: () => void
  onCancelEnd: () => void
}

function Row({ s, cursor, note, confirming, renaming, canHost, onRename, onRenamed, onPin, onStar, onPeek, noting, tucked, onTuck, onEditNote, onNote, onNoted, onOpen, onMove, onEnd, onConfirmEnd, onCancelEnd }: RowProps) {
  const inTerminal = !s.host
  const settled = useRef(false) // Enter or Esc already decided; the blur that follows shouldn't save again
  useEffect(() => {
    if (renaming) settled.current = false
  }, [renaming])
  const finish = (name: string | null) => {
    if (settled.current) return
    settled.current = true
    onRenamed(name)
  }
  const endHint = s.term
    ? 'Close this terminal. Anything still running in it stops.'
    : s.id.startsWith('tmux:')
    ? 'Close this Mason shell (Claude isn’t running in it)'
    : inTerminal
      ? 'Stop Claude in its Terminal window. The window stays open, and the conversation goes to paused so you can resume it.'
      : 'Stop this session. The conversation goes to paused so you can resume it.'
  return (
    <div className={`item ${cursor ? 'cursor' : ''}`}>
      <div className="row">
        {renaming ? (
          <span className="main-btn">
            <span className="title">
              <span className={`dot ${s.status}`} />
              <input
                className="rename"
                autoFocus
                defaultValue={s.title}
                maxLength={80}
                aria-label="Session name (leave empty to use Claude’s title)"
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') finish(e.currentTarget.value)
                  if (e.key === 'Escape') finish(null)
                }}
                onBlur={(e) => finish(e.currentTarget.value)}
              />
            </span>
            {s.now && <span className="now">{s.now}</span>}
          </span>
        ) : (
          <button className="main-btn" type="button" onClick={onOpen} title={inTerminal ? 'Bring its Terminal window to the front' : 'Open'}>
            <span className="title">
              <span className={`dot ${s.status}`} />
              <span className="title-text">{s.title}</span>
              {s.starred && (
                <span className="starred" title="Starred">
                  <StarIcon filled />
                </span>
              )}
              {s.pinned && (
                <span className="pinned" title="Pinned">
                  <PinIcon />
                </span>
              )}
              {s.status === 'needs' && <span className="tag">waiting</span>}
              {inTerminal && <span className="where">in Terminal</span>}
              {s.term && <span className="where">terminal</span>}
            </span>
            {note ? <span className={`toast ${note.tone}`}>{note.text}</span> : s.now && <span className="now">{s.now}</span>}
            {!note && s.next && <span className="now next">Next: {s.next}</span>}
          </button>
        )}
        {s.myNote && tucked && (
          <button className="note-badge" type="button" onClick={() => onTuck(false)} aria-label="Show note" title="Show note (N)">
            <NoteIcon />
          </button>
        )}
        {confirming ? (
          <span className="acts confirming">
            <span className="ask">End it?</span>
            <button className="yes" type="button" onClick={onConfirmEnd} title={endHint}>
              End
            </button>
            <button type="button" onClick={onCancelEnd} title="Keep it running">
              Cancel
            </button>
          </span>
        ) : (
          <span className="acts">
            {onPeek && (
              <button className="icon" type="button" onClick={onPeek} aria-label="Peek" title="Peek: see it big and answer it here (Space)">
                <PeekIcon />
              </button>
            )}
            {onRename && (
              <button className="icon" type="button" onClick={onRename} aria-label="Rename" title="Rename (R)">
                <RenameIcon />
              </button>
            )}
            {onNote && (
              <button className="icon" type="button" onClick={onNote} aria-label={s.myNote ? 'Edit note' : 'Add a note'} title={s.myNote ? 'Edit note (N)' : 'Add a note (N)'}>
                <NoteIcon />
              </button>
            )}
            {onStar && (
              <button className="icon" type="button" onClick={onStar} aria-label={s.starred ? 'Unstar' : 'Star'} title={s.starred ? 'Unstar (*)' : 'Star (*)'}>
                <StarIcon filled={s.starred} />
              </button>
            )}
            {onPin && (
              <button className="icon" type="button" onClick={onPin} aria-label={s.pinned ? 'Unpin' : 'Pin'} title={s.pinned ? 'Unpin (P)' : 'Pin to the top of its project (P)'}>
                <PinIcon filled={s.pinned} />
              </button>
            )}
            {inTerminal && canHost && (
              <button type="button" onClick={onMove} title="Stop it in Terminal and continue the same conversation inside Mason">
                Move here
              </button>
            )}
            <button className="end" type="button" onClick={onEnd} title={endHint}>
              End
            </button>
          </span>
        )}
      </div>
      {noting ? (
        <NoteEdit initial={s.myNote ?? ''} label={`Note on ${s.title}`} onDone={onNoted} />
      ) : (
        s.myNote && !tucked && <NoteView body={s.myNote} className="my-note" onEdit={onEditNote} onTuck={() => onTuck(true)} />
      )}
    </div>
  )
}

// Editing a note: Enter saves, Shift+Enter is a new line; Esc or clicking away also saves (never thrown away by accident).
// Clearing it removes the note.
function NoteEdit({ initial, label, onDone }: { initial: string; label: string; onDone: (body: string | null) => void }) {
  const settled = useRef(false)
  const finish = (body: string | null) => {
    if (settled.current) return
    settled.current = true
    onDone(body)
  }
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  return (
    <textarea
      className="note-edit"
      autoFocus
      rows={1}
      defaultValue={initial}
      maxLength={20000}
      aria-label={label}
      placeholder="A note for future you… (Enter to save, Shift+Enter for a new line)"
      ref={(el) => el && grow(el)}
      onInput={(e) => grow(e.currentTarget)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
          e.preventDefault()
          finish(e.currentTarget.value)
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  )
}

// Renaming a project in place. It sits inside the project's <summary>, so clicks and keys mustn't fold it.
// Enter or clicking away saves, Esc cancels; empty goes back to the folder name.
function ProjectName({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const settled = useRef(false)
  const finish = (name: string | null) => {
    if (settled.current) return
    settled.current = true
    onDone(name)
  }
  return (
    <input
      className="rename proj-name-edit serif"
      autoFocus
      defaultValue={initial}
      maxLength={60}
      aria-label="Project name (leave empty to use the folder name)"
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === ' ') e.preventDefault(), document.execCommand('insertText', false, ' ')
        if (e.key === 'Enter') e.preventDefault(), finish(e.currentTarget.value)
        if (e.key === 'Escape') finish(null)
      }}
      onKeyUp={(e) => e.preventDefault()}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  )
}

// A saved note. Folds after a few lines, with a fade and "more" when there's more below; ▴ tucks it away.
function NoteView({ body, className, onEdit, onTuck }: { body: string; className: string; onEdit: () => void; onTuck: () => void }) {
  const text = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (!el) return
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [body, open])
  return (
    <div className={`note-view ${className} ${open ? 'open' : ''} ${overflows ? 'folded' : ''}`}>
      <NoteIcon />
      <button className="note-body" type="button" onClick={onEdit} title="Edit note">
        <span ref={text}>{body}</span>
      </button>
      <span className="note-tools">
        {(overflows || open) && (
          <button type="button" onClick={() => setOpen((o) => !o)}>
            {open ? 'less ▴' : 'more ▾'}
          </button>
        )}
        <button className="note-tuck" type="button" onClick={onTuck} aria-label="Tuck note away" title="Tuck away · the pen brings it back">
          ▴
        </button>
      </span>
    </div>
  )
}

// One free-floating page for whatever's in your head. Saves as you type.
function Scratch({ initial }: { initial: string }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const save = (body: string) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => window.mason.setNote('scratch', body), 500)
  }
  return (
    <textarea
      className="scratch"
      autoFocus
      defaultValue={initial}
      maxLength={20000}
      aria-label="Scratchpad"
      placeholder="Anything you don’t want to hold in your head. Saves as you type."
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => save(e.currentTarget.value)}
      onBlur={(e) => (clearTimeout(timer.current), window.mason.setNote('scratch', e.currentTarget.value))}
    />
  )
}

// A dropdown that reads as part of a sentence: the current words and a small chevron, with the native
// select laid invisibly on top so it sizes to the words, not to its longest option.
function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <label className="pick">
      {options.find(([v]) => v === value)?.[1]}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </label>
  )
}

const KIND_LABEL = { message: 'Claude said', idea: 'Idea', later: 'Come back to' } as const

// One parked item. Long ones fold to three lines; Copy and Remove sit on hover like everywhere else.
function SavedRow({ item }: { item: AppState['saved'][number] }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const long = item.body.length > 220 || item.body.split('\n').length > 3
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }
  return (
    <div className="mini saved">
      <div className="mini-text">
        <span className="mini-sub">
          <b className={`kind ${item.kind}`}>{KIND_LABEL[item.kind]}</b>
          {item.from ? ` · from ${item.from}` : ''} · {ago(item.at)}
        </span>
        <span className={`saved-body ${long && !open ? 'clamped' : ''}`}>{item.body}</span>
        {long && (
          <button className="link" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? 'less' : 'more'}
          </button>
        )}
      </div>
      <span className="acts">
        <button type="button" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button className="end" type="button" onClick={() => window.mason.removeSaved(item.id)}>
          Remove
        </button>
      </span>
    </div>
  )
}
