import './hero-picker.css'

/**
 * Review-only switcher for the hero concepts. Fixed bottom-right; the active concept is mirrored in the URL hash
 * (#forged, #drop, #chalk) so a link opens straight to it.
 */
export function HeroPicker({ options, value, onChange, ready }) {
  if (options.length < 2) return null
  return (
    <div className={`hp ${ready ? 'is-in' : ''}`} role="group" aria-label="Hero concept">
      <span className="hp-label">Hero concept</span>
      {options.map(([key, label]) => (
        <button key={key} type="button" className="hp-btn" aria-pressed={value === key} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  )
}
