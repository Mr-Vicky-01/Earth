import { useCallback, useEffect, useRef } from 'react'
import { ScrollTrigger, reducedMotion } from '../lib/gsap'

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&/<>+=*'

/**
 * Returns `run(el, finalText, durationMs)`: characters flicker through random glyphs and
 * lock in left-to-right. Cancels any run already in progress on the same element.
 */
export function useScramble() {
  const frames = useRef(new Map())
  useEffect(() => () => frames.current.forEach((id) => cancelAnimationFrame(id)), [])
  return useCallback((el, finalText, duration = 650) => {
    if (!el) return
    const text = String(finalText)
    if (reducedMotion()) {
      el.textContent = text
      return
    }
    cancelAnimationFrame(frames.current.get(el))
    const t0 = performance.now()
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration)
      const locked = Math.floor(p * text.length)
      let out = ''
      for (let i = 0; i < text.length; i++) {
        const c = text[i]
        out += i < locked || c === ' ' ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0]
      }
      el.textContent = out
      if (p < 1) frames.current.set(el, requestAnimationFrame(step))
      else frames.current.delete(el)
    }
    frames.current.set(el, requestAnimationFrame(step))
  }, [])
}

/** Text that scrambles in when scrolled into view (`trigger="view"`) and/or on hover. */
export function ScrambleText({ text, as: Tag = 'span', trigger = 'view', duration = 650, className = '' }) {
  const ref = useRef(null)
  const run = useScramble()
  useEffect(() => {
    if (trigger !== 'view' && trigger !== 'both') return
    const st = ScrollTrigger.create({ trigger: ref.current, start: 'top 92%', once: true, onEnter: () => run(ref.current, text, duration) })
    return () => st.kill()
  }, [text, trigger, duration, run])
  const hover = trigger === 'hover' || trigger === 'both' ? { onMouseEnter: () => run(ref.current, text, duration) } : {}
  return (
    <Tag ref={ref} className={className} {...hover}>
      {text}
    </Tag>
  )
}
