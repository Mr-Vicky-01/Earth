import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, reducedMotion, finePointer } from '../lib/gsap'
import { scrollToTarget } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'
import { SpeedButton } from '../ui/SpeedButton'
import { SceneBoundary } from '../three/SceneBoundary'
import { createRig, stepRig, release, beginClean, beginDrag, startEntrance, LOAD_KG } from '../three/drop/sim'
import './hero-drop.css'

const DropScene = lazy(() => import('../three/drop/DropScene.jsx').then((m) => ({ default: m.DropScene })))

const SCENE_WAIT = 1.3 // s after `ready` before the copy enters without the canvas (ticker time)
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

/** Static stand-in when WebGL is unavailable: the headline painted on a dim block wall under a hard light. */
function DropFallback() {
  return (
    <div className="hd-fallback" aria-hidden="true">
      <div className="hd-fallback-wall" />
      <div className="hd-fallback-cone" />
      <p className="hd-fallback-type d">
        <span className="d-line">Move it</span>
        <span className="d-line">
          fast<span className="hd-fallback-dot">.</span>
        </span>
      </p>
      <div className="hd-fallback-floor" />
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
 * Hero: THE DROP. A lamp strikes in a dark gym and a loaded Olympic bar falls into its light and slams onto the
 * platform. Drag the bar up to lift it (it hangs on a heavy spring), let go and it drops and bounces; click, tap
 * or press "Drop it" for a power clean and drop. Scrolling hoists it overhead and the light dies into the next
 * section. All motion is physics in sim.js; this component owns the gate, the copy and the inputs.
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
    // dev-only handle for state probes in the capture tools (+ ?dd=slow: 10× slow motion)
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

  /* ---------------- entrance gate: the scene is compiled, uploaded and warm (with a safety timeout) ---------------- */
  const [sceneLive, setSceneLive] = useState(false)
  const onSceneLive = useCallback(() => setSceneLive(true), [])
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    if (!ready || sceneLive || reduced) return
    // on the GSAP ticker, so it measures the same clock the motion runs on
    const dc = gsap.delayedCall(SCENE_WAIT, () => setWaited(true))
    return () => dc.kill()
  }, [ready, sceneLive, reduced])
  const go = ready && (reduced || sceneLive || waited)
  if (import.meta.env.DEV) rig.dbg = { ready, sceneLive, warm: sceneLive, waited, go }

  /* ---------------- entrance: the lamp strikes, the bar drops into its light, the copy is yanked in on the slam ---------------- */
  const htmlIn = useRef(reduced)
  const introDone = useRef(reduced)
  useGSAP(
    () => {
      if (reduced) return
      const items = gsap.utils.toArray('[data-pull]', root.current)
      const scrim = root.current.querySelector('.hd-copy')
      const pullIn = (delay = 0) => {
        if (htmlIn.current) return
        htmlIn.current = true
        gsap.fromTo(items, PULL_FROM, { ...PULL_TO, delay })
        // the ink scrim behind the copy comes up with it (in the dark before the slam it would show as a panel);
        // the variable lives on the copy block itself, so only that small subtree restyles
        gsap.to(scrim, { '--hd-scrim': 1, duration: 0.45, ease: 'power2.out', delay })
      }
      if (!htmlIn.current) {
        gsap.set(items, PULL_FROM)
        gsap.set(scrim, { '--hd-scrim': 0 })
      }
      if (!go) return

      // page entered without the canvas: copy comes in now, the scene plays its own drop when it arrives
      if (!sceneLive) {
        pullIn(0.1)
        return
      }
      if (introDone.current) return
      introDone.current = true
      rig.onImpact = (v, n) => {
        if (n === 1) pullIn(0.04)
        flashRead()
      }
      startEntrance(rig)
      // dev-only: ?dd=skip fast-forwards the entrance (look iteration in the capture tools)
      if (import.meta.env.DEV && /[?&]dd=[^&]*skip/.test(location.search)) for (let i = 0; i < 240; i++) stepRig(rig, 1 / 60)
      // safety: never leave the copy waiting on the physics
      gsap.delayedCall(1.6, () => pullIn(0))
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

  /* ---------------- scroll exit: hoisted overhead, the light dies, the copy rips upward ---------------- */
  useGSAP(
    () => {
      if (reduced) return
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom top', scrub: true, invalidateOnRefresh: true },
      })
      // the rig low-passes exitIn before the scene uses it; the DOM layers track the scroll exactly
      tl.to(rig, { exitIn: 1, duration: 1 }, 0)
        // the scene holds still in the viewport while the next section slides up over it
        .fromTo(stage.current, { y: 0 }, { y: () => root.current.offsetHeight, duration: 1 }, 0)
        .fromTo(ui.current, { y: 0 }, { y: () => -0.55 * root.current.offsetHeight, duration: 1 }, 0)
        .fromTo(ui.current, { opacity: 1 }, { opacity: 0, duration: 0.12, ease: 'power1.in' }, 0.025)
    },
    { scope: root },
  )

  /* ---------------- power clean: the click / tap / keyboard action ---------------- */
  const powerClean = () => {
    if (rig.exitIn > 0.03) return
    // from the floor only (a bar still bouncing a few cm is fine: the hands take it as it settles)
    const onFloor = (rig.mode === 'rest' || rig.mode === 'fall') && rig.y < 0.08
    if (!onFloor) return
    beginClean(rig)
    root.current?.classList.add('is-clean')
  }
  const cleanRef = useRef(powerClean)
  cleanRef.current = powerClean

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
      sec.classList.remove('is-clean')
      beginDrag(rig)
      sec.classList.add('is-lifting')
    }
    const endDrag = () => {
      release(rig)
      sec.classList.remove('is-lifting')
    }
    const onDown = (e) => {
      if (id !== null || rig.exitIn > 0.03 || rig.mode === 'hold' || rig.mode === 'clean') return
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

    // desktop: the camera leans toward the pointer (the rig low-passes it)
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
  const read = useRef({ acc: 0, v: '', h: '', hot: null, peak: 0, peakAt: 0, clean: false })
  useTicker((time, deltaMs) => {
    stepRig(rig, (Math.max(deltaMs, 0) / 1000) * (rig.timeScale ?? 1))
    const r = read.current
    if (r.clean !== (rig.mode === 'clean')) {
      r.clean = rig.mode === 'clean'
      if (!r.clean) root.current?.classList.remove('is-clean')
    }
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
            <DropScene rig={rig} active={inView} reduced={reduced} lite={lite} onLive={onSceneLive} />
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
