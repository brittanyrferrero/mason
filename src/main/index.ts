import { app, BrowserWindow, ipcMain, nativeTheme, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { existsSync, watch, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DATA_DIR, openDb, type DB } from './db'
import { EVENTS_FILE, pruneNeeds, readEvents, writeHookScript } from './events'
import { CLAUDE_PROJECTS, ingestAll } from './ingest'
import { CLAUDE_SESSIONS, readLive } from './live'
import { projectIdFor } from './projects'
import * as term from './pty'
import { briefFile, editHandoff, HANDOFF_DIR, readHandoffs, takeHandoffs, writePauseScript } from './handoff'
import { buildState } from './state'
import { initSummaries, setSummaries, summarizeDue } from './summarize'
import { focusTerminalTab } from './terminal'
import { endSession, initTmux, listHosted, NAME_RE, peek, scroll, SESSION_ID_RE, startSession, TMUX, unscroll } from './tmux'

let db: DB
let win: BrowserWindow | null = null

const DEV_URL = process.env['ELECTRON_RENDERER_URL']

// Only our own bundled page may talk to the main process.
function trusted(e: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const url = e.senderFrame?.url ?? ''
  return url.startsWith('file://') || (!!DEV_URL && url.startsWith(DEV_URL))
}

function projectFor(cwd: string) {
  const id = projectIdFor(db, cwd)
  return db.prepare('SELECT id, name FROM projects WHERE id = ?').get(id) as { id: number; name: string }
}

function state() {
  const live = readLive()
  const needs = readEvents()
  pruneNeeds(new Set(live.keys()))
  return buildState(db, live, needs, listHosted(), projectFor, !!TMUX)
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function pushState(): void {
  const s = state()
  // The Dock badge counts sessions waiting on you, so you can see it from anywhere.
  const waiting = s.projects.reduce((n, p) => n + p.sessions.filter((x) => x.status === 'needs').length, 0)
  app.dock?.setBadge(waiting ? String(waiting) : '')
  send('state:changed', s)
}

const waitForExit = async (pid: number, ms: number) => {
  for (let t = 0; t < ms; t += 200) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

let pending: NodeJS.Timeout | undefined
function refreshSoon(reingest: boolean): void {
  clearTimeout(pending)
  pending = setTimeout(() => {
    if (reingest) ingestAll(db)
    pushState()
  }, 400)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1080,
    height: 820,
    minWidth: 420,
    minHeight: 400,
    title: 'Mason',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#f7f7f5',
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  // Developer check: render off-screen to a PNG and exit (`--snapshot=out.png`, optional `--theme=dark`).
  const snap = process.argv.find((a) => a.startsWith('--snapshot='))?.split('=')[1]
  if (snap) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', (e as any).message ?? ''))
    const theme = process.argv.find((a) => a.startsWith('--theme='))?.split('=')[1]
    if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        // Optional `--keys=a` presses keys first, e.g. "a" (Open all) to capture the Open tab.
        const keys = process.argv.find((a) => a.startsWith('--keys='))?.split('=')[1] ?? ''
        // Wait until the list has rendered before pressing anything.
        for (let i = 0; i < 40 && !(await win!.webContents.executeJavaScript(`!!document.querySelector('.proj')`)); i++) await new Promise((r) => setTimeout(r, 250))
        for (const key of keys) {
          const r = await win!.webContents.executeJavaScript(`(${JSON.stringify(key)} === "!" ? document.querySelector(".pill").click() : window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)} }))); document.querySelector('.tab[aria-selected=true]')?.textContent + ' wins=' + document.querySelectorAll('.win').length`)
          console.log('[snapshot] after key', key, r)
          await new Promise((r) => setTimeout(r, 2500))
          console.log('[snapshot] later', await win!.webContents.executeJavaScript(`document.querySelector('.tab[aria-selected=true]')?.textContent + ' wins=' + document.querySelectorAll('.win').length + ' hidden=' + document.querySelector('.desk')?.hidden`))
        }
        writeFileSync(snap, (await win!.webContents.capturePage()).toPNG())
        app.exit(0)
      }, 3000)
    )
  } else {
    win.once('ready-to-show', () => win?.show())
  }
  win.on('closed', () => {
    term.detachAll()
    win = null
  })
  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// Developer checks run alongside a normal Mason, so they skip the one-copy-only rule.
const DEV_CHECK = process.argv.some((a) => a === '--dump-state' || a.startsWith('--snapshot='))
if (!DEV_CHECK && !app.requestSingleInstanceLock()) app.quit()

app.on('second-instance', () => {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.focus()
})

