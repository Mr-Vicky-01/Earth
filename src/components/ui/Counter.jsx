import { useRef } from 'react'
import { gsap, useGSAP } from '../../lib/gsap'

/** Counts from 0 to `to` when it scrolls into view. */
export function Counter({ to, prefix = '', suffix = '', decimals = 0, duration = 2, className = '' }) {
  const ref = useRef(null)

  useGSAP(
    () => {
      const obj = { v: 0 }
      const el = ref.current
      const fmt = (v) => prefix + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix
      el.textContent = fmt(0)
      gsap.to(obj, {
        v: to,
        duration,
        ease: 'power3.out',
        onUpdate: () => (el.textContent = fmt(obj.v)),
        scrollTrigger: { trigger: el, start: 'top 90%', once: true },
      })
    },
    { scope: ref, dependencies: [to] },
  )

  return <span ref={ref} className={className} />
}
