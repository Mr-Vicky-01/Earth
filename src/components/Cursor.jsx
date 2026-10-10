import { useEffect, useRef } from 'react'
import { gsap, finePointer } from '../lib/gsap'

/** Custom cursor: an instant dot plus a lagging ring that reacts to links and `data-cursor` labels. */
export function Cursor() {
  const dot = useRef(null)
  const ring = useRef(null)

  useEffect(() => {
    if (!finePointer()) return
    const html = document.documentElement
    const d = dot.current
    const r = ring.current
    html.classList.add('has-cursor')
    gsap.set([d, r], { opacity: 0 })

    let x = window.innerWidth / 2
    let y = window.innerHeight / 2
    let rx = x
    let ry = y
    let raf = 0
    let visible = false

    const move = (e) => {
      x = e.clientX
      y = e.clientY
      d.style.transform = `translate3d(${x}px, ${y}px, 0)`
      if (!visible) {
        visible = true
        gsap.to([d, r], { opacity: 1, duration: 0.3 })
      }
    }
    const loop = () => {
      rx += (x - rx) * 0.16
      ry += (y - ry) * 0.16
      r.style.transform = `translate3d(${rx}px, ${ry}px, 0)`
      raf = requestAnimationFrame(loop)
    }
    const over = (e) => {
      const labelled = e.target.closest?.('[data-cursor]')
      const interactive = e.target.closest?.('a, button, [data-hover]')
      r.classList.toggle('is-label', !!labelled)
      r.classList.toggle('is-hover', !labelled && !!interactive)
      r.dataset.label = labelled?.dataset.cursor || ''
    }
    const leave = () => {
      visible = false
      gsap.to([d, r], { opacity: 0, duration: 0.3 })
    }

    window.addEventListener('mousemove', move, { passive: true })
    window.addEventListener('mouseover', over)
    document.documentElement.addEventListener('mouseleave', leave)
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseover', over)
      document.documentElement.removeEventListener('mouseleave', leave)
      html.classList.remove('has-cursor')
    }
  }, [])

  return (
    <>
      <div ref={dot} className="cursor-dot" aria-hidden="true" />
      <div ref={ring} className="cursor-ring" aria-hidden="true" />
    </>
  )
}
