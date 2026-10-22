import { useEffect, useRef, useState } from 'react'

// Experiment: rest the pointer on a window in the Open tab for a couple of seconds, then just start typing, and that
// window becomes the active one, with your first keystroke landing there too. No click needed.
// To remove it: delete this file, and in App.tsx the useHoverToType line, the `armed` class, and the armed-tag hint.
export const HOVER_TO_TYPE = true
const DWELL_MS = 2000

// Keys that count as "starting to type", and what each one sends to the terminal.
function keyData(e: KeyboardEvent): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null
  if (e.key.length === 1) return e.key
  if (e.key === 'Enter') return '\r'
  if (e.key === 'Backspace') return '\x7f'
  return null
}

// Returns the window that's "armed" (hovered long enough that typing will switch to it), so App can show a hint.
export function useHoverToType(active: boolean, focusHost: string | null, onActivate: (host: string) => void): string | null {
  const [armed, setArmed] = useState<string | null>(null)
  const focusRef = useRef(focusHost)
  focusRef.current = focusHost
  const activate = useRef(onActivate)
  activate.current = onActivate

  useEffect(() => {
    if (!HOVER_TO_TYPE || !active) return setArmed(null)
    let hovered: string | null = null
    let timer = 0
    let current: string | null = null
    const arm = (host: string | null) => {
      current = host
      setArmed(host)
    }

    const onOver = (e: MouseEvent) => {
      const host = (e.target as Element | null)?.closest?.<HTMLElement>('.win[data-host]')?.dataset.host ?? null
      if (host === hovered) return
      hovered = host
      window.clearTimeout(timer)
      arm(null)
      if (host && host !== focusRef.current) timer = window.setTimeout(() => host !== focusRef.current && arm(host), DWELL_MS)
    }
    const onLeaveWindow = (e: MouseEvent) => {
      if (e.relatedTarget) return
      hovered = null
      window.clearTimeout(timer)
      arm(null)
    }
    // Capture phase, so the keystroke is caught before the currently active terminal sees it.
    const onKey = (e: KeyboardEvent) => {
      if (!current || current === focusRef.current) return
      const data = keyData(e)
      if (data === null) return
      e.preventDefault()
      e.stopPropagation()
      const host = current
      arm(null)
      activate.current(host)
      window.mason.input(host, data)
    }

    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onLeaveWindow, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onLeaveWindow, true)
      window.removeEventListener('keydown', onKey, true)
      setArmed(null)
    }
  }, [active])

  // Clicking into (or otherwise switching to) the armed window means there's nothing left to arm.
  useEffect(() => {
    if (armed && armed === focusHost) setArmed(null)
  }, [focusHost, armed])

  return armed
}
