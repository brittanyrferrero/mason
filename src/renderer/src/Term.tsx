import { useEffect, useRef, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// ⌘ shortcuts that belong to Mason (switching tabs, arranging windows), not to the terminal.
const APP_KEYS = new Set(['Digit1', 'Digit2', 'BracketLeft', 'BracketRight', 'Enter', 'KeyL', 'KeyO', 'KeyW', 'KeyK', 'KeyP', 'KeyN', 'KeyT', 'KeyF', 'KeyJ'])

// Claude's footer: the permission-mode line ("⏵⏵ auto mode on (shift+tab to cycle) · ← for agents") or the plain
// "? for shortcuts" hint. Mason tucks it out of sight and shows the mode as a small chip in the window's title bar.
const FOOTER_RE = /(?:⏵⏵|⏸|⏵)\s*\S.*\bon\b|shift\+tab to cycle|\? for shortcuts/
const modeOf = (line: string) => /(?:⏵⏵|⏸|⏵)\s*([a-z][a-z -]*?)\s+(?:mode\s+)?on\b/i.exec(line)?.[1].replace(/\s*mode$/i, '') ?? null

// One live terminal, attached to a Mason session (a tmux session) through the main process.
// Unmounting only detaches; the session keeps running.
// `peek` makes a second, separate view of the same session (for the Peek overlay) alongside its Open-tab window.
export type Footer = { mode: string | null; text: string } | null

export function Term({ name, focus, tick, peek = false, onFooter }: { name: string; focus: boolean; tick: number; peek?: boolean; onFooter?: (f: Footer) => void }) {
  const client = peek ? `${name}~peek` : name
  const el = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const footerCb = useRef(onFooter)
  footerCb.current = onFooter

  useEffect(() => {
    const host = el.current
    if (!host) return
    const t = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 5000,
      theme: { background: '#1c1c1e', foreground: '#e5e5ea', cursor: '#e5e5ea', selectionBackground: '#48484a' }
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(host)
    t.attachCustomKeyEventHandler((e) => !(e.metaKey && APP_KEYS.has(e.code)))
    // The history lives in tmux, not in xterm, so the wheel scrolls tmux. Trackpads send many small pixel deltas.
    let wheel = 0
    t.attachCustomWheelEventHandler((e) => {
      e.preventDefault() // the page itself must not scroll too
      wheel += e.deltaMode === 1 ? e.deltaY : e.deltaY / 20
      const lines = Math.trunc(wheel)
      if (lines) {
        wheel -= lines
        window.mason.scroll(client, lines)
      }
      return false
    })
    // Claude gets one row more than fits. That row sits just below the visible edge: when it holds Claude's footer,
    // the footer stays out of sight (its mode shows in Mason's title bar instead). When it holds anything else
    // (a permission prompt, a menu), the view shifts up a row so nothing that needs you is ever hidden.
    const fitPlus = () => {
      const d = fit.proposeDimensions()
      if (!d || !Number.isFinite(d.rows) || !Number.isFinite(d.cols)) return
      const rows = Math.max(5, d.rows + 1)
      if (t.cols !== d.cols || t.rows !== rows) t.resize(d.cols, rows)
    }
    let lastFooter = ''
    let frame = 0
    const tuck = () => {
      frame = 0
      const buf = t.buffer.active
      const last = buf.getLine(buf.viewportY + t.rows - 1)?.translateToString(true).trim() ?? ''
      const isFooter = FOOTER_RE.test(last)
      const screen = t.element?.querySelector<HTMLElement>('.xterm-screen')
      const rowH = screen ? screen.clientHeight / t.rows : 0
      // Exactly one row is out of sight: the bottom one (the footer), or, shifted up, the top one.
      if (t.element && rowH) {
        t.element.style.transform = isFooter ? '' : `translateY(-${rowH}px)`
        t.element.style.clipPath = isFooter ? `inset(0 0 ${rowH}px 0)` : `inset(${rowH}px 0 0 0)`
      }
      const key = isFooter ? last : ''
      if (key !== lastFooter) {
        lastFooter = key
        footerCb.current?.(isFooter ? { mode: modeOf(last), text: last } : null)
      }
    }
    const soon = () => frame || (frame = requestAnimationFrame(tuck))
    const parsed = t.onWriteParsed(soon)
    try {
      fitPlus()
    } catch {}
    termRef.current = t

    // Listen before attaching so the first screen redraw isn't missed.
    const offData = window.mason.onTermData((n, d) => n === client && t.write(d))
    const offExit = window.mason.onTermExit((n) => n === client && t.write('\r\n\x1b[2m[Detached]\x1b[0m\r\n'))
    window.mason.attach(client, t.cols, t.rows).then((ok) => {
      if (!ok) t.write('\x1b[2mThis session has ended.\x1b[0m\r\n')
    })
    const input = t.onData((d) => window.mason.input(client, d))
    const resize = t.onResize(({ cols, rows }) => {
      window.mason.resize(client, cols, rows)
      soon()
    })
    const ro = new ResizeObserver(() => {
      try {
        fitPlus()
      } catch {}
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      cancelAnimationFrame(frame)
      parsed.dispose()
      input.dispose()
      resize.dispose()
      offData()
      offExit()
      window.mason.detach(client)
      t.dispose()
      termRef.current = null
    }
  }, [client])

  useEffect(() => {
    if (focus) termRef.current?.focus()
  }, [focus, tick])

  // Dropping files types their paths, like Terminal does, so Claude can pick up a dragged-in screenshot.
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-mason-window')) return // rearranging windows, not text
    // Dropped text (a note, a saved idea, a snippet from another app) lands in the prompt as a paste: it's never
    // sent on its own, and control characters are stripped so nothing in it can act like a keypress.
    if (!e.dataTransfer.files.length) {
      const term = termRef.current
      let text = e.dataTransfer.getData('text/plain').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      // Line breaks are only safe when the program has asked for bracketed paste (Claude, zsh do): then the whole
      // drop arrives marked as pasted text. Anywhere else (bash, an ssh session) a newline would press Enter and run
      // whatever follows, so it becomes a space instead.
      if (!term?.modes.bracketedPasteMode) text = text.replace(/[\n\t]+/g, ' ')
      if (!text.trim() || !term) return
      e.preventDefault()
      term.paste(text)
      term.focus()
      return
    }
    e.preventDefault()
    // A newline (or any control character) in a file name would act like pressing Enter at a shell prompt and run
    // whatever follows, so such names are skipped rather than typed.
    const paths = [...e.dataTransfer.files].map((f) => window.mason.pathFor(f)).filter((p) => p && !/[\x00-\x1f\x7f]/.test(p))
    if (!paths.length) return
    // Escaped the way Terminal does it (backslash before spaces and shell characters), which Claude recognizes.
    window.mason.input(client, paths.map((p) => p.replace(/([ \t'"\\()[\]{}&;|<>*?!$`#~])/g, '\\$1')).join(' ') + ' ')
    termRef.current?.focus()
  }
  return (
    <div
      className="term"
      ref={el}
      onMouseDown={() => termRef.current?.focus()}
      onDragOver={(e) =>
        !e.dataTransfer.types.includes('application/x-mason-window') &&
        (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain')) &&
        (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy'))
      }
      onDrop={onDrop}
    />
  )
}
