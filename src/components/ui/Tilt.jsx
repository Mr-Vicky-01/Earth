import { useEffect, useRef } from 'react'
import { gsap, finePointer, reducedMotion } from '../../lib/gsap'

/** 3D tilt-on-hover with a cursor-tracking glare (via --mx / --my). */
export function Tilt({ children, max = 7, className = '', ...rest }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !finePointer() || reducedMotion()) return
    gsap.set(el, { transformPerspective: 1000 })
    const rx = gsap.quickTo(el, 'rotationX', { duration: 0.8, ease: 'power3.out' })
    const ry = gsap.quickTo(el, 'rotationY', { duration: 0.8, ease: 'power3.out' })
    const move = (e) => {
      const r = el.getBoundingClientRect()
      const px = (e.clientX - r.left) / r.width
      const py = (e.clientY - r.top) / r.height
      el.style.setProperty('--mx', `${px * 100}%`)
      el.style.setProperty('--my', `${py * 100}%`)
      rx((0.5 - py) * max * 2)
      ry((px - 0.5) * max * 2)
    }
    const leave = () => {
      rx(0)
      ry(0)
    }
    el.addEventListener('mousemove', move)
    el.addEventListener('mouseleave', leave)
    return () => {
      el.removeEventListener('mousemove', move)
      el.removeEventListener('mouseleave', leave)
    }
  }, [max])

  return (
    <div ref={ref} className={className} {...rest}>
      {children}
    </div>
  )
}
