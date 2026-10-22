import { execFile, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeCopyScript } from './copyUnwrap'
import { DATA_DIR } from './db'

// Mason runs its own private tmux server ("-L mason"), separate from any tmux you use yourself.
// tmux keeps sessions alive when Mason's window closes or the app quits; Mason just attaches to them.
export const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(existsSync) ?? null
// MASON_TMUX_SOCKET is only for tests, so they never touch your real sessions.
const SOCKET = process.env.MASON_TMUX_SOCKET || 'mason'
const CONF = join(DATA_DIR, 'tmux.conf')

// Typing while scrolled back (tmux's copy mode) should just leave copy mode, never reach tmux's own copy-mode keys:
// "f" there opens a "(jump forward)" prompt that swallows what you type next. Mason usually leaves copy mode before a
// keystroke arrives; these catch the rest (e.g. a window left scrolled back across a restart). Only typing keys are
// listed, so mouse selection and scrolling are untouched.
const TYPING_KEYS = [
  ...Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).map((c) => (c === "'" ? `"'"` : `'${c}'`)),
  'Space', 'Enter', 'BSpace', 'Tab', 'Escape', 'Up', 'Down', 'Left', 'Right', 'C-c', 'C-d', 'C-u', 'C-a', 'C-e', 'C-r', 'C-s'
]
  .map((k) => `bind-key -T copy-mode ${k} send -X cancel`)
  .join('\n')

const CONF_TEXT = `# Written by Mason. Invisible tmux: no status bar, no prefix key, so every keystroke goes to Claude.
set -g status off
set -g prefix None
unbind-key -a
set -g history-limit 50000
set -sg escape-time 0
set -g focus-events on
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -g window-size latest
set -g aggressive-resize on
set -g set-titles off
# The mouse selects text: drag to select (Mason scrolls when you drag past the top or bottom edge), and letting go
# copies it to the clipboard. Double-click takes a word, triple-click a line. tmux's other mouse actions are removed
# (its right-click menu can kill the session). If the program in the pane asks for the mouse itself, it gets it.
set -g mouse on
set -g set-clipboard off
set -s copy-command 'sh "$HOME/.mason/copy.sh"'
unbind-key -T root -a
bind-key -n MouseDown1Pane if -F '#{mouse_any_flag}' 'send -M'
bind-key -n MouseUp1Pane if -F '#{mouse_any_flag}' 'send -M'
bind-key -n MouseDrag1Pane if -F '#{mouse_any_flag}' 'send -M' 'copy-mode -M'
bind-key -n DoubleClick1Pane if -F '#{mouse_any_flag}' 'send -M' 'copy-mode -H ; send -X select-word ; run -d0.3 ; send -X copy-pipe-and-cancel'
bind-key -n TripleClick1Pane if -F '#{mouse_any_flag}' 'send -M' 'copy-mode -H ; send -X select-line ; run -d0.3 ; send -X copy-pipe-and-cancel'
unbind-key -T copy-mode -a
${TYPING_KEYS}
# Sessions inside Mason don't update Claude themselves (so they never print "Update installed"); Mason runs
# claude update on its own schedule and moves idle sessions over (claudeUpdates.ts).
set-environment -g DISABLE_AUTOUPDATER 1
bind-key -T copy-mode MouseDown1Pane send -X clear-selection
bind-key -T copy-mode MouseDrag1Pane send -X begin-selection
# At the bottom, copying also leaves the selection so Claude's output keeps flowing; scrolled back, it stays highlighted.
bind-key -T copy-mode MouseDragEnd1Pane if -F '#{==:#{scroll_position},0}' 'send -X copy-pipe-and-cancel' 'send -X copy-pipe-no-clear'
bind-key -T copy-mode DoubleClick1Pane send -X select-word \\; run -d0.3 \\; send -X copy-pipe-no-clear
bind-key -T copy-mode TripleClick1Pane send -X select-line \\; run -d0.3 \\; send -X copy-pipe-no-clear
`

export const NAME_RE = /^ms-[0-9a-f]{8}$/
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Mason is often launched from the Dock with a bare environment; tmux and the shells it starts need a sane PATH,
// and should not inherit Electron's own variables.
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(ELECTRON|VITE|NODE_OPTIONS|CHROME)/.test(k)) env[k] = v
  env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':')
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Launched from the Dock there's no locale, and tmux then treats the terminal as plain ASCII: Claude's UI
  // renders as underscores and list-panes mangles tabs. Ask for UTF-8 unless the user already chose a locale.
  if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) env.LANG = 'en_US.UTF-8'
  delete env.TMUX
  return env
}

export function baseArgs(): string[] {
  return ['-L', SOCKET, '-f', CONF]
}

