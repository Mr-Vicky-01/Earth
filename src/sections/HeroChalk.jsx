import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, reducedMotion } from '../lib/gsap'
import { PX_TO_M, scrollToTarget } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'
import { SpeedButton } from '../ui/SpeedButton'
import { SceneBoundary } from '../three/SceneBoundary'
import { LAYOUTS, variantFor } from '../three/chalk/layout'
import './hero-chalk.css'

const ChalkScene = lazy(() => import('../three/chalk/ChalkScene.jsx').then((m) => ({ default: m.ChalkScene })))
const ChalkFallback = lazy(() => import('../three/chalk/ChalkFallback.jsx').then((m) => ({ default: m.ChalkFallback })))

const SCENE_WAIT = 1200 // ms after `ready` that the page waits for the canvas before entering without it
const LOCK_WAIT = 2600 // ms after the slam starts before the copy enters even if the letters haven't reported in
const AIR_HOT = 1 // m/s: the air readout turns heat above this
const PULL_FROM = { x: -110, skewX: -26, scaleX: 1.45, opacity: 0, transformOrigin: '0% 50%' }
const PULL_TO = { x: 0, skewX: 0, scaleX: 1, opacity: 1, duration: 0.8, ease: 'expo.out', stagger: 0.03 }

export function HeroChalk({ ready }) {
  const root = useRef(null)
  const ui = useRef(null)
  const word = useRef(null)
  const stage = useRef(null)
  const airRef = useRef(null)
  const inView = useInView(root, '10% 0px')
  const [reduced] = useState(reducedMotion)
  const [lite] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700),
  )
  // portrait boxes (phones, upright tablets) stack the dust headline in three lines so it can be twice as big
  const [variant, setVariant] = useState(() =>
    typeof window !== 'undefined' ? variantFor(window.innerWidth, window.innerHeight) : 'wide',
  )

  /*
   * Shared state, read by the WebGL scene every frame (no React state in the loop).
   * box: the dust headline's layout box (css px, relative to the section) · ptr: pointer in section px with its
   * velocity (px/s) and -1..1 position · claps: queued claps · hold: pointer held down (blowing) · exit 0..1
   */
  const motion = useRef(null)
  if (!motion.current) {
    motion.current = {
      go: false,
      box: null,
      ptr: { x: 0, y: 0, vx: 0, vy: 0, nx: 0, ny: 0, t: 0, inside: false },
      claps: [],
      hold: false,
      exit: 0,
      air: 0,
      stage: null,
      onBox: null,
      invalidate: null,
      dbg: null,
    }
    if (import.meta.env.DEV && typeof window !== 'undefined') window.__hc = motion.current
  }

  /* ---------------- entrance gate: wait for the canvas to draw (with a safety timeout) ---------------- */
  const [sceneLive, setSceneLive] = useState(false)
  const onSceneLive = useCallback(() => setSceneLive(true), [])
  const drawn = useRef(false)
  const onSceneFrame = useCallback(() => {
    drawn.current = true
  }, [])
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    if (!ready || sceneLive || reduced) return
    let id = setTimeout(() => {
      // the first frame compiles the shaders and can stall: once it has drawn, give it a little longer
      if (!drawn.current) setWaited(true)
      else id = setTimeout(() => setWaited(true), SCENE_WAIT * 2)
    }, SCENE_WAIT)
    return () => clearTimeout(id)
  }, [ready, sceneLive, reduced])
  const go = ready && (reduced || sceneLive || waited)
  useEffect(() => {
    motion.current.go = go
  }, [go])

  // the copy is pulled in as the letters lock in (the scene reports it), or after a timeout
  const [locked, setLocked] = useState(false)
  const onLock = useCallback(() => setLocked(true), [])
  useEffect(() => {
    if (!go || locked) return
    const id = setTimeout(() => {
      // dev only: frame-stepped verification runs far slower than real time, so the scene alone decides
      if (import.meta.env.DEV && motion.current.dbgDt) return
      setLocked(true)
    }, sceneLive ? LOCK_WAIT : 350)
    return () => clearTimeout(id)
  }, [go, locked, sceneLive])

  useGSAP(
    () => {
      if (reduced) return
      const items = gsap.utils.toArray('[data-pull]', root.current)
      if (!locked) {
        gsap.set(items, PULL_FROM)
        return
      }
      gsap.fromTo(items, PULL_FROM, PULL_TO)
    },
    { scope: root, dependencies: [locked] },
  )

  /* ---------------- scroll exit: a gust carries the dust (and the copy) off to the right ---------------- */
  useGSAP(
    () => {
      if (reduced) return
      const m = motion.current
      const top = gsap.utils.toArray('.hc-top [data-pull]', root.current)
      const items = gsap.utils.toArray('.hc-foot [data-pull]', root.current)
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom top', scrub: true, invalidateOnRefresh: true },
      })
      tl.to(m, { exit: 1, duration: 1 }, 0)
        .to(ui.current, { y: () => -0.18 * window.innerHeight, duration: 1 }, 0)
        // the top row goes first and fast, before it can slide up under the nav
        .fromTo(
          top,
          { x: 0, skewX: 0, scaleX: 1, opacity: 1, transformOrigin: '0% 50%' },
          {
            x: () => window.innerWidth * 0.4,
            skewX: -24,
            scaleX: 1.4,
            opacity: 0,
            duration: 0.032,
            ease: 'power1.in',
            stagger: 0.006,
            immediateRender: false,
          },
          0,
        )
        .fromTo(
          items,
          { x: 0, y: 0, skewX: 0, scaleX: 1, opacity: 1, transformOrigin: '0% 50%' },
          // blown off to the right with the gust front, front-loaded so it reads while still on screen
          {
            x: () => window.innerWidth * 0.72,
            y: -36,
            skewX: -24,
            scaleX: 1.4,
            opacity: 0,
            duration: 0.4,
            ease: 'power2.in',
            stagger: 0.03,
            immediateRender: false,
          },
          0.05,
        )
        .to(ui.current, { opacity: 0, duration: 0.15 }, 0.82)
    },
    { scope: root },
  )

  /* ---------------- layout box of the dust headline (never measured per frame) ---------------- */
  useEffect(() => {
    const sec = root.current
    const el = word.current
    const stg = stage.current
    if (!sec || !el || !stg) return
    const m = motion.current
    // layout offsets, not rects: the scroll exit transforms the UI layer
    const offset = (node) => {
      let x = 0
      let y = 0
      for (let n = node; n && n !== sec; n = n.offsetParent) {
        x += n.offsetLeft
        y += n.offsetTop
      }
      return [x, y]
    }
    const measure = () => {
      const [x, y] = offset(el)
      m.box = { x, y, w: el.offsetWidth, h: el.offsetHeight }
      const [, sy] = offset(stg)
      m.stage = { y: sy, h: stg.offsetHeight }
      m.size = { w: sec.clientWidth, h: sec.clientHeight }
      setVariant(variantFor(sec.clientWidth, sec.clientHeight))
      m.onBox?.()
      m.invalidate?.()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(sec)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* ---------------- pointer: blow, clap, hold to keep blowing ---------------- */
  const clapAt = useCallback((x, y) => {
    const m = motion.current
    m.claps.push({ x, y })
    m.air = Math.max(m.air, 3.2 + Math.random() * 0.9)
    m.invalidate?.()
  }, [])

  useEffect(() => {
    const el = root.current
    const m = motion.current
    if (!el) return
    const p = m.ptr
    let rect = null
    let downId = null
    let downX = 0
    let downY = 0
    let downT = 0
    let holdTimer = 0
    const stamp = (e) => (e.timeStamp > 0 ? e.timeStamp : performance.now())
    const local = (e) => {
      if (!rect) rect = el.getBoundingClientRect()
      return [e.clientX - rect.left, e.clientY - rect.top]
    }
    const dropRect = () => {
      rect = null
    }
    const track = (e) => {
      const [x, y] = local(e)
      const t = stamp(e)
      const dtMs = t - p.t
      if (p.inside && dtMs > 0 && dtMs < 120) {
        const k = 1 - Math.exp(-dtMs / 28)
        p.vx += (((x - p.x) / dtMs) * 1000 - p.vx) * k
        p.vy += (((y - p.y) / dtMs) * 1000 - p.vy) * k
      } else {
        p.vx = 0
        p.vy = 0
      }
      p.x = x
      p.y = y
      p.t = t
      // cached by the layout observer: no layout reads per pointer event
      const sz = m.size
      p.nx = sz ? (x / Math.max(1, sz.w)) * 2 - 1 : 0
      p.ny = sz ? (y / Math.max(1, sz.h)) * 2 - 1 : 0
      p.inside = true
    }
    const blocked = (e) => e.target instanceof Element && e.target.closest('a, button, input, select, textarea')

    const onMove = (e) => {
      track(e)
      if (downId === e.pointerId && e.pointerType !== 'mouse' && Math.hypot(e.clientX - downX, e.clientY - downY) > 10) {
        clearTimeout(holdTimer)
      }
    }
    const onDown = (e) => {
      if (blocked(e)) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      dropRect()
      track(e)
      downId = e.pointerId
      downX = e.clientX
      downY = e.clientY
      downT = stamp(e)
      if (e.pointerType === 'mouse') {
        e.preventDefault() // no text selection while blowing
        clapAt(p.x, p.y)
        m.hold = true
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          /* gone */
        }
      } else {
        // touch: a tap claps (on release); pressing and holding still blows
        clearTimeout(holdTimer)
        holdTimer = setTimeout(() => {
          if (downId !== null) m.hold = true
        }, 260)
      }
    }
    const end = (e, tap) => {
      if (e.pointerId !== downId) return
      clearTimeout(holdTimer)
      if (tap && e.pointerType !== 'mouse') {
        const moved = Math.hypot(e.clientX - downX, e.clientY - downY)
        if (moved < 12 && stamp(e) - downT < 380 && !m.hold) clapAt(p.x, p.y)
      }
      m.hold = false
      downId = null
      if (e.pointerType !== 'mouse') p.inside = false
    }
    const onUp = (e) => end(e, true)
    const onCancel = (e) => end(e, false)
    const onLeave = (e) => {
      if (e.pointerType === 'mouse' && downId === null) p.inside = false
    }
    const onBlur = () => {
      m.hold = false
      downId = null
      clearTimeout(holdTimer)
    }

    el.addEventListener('pointermove', onMove, { passive: true })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    el.addEventListener('pointerleave', onLeave)
    window.addEventListener('blur', onBlur)
    window.addEventListener('scroll', dropRect, { passive: true })
    window.addEventListener('resize', dropRect)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('scroll', dropRect)
      window.removeEventListener('resize', dropRect)
      clearTimeout(holdTimer)
      m.hold = false
    }
  }, [clapAt])

  // keyboard (and the hint itself): clap at the middle of the headline
  const clapCentre = () => {
    const b = motion.current.box
    if (b) clapAt(b.x + b.w / 2, b.y + b.h / 2)
  }

  /* ---------------- air readout: pointer speed in m/s, a clap spikes it (≤ 15 text updates/s) ---------------- */
  const hud = useRef({ acc: 0, txt: '', hot: null, air: 0 })
  useTicker((_t, deltaMs) => {
    const m = motion.current
    const h = hud.current
    const dt = Math.min(deltaMs, 100) / 1000
    const p = m.ptr
    const stale = performance.now() - p.t > 90
    const v = p.inside && !stale ? Math.hypot(p.vx, p.vy) * PX_TO_M : 0
    // claps write m.air directly; it decays like a puff of air
    m.air = Math.max(v, m.air * Math.exp(-dt * 3.2))
    h.air += (m.air - h.air) * (1 - Math.exp(-dt * 14))
    h.acc += deltaMs
    if (h.acc < 66) return
    h.acc = 0
    const txt = (h.air < 0.005 ? 0 : h.air).toFixed(2)
    if (txt !== h.txt && airRef.current) {
      h.txt = txt
      airRef.current.textContent = txt
    }
    const hot = h.air >= AIR_HOT
    if (hot !== h.hot && airRef.current) {
      h.hot = hot
      airRef.current.parentElement.classList.toggle('is-hot', hot)
    }
  }, inView)

  const jump = (target) => (e) => {
    e.preventDefault()
    scrollToTarget(target)
  }

  return (
    <section id="top" ref={root} className="sec s-ink hc" aria-labelledby="hc-title">
      <div className="hc-canvas" aria-hidden="true">
        <SceneBoundary
          fallback={
            <Suspense fallback={null}>
              <ChalkFallback motion={motion.current} variant={variant} />
            </Suspense>
          }
        >
          <Suspense fallback={null}>
            <ChalkScene
              motion={motion.current}
              active={inView}
              reduced={reduced}
              lite={lite}
              variant={variant}
              onFrame={onSceneFrame}
              onLive={onSceneLive}
              onLock={onLock}
            />
          </Suspense>
        </SceneBoundary>
      </div>
      <div className="hc-hit" data-cursor="Clap" aria-hidden="true" />

      <div ref={ui} className="hc-ui wrap">
        <div className="hc-top">
          <p className="tag hc-tag" data-pull>
            <span className="live-dot" aria-hidden="true" />
            <span>
              <span className="hc-tag-long">Velocity lab · </span>Open 24/7
            </span>
          </p>
          <p className="hc-air mono" data-pull aria-hidden="true">
            <span className="hc-air-k">Air</span>
            <b ref={airRef} className="tnum">
              0.00
            </b>
            <i>m/s</i>
          </p>
        </div>

        <div ref={stage} className="hc-stage">
          <h1 id="hc-title" className="sr-only">
            Move it fast.
          </h1>
          <div
            ref={word}
            className={`hc-word is-${variant}`}
            style={{ '--hc-aspect': LAYOUTS[variant].aspect }}
            aria-hidden="true"
          />
        </div>

        <div className="hc-foot">
          <p className="lead hc-lead" data-pull>
            Every bar on our floor reads your rep speed in real time. When the speed drops, the set ends. Train faster,
            recover sooner, get stronger without the grind.
          </p>
          <div className="hc-actions">
            <div className="hc-ctas">
              <div className="hc-cta" data-pull>
                <SpeedButton href="#pricing" variant="heat" onClick={jump('#pricing')}>
                  Book a free session
                </SpeedButton>
              </div>
              <div className="hc-cta" data-pull>
                <SpeedButton href="#method" variant="line" onClick={jump('#method')}>
                  See how it works
                </SpeedButton>
              </div>
            </div>
            <button type="button" className="hc-hint mono" data-pull onClick={clapCentre}>
              <span className="hc-hint-mark" aria-hidden="true">
                <i />
                <i />
              </span>
              <span className="hc-hint-fine">Move to blow the chalk · Click to clap</span>
              <span className="hc-hint-coarse">Tap to clap</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
