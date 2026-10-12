import { useEffect, useRef, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// ⌘ shortcuts that belong to Mason (switching tabs, arranging windows), not to the terminal.
const APP_KEYS = new Set(['Digit1', 'Digit2', 'BracketLeft', 'BracketRight', 'Enter', 'KeyL', 'KeyO', 'KeyW', 'KeyK', 'KeyP', 'KeyN'])

// One live terminal, attached to a Mason session (a tmux session) through the main process.
// Unmounting only detaches; the session keeps running.
export function Term({ name, focus, tick }: { name: string; focus: boolean; tick: number }) {
  const el = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

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
        window.mason.scroll(name, lines)
      }
      return false
    })
    try {
      fit.fit()
    } catch {}
    termRef.current = t

    // Listen before attaching so the first screen redraw isn't missed.
    const offData = window.mason.onTermData((n, d) => n === name && t.write(d))
    const offExit = window.mason.onTermExit((n) => n === name && t.write('\r\n\x1b[2m[Detached]\x1b[0m\r\n'))
    window.mason.attach(name, t.cols, t.rows).then((ok) => {
      if (!ok) t.write('\x1b[2mThis session has ended.\x1b[0m\r\n')
    })
    const input = t.onData((d) => window.mason.input(name, d))
    const resize = t.onResize(({ cols, rows }) => window.mason.resize(name, cols, rows))
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {}
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      input.dispose()
      resize.dispose()
      offData()
      offExit()
      window.mason.detach(name)
      t.dispose()
      termRef.current = null
    }
  }, [name])

  useEffect(() => {
    if (focus) termRef.current?.focus()
  }, [focus, tick])

  // Dropping files types their paths, like Terminal does, so Claude can pick up a dragged-in screenshot.
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    const paths = [...e.dataTransfer.files].map((f) => window.mason.pathFor(f)).filter(Boolean)
    if (!paths.length) return
    // Escaped the way Terminal does it (backslash before spaces and shell characters), which Claude recognizes.
    window.mason.input(name, paths.map((p) => p.replace(/([ \t'"\\()[\]{}&;|<>*?!$`#~])/g, '\\$1')).join(' ') + ' ')
    termRef.current?.focus()
  }
  return (
    <div
      className="term"
      ref={el}
      onMouseDown={() => termRef.current?.focus()}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy'))}
      onDrop={onDrop}
    />
  )
}
