import { useRef } from 'react'
import { gsap, useGSAP, reducedMotion } from '../lib/gsap'

/** Block that gets pulled in from the side (default left) when it scrolls into view. */
export function Reveal({ children, as: Tag = 'div', from = 'left', distance = 80, delay = 0, className = '', start = 'top 90%', ...rest }) {
  const ref = useRef(null)
  useGSAP(
    () => {
      if (reducedMotion()) return
      const x = from === 'right' ? distance : from === 'left' ? -distance : 0
      const y = from === 'bottom' ? distance * 0.6 : 0
      gsap.fromTo(
        ref.current,
        { x, y, opacity: 0 },
        { x: 0, y: 0, opacity: 1, duration: 0.9, delay, ease: 'expo.out', scrollTrigger: { trigger: ref.current, start, once: true } },
      )
    },
    { scope: ref },
  )
  return (
    <Tag ref={ref} className={className} {...rest}>
      {children}
    </Tag>
  )
}
