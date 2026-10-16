import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// ⌘ shortcuts that belong to Mason (switching tabs, arranging windows), not to the terminal.
const APP_KEYS = new Set(['Digit1', 'Digit2', 'BracketLeft', 'BracketRight', 'Enter', 'KeyL', 'KeyO', 'KeyW', 'KeyK', 'KeyP', 'KeyN', 'KeyT', 'KeyF', 'KeyJ'])

// Claude's footer: the permission-mode line ("⏵⏵ auto mode on (shift+tab to cycle) · ← for agents") or the plain
// "? for shortcuts" hint. Mason tucks it out of sight and shows the mode as a small chip in the window's title bar.
const FOOTER_RE = /(?:⏵⏵|⏸|⏵)\s*\S.*\bon\b|shift\+tab to cycle|\? for shortcuts/
// A line Claude sometimes adds under its footer ("✓ Update installed · Restart to update"). It's tucked away with the
// footer and shown as a small chip in the title bar instead.
const NOTICE_RE = /update installed|restart to update|update available/i
const modeOf = (line: string) => /(?:⏵⏵|⏸|⏵)\s*([a-z][a-z -]*?)\s+(?:mode\s+)?on\b/i.exec(line)?.[1].replace(/\s*mode$/i, '') ?? null

// One live terminal, attached to a Mason session (a tmux session) through the main process.
// Unmounting only detaches; the session keeps running.
// `peek` makes a second, separate view of the same session (for the Peek overlay) alongside its Open-tab window.
export type Footer = { mode: string | null; text: string; notice?: string } | null