function tmux(args: string[]): string {
  if (!TMUX) throw new Error('tmux is not installed')
  return execFileSync(TMUX, [...baseArgs(), ...args], { encoding: 'utf8', timeout: 5000, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
}

export function initTmux(): void {
  writeCopyScript() // the copy-command below runs it
  writeFileSync(CONF, CONF_TEXT, { mode: 0o600 })
  // A server that's already running (sessions outlive Mason) only read the config it started with.
  if (TMUX)
    execFile(TMUX, [...baseArgs(), 'source-file', CONF], { timeout: 5000, env: cleanEnv() }, () => {
      // A window left scrolled back from before goes back to the live view, so typing reaches Claude again.
      execFile(TMUX!, [...baseArgs(), 'list-panes', '-a', '-F', '#{pane_id} #{pane_in_mode}'], { timeout: 5000, env: cleanEnv() }, (_e, out) => {
        for (const line of String(out ?? '').split('\n')) {
          const [pane, inMode] = line.split(' ')
          if (inMode === '1' && /^%\d+$/.test(pane)) execFile(TMUX!, [...baseArgs(), 'send-keys', '-t', pane, '-X', 'cancel'], { timeout: 5000, env: cleanEnv() }, () => {})
        }
      })
    })
}

// resume: the conversation Mason started this shell for, so it can be named before Claude is up (or after it exits).
export type Hosted = {
  name: string
  tty: string
  cwd: string
  created: number
  resume?: string
  term?: boolean // a plain terminal: no Claude was started in it
  project?: number // the project a plain terminal was opened for
  cmd: string // what's running in it right now (e.g. zsh, npm, ssh)
}

export function listHosted(): Hosted[] {
  if (!TMUX) return []
  try {
    // Space-separated, path last: tmux can rewrite tabs in its output, and only the path can contain spaces.
    // The command name has its spaces swapped out by tmux itself, so every field but the path stays one word.
    const format = '#{session_name} #{pane_tty} #{session_created} r#{@mason_resume} k#{@mason_kind} p#{@mason_project} c#{s/ /_/:pane_current_command} #{pane_current_path}'
    return tmux(['list-panes', '-a', '-F', format])
      .split('\n')
      .map((l) => l.match(/^(\S+) (\S+) (\d+) r(\S*) k(\S*) p(\d*) c(\S*) (.*)$/))
      .filter((m): m is RegExpMatchArray => !!m && NAME_RE.test(m[1]))
      .map(([, name, tty, created, resume, kind, project, cmd, cwd]) => ({
        name,
        tty: tty.replace('/dev/', ''),
        cwd,
        created: Number(created) * 1000,
        resume: SESSION_ID_RE.test(resume) ? resume : undefined,
        term: kind === 'term' || undefined,
        project: project ? Number(project) : undefined,
        cmd: cmd.replace(/_/g, ' ')
      }))
  } catch {
    return [] // no server running yet
  }
}

// Starts your normal login shell in the folder (so your PATH, nvm, etc. all work), then types `claude` into it.
// If Claude exits, the shell stays, just like a Terminal tab.
// A plain terminal: your login shell in the folder, nothing typed into it. Remembers which project it was opened
// for, so it stays under that project even if you cd somewhere else.
export function startTerminal(cwd: string, projectId: number): string {
  const name = `ms-${randomBytes(4).toString('hex')}`
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '120', '-y', '36'])
  tmux(['set-option', '-t', name, '@mason_kind', 'term'])
  tmux(['set-option', '-t', name, '@mason_project', String(projectId)])
  return name
}

// Dragging a plain terminal onto another project.
export function setTerminalProject(name: string, projectId: number): boolean {
  if (!NAME_RE.test(name)) return false
  try {
    tmux(['set-option', '-t', name, '@mason_project', String(projectId)])
    return true
  } catch {
    return false
  }
}

// worktree: start Claude in a fresh worktree of this repo (see worktrees.ts).
// A model alias ("sonnet") or a full name ("claude-sonnet-5-5"). Anything else is ignored rather than typed into a shell.
export const MODEL_RE = /^(?:opus|sonnet|haiku|fable|claude-[a-z0-9-]{3,60})$/
// model: start (or resume) with this model rather than your default. Resuming keeps a session's model this way.
export function startSession(cwd: string, resumeId?: string, briefPath?: string, worktree = false, model?: string): string {
  if (resumeId && !SESSION_ID_RE.test(resumeId)) throw new Error('bad session id')
  const withModel = model && MODEL_RE.test(model) ? ` --model ${model}` : ''
  const name = `ms-${randomBytes(4).toString('hex')}`
  tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', '120', '-y', '36'])
  if (resumeId) tmux(['set-option', '-t', name, '@mason_resume', resumeId])
  // A fresh start from a handoff hands Claude the brief as its first message, read from a file so nothing needs quoting.
  const first = briefPath ? ` "$(cat '${briefPath.replace(/'/g, `'\\''`)}')"` : ''
  tmux(['send-keys', '-t', name, '-l', resumeId ? `DISABLE_AUTOUPDATER=1 claude --resume ${resumeId}${withModel}` : `DISABLE_AUTOUPDATER=1 claude${withModel}${worktree ? ' --worktree' : ''}${first}`])
  tmux(['send-keys', '-t', name, 'Enter'])
  return name
}

