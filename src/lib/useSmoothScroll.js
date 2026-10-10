import { useEffect } from 'react'
import Lenis from 'lenis'
import { gsap, ScrollTrigger, reducedMotion } from './gsap'

let lenis = null

export function getLenis() {
  return lenis
}

export function scrollToTarget(target) {
  if (lenis) {
    lenis.scrollTo(target, { duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 4) })
  } else {
    const el = typeof target === 'string' ? document.querySelector(target) : target
    el?.scrollIntoView({ behavior: 'smooth' })
  }
}

/** Smooth scrolling (Lenis) wired into GSAP's ticker + ScrollTrigger. */
export function useSmoothScroll(enabled) {
  useEffect(() => {
    if (reducedMotion()) return
    lenis = new Lenis({ lerp: 0.085, smoothWheel: true, syncTouch: false })
    lenis.on('scroll', ScrollTrigger.update)
    const tick = (time) => lenis.raf(time * 1000)
    gsap.ticker.add(tick)
    lenis.stop()
    return () => {
      gsap.ticker.remove(tick)
      lenis.destroy()
      lenis = null
    }
  }, [])

  useEffect(() => {
    if (enabled) {
      lenis?.start()
      document.documentElement.classList.remove('is-locked')
      requestAnimationFrame(() => ScrollTrigger.refresh())
    } else {
      lenis?.stop()
      document.documentElement.classList.add('is-locked')
    }
  }, [enabled])
}
