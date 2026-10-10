import { Magnetic } from './Magnetic'
import { RollText } from './RollText'
import { ArrowUpRight } from './Icons'

/**
 * Skewed button with a fast colour sweep, rolling label and an arrow that shoots out and back.
 * variant: 'heat' | 'paper' | 'ink' | 'cobalt' | 'line'
 * Renders <a> when `href` is given, otherwise <button type="button">.
 */
export function SpeedButton({ children, href, variant = 'heat', size, onClick, magnetic = true, icon = true, className = '', ...rest }) {
  const cls = `btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} roll-host ${className}`
  const inner = (
    <>
      <RollText>{children}</RollText>
      {icon && (
        <span className="btn-ico" aria-hidden="true">
          <ArrowUpRight />
          <ArrowUpRight />
        </span>
      )}
    </>
  )
  const el = href ? (
    <a href={href} onClick={onClick} className={cls} {...rest}>
      {inner}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={cls} {...rest}>
      {inner}
    </button>
  )
  return magnetic ? <Magnetic>{el}</Magnetic> : el
}
