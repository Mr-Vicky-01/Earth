import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, reducedMotion } from '../lib/gsap'
import { scrollToTarget } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'
import { SlamText } from '../ui/SlamText'
import { SpeedButton } from '../ui/SpeedButton'
import { SceneBoundary } from '../three/SceneBoundary'
import { heatToCelsius, swatchCss } from '../three/forged/heat'
import './hero-forged.css'

const ForgedScene = lazy(() => import('../three/forged/ForgedScene.jsx').then((m) => ({ default: m.ForgedScene })))

const SCENE_WAIT = 1200 // ms after `ready` that the page waits for the canvas before entering without it
const COPY_DELAY = 1250 // ms after the first slam: the word is passing through orange
const PULL_FROM = { x: -110, skewX: -26, scaleX: 1.45, opacity: 0, transformOrigin: '0% 50%' }
const PULL_TO = { x: 0, skewX: 0, scaleX: 1, opacity: 1, duration: 0.8, ease: 'expo.out', stagger: 0.032 }
const fmt = new Intl.NumberFormat('en-US')

/** No WebGL: the word set in big satin type over a forge glow, with its reflection. */
function ForgedFallback() {
  return (
    <div className="hf-fb" aria-hidden="true">
      <div className="hf-fb-glow" />
      <div className="hf-fb-word d">Forge</div>
      <div className="hf-fb-word hf-fb-mirror d">Forge</div>
      <div className="hf-fb-floor" />
    </div>
  )
}

