import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, reducedMotion, finePointer } from '../lib/gsap'
import { scroll, scrollToTarget } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'
import { SlamText } from '../ui/SlamText'
import { SpeedButton } from '../ui/SpeedButton'
import { ArrowRight } from '../ui/Icons'
import { SceneBoundary, SceneFallback } from '../three/SceneBoundary'
import './hero.css'

const HeroScene = lazy(() => import('../three/HeroScene.jsx').then((m) => ({ default: m.HeroScene })))

const OMEGA_MAX = 45 // rad/s
const IDLE_OMEGA = 0.5 // rad/s
const INTRO_TURNS = 3 // full turns the bell spins through while dropping out of warp
const RPM_HOT = 120
const WARP_HOT = 3
const WARP_MAX = 16

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

/** Hidden "about to be yanked in" state for the HTML furniture. */
const PULL_FROM = { x: -110, skewX: -26, scaleX: 1.45, opacity: 0, transformOrigin: '0% 50%' }
const PULL_TO = { x: 0, skewX: 0, scaleX: 1, opacity: 1, duration: 0.8, ease: 'expo.out', stagger: 0.032 }

export function Hero({ ready }) {
  const root = useRef(null)
  const ui = useRef(null)
  const rpmRef = useRef(null)
  const warpRef = useRef(null)
  const spinMeter = useRef(null)
  const warpMeter = useRef(null)
  const inView = useInView(root, '10% 0px')
  const [reduced] = useState(reducedMotion)
  const [lite] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700),
  )

  /*
   * Shared motion state, read by the WebGL scene every frame.
   * angle/omega/tilt: kettlebell physics · energy 0..1 · warp: streak speed multiplier
   * intro 0→1 (drop out of warp) · exit 0→1 (scroll away) · px/py pointer -1..1
   */
  const motion = useRef(null)
  if (!motion.current) {
    motion.current = {
      angle: -0.55,
      omega: reduced ? 0 : IDLE_OMEGA,
      tilt: 0,
      tiltVel: 0,
      tiltTarget: 0,
      dragging: false,
      lastMove: 0,
      energy: 0,
      warp: 1,
      intro: reduced ? 1 : 0,
      exit: 0,
      px: 0,
      py: 0,
      rpm: 0,
      spin: 0,
    }
  }

  /* ---------------- entrance + scroll exit ---------------- */
  // HTML furniture: hidden until ready, then yanked in from the left
  useGSAP(
    () => {
      if (reduced) return
      const items = gsap.utils.toArray('[data-pull]', root.current)
      if (!ready) {
        gsap.set(items, PULL_FROM)
        return
      }
      gsap.fromTo(items, PULL_FROM, { ...PULL_TO, delay: 0.35 })
    },
    { scope: root, dependencies: [ready] },
  )

  // 3D "drop out of warp": waits for the first rendered frame so the move is never played to an empty canvas
  const [sceneLive, setSceneLive] = useState(false)
  const onSceneLive = useCallback(() => setSceneLive(true), [])
  useGSAP(
    () => {
      const m = motion.current
      if (reduced) {
        m.intro = 1
        return
      }
      if (!ready) {
        m.intro = 0
        return
      }
      if (sceneLive) {
        gsap.fromTo(m, { intro: 0 }, { intro: 1, duration: 1.6, ease: 'expo.out' })
        return
      }
      // no WebGL (fallback) or a very slow load: don't leave the readout stuck at warp speed
      gsap.delayedCall(4, () => {
        if (m.intro === 0) m.intro = 1
      })
    },
    { scope: root, dependencies: [ready, sceneLive] },
  )

  useGSAP(
    () => {
      if (reduced) return
      const m = motion.current
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom top', scrub: true },
      })
      tl.to(m, { exit: 1, duration: 1 }, 0)
        .to(ui.current, { y: () => -0.32 * window.innerHeight, duration: 1 }, 0)
        .to(ui.current, { opacity: 0, duration: 0.55, ease: 'power1.in' }, 0.12)
    },
    { scope: root },
  )

  /* ---------------- drag to spin ---------------- */
  useEffect(() => {
    const el = root.current
    const m = motion.current
    if (!el) return
    let id = null
    let engaged = false
    let sx = 0
    let sy = 0
    let lx = 0
    let lt = 0
    let k = 0.0085
    const samples = [] // flat [t, x, t, x, …]
    // event creation time (not handling time), so a busy main thread can't eat the fling
    const stamp = (e) => (e.timeStamp > 0 ? e.timeStamp : performance.now())

    const pushSample = (t, x) => {
      samples.push(t, x)
      while (samples.length > 2 && t - samples[0] > 240) samples.splice(0, 2)
    }
    const flingOmega = (upT) => {
      // angular velocity from the last ~80 ms of pointer travel (0 if the pointer was held still)
      const i = samples.length - 2
      if (i < 2 || upT - samples[i] > 100) return 0
      let j = i
      while (j - 2 >= 0 && samples[i] - samples[j - 2] <= 80) j -= 2
      if (j === i) j = i - 2 // sparse events (slow frame): use the previous sample
      const dtMs = samples[i] - samples[j]
      if (dtMs < 4 || dtMs > 220) return 0
      return ((samples[i + 1] - samples[j + 1]) / dtMs) * 1000 * k
    }
    const engage = (capture) => {
      engaged = true
      m.dragging = true
      el.classList.add('is-dragging')
      // touch is implicitly captured by the section already; re-capturing would fire lost/got capture
      if (!capture) return
      try {
        el.setPointerCapture(id)
      } catch {
        /* pointer already gone */
      }
    }
    const end = (e, fling) => {
      if (e.pointerId !== id) return
      if (engaged && fling) m.omega = clamp(flingOmega(stamp(e)), -OMEGA_MAX, OMEGA_MAX)
      m.dragging = false
      m.tiltTarget = 0
      engaged = false
      id = null
      el.classList.remove('is-dragging')
    }

    const onDown = (e) => {
      if (id !== null) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (e.target.closest('a, button, input, select, textarea, [data-nodrag]')) return
      id = e.pointerId
      sx = lx = e.clientX
      sy = e.clientY
      lt = stamp(e)
      samples.length = 0
      pushSample(lt, sx)
      const touch = e.pointerType !== 'mouse'
      k = touch ? 0.017 : 0.0085
      if (!touch) {
        e.preventDefault() // no text selection while flinging
        engage(true)
      } else {
        engaged = false
      }
    }
    const onMove = (e) => {
      if (e.pointerId !== id) return
      if (!engaged) {
        // touch: only clearly horizontal gestures spin; vertical ones belong to the page
        const tx = e.clientX - sx
        const ty = e.clientY - sy
        if (Math.abs(tx) > 8 && Math.abs(tx) > Math.abs(ty) * 1.3) engage(false)
        else if (Math.abs(ty) > 10) id = null
        if (!engaged) return
      }
      const now = stamp(e)
      const dx = e.clientX - lx
      const dtMs = Math.max(now - lt, 1)
      m.angle += dx * k
      const inst = clamp(((dx * k) / dtMs) * 1000, -OMEGA_MAX, OMEGA_MAX)
      m.omega += (inst - m.omega) * 0.4
      m.lastMove = now
      m.tiltTarget = clamp((e.clientY - sy) * 0.0032, -0.42, 0.42)
      lx = e.clientX
      lt = now
      const co = e.getCoalescedEvents?.()
      if (co && co.length > 1) for (const c of co) pushSample(stamp(c), c.clientX)
      else pushSample(now, e.clientX)
    }
    const onUp = (e) => end(e, true)
    const onCancel = (e) => end(e, false)
    const onBlur = () => {
      if (id === null) return
      m.dragging = false
      m.tiltTarget = 0
      engaged = false
      id = null
      el.classList.remove('is-dragging')
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onBlur)

    // lean toward the pointer (desktop only)
    let onLean = null
    if (finePointer()) {
      onLean = (e) => {
        m.px = (e.clientX / window.innerWidth) * 2 - 1
        m.py = (e.clientY / window.innerHeight) * 2 - 1
      }
      window.addEventListener('pointermove', onLean, { passive: true })
    }
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onBlur)
      if (onLean) window.removeEventListener('pointermove', onLean)
      el.classList.remove('is-dragging')
      m.dragging = false
    }
  }, [])

  /* ---------------- physics + HUD (gsap ticker, ~15 Hz text) ---------------- */
  const hud = useRef({ acc: 0, rpm: -1, warp: '', hotR: null, hotW: null, prevSpin: null })
  useTicker((_, deltaMs) => {
    const m = motion.current
    const h = hud.current
    const dt = Math.min(Math.max(deltaMs, 1), 50) / 1000
    const idle = reduced ? 0 : IDLE_OMEGA

    if (m.dragging) {
      // held still mid-drag → measured speed falls away quickly
      if (performance.now() - m.lastMove > 50) m.omega *= Math.exp(-dt * 12)
    } else {
      m.omega = idle + (m.omega - idle) * Math.exp(-dt * 0.8)
      m.angle += m.omega * dt
    }
    // vertical drag tilt: spring back
    const kSpring = 70
    const cDamp = 11
    m.tiltVel += ((m.tiltTarget - m.tilt) * kSpring - m.tiltVel * cDamp) * dt
    m.tilt += m.tiltVel * dt

    // spin-in on entrance: an extra angle that unwinds with intro (expo.out → fast then settles)
    const introSpin = -(1 - m.intro) * Math.PI * 2 * INTRO_TURNS
    const spin = m.angle + introSpin
    const shown = h.prevSpin === null ? 0 : Math.abs(spin - h.prevSpin) / dt
    h.prevSpin = spin
    m.spin = spin
    m.rpm += (shown * (60 / (2 * Math.PI)) - m.rpm) * 0.25

    m.energy = Math.min(1, Math.abs(m.omega) / 30)
    m.warp = Math.min(WARP_MAX, (1 + scroll.abs * 8 + m.energy * 6 + m.exit * 6) * (1 + 11 * (1 - m.intro)))

    // meters every frame (transform only)
    const eSpin = Math.min(1, m.rpm / 430)
    const eWarp = Math.min(1, (m.warp - 1) / 14)
    if (spinMeter.current) spinMeter.current.style.transform = `scaleX(${eSpin.toFixed(3)})`
    if (warpMeter.current) warpMeter.current.style.transform = `scaleX(${eWarp.toFixed(3)})`

    // text ~15×/s
    h.acc += deltaMs
    if (h.acc < 66) return
    h.acc = 0
    const rpm = Math.round(m.rpm)
    if (rpm !== h.rpm && rpmRef.current) {
      h.rpm = rpm
      rpmRef.current.textContent = String(rpm)
      const hot = rpm >= RPM_HOT
      if (hot !== h.hotR) {
        h.hotR = hot
        rpmRef.current.parentElement.parentElement.classList.toggle('is-hot', hot)
      }
    }
    const w = m.warp.toFixed(1)
    if (w !== h.warp && warpRef.current) {
      h.warp = w
      warpRef.current.textContent = w
      const hot = m.warp >= WARP_HOT
      if (hot !== h.hotW) {
        h.hotW = hot
        warpRef.current.parentElement.parentElement.classList.toggle('is-hot', hot)
      }
    }
  }, inView)

  const go = (target) => (e) => {
    e.preventDefault()
    scrollToTarget(target)
  }

  return (
    <section id="top" ref={root} className="sec s-cobalt hero" data-cursor="Drag" aria-labelledby="hero-title">
      <div className="hero-canvas" aria-hidden="true">
        <SceneBoundary fallback={<SceneFallback />}>
          <Suspense fallback={null}>
            <HeroScene motion={motion.current} active={inView} reduced={reduced} lite={lite} onLive={onSceneLive} />
          </Suspense>
        </SceneBoundary>
      </div>

      <div ref={ui} className="hero-ui wrap">
        <div className="hero-top">
          <p className="tag hero-tag" data-pull>
            <span className="live-dot" aria-hidden="true" />
            Velocity lab · Open 24/7
          </p>

          <div className="hero-hud mono" aria-hidden="true">
            <div className="hero-hud-row hero-hud-spin" data-pull>
              <span className="hero-hud-k">Spin</span>
              <span className="hero-hud-v tnum">
                <b ref={rpmRef}>0</b>
                <i>RPM</i>
              </span>
              <span className="hero-meter">
                <span ref={spinMeter} />
              </span>
            </div>
            <div className="hero-hud-row hero-hud-warp" data-pull>
              <span className="hero-hud-k">Warp</span>
              <span className="hero-hud-v tnum">
                <b ref={warpRef}>1.0</b>
                <i>×</i>
              </span>
              <span className="hero-meter">
                <span ref={warpMeter} />
              </span>
            </div>
            <div className="hero-hud-row hero-hud-hint" data-pull>
              <span className="hero-hud-k">
                <span className="hero-hint-idle">Drag to spin</span>
                <span className="hero-hint-drag">Let go to fling</span>
              </span>
              <span className="hero-nudge">
                <ArrowRight />
              </span>
            </div>
          </div>
        </div>

        <div className="hero-foot">
          <SlamText
            as="h1"
            id="hero-title"
            className="d t-mega hero-title"
            play={ready}
            stretch
            skew
            width={72}
            gain={34}
            lines={['Move it', { text: 'fast.', className: 'outline' }]}
          />

          <div className="hero-copy">
            <p className="lead hero-lead" data-pull>
              Every bar on our floor reads your rep speed in real time. When the speed drops, the set ends. Train
              faster, recover sooner, get stronger without the grind.
            </p>
            <div className="hero-ctas">
              <div className="hero-cta" data-pull>
                <SpeedButton href="#pricing" variant="heat" onClick={go('#pricing')}>
                  Book a free session
                </SpeedButton>
              </div>
              <div className="hero-cta" data-pull>
                <SpeedButton href="#method" variant="line" onClick={go('#method')}>
                  See how it works
                </SpeedButton>
              </div>
            </div>
          </div>

          <a href="#method" className="hero-cue mono" onClick={go('#method')} aria-label="Scroll to how it works" data-pull>
            <span>Scroll</span>
            <span className="hero-cue-lines" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </a>
        </div>
      </div>
    </section>
  )
}
