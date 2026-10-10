import { useEffect } from 'react'
import Lenis from 'lenis'
import { gsap, ScrollTrigger, reducedMotion } from './gsap'

/**
 * Live scroll state, updated once per GSAP tick. Read it from tickers / useFrame.
 *  - velocity: raw px per 60fps-frame (signed)
 *  - smooth:   eased velocity (signed)
 *  - norm:     smooth velocity normalised to -1..1   (≈45 px/frame = 1)
 *  - abs:      |norm|, 0..1 — use this for "how fast is the user scrolling"
 *  - direction: 1 down, -1 up (sticky, last non-zero direction)
 *  - progress: 0..1 through the whole document
 */
export const scroll = { y: 0, velocity: 0, smooth: 0, norm: 0, abs: 0, direction: 1, progress: 0 }

/** px → metres, using the CSS reference pixel (1px = 0.2646 mm at 96 dpi). */
export const PX_TO_M = 0.0002646

let lenis = null
export const getLenis = () => lenis

export function scrollToTarget(target, { offset = 0, immediate = false } = {}) {
  const el = typeof target === 'string' ? (target === '#top' ? document.body : document.querySelector(target)) : target
  if (lenis) {
    lenis.scrollTo(target === '#top' ? 0 : el ?? target, {
      offset,
      immediate,
      duration: 1.15,
      easing: (t) => 1 - Math.pow(1 - t, 5),
    })
  } else if (el) {
    const top = target === '#top' ? 0 : el.getBoundingClientRect().top + window.scrollY + offset
    window.scrollTo({ top, behavior: reducedMotion() || immediate ? 'auto' : 'smooth' })
  }
}

function tick(_time, deltaTime) {
  const y = window.scrollY
  const dt = Math.max(deltaTime || 16.667, 1)
  const raw = ((y - scroll.y) / dt) * 16.667
  scroll.y = y
  scroll.velocity = raw
  scroll.smooth += (raw - scroll.smooth) * 0.16
  if (Math.abs(scroll.smooth) < 0.002) scroll.smooth = 0
  scroll.norm = gsap.utils.clamp(-1, 1, scroll.smooth / 45)
  scroll.abs = Math.abs(scroll.norm)
  if (raw > 0.5) scroll.direction = 1
  else if (raw < -0.5) scroll.direction = -1
  const max = document.documentElement.scrollHeight - window.innerHeight
  scroll.progress = max > 0 ? y / max : 0
}

/** Lenis smooth scroll + velocity tracking. Scrolling is locked until `enabled` is true. */
export function useSmoothScroll(enabled) {
  useEffect(() => {
    scroll.y = window.scrollY
    // follow real time even when frames run long (heavy WebGL, slow devices): animations stay on schedule
    gsap.ticker.lagSmoothing(0)
    gsap.ticker.add(tick)
    let lenisTick = null
    if (!reducedMotion()) {
      lenis = new Lenis({ lerp: 0.11, smoothWheel: true, wheelMultiplier: 1.05 })
      lenis.on('scroll', ScrollTrigger.update)
      lenisTick = (t) => lenis?.raf(t * 1000)
      gsap.ticker.add(lenisTick)
      lenis.stop()
    }
    return () => {
      gsap.ticker.remove(tick)
      if (lenisTick) gsap.ticker.remove(lenisTick)
      lenis?.destroy()
      lenis = null
    }
  }, [])

  useEffect(() => {
    const html = document.documentElement
    if (enabled) {
      lenis?.start()
      html.classList.remove('is-locked')
      requestAnimationFrame(() => ScrollTrigger.refresh())
    } else {
      lenis?.stop()
      html.classList.add('is-locked')
    }
  }, [enabled])
}
