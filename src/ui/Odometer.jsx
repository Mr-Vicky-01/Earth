import { useEffect, useMemo, useRef } from 'react'
import { gsap, ScrollTrigger, reducedMotion } from '../lib/gsap'

const DIGITS = '0123456789'

/**
 * Rolling-digit number. Each digit is a vertical strip that spins and lands.
 * Rolls in when scrolled into view (or immediately if `onView` is false), and rolls again
 * whenever `value` changes.
 *
 * props: value (number), decimals, prefix, suffix, separator (',' default), duration, className
 */
export function Odometer({ value, decimals = 0, prefix = '', suffix = '', separator = ',', duration = 1.4, onView = true, className = '' }) {
  const ref = useRef(null)
  const shown = useRef(false)

  const text = useMemo(() => {
    const fixed = Number(value).toFixed(decimals)
    const [int, dec] = fixed.split('.')
    const grouped = separator ? int.replace(/\B(?=(\d{3})+(?!\d))/g, separator) : int
    return prefix + grouped + (dec ? '.' + dec : '') + suffix
  }, [value, decimals, prefix, suffix, separator])

  const chars = Array.from(text)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const strips = Array.from(el.querySelectorAll('.odo-strip'))
    const roll = (instant) => {
      strips.forEach((s, i) => {
        const d = Number(s.dataset.d)
        // strip holds 0-9 twice; land in the second set so it always spins forward
        const target = -((10 + d) / 20) * 100
        if (instant || reducedMotion()) {
          gsap.set(s, { yPercent: target })
        } else {
          gsap.to(s, {
            yPercent: target,
            duration: duration + (strips.length - i) * 0.06,
            ease: 'expo.out',
            overwrite: true,
          })
        }
      })
    }
    if (shown.current) {
      // value changed after first reveal: jump back a lap then roll forward
      strips.forEach((s) => {
        const cur = gsap.getProperty(s, 'yPercent')
        gsap.set(s, { yPercent: cur + 50 })
      })
      roll(false)
      return
    }
    strips.forEach((s) => gsap.set(s, { yPercent: 0 }))
    if (!onView) {
      shown.current = true
      roll(false)
      return
    }
    const st = ScrollTrigger.create({
      trigger: el,
      start: 'top 92%',
      once: true,
      onEnter: () => {
        shown.current = true
        roll(false)
      },
    })
    return () => st.kill()
  }, [text, duration, onView])

  return (
    <span ref={ref} className={`odo ${className}`}>
      <span className="sr-only">{text}</span>
      {chars.map((c, i) =>
        DIGITS.includes(c) ? (
          <span key={`${i}-${chars.length}`} className="odo-col" aria-hidden="true">
            <span className="odo-strip" data-d={c}>
              {(DIGITS + DIGITS).split('').map((n, k) => (
                <span key={k}>{n}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={`${i}-${chars.length}`} className="odo-static" aria-hidden="true">
            {c}
          </span>
        ),
      )}
    </span>
  )
}
