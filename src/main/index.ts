import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, nativeImage, nativeTheme, session, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { watchDebugRequests } from './debugSnapshot'
import { autoUpdateOn, modelOf, noteTyping, restartSession, startClaudeUpdater, updateView } from './claudeUpdates'
import { existsSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { LAST_COPY } from './copyUnwrap'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DATA_DIR, openDb, type DB } from './db'
import { EVENTS_FILE, lastActiveSession, pruneNeeds, readEvents, writeHookScript } from './events'
import { SPINOFF_DIR, spinPrompt, takeSpinoffs, writeSpinoffCommand } from './spinoff'
import { STASH_DIR, takeStashes, writeStashCommand } from './stash'
import { TRAY_1X, TRAY_2X } from './trayIcon'
import { checkForUpdate, runUpdate, updateInfo } from './updates'
import { rememberHostedIds, rememberTerminals, reopenAfterRestart } from './reopen'
import { backfillModels, CLAUDE_PROJECTS, ingestAll } from './ingest'
import { CLAUDE_SESSIONS, readLive } from './live'
import { nameFor, projectIdFor } from './projects'
import * as term from './pty'
import { CLIENT_RE, sessionOf } from './pty'
import { briefFile, editHandoff, HANDOFF_DIR, readHandoffs, takeHandoffs, writePauseScript } from './handoff'
import { buildState, searchPast } from './state'
import { isGitRoot, setWorktrees, tidyWorktrees, worktreesOn } from './worktrees'
import { initSummaries, setSummaries, summarizeDue } from './summarize'
import { focusTerminalTab } from './terminal'
import { endSession, initTmux, listHosted, NAME_RE, peek, scroll, dragScroll, selecting, SESSION_ID_RE, setTerminalProject, startSession, startTerminal, TMUX, unscroll } from './tmux'

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
  // `--fake-update` (developer snapshots only) shows the Update button without a real update.
  const update = DEV_CHECK && process.argv.includes('--fake-update') ? { count: 2, notes: ['Peek, menu bar icon, and reopen after restart', 'Quick capture and /stash'] } : updateInfo()
  return { ...buildState(db, live, needs, listHosted(), projectFor, !!TMUX), update, claudeUpdate: updateView(live), claudeAuto: autoUpdateOn(db) }
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// A Mac notification the moment a session starts waiting on you, but only while you're somewhere else:
// with Mason in front, the coral dot already says it. Clicking it opens that session in Peek.
const notifyOn = () => (db.prepare("SELECT value FROM settings WHERE key = 'notify'").get() as { value: string } | undefined)?.value !== 'off'
let wasWaiting: Set<string> | null = null // null until the first look, which only takes stock (no burst at launch)
function notifyNewWaiting(s: ReturnType<typeof state>): void {
  const rows = s.projects.flatMap((p) => p.sessions.filter((x) => x.status === 'needs').map((x) => ({ ...x, project: p.name })))
  const before = wasWaiting
  wasWaiting = new Set(rows.map((r) => r.id))
  if (!before) return
  const fresh = rows.filter((r) => !before.has(r.id))
  if (!fresh.length || win?.isFocused() || !notifyOn() || !Notification.isSupported()) return
  for (const r of fresh.slice(0, 3)) {
    const n = new Notification({ title: `${r.title} · ${r.project}`, body: r.now || 'Waiting on you', silent: false })
    n.on('click', () => {
      showMason()
      send('mason:peek', r.host ? { host: r.host, id: r.id } : null, r.id)
    })
    n.show()
  }
}

function pushState(): void {
  const s = state()
  notifyNewWaiting(s)
  // The Dock badge counts sessions waiting on you, so you can see it from anywhere.
  const waiting = s.projects.reduce((n, p) => n + p.sessions.filter((x) => x.status === 'needs').length, 0)
  app.dock?.setBadge(waiting ? String(waiting) : '')
  updateTray(s)
  rememberHosted(s)
  send('state:changed', s)
}

