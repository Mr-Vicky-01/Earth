import { useEffect, useRef } from 'react'
import { reducedMotion } from '../lib/gsap'
import { scroll } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'

/**
 * Infinite marquee that accelerates with scroll speed, flips direction with scroll direction
 * and skews while moving fast.
 *
 * props
 *  children   one copy of the content (rendered `repeat` times per half)
 *  speed      base px/second
 *  boost      extra px/second at full scroll speed
 *  reverse    start moving the other way
 *  skew       max skew in degrees at full speed (0 to disable)
 *  repeat     copies per half (raise it for short content)
 */
export function VelocityMarquee({ children, speed = 70, boost = 1600, reverse = false, skew = 10, repeat = 3, className = '', trackClassName = '' }) {
  const root = useRef(null)
  const track = useRef(null)
  const half = useRef(null)
  const state = useRef({ x: 0, w: 1, skew: 0 })
  const inView = useInView(root, '10% 0px')

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      state.current.w = half.current?.offsetWidth || 1
    })
    if (half.current) ro.observe(half.current)
    return () => ro.disconnect()
  }, [])

  useTicker(
    (_t, dt) => {
      const s = state.current
      const dir = (reverse ? 1 : -1) * scroll.direction
      const v = speed + scroll.abs * boost
      s.x += dir * v * (Math.min(dt, 50) / 1000)
      if (s.x <= -s.w) s.x += s.w
      if (s.x > 0) s.x -= s.w
      s.skew += (-scroll.norm * skew - s.skew) * 0.15
      if (track.current) track.current.style.transform = `translate3d(${s.x.toFixed(2)}px,0,0) skewX(${s.skew.toFixed(2)}deg)`
    },
    inView && !reducedMotion(),
  )

  const copies = (key) =>
    Array.from({ length: repeat }, (_, i) => (
      <div key={`${key}-${i}`} className="vmq-group">
        {children}
      </div>
    ))

  return (
    <div ref={root} className={`vmq ${className}`}>
      <div ref={track} className={`vmq-track ${trackClassName}`}>
        <div ref={half} className="vmq-group">
          {copies('a')}
        </div>
        <div className="vmq-group" aria-hidden="true">
          {copies('b')}
        </div>
      </div>
    </div>
  )
}
