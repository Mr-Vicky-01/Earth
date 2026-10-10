import { useEffect, useRef, useState } from 'react'
import { finePointer, reducedMotion } from '../lib/gsap'
import './chrome.css'

const INTERACTIVE = 'a, button, [role="button"], input, select, textarea, label, [data-hover]'

/**
 * Custom cursor: a difference-blended blob that trails the pointer and stretches along its direction of travel
 * (fast flicks smear it into a streak). Grows over links/buttons; over `[data-cursor="Word"]` it becomes a heat
 * plate showing that word. Fine pointers only.
 */
export function Cursor() {
  const root = useRef(null)
  const blob = useRef(null)
  const label = useRef(null)
  const [enabled] = useState(() => finePointer())

  useEffect(() => {
    if (!enabled) return
    const html = document.documentElement
    html.classList.add('has-cursor')
    const el = root.current
    const still = reducedMotion()
    let x = -100
    let y = -100
    let bx = x
    let by = y
    let raf = 0
    let mode = ''

    const setMode = (next, text = '') => {
      if (next === mode && label.current.textContent === text) return
      mode = next
      el.classList.toggle('is-hover', next === 'hover')
      el.classList.toggle('is-label', next === 'label')
      label.current.textContent = text
    }
    const move = (e) => {
      x = e.clientX
      y = e.clientY
      if (!el.classList.contains('is-visible')) {
        bx = x
        by = y
        el.classList.add('is-visible')
      }
    }
    const over = (e) => {
      const t = e.target instanceof Element ? e.target : null
      const labelled = t?.closest('[data-cursor]')
      if (labelled) return setMode('label', labelled.dataset.cursor)
      if (t?.closest(INTERACTIVE)) return setMode('hover')
      setMode('')
    }
    const down = () => el.classList.add('is-down')
    const up = () => el.classList.remove('is-down')
    const leave = () => el.classList.remove('is-visible')

    const loop = () => {
      const dx = x - bx
      const dy = y - by
      const k = still ? 1 : 0.22
      bx += dx * k
      by += dy * k
      el.style.transform = `translate3d(${bx.toFixed(1)}px, ${by.toFixed(1)}px, 0)`
      const speed = Math.hypot(dx, dy) * k
      const s = still ? 0 : Math.min(speed / 16, mode === 'label' ? 0.35 : 1.6)
      const angle = Math.atan2(dy, dx)
      blob.current.style.transform = `rotate(${angle.toFixed(3)}rad) scale(${(1 + s).toFixed(3)}, ${(1 - s * 0.32).toFixed(3)})`
      raf = requestAnimationFrame(loop)
    }

    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerover', over, { passive: true })
    window.addEventListener('pointerdown', down, { passive: true })
    window.addEventListener('pointerup', up, { passive: true })
    html.addEventListener('pointerleave', leave)
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerover', over)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      html.removeEventListener('pointerleave', leave)
      html.classList.remove('has-cursor')
    }
  }, [enabled])

  if (!enabled) return null
  return (
    <div ref={root} className="chr-cursor" aria-hidden="true">
      <div ref={blob} className="chr-blob" />
      <div ref={label} className="chr-label" />
    </div>
  )
}
