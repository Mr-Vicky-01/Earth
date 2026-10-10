import { useEffect, useRef } from 'react'
import { gsap, finePointer, reducedMotion } from '../lib/gsap'

/** Wraps an element so it gently follows the cursor while hovered. */
export function Magnetic({ children, strength = 0.32, className = '' }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !finePointer() || reducedMotion()) return
    const xTo = gsap.quickTo(el, 'x', { duration: 0.7, ease: 'power3.out' })
    const yTo = gsap.quickTo(el, 'y', { duration: 0.7, ease: 'power3.out' })
    const move = (e) => {
      const r = el.getBoundingClientRect()
      xTo((e.clientX - (r.left + r.width / 2)) * strength)
      yTo((e.clientY - (r.top + r.height / 2)) * strength)
    }
    const leave = () => {
      xTo(0)
      yTo(0)
    }
    el.addEventListener('mousemove', move)
    el.addEventListener('mouseleave', leave)
    return () => {
      el.removeEventListener('mousemove', move)
      el.removeEventListener('mouseleave', leave)
    }
  }, [strength])

  return (
    <div ref={ref} className={`inline-block ${className}`}>
      {children}
    </div>
  )
}