// ---- Bring Mason forward from anywhere (⌃⌥M); press again to put it away ----
export const SHOW_SHORTCUT = 'Control+Alt+M'
function showMason(): void {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
  }
  app.focus({ steal: true })
  win?.focus()
}
function toggleMason(): void {
  if (win && win.isFocused() && win.isVisible()) app.hide()
  else showMason()
}

// ---- Menu bar: the waiting count, and a way in from anywhere ----
let tray: Tray | null = null
let trayKey = ''
function updateTray(s: ReturnType<typeof state>): void {
  if (!tray) return
  const waitingRows = s.projects.flatMap((p) => p.sessions.filter((x) => x.status === 'needs').map((x) => ({ ...x, project: p.name })))
  tray.setTitle(waitingRows.length ? ` ${waitingRows.length}` : '')
  tray.setToolTip(waitingRows.length ? `Mason: ${waitingRows.length} waiting on you` : 'Mason')
  const key = JSON.stringify(waitingRows.map((r) => [r.id, r.title, r.host]))
  if (key === trayKey) return // the menu only changes when the waiting list does
  trayKey = key
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Mason', accelerator: SHOW_SHORTCUT, click: showMason },
      { label: 'Quick capture…', accelerator: CAPTURE_SHORTCUT, click: openCapture },
      { type: 'separator' },
      ...(waitingRows.length
        ? [
            { label: 'Waiting on you', enabled: false },
            ...waitingRows.slice(0, 12).map((r) => ({
              label: `${r.title}  ·  ${r.project}`,
              // Sessions inside Mason open in Peek, so you can answer straight away.
              click: () => {
                showMason()
                send('mason:peek', r.host ? { host: r.host, id: r.id } : null, r.id)
              }
            })),
            { type: 'separator' as const }
          ]
        : [{ label: 'Nothing is waiting on you', enabled: false }, { type: 'separator' as const }]),
      { label: 'Quit Mason', click: () => app.quit() }
    ])
  )
}
function createTray(): void {
  const img = nativeImage.createFromDataURL(TRAY_1X)
  img.addRepresentation({ scaleFactor: 2, dataURL: TRAY_2X })
  img.setTemplateImage(true)
  tray = new Tray(img)
  trayKey = ''
}

// ---- After a Mac restart, tmux is gone; reopen the sessions that were running in Mason (see reopen.ts) ----
function rememberHosted(s: ReturnType<typeof state>): void {
  rememberHostedIds(db, s.projects.flatMap((p) => p.sessions.filter((x) => x.host && !x.id.startsWith('tmux:')).map((x) => x.id)))
  rememberTerminals(db, listHosted().flatMap((h) => (h.term && h.project ? [{ cwd: h.cwd, project: h.project }] : [])))
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

// Quick capture: a one-line box from any app (⌃⌥N). Type, Enter, gone; it lands in "saved".
export const CAPTURE_SHORTCUT = 'Control+Alt+N'
let capture: BrowserWindow | null = null
let captureFrom: string | null = null // the session you were last typing into
let captureReturns = false // hide Mason again afterwards, so focus goes back to the app you were in

function sessionTitle(sid: string): string {
  const r = db
    .prepare(`SELECT COALESCE(sp.name, su.title, s.ai_title, 'a session') AS t FROM sessions s
              LEFT JOIN session_prefs sp ON sp.session_id = s.id LEFT JOIN summaries su ON su.session_id = s.id WHERE s.id = ?`)
    .get(sid) as { t: string } | undefined
  return r?.t ?? 'a session'
}

function openCapture(): void {
  readEvents()
  captureFrom = lastActiveSession(3 * 60 * 60_000)
  if (captureFrom && !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(captureFrom)) captureFrom = null
  captureReturns = !(win?.isFocused() ?? false)
  if (!capture || capture.isDestroyed()) {
    capture = new BrowserWindow({
      width: 560,
      height: 76,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      type: 'panel',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: true
      }
    })
    capture.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    capture.on('blur', () => closeCapture(false))
    if (DEV_URL) capture.loadURL(DEV_URL + '#capture')
    else capture.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'capture' })
  }
  const c = capture
  const show = () => {
    c.center()
    const [x, y] = c.getPosition()
    c.setPosition(x, Math.max(80, Math.round(y * 0.45)))
    c.webContents.send('capture:show', captureFrom ? sessionTitle(captureFrom) : null)
    c.show()
    c.focus()
  }
  if (c.webContents.isLoading()) c.webContents.once('did-finish-load', show)
  else show()
}

