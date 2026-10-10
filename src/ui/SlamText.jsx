import { useRef } from 'react'
import { gsap, useGSAP, ScrollTrigger, reducedMotion } from '../lib/gsap'
import { scroll } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { Chars } from './Chars'

/**
 * Display text whose characters get yanked into place: each char shoots in from the side,
 * stretched and skewed, then snaps to rest.
 *
 * props
 *  lines     string | (string | { text, className })[]   one entry per line (lines never wrap)
 *  as        tag name (default h2)
 *  className classes for the element (add `d t-xl` etc. yourself)
 *  play      undefined → plays when scrolled into view; boolean → plays when it becomes true
 *  from      'left' | 'right'
 *  delay, stagger, start (ScrollTrigger start for the scroll mode)
 *  stretch   true → font width follows scroll speed (variable font `--w`)
 *  width     base font width for stretch (default 75), gain = extra width at full speed (default 30)
 *  skew      true → whole block skews with scroll velocity
 */
export function SlamText({
  lines,
  as: Tag = 'h2',
  className = '',
  play,
  from = 'left',
  delay = 0,
  stagger = 0.022,
  start = 'top 88%',
  stretch = false,
  width = 75,
  gain = 30,
  skew = false,
  ...rest
}) {
  const ref = useRef(null)
  const list = Array.isArray(lines) ? lines : [lines]

  useGSAP(
    () => {
      const chars = ref.current.querySelectorAll('.ch')
      if (reducedMotion()) return
      const fromVars =
        from === 'right'
          ? { xPercent: 150, scaleX: 1.9, skewX: 28, transformOrigin: '100% 60%' }
          : { xPercent: -150, scaleX: 1.9, skewX: -28, transformOrigin: '0% 60%' }
      gsap.set(chars, { x: 0, ...fromVars, opacity: 0 })
      const run = () =>
        gsap.to(chars, {
          x: 0,
          xPercent: 0,
          scaleX: 1,
          skewX: 0,
          opacity: 1,
          duration: 0.8,
          ease: 'expo.out',
          stagger: from === 'right' ? { each: stagger, from: 'end' } : stagger,
          delay,
        })
      if (play === undefined) {
        ScrollTrigger.create({ trigger: ref.current, start, once: true, onEnter: run })
      } else if (play) {
        run()
      }
    },
    { scope: ref, dependencies: [play] },
  )

  const last = useRef({ w: width, s: 0 })
  useTicker(() => {
    const el = ref.current
    if (!el) return
    if (stretch) {
      const w = Math.round((width + scroll.abs * gain) * 2) / 2
      if (w !== last.current.w) {
        last.current.w = w
        el.style.setProperty('--w', w)
      }
    }
    if (skew) {
      const s = Math.round(-scroll.norm * 9 * 10) / 10
      if (s !== last.current.s) {
        last.current.s = s
        el.style.transform = `skewX(${s}deg)`
      }
    }
  }, (stretch || skew) && !reducedMotion())

  return (
    <Tag ref={ref} className={className} style={{ '--w': width }} {...rest}>
      {list.map((line, i) => {
        const text = typeof line === 'string' ? line : line.text
        const cls = typeof line === 'string' ? '' : line.className || ''
        return (
          <span key={i} className={`d-line ${cls}`}>
            <Chars text={text} />
          </span>
        )
      })}
    </Tag>
  )
}
