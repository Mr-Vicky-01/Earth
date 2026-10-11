import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, reducedMotion, finePointer } from '../lib/gsap'
import { scrollToTarget } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'
import { SpeedButton } from '../ui/SpeedButton'
import { SceneBoundary } from '../three/SceneBoundary'
import { createRig, stepRig, release, LOAD_KG } from '../three/drop/sim'
import './hero-drop.css'

const DropScene = lazy(() => import('../three/drop/DropScene.jsx').then((m) => ({ default: m.DropScene })))

const SCENE_WAIT = 1300 // ms after `ready` before the copy enters without the canvas
const PULL_FROM = { x: -110, skewX: -26, scaleX: 1.45, opacity: 0, transformOrigin: '0% 50%' }
const PULL_TO = { x: 0, skewX: 0, scaleX: 1, opacity: 1, duration: 0.8, ease: 'expo.out', stagger: 0.03 }
const HOT = 1.5 // m/s: the readout turns heat above this

/** Software rasterisers (SwiftShader, llvmpipe) get the light path: no MSAA, smaller shadows, fewer particles. */
function softwareGL() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') || c.getContext('webgl')
    if (!gl) return false
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return /swiftshader|llvmpipe|software|softpipe/i.test(name)
  } catch {
    return false
  }
}

/** Static stand-in when WebGL is unavailable: the headline set big under a hard spotlight. */
function DropFallback() {
  return (
    <div className="hd-fallback" aria-hidden="true">
      <div className="hd-fallback-cone" />
      <p className="hd-fallback-type d">
        <span className="d-line">Move it</span>
        <span className="d-line">
          fast<span className="hd-fallback-dot">.</span>
        </span>
      </p>
      <div className="hd-fallback-bar">
        <i />
        <i />
        <i />
        <b />
        <i />
        <i />
        <i />
      </div>
    </div>
  )
}

/**
 * Hero: THE DROP. A loaded Olympic bar falls into a dark gym and slams onto the platform under one hard light.
 * Drag the bar up to lift it (it hangs on a heavy spring), let go and it drops and bounces; click, tap or
 * press "Drop it" for a power clean and drop. Scrolling hoists it overhead and the light dies into the next section.
 */