export function Term({ name, focus, tick, peek = false, onFooter }: { name: string; focus: boolean; tick: number; peek?: boolean; onFooter?: (f: Footer) => void }) {
  const client = peek ? `${name}~peek` : name
  const el = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const footerCb = useRef(onFooter)
  footerCb.current = onFooter
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const host = el.current
    if (!host) return
    const t = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true, // ⌥-drag makes a plain on-screen selection for ⌘C
      scrollback: 0, // the history lives in tmux, so xterm keeps none of its own to get stuck in
      theme: { background: '#1c1c1e', foreground: '#e5e5ea', cursor: '#e5e5ea', selectionBackground: '#48484a' }
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(host)
    t.attachCustomKeyEventHandler((e) => !(e.metaKey && APP_KEYS.has(e.code)))
    // The history lives in tmux, not in xterm, so the wheel scrolls tmux. Trackpads send many small pixel deltas.
    // The wheel is caught before xterm sees it: after a resize xterm can hold a few spare lines above the screen, and
    // if its own view scrolled into them they'd sit frozen at the top while tmux scrolled underneath.
    let wheel = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault() // the page itself must not scroll too
      e.stopPropagation()
      wheel += e.deltaMode === 1 ? e.deltaY : e.deltaY / 20
      const lines = Math.trunc(wheel)
      if (lines) {
        wheel -= lines
        window.mason.scroll(client, lines)
      }
    }
    host.addEventListener('wheel', onWheel, { capture: true, passive: false })
    // Dragging selects text, and tmux does the selecting so it can run back through the history. Held past the top
    // or bottom edge, the view keeps scrolling. Letting go copies; a small "Copied" shows so you know it worked.
    let drag: { moved: boolean; dir: number; timer: number } | null = null
    let copiedTimer = 0
    const stopAuto = () => {
      if (drag?.timer) clearInterval(drag.timer)
      if (drag) drag.timer = drag.dir = 0
    }
    const onDown = (e: MouseEvent) => {
      if (e.button === 0 && !e.altKey && t.modes.mouseTrackingMode !== 'none') drag = { moved: false, dir: 0, timer: 0 }
    }
    const onMove = (e: MouseEvent) => {
      if (!drag) return
      drag.moved = true
      const r = host.getBoundingClientRect()
      const dir = e.clientY < r.top + 6 ? -1 : e.clientY > r.bottom - 6 ? 1 : 0
      if (dir === drag.dir) return
      stopAuto()
      if (dir) {
        drag.dir = dir
        drag.timer = window.setInterval(() => window.mason.scroll(client, dir), 110)
      }
    }
    const onUp = (e: MouseEvent) => {
      const d = drag
      stopAuto()
      drag = null
      if (!d || !(d.moved || e.detail >= 2)) return
      window.mason.selecting(client)
      setCopied(true)
      clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => setCopied(false), 1400)
    }
    host.addEventListener('mousedown', onDown, true)
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
    // And should xterm's view ever move off the bottom anyway, put it straight back.
    const pinned = t.onScroll(() => t.buffer.active.viewportY !== t.buffer.active.baseY && t.scrollToBottom())
    // Claude gets one row more than fits (up to three while its footer has a notice line under it). Those rows sit just below
    // the visible edge: when they hold Claude's footer, it stays out of sight (its mode shows in Mason's title bar
    // instead). When they hold anything else (a permission prompt, a menu), the view shifts up so nothing that needs
    // you is ever hidden.
    let extra = 1
    const fitPlus = () => {
      const d = fit.proposeDimensions()
      if (!d || !Number.isFinite(d.rows) || !Number.isFinite(d.cols)) return
      // The fit addon measures the host's width with its padding included (everything is border-box), so take that back off.
      const cs = getComputedStyle(host)
      const cellW = (t as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number } } } } } })._core._renderService.dimensions.css.cell.width
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      const cols = Math.max(20, cellW ? Math.floor((host.clientWidth - pad) / cellW) : d.cols)
      const rows = Math.max(5, d.rows + extra)
      if (t.cols !== cols || t.rows !== rows) t.resize(cols, rows)
    }
    let lastFooter = ''
    let blanked: HTMLElement[] = []
    let frame = 0
    const tuck = () => {
      frame = 0
      const buf = t.buffer.active
      if (buf.viewportY !== buf.baseY) t.scrollToBottom()
      const row = (i: number) => buf.getLine(buf.viewportY + t.rows - 1 - i)?.translateToString(true).trim() ?? ''
      // The footer is the bottom row, or sits above a notice line and/or blank rows. Near the bottom it's kept just out of
      // sight; higher up (a conversation that doesn't fill the window yet) its rows are blanked where they are.
      let at = -1
      let notice = ''
      for (let k = 0; k < t.rows - 1 && at < 0; k++) {
        const r = row(k)
        if (FOOTER_RE.test(r)) at = k
        else if (NOTICE_RE.test(r)) notice = r
        else if (r) break
      }
      const isFooter = at >= 0 && at <= 2
      const last = at >= 0 ? row(at) : ''
      for (const d of blanked) d.style.visibility = ''
      blanked = []
      if (at > 2) {
        const divs = t.element?.querySelectorAll<HTMLElement>('.xterm-rows > div')
        for (let k = 0; k <= at; k++) {
          const d = divs?.[t.rows - 1 - k]
          if (d && row(k)) (d.style.visibility = 'hidden'), blanked.push(d)
        }
      }
      const want = isFooter ? at + 1 : extra
      if (want !== extra) {
        extra = want
        try {
          fitPlus()
        } catch {}
      }
      const screen = t.element?.querySelector<HTMLElement>('.xterm-screen')
      const rowH = screen ? screen.clientHeight / t.rows : 0
      // Exactly `extra` rows are out of sight: the bottom ones (the footer), or, shifted up, the top ones.
      // (Below a footer higher up there's only blank space, so the bottom rows can go without shifting anything.)
      const atBottom = at >= 0
      if (t.element && rowH) {
        t.element.style.transform = atBottom ? '' : `translateY(-${rowH * extra}px)`
        t.element.style.clipPath = atBottom ? `inset(0 0 ${rowH * extra}px 0)` : `inset(${rowH * extra}px 0 0 0)`
      }
      const key = last ? `${last}\n${notice}` : ''
      if (key !== lastFooter) {
        lastFooter = key
        footerCb.current?.(last ? { mode: modeOf(last), text: last, notice: notice || undefined } : null)
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
      host.removeEventListener('wheel', onWheel, { capture: true })
      host.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
      stopAuto()
      clearTimeout(copiedTimer)
      pinned.dispose()
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
    >
      {copied && <span className="copied">Copied</span>}
    </div>
  )
}
