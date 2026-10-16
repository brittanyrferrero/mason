import type { BrowserWindow } from 'electron'
import { existsSync, rmSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db'

// A way for Claude (or you) to see exactly what Mason is showing, without screen-recording permission:
// `touch ~/.mason/debug-request` and Mason saves a picture of its own window to ~/.mason/debug.png, plus layout
// measurements (anything scrolled or squeezed sideways) to ~/.mason/debug.json. Nothing leaves your Mac.
const REQUEST = join(DATA_DIR, 'debug-request')

// Runs in the page. Reports every scrolled-sideways element, anything wider than its box, and each window's layout.
const MEASURE = `(() => {
  const name = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')
  const all = [...document.querySelectorAll('*')]
  const scrolledSideways = all.filter((e) => e.scrollLeft !== 0).map((e) => ({ el: name(e), scrollLeft: e.scrollLeft }))
  const wider = all
    .filter((e) => e.scrollWidth - e.clientWidth > 1 && getComputedStyle(e).overflowX !== 'visible')
    .map((e) => ({ el: name(e), slack: e.scrollWidth - e.clientWidth, overflowX: getComputedStyle(e).overflowX }))
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) } }
  const wins = [...document.querySelectorAll('.win')].map((w) => {
    const bar = w.querySelector('.win-bar'), title = w.querySelector('.win-bar b'), screen = w.querySelector('.xterm-screen')
    return {
      host: w.dataset.host, classes: w.className.replace(/\\s+/g, ' ').trim(), win: r(w), bar: r(bar),
      barOverflow: bar ? bar.scrollWidth - bar.clientWidth : null, title: title?.textContent ?? null, titleBox: r(title),
      term: r(w.querySelector('.term')), xterm: r(w.querySelector('.xterm')), screen: r(screen),
      xtermTransform: w.querySelector('.xterm')?.style.transform || '', xtermClip: w.querySelector('.xterm')?.style.clipPath || ''
    }
  })
  return { viewport: { w: innerWidth, h: innerHeight }, view: document.querySelector('.app')?.className, scrolledSideways, wider, wins }
})()`

export function watchDebugRequests(getWin: () => BrowserWindow | null): void {
  const handle = async () => {
    if (!existsSync(REQUEST)) return
    rmSync(REQUEST, { force: true })
    const win = getWin()
    if (!win || win.isDestroyed()) return
    try {
      writeFileSync(join(DATA_DIR, 'debug.png'), (await win.webContents.capturePage()).toPNG(), { mode: 0o600 })
      const measured = await win.webContents.executeJavaScript(MEASURE)
      writeFileSync(join(DATA_DIR, 'debug.json'), JSON.stringify({ at: new Date().toISOString(), ...measured }, null, 2), { mode: 0o600 })
    } catch (e) {
      writeFileSync(join(DATA_DIR, 'debug.json'), JSON.stringify({ error: String(e) }), { mode: 0o600 })
    }
  }
  try {
    watch(DATA_DIR, (_ev, f) => f === 'debug-request' && handle())
  } catch {}
}