export function HeroDrop({ ready }) {
  const root = useRef(null)
  const ui = useRef(null)
  const stage = useRef(null)
  const grab = useRef(null)
  const band = useRef(null)
  const speedRef = useRef(null)
  const heightRef = useRef(null)
  const readRef = useRef(null)
  const inView = useInView(root, '10% 0px')
  const [reduced] = useState(reducedMotion)
  const [lite] = useState(
    () =>
      typeof window !== 'undefined' &&
      !(import.meta.env.DEV && /[?&]dd=[^&]*full/.test(location.search)) &&
      (window.matchMedia('(pointer: coarse)').matches ||
        window.innerWidth < 700 ||
        softwareGL() ||
        (import.meta.env.DEV && /[?&]dd=[^&]*lite/.test(location.search))),
  )
  const rigRef = useRef(null)
  if (!rigRef.current) rigRef.current = createRig({ reduced })
  const rig = rigRef.current

  useEffect(() => {
    rig.grabEl = grab.current
    // dev-only handle for state probes in the screenshot harness (+ ?dd=slow: 10× slow motion for captures)
    if (import.meta.env.DEV) {
      window.__drop = rig
      if (/[?&]dd=[^&]*slow/.test(location.search)) {
        rig.timeScale = 0.1
        gsap.globalTimeline.timeScale(0.1)
      }
    }
    return () => {
      rig.grabEl = null
      if (import.meta.env.DEV && rig.timeScale) gsap.globalTimeline.timeScale(1)
    }
  }, [rig])

  /* ---------------- free band between the top row and the copy (the scene frames into it) ---------------- */
  useEffect(() => {
    const sec = root.current
    const el = band.current
    if (!sec || !el) return
    const offsetIn = (node) => {
      let v = 0
      for (let n = node; n && n !== sec; n = n.offsetParent) v += n.offsetTop
      return v
    }
    let ver = 0
    const box = (node) => {
      if (!node || !node.offsetWidth) return null
      let x = 0
      let y = 0
      for (let n = node; n && n !== sec; n = n.offsetParent) {
        x += n.offsetLeft
        y += n.offsetTop
      }
      return { x0: x, y0: y, x1: x + node.offsetWidth, y1: y + node.offsetHeight }
    }
    const measure = () => {
      const top = offsetIn(el)
      // the wrap's content edge, so the painted headline lines up with the copy
      const wrap = ui.current
      const left = wrap ? wrap.offsetLeft + parseFloat(getComputedStyle(wrap).paddingLeft || '0') : 0
      // HTML blocks the plates must stay above (copy first: particles also fade over it)
      const blocks = ['.hd-copy', '.hd-act', '.hd-hint', '.hd-read', '.hd-drop']
        .map((q) => box(sec.querySelector(q)))
        .filter((b) => b && b.y0 >= top + el.offsetHeight - 2)
      rig.band = { top, bottom: top + el.offsetHeight, left, h: sec.offsetHeight, w: sec.offsetWidth, blocks, ver: ++ver }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(sec)
    ro.observe(el)
    // the web fonts change the copy's height once they arrive
    let alive = true
    document.fonts?.ready.then(() => alive && measure())
    return () => {
      alive = false
      ro.disconnect()
    }
  }, [rig])

  /* ---------------- entrance gate: wait for the scene to draw (with a safety timeout) ---------------- */
  const [sceneLive, setSceneLive] = useState(false)
  const drawn = useRef(false)
  const onSceneFrame = useCallback(() => {
    drawn.current = true
  }, [])
  const onSceneLive = useCallback(() => setSceneLive(true), [])
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    if (!ready || sceneLive || reduced) return
    let id = setTimeout(() => {
      // the first frame compiles every shader and can stall; once it is drawn, give it a little longer
      if (!drawn.current) setWaited(true)
      else id = setTimeout(() => setWaited(true), SCENE_WAIT * 1.5)
    }, SCENE_WAIT)
    return () => clearTimeout(id)
  }, [ready, sceneLive, reduced])
  const go = ready && (reduced || sceneLive || waited)
  if (import.meta.env.DEV) rig.dbg = { ready, sceneLive, waited, go }

  /* ---------------- entrance: flicker on, the bar drops and slams, the copy is yanked in ---------------- */
  const htmlIn = useRef(reduced)
  const introDone = useRef(reduced)
  const { contextSafe } = useGSAP(
    () => {
      if (reduced) return
      const items = gsap.utils.toArray('[data-pull]', root.current)
      const pullIn = (delay = 0) => {
        if (htmlIn.current) return
        htmlIn.current = true
        gsap.fromTo(items, PULL_FROM, { ...PULL_TO, delay })
      }
      if (!htmlIn.current) gsap.set(items, PULL_FROM)
      if (!go) return

      // page entered without the canvas: copy comes in now, the scene plays its own drop when it arrives
      if (!sceneLive) {
        pullIn(0.1)
        return
      }
      if (introDone.current) return
      introDone.current = true

      const landed = { done: false }
      const onSlam = () => {
        if (landed.done) return
        landed.done = true
        gsap.to(rig, { dolly: 1, duration: 1.2, ease: 'expo.out' })
        gsap
          .timeline()
          // the slam jolts the tube: a quick dip as the lamp starts to swing
          .to(rig, { light: 0.55, duration: 0.03, ease: 'none' }, 0.02)
          .to(rig, { light: 1, duration: 0.09, ease: 'none' }, 0.06)
          // and the wall comes up with it: a stutter, then the headline is lit
          .to(rig, { wall: 0.75, duration: 0.04, ease: 'none' }, 0.04)
          .to(rig, { wall: 0.15, duration: 0.05, ease: 'none' })
          .to(rig, { wall: 1, duration: 0.7, ease: 'expo.out' })
        pullIn(0.06)
      }
      rig.onImpact = (v, n) => {
        if (n === 1) onSlam()
        flashRead()
      }
      gsap
        .timeline()
        .set(rig, { light: 0, wall: 0, dolly: 0 })
        // fluorescent flicker: three blinks over a quarter second, then it holds
        .to(rig, { light: 1, duration: 0.02, ease: 'none' }, 0.05)
        .to(rig, { light: 0.05, duration: 0.03, ease: 'none' }, 0.1)
        .to(rig, { light: 0.9, duration: 0.02, ease: 'none' }, 0.15)
        .to(rig, { light: 0.2, duration: 0.03, ease: 'none' }, 0.19)
        .to(rig, { light: 1, duration: 0.05, ease: 'none' }, 0.25)
        .call(
          () => {
            rig.y = rig.dropFrom
            rig.vy = -2.6
            rig.mode = 'fall'
          },
          null,
          0.3,
        )
        // safety: never leave the copy waiting on the physics
        .call(onSlam, null, 1.9)
    },
    { scope: root, dependencies: [go, sceneLive] },
  )

  // impacts flash the readout heat
  const flashRead = () => {
    const el = readRef.current
    if (!el) return
    el.classList.remove('is-slam')
    void el.offsetWidth
    el.classList.add('is-slam')
  }
  useEffect(() => {
    if (reduced) rig.onImpact = () => flashRead()
    return () => {
      rig.onImpact = null
    }
  }, [rig, reduced])

  /* ---------------- idle: the tube buzzes now and then (a faint double dip), only while nothing is happening ---------------- */
  const inViewRef = useRef(inView)
  useEffect(() => {
    inViewRef.current = inView
  }, [inView])
  useEffect(() => {
    if (reduced || !go) return
    let next = null
    let tl = null
    const buzz = () => {
      const idle = inViewRef.current && rig.mode === 'rest' && rig.exit < 0.01 && rig.light > 0.99 && htmlIn.current
      if (idle) {
        tl = gsap
          .timeline()
          .to(rig, { light: 0.78, duration: 0.03, ease: 'none' })
          .to(rig, { light: 1, duration: 0.04, ease: 'none' })
          .to(rig, { light: 0.86, duration: 0.03, ease: 'none' }, '+=0.05')
          .to(rig, { light: 1, duration: 0.06, ease: 'none' })
      }
      next = gsap.delayedCall(gsap.utils.random(7, 12), buzz)
    }
    next = gsap.delayedCall(6, buzz)
    return () => {
      next?.kill()
      tl?.kill()
      if (tl) rig.light = 1
    }
  }, [go, reduced, rig])

  /* ---------------- scroll exit: hoisted overhead, the light dies, the copy rips upward ---------------- */
  useGSAP(
    () => {
      if (reduced) return
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom top', scrub: true, invalidateOnRefresh: true },
      })
      tl.to(rig, { exit: 1, duration: 1 }, 0)
        // the scene holds still in the viewport while the next section slides up over it
        .fromTo(stage.current, { y: 0 }, { y: () => root.current.offsetHeight, duration: 1 }, 0)
        .fromTo(ui.current, { y: 0 }, { y: () => -0.55 * root.current.offsetHeight, duration: 1 }, 0)
        .fromTo(ui.current, { opacity: 1 }, { opacity: 0, duration: 0.12, ease: 'power1.in' }, 0.025)
    },
    { scope: root },
  )

  /* ---------------- power clean: the click / tap / keyboard action ---------------- */
  const cleanTl = useRef(null)
  const powerClean = contextSafe(() => {
    if (rig.mode === 'hold' || rig.mode === 'drag' || rig.mode === 'script' || rig.exit > 0.03) return
    cleanTl.current?.kill()
    const top = rig.cleanTop
    rig.scriptY = rig.y
    rig.mode = 'script'
    rig.lifted = true
    root.current?.classList.add('is-clean')
    const knee = Math.min(0.42, top * 0.36)
    const hip = top * 0.82
    cleanTl.current = gsap
      .timeline({
        onComplete: () => {
          release(rig)
          rig.vy = 0
          root.current?.classList.remove('is-clean')
        },
      })
      .to(rig, { scriptY: knee, duration: 0.4, ease: 'sine.in' }) // first pull
      .to(rig, { scriptY: hip, duration: 0.24, ease: 'none' }) // second pull: explosive
      .to(rig, { scriptY: top, duration: 0.17, ease: 'power1.out' }) // floats to the catch
      .to(rig, { scriptY: top - 0.07, duration: 0.16, ease: 'power2.out' }) // caught at the chest
      .to(rig, { scriptY: top - 0.055, duration: 0.42, ease: 'sine.inOut' }) // hold … then drop
    if (import.meta.env.DEV) rig.cleanTl = cleanTl.current
  })
  const cleanRef = useRef(powerClean)
  cleanRef.current = powerClean
  useEffect(
    () => () => {
      cleanTl.current?.kill()
    },
    [],
  )

  /* ---------------- drag to lift (mouse/pen), tap to clean (touch) ---------------- */
  useEffect(() => {
    const el = grab.current
    const sec = root.current
    if (!el || !sec) return
    let id = null
    let state = 'idle' // idle | pending | drag | touch
    let sx = 0
    let sy = 0
    let t0 = 0
    let grip = null // where on the bar the pointer pressed (world x, height above the bar's axis)

    const startDrag = () => {
      state = 'drag'
      cleanTl.current?.kill()
      sec.classList.remove('is-clean')
      rig.target = Math.max(0, rig.y)
      rig.mode = 'drag'
      rig.lifted = true
      sec.classList.add('is-lifting')
    }
    const endDrag = () => {
      release(rig)
      sec.classList.remove('is-lifting')
    }
    const onDown = (e) => {
      if (id !== null || rig.exit > 0.03 || rig.mode === 'hold' || rig.mode === 'script') return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      id = e.pointerId
      sx = e.clientX
      sy = e.clientY
      t0 = e.timeStamp
      if (e.pointerType === 'touch') {
        state = 'touch' // never block the page scrolling: taps only
        return
      }
      e.preventDefault()
      state = 'pending'
      grip = rig.pick ? rig.pick(e.clientX, e.clientY) : null
      try {
        el.setPointerCapture(id)
      } catch {
        /* pointer already gone */
      }
    }
    const onMove = (e) => {
      if (e.pointerId !== id) return
      if (state === 'touch') {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) {
          state = 'idle'
          id = null
        }
        return
      }
      if (state === 'pending' && Math.hypot(e.clientX - sx, e.clientY - sy) > 4) startDrag()
      // the grabbed point stays under the hand: solved through the live camera (crane follow included)
      if (state === 'drag' && rig.liftAt && grip) rig.target = rig.liftAt(e.clientX, e.clientY, grip)
    }
    const onUp = (e) => {
      if (e.pointerId !== id) return
      const quick = e.timeStamp - t0 < 450
      if (state === 'drag') endDrag()
      else if ((state === 'pending' || state === 'touch') && quick) cleanRef.current()
      state = 'idle'
      id = null
    }
    const onCancel = (e) => {
      if (e.pointerId !== id) return
      if (state === 'drag') endDrag()
      state = 'idle'
      id = null
    }
    const onBlur = () => {
      if (state === 'drag') endDrag()
      state = 'idle'
      id = null
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onBlur)

    // desktop: the camera leans toward the pointer
    let onLean = null
    if (finePointer() && !reduced) {
      onLean = (e) => {
        rig.px = (e.clientX / window.innerWidth) * 2 - 1
        rig.py = (e.clientY / window.innerHeight) * 2 - 1
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
      sec.classList.remove('is-lifting', 'is-clean')
      if (rig.mode === 'drag') release(rig)
    }
  }, [rig, reduced])

  /* ---------------- physics + readout (gsap ticker; text ≤ 20×/s) ---------------- */
  const read = useRef({ acc: 0, v: '', h: '', hot: null, peak: 0, peakAt: 0 })
  useTicker((time, deltaMs) => {
    stepRig(rig, (Math.max(deltaMs, 0) / 1000) * (rig.timeScale ?? 1))
    const r = read.current
    // hold the peak speed for a moment so a fast rep or a slam can actually be read
    const speed = Math.abs(rig.vy)
    if (speed >= r.peak || time - r.peakAt > 0.55) {
      r.peak = speed
      r.peakAt = time
    }
    r.acc += deltaMs
    if (r.acc < 50) return
    r.acc = 0
    const v = r.peak.toFixed(2)
    const h = (rig.mode === 'hold' ? 0 : Math.max(0, rig.y)).toFixed(2)
    if (v !== r.v && speedRef.current) {
      r.v = v
      speedRef.current.textContent = v
    }
    if (h !== r.h && heightRef.current) {
      r.h = h
      heightRef.current.textContent = h
    }
    const hot = r.peak >= HOT
    if (hot !== r.hot && readRef.current) {
      r.hot = hot
      readRef.current.classList.toggle('is-hot', hot)
    }
  }, inView)

  const jump = (target) => (e) => {
    e.preventDefault()
    scrollToTarget(target)
  }

  return (
    <section id="top" ref={root} className="sec s-ink hd" aria-labelledby="hd-title">
      <div ref={stage} className="hd-stage" aria-hidden="true">
        <SceneBoundary fallback={<DropFallback />}>
          <Suspense fallback={null}>
            <DropScene
              rig={rig}
              active={inView}
              reduced={reduced}
              lite={lite}
              onFrame={onSceneFrame}
              onLive={onSceneLive}
            />
          </Suspense>
        </SceneBoundary>
      </div>

      {/* hit area over the bar, positioned by the scene every frame it moves */}
      <div ref={grab} className="hd-grab" data-cursor="Lift" aria-hidden="true" />

      <div ref={ui} className="hd-ui wrap">
        <p className="tag hd-tag" data-pull>
          <span className="live-dot" aria-hidden="true" />
          <span>
            <span className="hd-tag-long">Velocity lab · </span>Open 24/7
          </span>
        </p>

        <p ref={readRef} className="hd-read mono tnum" data-pull aria-hidden="true">
          <span>
            Load <b>{LOAD_KG}</b> kg
          </span>
          <i>·</i>
          <span>
            Bar <b ref={speedRef}>0.00</b> m/s
          </span>
          <i>·</i>
          <span>
            <b ref={heightRef}>0.00</b> m
          </span>
        </p>

        <h1 id="hd-title" className="sr-only">
          Move it fast.
        </h1>
        <div ref={band} className="hd-band" aria-hidden="true" />

        <div className="hd-copy">
          <p className="lead hd-lead" data-pull>
            Every bar on our floor reads your rep speed in real time. When the speed drops, the set ends.{' '}
            <span className="hd-lead-more">Train faster, recover sooner, get stronger without the grind.</span>
          </p>
          <div className="hd-ctas">
            <div className="hd-cta" data-pull>
              <SpeedButton href="#pricing" variant="heat" onClick={jump('#pricing')}>
                Book a free session
              </SpeedButton>
            </div>
            <div className="hd-cta" data-pull>
              <SpeedButton href="#method" variant="line" onClick={jump('#method')}>
                See how it works
              </SpeedButton>
            </div>
          </div>
        </div>

        <div className="hd-act">
          <p className="mono hd-hint" data-pull>
            <span className="hd-hint-idle">
              <span className="hd-hint-fine">
                <span>Drag the bar up to lift</span>
                <span>Let go to drop</span>
              </span>
              <span className="hd-hint-coarse">Tap the bar to lift</span>
            </span>
            <span className="hd-hint-lift">Let go to drop</span>
          </p>
          <button type="button" className="hd-drop mono" onClick={powerClean} data-pull>
            <span className="speed-glyph" aria-hidden="true" />
            Drop it
          </button>
        </div>
      </div>
    </section>
  )
}

export default HeroDrop