function closeCapture(returnFocus: boolean): void {
  if (!capture || capture.isDestroyed() || !capture.isVisible()) return
  capture.hide()
  if (returnFocus && captureReturns) app.hide()
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
  // ⌘V with only an image on the clipboard (a screenshot): a terminal can't paste that, and the page never sees a
  // paste it could act on. Claude Code reads images from the clipboard itself on Ctrl+V, so the focused window
  // gets that instead.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.code !== 'KeyV' || !input.meta || input.shift || input.alt || input.control) return
    const cb = clipboard as unknown as { readText(): string; availableFormats(): string[] } // (the DOM's Clipboard type shadows Electron's here)
    if (cb.readText() || !cb.availableFormats().some((f) => f.startsWith('image/'))) return
    e.preventDefault()
    win?.webContents.send('term:paste-image')
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
        // Optional `--layout=grid|side|stack|one` sets the Open tab layout first (in the dev-only preferences).
        const layout = process.argv.find((a) => a.startsWith('--layout='))?.split('=')[1]
        if (layout) {
          await win!.webContents.executeJavaScript(`localStorage.setItem('openLayout', ${JSON.stringify(layout)})`)
          win!.webContents.reload()
          await new Promise((r) => win!.webContents.once('did-finish-load', () => r(null)))
        }
        // Wait until the list has rendered before pressing anything.
        for (let i = 0; i < 40 && !(await win!.webContents.executeJavaScript(`!!document.querySelector('.proj')`)); i++) await new Promise((r) => setTimeout(r, 250))
        for (const key of keys) {
          const r = await win!.webContents.executeJavaScript(`(${JSON.stringify(key)} === "!" ? document.querySelector(".pill").click() : ${JSON.stringify(key)} === "@" ? document.querySelector(".update-btn").click() : ${JSON.stringify(key)} === "~" ? [...document.querySelectorAll(".foot-btn")].find((b) => /saved|Saved/.test(b.textContent)).click() : window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)} }))); document.querySelector('.tab[aria-selected=true]')?.textContent + ' wins=' + document.querySelectorAll('.win').length`)
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
// Developer checks get their own preferences (theme, layout, shush…), so they never change your real Mason's.
if (DEV_CHECK) app.setPath('userData', join(app.getPath('temp'), `mason-dev-check-${process.pid}`))

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
  backfillModels(db)

  // Developer check: print what Mason sees and exit, without opening a window.
  if (process.argv.includes('--dump-state')) {
    process.stdout.write(JSON.stringify(state(), null, 2) + '\n', () => app.exit(0))
    return
  }

  initTmux()
  writeHookScript()
  writePauseScript()
  writeStashCommand()
  writeSpinoffCommand()
  ipcMain.handle('state:get', (e) => (trusted(e) ? state() : null))

  // The Open tab's windows, kept in Mason's database so nothing in the window itself can lose them.
  // null means never saved here yet (the window then hands over what it kept itself, once).
  const setting = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value
  const putSetting = (k: string, v: string) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)
  let windowsAskedAt = 0
  ipcMain.handle('windows:get', (e) => {
    if (!trusted(e)) return null
    windowsAskedAt = Date.now() // the window just (re)loaded
    const v = setting('openWindows')
    return v ? JSON.parse(v) : null
  })
  ipcMain.handle('windows:set', (e, list: unknown) => {
    if (!trusted(e) || !Array.isArray(list) || list.length > 200) return false
    const clean = list.filter(
      (w): w is { host: string; sid: string | null } =>
        !!w && typeof w.host === 'string' && NAME_RE.test(w.host) && (w.sid === null || (typeof w.sid === 'string' && SESSION_ID_RE.test(w.sid)))
    ).map((w) => ({ host: w.host, sid: w.sid }))
    const before = setting('openWindows')
    // Just after the window loads, an empty list over a full one is almost certainly a hiccup, not you closing
    // everything in that minute: keep the full one.
    if (!clean.length && before && before !== '[]' && Date.now() - windowsAskedAt < 60_000) return false
    putSetting('openWindows', JSON.stringify(clean))
    return true
  })

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
  // A plain terminal in a project's folder, hosted inside Mason like a Claude session.
  ipcMain.handle('terminal:new', (e, projectId: unknown) => {
    if (!trusted(e) || typeof projectId !== 'number') return { error: 'bad request' }
    const p = db.prepare('SELECT root FROM projects WHERE id = ?').get(projectId) as { root: string } | undefined
    if (!p || !existsSync(p.root)) return { error: 'That project folder no longer exists.' }
    const host = startTerminal(p.root, projectId)
    refreshSoon(false)
    return { host }
  })
  // ⌘T in the Open tab: a terminal in the same folder (and project) as the window you're in.
  ipcMain.handle('terminal:here', (e, name: unknown) => {
    if (!trusted(e) || typeof name !== 'string' || !NAME_RE.test(name)) return { error: 'bad request' }
    const h = listHosted().find((x) => x.name === name)
    if (!h || !existsSync(h.cwd)) return { error: 'Couldn’t find that window’s folder.' }
    const host = startTerminal(h.cwd, h.project ?? projectFor(h.cwd).id)
    refreshSoon(false)
    return { host }
  })

  // New project: pick (or create) a folder; it stays in the list even before anything runs there.
  ipcMain.handle('project:add', async (e) => {
    if (!trusted(e) || !win) return { error: 'bad request' }
    const r = await dialog.showOpenDialog(win, { title: 'New project', buttonLabel: 'Add project', defaultPath: homedir(), properties: ['openDirectory', 'createDirectory'] })
    const dir = r.filePaths[0]
    if (r.canceled || !dir) return {}
    const id = projectIdFor(db, dir)
    db.prepare('UPDATE projects SET kept = 1 WHERE id = ?').run(id)
    pushState()
    return { projectId: id }
  })
  ipcMain.handle('project:forget', (e, id: unknown) => {
    if (!trusted(e) || typeof id !== 'number') return false
    db.prepare('UPDATE projects SET kept = 0 WHERE id = ?').run(id)
    pushState()
    return true
  })

  ipcMain.handle('session:new', (e, projectId: unknown) => {
    if (!trusted(e) || typeof projectId !== 'number') return { error: 'bad request' }
    const p = db.prepare('SELECT root FROM projects WHERE id = ?').get(projectId) as { root: string } | undefined
    if (!p || !existsSync(p.root)) return { error: 'That project folder no longer exists.' }
    const host = startSession(p.root, undefined, undefined, worktreesOn(db) && isGitRoot(p.root))
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
    const host = startSession(s.cwd, id, undefined, false, modelOf(db, id))
    refreshSoon(false)
    return { host }
  })

  // Switch a session's model: restart it with --model, keeping the conversation and anything typed in its prompt.
  // Only while it's idle and inside Mason (a session in Terminal can't be restarted from here).
  const MODEL_IDS: Record<string, string> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' }
  const switching = new Set<string>()
  ipcMain.handle('session:model', async (e, id: unknown, model: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || !SESSION_ID_RE.test(id) || typeof model !== 'string' || !(model in MODEL_IDS)) return { error: 'bad request' }
    const live = readLive().get(id)
    const host = live && (listHosted().find((h) => h.name === live.tmux) ?? (live.tty ? listHosted().find((h) => h.tty === live.tty) : undefined))
    if (!live || !host) return { error: 'Only sessions running inside Mason can switch models.' }
    if (live.copies > 1) return { error: 'That conversation is running in more than one place.' }
    if (live.status !== 'idle' || readEvents().has(id)) return { error: 'Switch once Claude has finished and isn’t waiting on you.' }
    if (switching.has(id)) return { error: 'Already switching.' }
    switching.add(id)
    try {
      const result = await restartSession(host.name, id, live.pid, readLive, { model, keepDraft: true })
      if (result === 'skipped') return { error: 'Couldn’t read its prompt safely, so it was left as it was.' }
      if (result === 'failed') return { error: 'The switch didn’t finish. Open the window to check on it.' }
      // Show the new model straight away; Claude's next reply confirms it.
      db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(MODEL_IDS[model], id)
      if (result === 'draft-not-restored') return { error: 'Switched, but your draft didn’t come back. It’s saved in ~/.mason/drafts.' }
      return { ok: true }
    } finally {
      switching.delete(id)
      refreshSoon(false)
    }
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
    const host = startSession(cwd, id, undefined, false, modelOf(db, id))
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
  // Find box: past conversations of any age (live ones are already on screen).
  ipcMain.handle('session:search', (e, query: unknown) => {
    if (!trusted(e) || typeof query !== 'string') return []
    return searchPast(db, query.slice(0, 200), new Set(readLive().keys()))
  })
  // Your own name for a project; empty goes back to its folder name.
  // Drag a session onto another project. Remembered, so following its folders never moves it back.
  ipcMain.handle('session:move-to', (e, id: unknown, projectId: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || typeof projectId !== 'number') return false
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return false
    // A plain terminal remembers its project on its tmux session.
    if (id.startsWith('tmux:')) {
      const ok = setTerminalProject(id.slice(5), projectId)
      pushState()
      return ok
    }
    if (!SESSION_ID_RE.test(id)) return false
    const r = db.prepare('UPDATE sessions SET project_id = ?, placed = 1 WHERE id = ?').run(projectId, id)
    pushState()
    return r.changes > 0
  })

  ipcMain.handle('project:rename', (e, id: unknown, name: unknown) => {
    if (!trusted(e) || typeof id !== 'number' || typeof name !== 'string') return false
    const p = db.prepare('SELECT root FROM projects WHERE id = ?').get(id) as { root: string } | undefined
    if (!p) return false
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 60)
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(clean || nameFor(p.root), id)
    pushState()
    return true
  })
  ipcMain.handle('session:star', (e, id: unknown, starred: unknown) => {
    if (!trusted(e) || typeof id !== 'string' || !SESSION_ID_RE.test(id) || typeof starred !== 'boolean') return false
    db.prepare('INSERT INTO session_prefs (session_id, starred) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET starred = excluded.starred').run(id, starred ? 1 : 0)
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

  // Spin-off: start a side thought as its own Claude session in the same folder. The new window opens beside the
  // one it came from, and focus stays where you are.
  const titleOf = (sid: string | null) =>
    sid
      ? ((
          db
            .prepare(
              `SELECT COALESCE(sp.name, su.title, s.ai_title) AS t FROM sessions s
               LEFT JOIN session_prefs sp ON sp.session_id = s.id LEFT JOIN summaries su ON su.session_id = s.id WHERE s.id = ?`
            )
            .get(sid) as { t: string | null } | undefined
        )?.t ?? null)
      : null
  const spinOff = (cwd: string, fromSid: string | null, fromHost: string | null, thought: string) => {
    if (!existsSync(cwd)) return null
    const host = startSession(cwd, undefined, spinPrompt(thought, titleOf(fromSid)))
    send('mason:spunoff', host, fromHost)
    refreshSoon(false)
    return host
  }
  const takeSpun = () => {
    const live = readLive()
    for (const s of takeSpinoffs()) {
      const l = s.from ? live.get(s.from) : undefined
      spinOff(s.cwd, s.from, (l && hostFor(l)) ?? null, s.thought)
    }
  }
  takeSpun()
  try {
    watch(SPINOFF_DIR, (_ev, f) => f?.endsWith('.json') && setTimeout(takeSpun, 200))
  } catch {}
  // What you last highlighted in a window, if it was in the last couple of minutes (for ⌘⇧N).
  ipcMain.handle('copy:last', (e) => {
    if (!trusted(e)) return null
    try {
      const at = statSync(LAST_COPY).mtimeMs
      if (Date.now() - at > 2 * 60_000) return null
      const text = readFileSync(LAST_COPY, 'utf8').trim().slice(0, 10_000)
      return text ? { text, at } : null
    } catch {
      return null
    }
  })
  ipcMain.handle('session:spinoff', (e, from: unknown, thought: unknown) => {
    if (!trusted(e) || typeof from !== 'string' || !NAME_RE.test(from) || typeof thought !== 'string') return { error: 'bad request' }
    const h = listHosted().find((x) => x.name === from)
    if (!h) return { error: 'Couldn’t find that window.' }
    const sid = [...readLive()].find(([, l]) => hostFor(l) === from)?.[0] ?? h.resume ?? null
    const host = spinOff(h.cwd, sid, from, thought.trim().slice(0, 10_000))
    return host ? { host } : { error: 'That folder no longer exists.' }
  })
  ipcMain.handle('worktrees:set', (e, on: unknown) => {
    if (!trusted(e) || typeof on !== 'boolean') return false
    setWorktrees(db, on)
    pushState()
    return true
  })
  ipcMain.handle('claudeAuto:set', (e, on: unknown) => {
    if (!trusted(e) || typeof on !== 'boolean') return false
    db.prepare("INSERT INTO settings (key, value) VALUES ('claudeAutoUpdate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? 'on' : 'off')
    pushState()
    return true
  })
  ipcMain.handle('notify:set', (e, on: unknown) => {
    if (!trusted(e) || typeof on !== 'boolean') return false
    db.prepare("INSERT INTO settings (key, value) VALUES ('notify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? 'on' : 'off')
    pushState()
    return true
  })

  // /stash from inside Claude, filed into "saved".
  const takeStashed = () => takeStashes(db) && refreshSoon(false)
  takeStashed()
  try {
    watch(STASH_DIR, (_ev, f) => f?.endsWith('.json') && setTimeout(takeStashed, 300))
  } catch {}
  setInterval(takeStashed, 20_000) // one waiting for its transcript to be read in

  // Updates: a quiet check now and then; updating only ever happens when you click.
  const checkUpdates = () => checkForUpdate().then((changed) => changed && refreshSoon(false))
  // Every half hour, and when you come back to Mason (at most every 5 minutes), so the Update button turns up soon after
  // a change lands rather than hours later.
  let lastCheck = 0
  const checkSoon = () => Date.now() - lastCheck > 5 * 60_000 && ((lastCheck = Date.now()), checkUpdates())
  if (!DEV_CHECK) {
    setTimeout(checkSoon, 30_000)
    setInterval(checkSoon, 30 * 60_000)
    app.on('browser-window-focus', checkSoon)
  }
  ipcMain.handle('update:check', async (e) => (trusted(e) ? (await checkForUpdate(), updateInfo()) : null))
  ipcMain.handle('update:run', (e) => (trusted(e) ? runUpdate((msg) => send('mason:notice', msg)) : { ok: false }))

  ipcMain.handle('saved:remove', (e, id: unknown) => {
    if (!trusted(e) || !Number.isInteger(id)) return false
    db.prepare('DELETE FROM notes WHERE id = ?').run(id)
    refreshSoon(false)
    return true
  })

  ipcMain.handle('capture:save', (e, text: unknown) => {
    if (!trusted(e) || typeof text !== 'string' || !text.trim()) return false
    db.prepare("INSERT INTO notes (session_id, kind, body, created_at) VALUES (?, 'idea', ?, ?)").run(captureFrom, text.trim().slice(0, 5000), Date.now())
    closeCapture(true)
    refreshSoon(false)
    return true
  })
  ipcMain.on('capture:close', (e) => trusted(e) && closeCapture(true))
  if (!DEV_CHECK && !globalShortcut.register(CAPTURE_SHORTCUT, openCapture)) console.warn(`Couldn't claim ${CAPTURE_SHORTCUT} for quick capture; another app has it.`)

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
  ipcMain.handle('term:attach', (e, client: unknown, cols: unknown, rows: unknown) => {
    if (!trusted(e) || typeof client !== 'string' || !CLIENT_RE.test(client)) return false
    if (!listHosted().some((h) => h.name === sessionOf(client))) return false
    return term.attach(
      client,
      Number(cols),
      Number(rows),
      (data) => send('term:data', client, data),
      () => {
        send('term:exit', client)
        refreshSoon(false)
      }
    )
  })
  ipcMain.on('term:input', (e, client: unknown, data: unknown) => {
    if (!trusted(e) || typeof client !== 'string' || typeof data !== 'string' || !CLIENT_RE.test(client)) return
    // Mouse and focus reports aren't typing: they mustn't jump a scrolled-back view to the bottom.
    if (!/^(?:\x1b\[(?:<[\d;]+[Mm]|[IO]))+$/.test(data)) unscroll(sessionOf(client)), noteTyping(sessionOf(client))
    term.write(client, data)
  })
  ipcMain.on('term:scroll', (e, client: unknown, lines: unknown) => {
    if (trusted(e) && typeof client === 'string' && CLIENT_RE.test(client)) scroll(sessionOf(client), Number(lines))
  })
  ipcMain.on('term:dragScroll', (e, client: unknown, lines: unknown) => {
    if (trusted(e) && typeof client === 'string' && CLIENT_RE.test(client)) dragScroll(sessionOf(client), Number(lines))
  })
  ipcMain.on('term:selecting', (e, client: unknown) => {
    if (trusted(e) && typeof client === 'string' && CLIENT_RE.test(client)) selecting(sessionOf(client))
  })
  ipcMain.on('term:resize', (e, client: unknown, cols: unknown, rows: unknown) => {
    if (trusted(e) && typeof client === 'string') term.resize(client, Number(cols), Number(rows))
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
  // `touch ~/.mason/debug-request` saves a picture and layout measurements of Mason's window (see debugSnapshot.ts).
  watchDebugRequests(() => win)
  // Sessions move onto a newly installed Claude by themselves once they're idle (see claudeUpdates.ts).
  startClaudeUpdater({ db, readLive, needs: readEvents, notice: (msg) => send('mason:notice', msg), changed: () => refreshSoon(false) })
  // A crashed Claude leaves its status file behind; a slow poll notices the process is gone.
  setInterval(() => refreshSoon(false), 10_000)
  // Worktrees whose work is merged (or never started) are cleared away, never one with anything running or unsaved.
  const tidy = () => {
    const inUse = [...[...readLive().values()].flatMap((l) => (l.cwd ? [l.cwd] : [])), ...listHosted().map((h) => h.cwd)]
    tidyWorktrees(db, inUse).catch(() => 0)
  }
  setTimeout(tidy, 30_000)
  setInterval(tidy, 15 * 60_000)
  // Summaries catch up quietly in the background, one session at a time.
  const summarize = () => {
    const busy = new Set([...readLive()].filter(([, l]) => l.status === 'working').map(([id]) => id))
    summarizeDue(db, busy, () => refreshSoon(false))
  }
  setTimeout(summarize, 15_000)
  setInterval(summarize, 60_000)

  const reopened = DEV_CHECK ? 0 : reopenAfterRestart(db)
  createWindow()
  if (!DEV_CHECK) createTray()
  pushState()
  if (reopened)
    win?.webContents.once('did-finish-load', () =>
      setTimeout(() => send('mason:notice', `Reopened ${reopened} session${reopened > 1 ? 's' : ''} from before your Mac restarted.`), 800)
    )
  if (!DEV_CHECK && !globalShortcut.register(SHOW_SHORTCUT, toggleMason)) console.warn(`Couldn't claim ${SHOW_SHORTCUT}; another app has it.`)
  // The quick-capture panel counts as a window, so check for the main one specifically.
  app.on('activate', () => !win && createWindow())
})

// Quitting Mason only detaches; your sessions keep running in tmux and reappear next launch.
app.on('before-quit', () => term.detachAll())
app.on('will-quit', () => globalShortcut.unregisterAll())

// Mason is a place you keep open; closing the window on macOS leaves it in the Dock.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