// What a shell without a running Claude is showing, in a few words.
export function peek(name: string): 'trust' | 'shell' | 'starting' {
  try {
    const lines = tmux(['capture-pane', '-p', '-t', name]).split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.some((l) => /trust this folder/i.test(l))) return 'trust'
    if (/[%$#❯>]$/.test(lines.at(-1) ?? '')) return 'shell'
  } catch {}
  return 'starting'
}

// Scrolling uses tmux's own history (copy mode), so you can read back everything Claude printed, not just
// what's on screen. -e drops out of copy mode by itself once you scroll back to the bottom.
// Except when the window's program draws its own full screen and asks for the mouse (Claude's fullscreen renderer,
// /tui fullscreen): its history isn't in tmux at all, so the wheel goes to the program, as in any terminal.
const scrolled = new Set<string>()
export function scroll(name: string, lines: number): void {
  if (!TMUX || !NAME_RE.test(name) || !Number.isFinite(lines) || !lines) return
  const run = (args: string[], then?: (out: string) => void) => execFile(TMUX!, [...baseArgs(), ...args], { timeout: 5000, env: cleanEnv(), encoding: 'utf8' }, (_e, out) => then?.(out ?? ''))
  const move = () => run(['send-keys', '-t', name, '-X', '-N', String(Math.min(50, Math.abs(lines | 0) || 1)), lines < 0 ? 'scroll-up' : 'scroll-down'])
  run(['display-message', '-p', '-t', name, '#{alternate_on} #{mouse_any_flag} #{mouse_sgr_flag} #{pane_in_mode} #{pane_width} #{pane_height}'], (out) => {
    const [alt, mouse, sgr, inMode, w, h] = out.trim().split(' ').map(Number)
    if (alt && mouse && sgr && !inMode) {
      // SGR mouse wheel events (64 up, 65 down) over the middle of the conversation, one per few lines.
      const ev = `\x1b[<${lines < 0 ? 64 : 65};${Math.max(1, (w / 2) | 0)};${Math.max(1, (h / 3) | 0)}M`
      const hex = [...Buffer.from(ev.repeat(Math.min(10, Math.ceil(Math.abs(lines) / 3))))].map((b) => b.toString(16).padStart(2, '0'))
      run(['send-keys', '-t', name, '-H', ...hex])
    } else if (lines > 0) move()
    else {
      scrolled.add(name)
      run(['copy-mode', '-e', '-t', name], move)
    }
  })
}

// Dragging a selection past the top or bottom edge: move tmux's cursor, which scrolls the history and grows the
// selection with it. (Scrolling the view instead leaves the selection where it was.) Only acts mid-selection.
export function dragScroll(name: string, lines: number): void {
  if (!TMUX || !NAME_RE.test(name) || !Number.isFinite(lines) || !lines) return
  const n = String(Math.min(20, Math.abs(lines | 0) || 1))
  scrolled.add(name)
  execFile(TMUX, [...baseArgs(), 'if-shell', '-F', '-t', name, '#{pane_in_mode}', `send-keys -t ${name} -X -N ${n} ${lines < 0 ? 'cursor-up' : 'cursor-down'}`], { timeout: 5000, env: cleanEnv() }, () => {})
}

// A text selection made with the mouse puts the pane in copy mode too, so typing should leave it the same way.
export function selecting(name: string): void {
  if (NAME_RE.test(name)) scrolled.add(name)
}

// Typing while scrolled back jumps to the bottom first, like any terminal. Synchronous so the keystroke lands after.
export function unscroll(name: string): void {
  if (!scrolled.delete(name)) return
  try {
    tmux(['send-keys', '-t', name, '-X', 'cancel'])
  } catch {} // already back at the bottom
}

// For restarting a session onto a new Claude: read the screen, type a command, put a draft back.
export function capturePane(name: string, colors = false): string {
  if (!NAME_RE.test(name)) throw new Error('bad session name')
  return tmux(['capture-pane', '-p', '-J', ...(colors ? ['-e'] : []), '-t', name])
}
export function sendLine(name: string, text: string): void {
  if (!NAME_RE.test(name)) return
  tmux(['send-keys', '-t', name, '-l', text])
  tmux(['send-keys', '-t', name, 'Enter'])
}
// A bracketed paste (-p), so line breaks land in Claude's prompt instead of sending it.
export function pasteText(name: string, text: string): void {
  if (!NAME_RE.test(name) || !text) return
  tmux(['set-buffer', '-b', 'mason-draft', '--', text])
  tmux(['paste-buffer', '-p', '-d', '-b', 'mason-draft', '-t', name])
}

export function endSession(name: string): void {
  if (!NAME_RE.test(name)) return
  try {
    tmux(['kill-session', '-t', name])
  } catch {}
}
