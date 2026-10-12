import { useEffect, useRef, useState } from 'react'

// Quick capture (⌃⌥N from any app): one line, Enter saves it to Mason's "Saved", Esc closes.
export function Capture() {
  const [text, setText] = useState('')
  const [from, setFrom] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.documentElement.classList.add('capture')
    try {
      const theme = localStorage.getItem('theme')
      if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)
    } catch {}
    return window.mason.onCaptureShow((f) => {
      setFrom(f)
      setText('')
      setTimeout(() => input.current?.focus(), 0)
    })
  }, [])

  const save = async () => {
    if (!text.trim()) return window.mason.captureClose()
    if (await window.mason.captureSave(text)) setText('')
  }

  return (
    <div className="capture-box">
      <span className="capture-mark" aria-hidden="true" />
      <input
        ref={input}
        autoFocus
        aria-label="Capture a thought"
        placeholder="Park a thought…  ↵ save · esc close"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') window.mason.captureClose()
        }}
      />
      {from && <span className="capture-from" title={`Tagged with ${from}`}>from {from}</span>}
    </div>
  )
}
