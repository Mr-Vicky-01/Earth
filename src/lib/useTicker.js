import { useEffect, useRef } from 'react'
import { gsap } from './gsap'

/**
 * Run `fn(timeSeconds, deltaMs)` on every GSAP tick while `active` is true.
 * The latest `fn` is always used, so it may close over fresh props/state.
 */
export function useTicker(fn, active = true) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const cb = (t, dt) => ref.current(t, dt)
    gsap.ticker.add(cb)
    return () => gsap.ticker.remove(cb)
  }, [active])
}