// Lock the renderer down: no navigation away, no new windows, no browser permissions.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault())
  contents.on('will-attach-webview', (e) => e.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

  db = openDb()
  initSummaries(db)
  ingestAll(db)

  // Developer check: print what Mason sees and exit, without opening a window.
  if (process.argv.includes('--dump-state')) {
    process.stdout.write(JSON.stringify(state(), null, 2) + '\n', () => app.exit(0))
    return
  }

  initTmux()
  writeHookScript()
  writePauseScript()
  ipcMain.handle('state:get', (e) => (trusted(e) ? state() : null))

  // Open: a session inside Mason opens in the Open tab; one in a Terminal window gets brought to the front.
  // Which Mason shell a running copy is in: Claude's own record of its tmux pane, else matching the terminal.
  const hostFor = (c: { tty?: string; tmux?: string }): string | undefined => {
    const hosted = listHosted()
    return (c.tmux && hosted.find((h) => h.name === c.tmux)?.name) || (c.tty ? hosted.find((h) => h.tty === c.tty)?.name : undefined)
  }

  ipcMain.handle('session:open', async (e, id: unknown) => {
    if (!trusted(e) || typeof id !== 'string') return { ok: false }
    if (id.startsWith('tmux:')) return { host: id.slice(5) }
    const live = readLive().get(id)
    if (!live) return { ok: false }
    const host = hostFor(live)
    if (host) return { host }
    return { ok: !!live.tty && (await focusTerminalTab(live.tty)) }
  })

  // New Claude session in a project's folder, hosted inside Mason.
  ipcMain.handle('session:new', (e, projectId: unknown) => {
    if (!trusted(e) || typeof projectId !== 'number') return { error: 'bad request' }
    const p = db.prepare('SELECT root FROM projects WHERE id = ?').get(projectId) as { root: string } | undefined
    if (!p || !existsSync(p.root)) return { error: 'That project folder no longer exists.' }
    const host = startSession(p.root)
    refreshSoon(false)
    return { host }
  })

  // Pick a closed session back up, inside Mason.
  ipcMain.handle('session:resume', (e, id: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || !SESSION_ID_RE.test(id)) return { error: 'bad request' }
    // Already running: open it rather than starting a second copy.
    const live = readLive().get(id)
    if (live) {
      const host = hostFor(live)
      return host ? { host } : { error: 'It’s already running in a Terminal window. Use “Move here” to bring it in.' }
    }
    // Mason already has a shell for it (maybe Claude is still starting there): show that instead of starting another copy.
    const shell = listHosted().find((h) => h.resume === id && peek(h.name) !== 'shell')
    if (shell) return { host: shell.name }
    const s = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(id) as { cwd: string | null } | undefined
    if (!s?.cwd || !existsSync(s.cwd)) return { error: 'Its folder no longer exists.' }
    const host = startSession(s.cwd, id)
    refreshSoon(false)
    return { host }
  })

  // Move a session that's running in a Terminal window into Mason: stop it there, resume the same conversation here.
  ipcMain.handle('session:move', async (e, id: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || !SESSION_ID_RE.test(id)) return { error: 'bad request' }
    const live = readLive().get(id)
    const cwd = live?.cwd ?? (db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(id) as { cwd: string } | undefined)?.cwd
    if (!live || !cwd || !existsSync(cwd)) return { error: 'Couldn’t find that session.' }
    if (live.copies > 1) return { error: 'That conversation is running in more than one place. End the extra copies first.' }
    // Already inside Mason: just show it, never stop it.
    const already = (live.tty ? listHosted().find((h) => h.tty === live.tty) : undefined) ?? listHosted().find((h) => h.resume === id && peek(h.name) !== 'shell')
    if (already) return { host: already.name }
    process.kill(live.pid, 'SIGTERM')
    if (!(await waitForExit(live.pid, 6000))) return { error: 'It didn’t stop in time. Try again in a moment.' }
    const host = startSession(cwd, id)
    refreshSoon(false)
    return { host }
  })

  // Your own name for a session (empty clears it, back to Claude's title) and whether it's pinned.
  // Your notes. Empty means remove.
  ipcMain.handle('note:set', (e, target: unknown, body: unknown) => {
    if (!trusted(e) || typeof target !== 'string' || typeof body !== 'string' || body.length > 20_000) return false
    const [kind, id] = target.split(':')
    const ok = target === 'scratch' || (kind === 's' && SESSION_ID_RE.test(id ?? '')) || (kind === 'p' && /^\d+$/.test(id ?? ''))
    if (!ok) return false
    if (body.trim()) db.prepare('INSERT INTO my_notes (target, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(target) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at').run(target, body.replace(/\s+$/, ''), Date.now())
    else db.prepare('DELETE FROM my_notes WHERE target = ?').run(target)
    pushState()
    return true
  })

  ipcMain.handle('summaries:set', (e, on: unknown) => {
    if (!trusted(e) || typeof on !== 'boolean') return false
    setSummaries(db, on)
    pushState()
    return true
  })

  ipcMain.handle('session:rename', (e, id: unknown, name: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || !SESSION_ID_RE.test(id) || typeof name !== 'string') return false
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80)
    db.prepare('INSERT INTO session_prefs (session_id, name) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET name = excluded.name').run(id, clean || null)
    pushState()
    return true
  })
  ipcMain.handle('session:pin', (e, id: unknown, pinned: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || !SESSION_ID_RE.test(id) || typeof pinned !== 'boolean') return false
    db.prepare('INSERT INTO session_prefs (session_id, pinned) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET pinned = excluded.pinned').run(id, pinned ? 1 : 0)
    pushState()
    return true
  })

  // /pause: file the handoff note, then stop that copy of the session once Claude has had a moment to reply.
  const takePauses = () => {
    for (const { sid, pid } of takeHandoffs(db)) {
      setTimeout(() => {
        const live = readLive().get(sid)
        const copy = live && (live.pid === pid ? live : live.extra.find((c) => c.pid === pid))
        if (!copy) return // already gone, or the pid isn't a copy of that session: never signal a stranger
        const host = hostFor(copy)
        if (host) {
          term.detach(host)
          endSession(host)
        } else process.kill(pid, 'SIGTERM')
        refreshSoon(false)
      }, 4000)
    }
    refreshSoon(false)
  }
  takePauses()

  ipcMain.handle('handoff:edit', (e, id: unknown, brief: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || !SESSION_ID_RE.test(id) || typeof brief !== 'string') return false
    const ok = editHandoff(db, id, brief)
    pushState()
    return ok
  })

  // Fresh start: a brand-new Claude in the same folder, briefed by the handoff instead of the whole old conversation.
  ipcMain.handle('session:fresh', (e, id: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || !SESSION_ID_RE.test(id)) return { error: 'bad request' }
    const h = readHandoffs(db).get(id)
    const s = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(id) as { cwd: string | null } | undefined
    if (!h?.brief) return { error: 'That session has no handoff to start from.' }
    if (!s?.cwd || !existsSync(s.cwd)) return { error: 'Its folder no longer exists.' }
    const host = startSession(s.cwd, undefined, briefFile(id, h.brief))
    refreshSoon(false)
    return { host }
  })

  // End: close a Mason session, or stop Claude in a Terminal window (the window itself stays).
  ipcMain.handle('session:end', (e, id: unknown) => {
    if (!trusted(e) || typeof id !== 'string') return false
    if (id.startsWith('tmux:')) {
      term.detach(id.slice(5))
      endSession(id.slice(5))
    } else {
      const live = readLive().get(id)
      if (!live) return false
      const host = hostFor(live)
      if (host) {
        term.detach(host)
        endSession(host)
      } else process.kill(live.pid, 'SIGTERM')
    }
    refreshSoon(false)
    return true
  })

  // Terminals in the Open tab. Each window is one attached tmux client; closing it only detaches.
  ipcMain.handle('term:attach', (e, name: unknown, cols: unknown, rows: unknown) => {
    if (!trusted(e) || typeof name !== 'string' || !NAME_RE.test(name)) return false
    if (!listHosted().some((h) => h.name === name)) return false
    return term.attach(
      name,
      Number(cols),
      Number(rows),
      (data) => send('term:data', name, data),
      () => {
        send('term:exit', name)
        refreshSoon(false)
      }
    )
  })
  ipcMain.on('term:input', (e, name: unknown, data: unknown) => {
    if (!trusted(e) || typeof name !== 'string' || typeof data !== 'string') return
    unscroll(name)
    term.write(name, data)
  })
  ipcMain.on('term:scroll', (e, name: unknown, lines: unknown) => {
    if (trusted(e) && typeof name === 'string') scroll(name, Number(lines))
  })
  ipcMain.on('term:resize', (e, name: unknown, cols: unknown, rows: unknown) => {
    if (trusted(e) && typeof name === 'string') term.resize(name, Number(cols), Number(rows))
  })
  ipcMain.on('term:detach', (e, name: unknown) => {
    if (trusted(e) && typeof name === 'string') term.detach(name)
  })

  // Transcripts change as Claude works; the sessions folder changes as Claude starts, stops, or goes busy/idle.
  try {
    watch(CLAUDE_PROJECTS, { recursive: true }, (_ev, f) => f?.endsWith('.jsonl') && refreshSoon(true))
  } catch {}
  try {
    watch(CLAUDE_SESSIONS, () => refreshSoon(false))
  } catch {}
  // Hooks append here the moment Claude asks for permission or a question, so react quickly.
  try {
    watch(DATA_DIR, (_ev, f) => f === basename(EVENTS_FILE) && refreshSoon(false))
  } catch {}
  try {
    watch(HANDOFF_DIR, (_ev, f) => f?.endsWith('.handoff') && setTimeout(takePauses, 300))
  } catch {}
  // A crashed Claude leaves its status file behind; a slow poll notices the process is gone.
  setInterval(() => refreshSoon(false), 10_000)
  // Summaries catch up quietly in the background, one session at a time.
  const summarize = () => {
    const busy = new Set([...readLive()].filter(([, l]) => l.status === 'working').map(([id]) => id))
    summarizeDue(db, busy, () => refreshSoon(false))
  }
  setTimeout(summarize, 15_000)
  setInterval(summarize, 60_000)

  createWindow()
  pushState()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

// Quitting Mason only detaches; your sessions keep running in tmux and reappear next launch.
app.on('before-quit', () => term.detachAll())

// Mason is a place you keep open; closing the window on macOS leaves it in the Dock.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
