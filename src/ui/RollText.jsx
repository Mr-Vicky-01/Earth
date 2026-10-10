/**
 * Hover text roll: every letter flips up and is replaced by its twin from below, staggered.
 * Triggers when hovering the element itself or any ancestor with class `roll-host`.
 */
export function RollText({ children, className = '' }) {
  const text = String(children)
  const chars = Array.from(text).map((c, i) => (
    <span key={i} className="rc" style={{ '--i': i }}>
      {c === ' ' ? ' ' : c}
    </span>
  ))
  return (
    <span className={`roll ${className}`}>
      <span className="sr-only">{text}</span>
      <span className="roll-a" aria-hidden="true">
        {chars}
      </span>
      <span className="roll-b" aria-hidden="true">
        {chars}
      </span>
    </span>
  )
}
