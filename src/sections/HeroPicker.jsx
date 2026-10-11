import { useEffect, useState } from 'react'
import './hero-picker.css'

/**
 * Review-only switcher for the hero concepts; the choice is mirrored in the URL hash (#forged, #drop, #chalk).
 * variant "float": fixed under the nav bar on tablets and desktops, shown only while the hero is on screen.
 * variant "inline": rendered inside the phone menu.
 */
export function HeroPicker({ options, value, onChange, ready, variant = 'float' }) {
  const [near, setNear] = useState(true)
  useEffect(() => {
    if (variant !== 'float') return
    const on = () => setNear(window.scrollY < window.innerHeight * 0.55)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [variant])

  if (options.length < 2) return null
  const cls = variant === 'float' ? `hp hp-float ${ready && near ? 'is-in' : ''}` : 'hp hp-inline'
  return (
    <div className={cls} role="group" aria-label="Hero concept">
      <span className="hp-label">Hero concept</span>
      {options.map(([key, label]) => (
        <button key={key} type="button" className="hp-btn" aria-pressed={value === key} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  )
}
