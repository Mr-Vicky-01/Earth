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
// At rest the bell settles into a 3/4 view with the handle and the 28 KG mark facing the camera and sways gently.
// It never idles side-on: the handle is a flat arch, and edge-on it reads as a single post.
const SHOWCASE = -0.38 // rad
const SWAY = 0.2 // rad either side of the showcase angle while idle
const FREE_SPIN = 2.6 // rad/s; above this the bell coasts freely, below it the settle spring takes over
const TAU = Math.PI * 2
const INTRO_TURNS = 3 // full turns the bell spins through while dropping out of warp
const RPM_HOT = 120
const WARP_HOT = 3
const WARP_MAX = 16
const SCENE_WAIT = 1200 // ms after `ready` that the page waits for the canvas before entering without it
const STIR_MAX = 0.2 // energy a fast mouse pass over the hero can add (fine pointers)

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
  const inViewRef = useRef(inView)
  useEffect(() => {
    inViewRef.current = inView
  }, [inView])
  const [reduced] = useState(reducedMotion)
  const [lite] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700),
  )

  /*
   * Shared motion state, read by the WebGL scene every frame.
   * angle/omega/tilt: kettlebell physics · energy 0..1 (spin, or a fast mouse pass) · warp: streak speed multiplier
   * intro 0→1 (drop out of warp) · burst 1→0 (late-scene warp kick) · pulse 0..1 (idle rep pulse)
   * cue: extra settle angle for the one-off "it spins" wiggle · exit 0→1 (scroll away) · px/py pointer -1..1
   * band: free vertical band between the top row and the headline (stacked layouts frame the bell into it)
   */
  const motion = useRef(null)
  if (!motion.current) {
    motion.current = {
      angle: -0.55,
      omega: 0,
      settle: null,
      tilt: 0,
      tiltVel: 0,
      tiltTarget: 0,
      dragging: false,
      engaged: false,
      lastMove: 0,
      energy: 0,
      stir: 0,
      warp: 1,
      intro: reduced ? 1 : 0,
      introStarted: reduced,
      burst: 0,
      pulse: 0,
      cue: 0,
      exit: 0,
      px: 0,
      py: 0,
      rpm: 0,
      spin: 0,
      band: null,
    }
  }

  /* ---------------- entrance: HTML and warp start in the same frame ---------------- */
  // The page waits briefly for the canvas so the text and the drop out of warp land together. If the canvas is
  // late (cold cache, slow GPU) the page enters on its own after SCENE_WAIT and the scene joins with a short kick.
  const [sceneLive, setSceneLive] = useState(false)
  const onSceneLive = useCallback(() => setSceneLive(true), [])
  // the first frame compiles every shader and can block the main thread for a while: once it has been drawn,
  // the scene is about to go live, so the page keeps waiting a little longer rather than entering without it
  const drawn = useRef(false)
  const onSceneFrame = useCallback(() => {
    drawn.current = true
  }, [])
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    if (!ready || sceneLive || reduced) return
    let id = setTimeout(() => {
      if (!drawn.current) setWaited(true)
      else id = setTimeout(() => setWaited(true), SCENE_WAIT * 2)
    }, SCENE_WAIT)
    return () => clearTimeout(id)
  }, [ready, sceneLive, reduced])
  const go = ready && (reduced || sceneLive || waited)

  // HTML furniture: hidden until go, then yanked in from the left
  useGSAP(
    () => {
      if (reduced) return
      const items = gsap.utils.toArray('[data-pull]', root.current)
      if (!go) {
        gsap.set(items, PULL_FROM)
        return
      }
      gsap.fromTo(items, PULL_FROM, { ...PULL_TO, delay: 0.35 })
    },
    { scope: root, dependencies: [go] },
  )

  // 3D "drop out of warp"
  const forced = useRef(false)
  useGSAP(
    () => {
      const m = motion.current
      if (reduced) {
        m.intro = 1
        m.introStarted = true
        return
      }
      if (!go) {
        m.intro = 0
        m.introStarted = false
        return
      }
      m.introStarted = true
      if (!sceneLive) {
        // page entered without the canvas: the scene will join at rest
        forced.current = true
        m.intro = 1
        return
      }
      if (forced.current) {
        // the scene arrived after the page settled: a short warp kick, no camera replay
        gsap.fromTo(m, { burst: 1 }, { burst: 0, duration: 0.6, ease: 'expo.out' })
        return
      }
      gsap.fromTo(m, { intro: 0 }, { intro: 1, duration: 1.6, ease: 'expo.out' })
    },
    { scope: root, dependencies: [go, sceneLive] },
  )

  /* ---------------- scroll exit: everything gets yanked out as the page accelerates ---------------- */
  useGSAP(
    () => {
      if (reduced) return
      const m = motion.current
      const items = gsap.utils.toArray('[data-pull], .hero-title .d-line', root.current)
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom top', scrub: true, invalidateOnRefresh: true },
      })
      tl.to(m, { exit: 1, duration: 1 }, 0)
        .to(ui.current, { y: () => -0.32 * window.innerHeight, duration: 1 }, 0)
        .fromTo(
          items,
          { x: 0, skewX: 0, scaleX: 1, transformOrigin: '0% 50%' },
          // front-loaded so the yank reads while the content is still on screen (it leaves at ≈55% progress)
          { x: -220, skewX: -22, scaleX: 1.35, duration: 0.42, ease: 'power2.in', stagger: 0.02, immediateRender: false },
          0.03,
        )
        // stays solid until it is nearly gone: no muddy half-transparent heat button over cobalt
        .to(ui.current, { opacity: 0, duration: 0.15 }, 0.85)
    },
    { scope: root },
  )

  /* ---------------- alive at rest: one "it spins" cue, then rep pulses every 4–6 s ---------------- */
  useEffect(() => {
    if (reduced || !go) return
    const m = motion.current
    const kick = root.current?.querySelectorAll('.hero-title .outline .ch') ?? []
    let next = null
    let tlPulse = null
    let tlKick = null
    let tlCue = null
    const idle = () =>
      inViewRef.current && !m.dragging && m.intro > 0.98 && m.exit < 0.02 && scroll.abs < 0.05 && Math.abs(m.omega) < FREE_SPIN
    const pulse = () => {
      if (idle()) {
        tlPulse?.kill()
        tlPulse = gsap
          .timeline()
          .to(m, { pulse: 1, duration: 0.15, ease: 'expo.out' })
          .to(m, { pulse: 0, duration: 0.9, ease: 'power2.out' })
        if (kick.length) {
          // the outlined FAST. gets yanked forward with the rep and snaps back
          tlKick?.kill()
          tlKick = gsap
            .timeline()
            .to(kick, { x: 16, skewX: -16, duration: 0.14, ease: 'expo.out', stagger: 0.016 })
            .to(kick, { x: 0, skewX: 0, duration: 0.75, ease: 'expo.out', stagger: 0.016 }, 0.16)
        }
      }
      next = gsap.delayedCall(gsap.utils.random(4, 6), pulse)
    }
    const cue = () => {
      // the bell wiggles once on its settle spring (never toward side-on), so it's obvious it can be spun
      if (!m.engaged && idle()) {
        tlCue = gsap
          .timeline()
          .to(m, { cue: 0.45, duration: 0.22, ease: 'power2.out' })
          .to(m, { cue: -0.3, duration: 0.34, ease: 'power2.inOut' })
          .to(m, { cue: 0, duration: 0.55, ease: 'power3.out' })
      }
      next = gsap.delayedCall(2.4, pulse)
    }
    next = gsap.delayedCall(2.1, cue)
    return () => {
      next?.kill()
      tlPulse?.kill()
      tlKick?.kill()
      tlCue?.kill()
      if (tlKick) gsap.set(kick, { x: 0, skewX: 0 })
      m.pulse = 0
      m.cue = 0
    }
  }, [go, reduced])

  /* ---------------- stacked layouts: measure the free band above the headline (never per frame) ---------------- */
  useEffect(() => {
    const sec = root.current
    const top = sec?.querySelector('.hero-top')
    const foot = sec?.querySelector('.hero-foot')
    const title = sec?.querySelector('.hero-title')
    const hudEl = sec?.querySelector('.hero-hud')
    if (!sec || !top || !foot || !title || !hudEl) return
    const m = motion.current
    // layout offsets, not rects: the entrance and scroll exit transform these elements
    const offsetIn = (el, axis) => {
      let v = 0
      for (let n = el; n && n !== sec; n = n.offsetParent) v += axis === 'x' ? n.offsetLeft : n.offsetTop
      return v
    }
    const measure = () => {
      m.band = {
        top: offsetIn(top) + top.offsetHeight,
        bottom: offsetIn(title),
        hudLeft: hudEl.offsetWidth ? offsetIn(hudEl, 'x') : 0,
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ;[sec, top, foot, title, hudEl].forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [])

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
      m.engaged = true
      // the user found the interaction: drop the hint wiggle
      gsap.killTweensOf(m, 'cue')
      m.cue = 0
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
      m.settle = null
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
      m.settle = null
      const inst = clamp(((dx * k) / dtMs) * 1000, -OMEGA_MAX, OMEGA_MAX)
      // time-based smoothing: same feel whatever the pointer event rate
      m.omega += (inst - m.omega) * (1 - Math.exp((-dtMs / 1000) * 30))
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

    // desktop: lean toward the pointer, and a fast pass over the hero stirs the warp
    let onLean = null
    if (finePointer()) {
      let pt = 0
      let px = 0
      let py = 0
      onLean = (e) => {
        m.px = (e.clientX / window.innerWidth) * 2 - 1
        m.py = (e.clientY / window.innerHeight) * 2 - 1
        if (reduced || m.dragging || !el.contains(e.target)) {
          pt = 0
          return
        }
        const t = stamp(e)
        const dtMs = t - pt
        if (pt && dtMs > 0 && dtMs < 120) {
          const v = Math.hypot(e.clientX - px, e.clientY - py) / dtMs // px per ms
          const s = Math.min(STIR_MAX, v / 15)
          if (s > m.stir) m.stir = s
        }
        pt = t
        px = e.clientX
        py = e.clientY
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
  }, [reduced])

  /* ---------------- physics + HUD (gsap ticker, ~15 Hz text) ---------------- */
  const hud = useRef({ acc: 0, rpm: -1, warp: '', hotR: null, hotW: null, prevIntro: null })
  useTicker((time, deltaMs) => {
    const m = motion.current
    const h = hud.current
    // gsap clock (lag smoothing is off, so this is real time); physics steps are clamped for stability
    const realDt = Math.max(deltaMs, 1) / 1000
    const dt = Math.min(realDt, 0.05)

    if (m.dragging) {
      // held still mid-drag → measured speed falls away quickly
      if (performance.now() - m.lastMove > 50) m.omega *= Math.exp(-dt * 12)
    } else {
      if (m.settle === null && Math.abs(m.omega) > FREE_SPIN) {
        // flung: coast and slow down
        m.omega *= Math.exp(-dt * 0.8)
      } else {
        if (m.settle === null) {
          // aim for the showcase angle nearest to where the coast would have stopped, so it never spins back
          const proj = m.angle + m.omega / 2.4
          m.settle = SHOWCASE + Math.round((proj - SHOWCASE) / TAU) * TAU
        }
        const target = m.settle + (reduced ? 0 : Math.sin(time * 0.55) * SWAY) + m.cue
        // critically damped spring toward the showcase angle
        const K = 9
        m.omega += ((target - m.angle) * K - m.omega * 2 * Math.sqrt(K)) * dt
      }
      m.angle += m.omega * dt
    }
    // vertical drag tilt: spring back
    const kSpring = 70
    const cDamp = 11
    m.tiltVel += ((m.tiltTarget - m.tilt) * kSpring - m.tiltVel * cDamp) * dt
    m.tilt += m.tiltVel * dt
    // mouse stir fades out
    m.stir *= Math.exp(-realDt * 2.2)

    // spin-in on entrance: an extra angle that unwinds with intro (expo.out → fast then settles)
    m.spin = m.angle - (1 - m.intro) * TAU * INTRO_TURNS
    // shown spin speed, analytic: physics ω plus the rate the entrance unwinds, both on the gsap clock
    const introRate = h.prevIntro === null ? 0 : ((m.intro - h.prevIntro) / realDt) * TAU * INTRO_TURNS
    h.prevIntro = m.intro
    const rpmNow = Math.abs(m.omega + introRate) * (60 / TAU)
    m.rpm += (rpmNow - m.rpm) * (1 - Math.exp(-realDt * 18))

    m.energy = Math.max(Math.min(1, Math.abs(m.omega) / 30), m.stir)
    const cruise = 1 + scroll.abs * 8 + m.energy * 6 + m.exit * 6 + m.pulse * 3
    m.warp = Math.min(WARP_MAX, cruise * (1 + 11 * (1 - m.intro)) + m.burst * 5)
    const shownWarp = m.introStarted ? m.warp : 1

    // meters every frame (transform only)
    const eSpin = Math.min(1, m.rpm / 430)
    const eWarp = Math.min(1, (shownWarp - 1) / 14)
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
    const w = shownWarp.toFixed(1)
    if (w !== h.warp && warpRef.current) {
      h.warp = w
      warpRef.current.textContent = w
      const hot = shownWarp >= WARP_HOT
      if (hot !== h.hotW) {
        h.hotW = hot
        warpRef.current.parentElement.parentElement.classList.toggle('is-hot', hot)
      }
    }
  }, inView)

  const jump = (target) => (e) => {
    e.preventDefault()
    scrollToTarget(target)
  }

  return (
    <section id="top" ref={root} className="sec s-cobalt hero" data-cursor="Drag" aria-labelledby="hero-title">
      <div className="hero-canvas" aria-hidden="true">
        <SceneBoundary fallback={<SceneFallback />}>
          <Suspense fallback={null}>
            <HeroScene
              motion={motion.current}
              active={inView}
              reduced={reduced}
              lite={lite}
              onFrame={onSceneFrame}
              onLive={onSceneLive}
            />
          </Suspense>
        </SceneBoundary>
      </div>

      <div ref={ui} className="hero-ui wrap">
        <div className="hero-top">
          <p className="tag hero-tag" data-pull>
            <span className="live-dot" aria-hidden="true" />
            <span className="hero-tag-text">
              <span className="hero-tag-long">Velocity lab · </span>Open 24/7
            </span>
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
                <span className="hero-hint-idle">
                  <span className="hero-hint-fine">Drag</span>
                  <span className="hero-hint-coarse">Swipe</span> to spin
                </span>
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
            play={go}
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
                <SpeedButton href="#pricing" variant="heat" onClick={jump('#pricing')}>
                  Book a free session
                </SpeedButton>
              </div>
              <div className="hero-cta" data-pull>
                <SpeedButton href="#method" variant="line" onClick={jump('#method')}>
                  See how it works
                </SpeedButton>
              </div>
            </div>
          </div>

          <a href="#method" className="hero-cue mono" onClick={jump('#method')} aria-label="Scroll to how it works" data-pull>
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