export function HeroForged({ ready }) {
  const root = useRef(null)
  const stage = useRef(null)
  const ui = useRef(null)
  const top = useRef(null)
  const cut = useRef(null)
  const zone = useRef(null)
  const readRef = useRef(null)
  const tempRef = useRef(null)
  const countRef = useRef(null)
  const swatchRef = useRef(null)
  const inView = useInView(root, '10% 0px')
  const [reduced] = useState(reducedMotion)
  const [lite] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700),
  )

  /*
   * Shared state, read and written by the WebGL scene every frame.
   * go: entrance may start · exit 0→1 scroll-out · band: free strip for the word (px, section space)
   * ptr: torch pointer in canvas NDC · look: hover position for parallax · read: probe heat + strikes (scene → HTML)
   * api: { pick, strikeAt, strikeRandom } set by the scene · zone/onZone: the word's screen box (cursor label)
   * onCopy: called by the scene as the cooling word passes through orange (the copy's cue)
   */
  const motion = useRef(null)
  if (!motion.current) {
    motion.current = {
      go: false,
      exit: 0,
      band: null,
      zone: null,
      onZone: null,
      api: null,
      ptr: { x: 0, y: 0, active: false },
      look: { x: 0, y: 0 },
      read: { heat: 0, strikes: 0 },
      onCopy: null,
    }
  }

  // dev-only handle for the screenshot/probe scripts
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__hf = { motion: motion.current, gsap }
    return () => {
      delete window.__hf
    }
  }, [])

  /* ---------------- entrance gate: the slam only plays once the canvas has really drawn ---------------- */
  const [sceneLive, setSceneLive] = useState(false)
  const onSceneLive = useCallback(() => setSceneLive(true), [])
  // the first frame compiles every shader and can block the main thread: once it is drawn, keep waiting a bit
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
  useEffect(() => {
    motion.current.go = go
  }, [go])

  // the copy lands as the word passes through orange (at once if the canvas never came)
  const [copyIn, setCopyIn] = useState(false)
  useEffect(() => {
    if (!go) return
    if (reduced) {
      setCopyIn(true)
      return
    }
    // the scene calls onCopy as the word passes through orange; the timer is only a fallback
    const m = motion.current
    m.onCopy = () => setCopyIn(true)
    const dbgStep = import.meta.env.DEV && m.dbgStep
    const id = dbgStep ? 0 : setTimeout(() => setCopyIn(true), sceneLive ? COPY_DELAY + 1500 : 120)
    return () => {
      clearTimeout(id)
      m.onCopy = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go, reduced])

  // the readout and tag arrive with the first slam, so the temperature can be read falling from white heat
  useGSAP(
    () => {
      if (reduced) return
      const items = gsap.utils.toArray('[data-pull-top]', root.current)
      if (!go) {
        gsap.set(items, PULL_FROM)
        return
      }
      gsap.fromTo(items, PULL_FROM, { ...PULL_TO, delay: 0.12 })
    },
    { scope: root, dependencies: [go] },
  )
  useGSAP(
    () => {
      if (reduced) return
      const items = gsap.utils.toArray('[data-pull]', root.current)
      if (!copyIn) {
        gsap.set(items, PULL_FROM)
        return
      }
      gsap.fromTo(items, PULL_FROM, { ...PULL_TO, delay: 0.08 })
    },
    { scope: root, dependencies: [copyIn] },
  )

  /* ---------------- scroll exit: letters fly apart, camera dives through the O ---------------- */
  useGSAP(
    () => {
      if (reduced) return
      const m = motion.current
      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom top', scrub: true, invalidateOnRefresh: true },
      })
      tl.to(m, { exit: 1, duration: 1 }, 0)
        // the canvas holds still in the viewport while the page moves: the next section rises over the dive
        .fromTo(stage.current, { y: 0 }, { y: () => root.current.offsetHeight, duration: 1 }, 0)
        // copy slides up faster than the page and is gone by 0.1, before any letter flies (from 0.06 on desktop,
        // 0.1 on phones), so text never crosses hot steel
        .fromTo(ui.current, { y: 0 }, { y: () => -0.42 * window.innerHeight, duration: 1 }, 0)
        .fromTo(ui.current, { opacity: 1 }, { opacity: 0, duration: 0.1, ease: 'power1.in' }, 0)
        // the tag and readout leave before they could slide under the fixed nav
        .fromTo(top.current, { opacity: 1 }, { opacity: 0, duration: 0.035, ease: 'power1.in' }, 0)
        // past the forge mouth: a clean cut to black before the next section's wedge takes the frame
        .fromTo(cut.current, { opacity: 0 }, { opacity: 1, duration: 0.07, ease: 'power2.in' }, 0.63)
    },
    { scope: root },
  )

  /* ---------------- free band for the word: between the top row and the copy (never per frame) ---------------- */
  useEffect(() => {
    const sec = root.current
    const top = sec?.querySelector('.hf-top')
    const foot = sec?.querySelector('.hf-foot')
    if (!sec || !top || !foot) return
    const m = motion.current
    // layout offsets, not rects: the entrance and the scroll exit transform these elements
    const offsetIn = (el) => {
      let v = 0
      for (let n = el; n && n !== sec; n = n.offsetParent) v += n.offsetTop
      return v
    }
    const measure = () => {
      const t = Math.max(offsetIn(top) + top.offsetHeight + 10, 92)
      const b = offsetIn(foot) - 8
      m.band = { top: t, bottom: Math.max(b, t + 90) }
      sec.style.setProperty('--hf-band-top', `${m.band.top}px`)
      sec.style.setProperty('--hf-band-h', `${m.band.bottom - m.band.top}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ;[sec, top, foot].forEach((el) => ro.observe(el))
    return () => ro.disconnect()
  }, [])

  /* ---------------- cursor label zone over the word (set by the scene on resize) ---------------- */
  useEffect(() => {
    const m = motion.current
    m.onZone = () => {
      const z = m.zone
      const el = zone.current
      if (!z || !el) return
      el.style.transform = `translate(${z.left.toFixed(1)}px, ${z.top.toFixed(1)}px)`
      el.style.width = `${z.width.toFixed(1)}px`
      el.style.height = `${z.height.toFixed(1)}px`
    }
    m.onZone()
    return () => {
      m.onZone = null
    }
  }, [])

  /* ---------------- torch (move / horizontal drag) and hammer (click / tap) ---------------- */
  useEffect(() => {
    const el = root.current
    const m = motion.current
    if (!el) return
    const rectOf = () => stage.current.getBoundingClientRect()
    const toNdc = (e, r) => {
      m.ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1
      m.ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1
    }
    const interactive = (e) => e.target instanceof Element && e.target.closest('a, button, input, select, textarea')
    let touchId = null
    let sx = 0
    let sy = 0
    let t0 = 0
    let onWord = false
    let engaged = false

    const endTouch = () => {
      touchId = null
      engaged = false
      m.ptr.active = false
      el.classList.remove('is-heating')
    }
    const onMove = (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        toNdc(e, rectOf())
        m.ptr.active = true
        m.look.x = m.ptr.x
        m.look.y = m.ptr.y
        return
      }
      if (e.pointerId !== touchId) return
      if (!engaged) {
        // touch: only a clearly horizontal drag that starts on the word heats; anything else is the page's scroll
        const dx = e.clientX - sx
        const dy = e.clientY - sy
        if (onWord && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          engaged = true
          el.classList.add('is-heating')
        } else if (Math.abs(dy) > 10 || Math.hypot(dx, dy) > 16) {
          endTouch()
          return
        } else return
      }
      toNdc(e, rectOf())
      m.ptr.active = true
    }
    const onLeave = (e) => {
      if (e.pointerType !== 'mouse') return
      m.ptr.active = false
      m.look.x = 0
      m.look.y = 0
    }
    const onDown = (e) => {
      if (interactive(e)) return
      if (e.pointerType === 'mouse') {
        if (e.button !== 0) return
        toNdc(e, rectOf())
        // no text selection while hammering
        if (m.api?.strikeAt(m.ptr.x, m.ptr.y)) e.preventDefault()
        return
      }
      if (touchId !== null) return
      touchId = e.pointerId
      sx = e.clientX
      sy = e.clientY
      t0 = performance.now()
      engaged = false
      toNdc(e, rectOf())
      onWord = !!m.api?.pick(m.ptr.x, m.ptr.y)
    }
    const onUp = (e) => {
      if (e.pointerId !== touchId) return
      if (!engaged && Math.hypot(e.clientX - sx, e.clientY - sy) < 14 && performance.now() - t0 < 550) {
        toNdc(e, rectOf())
        // a short buzz on phones that have it: the tap lands like a hammer
        if (m.api?.strikeAt(m.ptr.x, m.ptr.y)) navigator.vibrate?.(12)
      }
      endTouch()
    }
    const onCancel = (e) => {
      if (e.pointerId === touchId) endTouch()
    }
    const onBlur = () => {
      endTouch()
      m.look.x = 0
      m.look.y = 0
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onBlur)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onBlur)
      endTouch()
    }
  }, [])

  /* ---------------- readout: °C at the torch / last strike / hottest letter (≈15 Hz text) ---------------- */
  const hud = useRef({ acc: 0, c: -1, n: -1, sw: '', hot: null })
  useTicker((_time, deltaMs) => {
    const h = hud.current
    h.acc += deltaMs
    if (h.acc < 66) return
    h.acc = 0
    const m = motion.current
    const heat = m.read.heat
    const raw = heatToCelsius(heat)
    const c = raw >= 100 ? Math.round(raw / 10) * 10 : Math.round(raw)
    if (c !== h.c && tempRef.current) {
      h.c = c
      tempRef.current.textContent = fmt.format(c)
      const sw = swatchCss(heat)
      if (sw !== h.sw && swatchRef.current) {
        h.sw = sw
        swatchRef.current.style.backgroundColor = sw
      }
      const hot = c >= 500
      if (hot !== h.hot && readRef.current) {
        h.hot = hot
        readRef.current.classList.toggle('is-hot', hot)
      }
    }
    const n = m.read.strikes
    if (n !== h.n && countRef.current) {
      h.n = n
      countRef.current.textContent = String(n)
    }
  }, inView)

  const jump = (target) => (e) => {
    e.preventDefault()
    scrollToTarget(target)
  }
  const strikeKey = () => motion.current.api?.strikeRandom()

  return (
    <section id="top" ref={root} className="sec s-ink hf" aria-labelledby="hf-title">
      <div ref={stage} className="hf-stage" aria-hidden="true">
        <SceneBoundary fallback={<ForgedFallback />}>
          <Suspense fallback={null}>
            <ForgedScene
              motion={motion.current}
              active={inView}
              reduced={reduced}
              lite={lite}
              onFrame={onSceneFrame}
              onLive={onSceneLive}
            />
          </Suspense>
        </SceneBoundary>
        <div ref={zone} className="hf-zone" data-cursor="Strike" />
        <div ref={cut} className="hf-cut" />
      </div>

      <div ref={ui} className="hf-ui wrap">
        <div ref={top} className="hf-top">
          <p className="tag hf-tag" data-pull-top>
            <span className="live-dot" aria-hidden="true" />
            <span>
              <span className="hf-tag-long">Velocity lab · </span>Open 24/7
            </span>
          </p>
          <p ref={readRef} className="hf-read mono tnum" data-pull-top aria-hidden="true">
            <i ref={swatchRef} className="hf-swatch" />
            <span className="hf-read-t">
              <b ref={tempRef}>21</b>
              <span className="hf-unit">°C</span>
            </span>
            <span className="hf-sep">·</span>
            <span className="hf-read-n">
              Strikes <b ref={countRef}>0</b>
            </span>
          </p>
        </div>

        <div className="hf-foot">
          <SlamText
            as="h1"
            id="hf-title"
            className="d hf-title"
            play={copyIn}
            stretch
            width={74}
            gain={30}
            lines={['Strength,', 'forged at speed.']}
          />
          <div className="hf-copy">
            <p className="lead hf-lead" data-pull>
              Every bar on our floor reads your rep speed in real time. When the speed drops, the set ends. Train faster,
              recover sooner, get stronger without the grind.
            </p>
            <div className="hf-ctas">
              <div data-pull>
                <SpeedButton href="#pricing" variant="heat" onClick={jump('#pricing')}>
                  Book a free session
                </SpeedButton>
              </div>
              <div data-pull>
                <SpeedButton href="#method" variant="line" onClick={jump('#method')}>
                  See how it works
                </SpeedButton>
              </div>
            </div>
          </div>
          <div className="hf-hint mono" data-pull>
            <span className="hf-hint-fine">Move to heat · Click to strike</span>
            <span className="hf-hint-coarse">Tap a letter to strike</span>
            <button type="button" className="hf-strike" onClick={strikeKey} aria-label="Strike a letter with the hammer">
              <span className="speed-glyph" aria-hidden="true" />
              Strike
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

export default HeroForged
