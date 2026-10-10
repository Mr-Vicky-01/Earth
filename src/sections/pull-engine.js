import { gsap, reducedMotion } from '../lib/gsap'
import {
  MAX_V,
  REST,
  TRACK_M,
  YANK_T,
  YANK_U,
  createSim,
  handSpeed,
  keySpeed,
  ratingIndex,
  releaseHandle,
  step,
} from './pull-physics'

const SLANT = Math.tan((12 * Math.PI) / 180)
const SUB = 4
const PAPER = '#efeee9'
const HEAT = '#ff4b1f'
const CHROME = '#c8cbd6'
const MAX_PARTS = 280

const r1 = (n) => Math.round(n * 10) / 10
const r2 = (n) => Math.round(n * 100) / 100
const r4 = (n) => Math.round(n * 10000) / 10000
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

/**
 * Imperative driver for the sled-pull track: geometry, pointer + keyboard input, the physics loop
 * (gsap.ticker, only while something moves and the track is in view), rendering to transforms,
 * the speed-line canvas and throttled readouts. React only wires refs and reacts to hooks.
 *
 * hooks: onFirst(), onStart(), onRating(index), onStop({ peak, dist }), onReset()
 */
export function createPullEngine(el, hooks = {}) {
  const reduced = reducedMotion()
  const sim = createSim()
  const g = { W: 0, H: 0, cy: 0, ppm: 1, x0: 0, span: 1, sledW: 0, sledH: 0, handleW: 0, small: false, dpr: 1 }
  const st = {
    dragging: false,
    pid: null,
    left: 0,
    grabOff: 0,
    p: 0,
    pPrev: 0,
    vp: 0,
    key: false,
    keyT: 0,
    yankT: 0,
    run: false,
    done: false,
    peak: 0,
    peakS: 0,
    maxS: 0,
    fast: false,
    rating: -1,
    first: false,
    hint: 0,
    hintTl: null,
    strain: 0,
    back: 0,
    resetTween: null,
    running: false,
    inView: false,
    ready: false,
    textT: 0,
    fxDirty: false,
    acc: 0,
    dacc: 0,
    wacc: 0,
    taut: null,
    live: null,
    chipOn: null,
    flagOn: null,
    fasterW: 0,
  }
  const shown = {}
  const parts = []
  const ctx = el.canvas.getContext('2d')

  /* ---------------- geometry ---------------- */
  function measure() {
    const W = el.track.clientWidth
    const H = el.track.clientHeight
    if (!W || !H) return
    const small = H < 260
    // the track's slanted ends (CSS --sl, 0 on phones): keep the sled and handle inside them
    const sl = Math.min(H * SLANT, parseFloat(getComputedStyle(el.track).getPropertyValue('--sl')) || 0)
    g.W = W
    g.H = H
    g.cy = H / 2
    g.small = small
    g.sledW = el.sled.offsetWidth
    g.sledH = el.sled.offsetHeight
    g.handleW = el.handle.offsetWidth
    g.x0 = sl / 2 + g.sledW + (small ? 12 : 30)
    // room past the finish for the handle, kept clear of the slanted end of the lane
    const edge = W - sl / 2 - (sl ? (g.handleW * 0.32 + 6) : 4)
    const xEnd = edge - g.handleW - (small ? 8 : 22)
    g.span = xEnd - g.x0
    g.ppm = g.span / TRACK_M
    sim.L = (0.12 * W) / g.ppm
    sim.hMax = (edge - g.handleW - g.x0) / g.ppm
    sim.gap = 5 / g.ppm
    const ts = el.track.style
    ts.setProperty('--x0', `${r1(g.x0)}px`)
    ts.setProperty('--ppm', `${r4(g.ppm)}px`)
    ts.setProperty('--span', `${r1(g.span)}px`)
    ts.setProperty('--sledw', `${g.sledW}px`)
    g.dpr = Math.min(1.75, window.devicePixelRatio || 1)
    el.canvas.width = Math.round(W * g.dpr)
    el.canvas.height = Math.round(H * g.dpr)
    st.fxDirty = true
    el.ropeSvg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    if (!st.run && !st.dragging && !st.key && !st.resetTween) {
      sim.s = 0
      sim.h = sim.L * REST
    } else {
      sim.h = clamp(sim.h, sim.s + sim.gap, sim.hMax)
    }
    render()
    texts(true)
    startHint()
  }

  /* ---------------- loop ---------------- */
  const handActive = () => st.dragging || st.key || st.yankT > 0
  const needsLoop = () => handActive() || sim.sv !== 0 || sim.glide || parts.length > 0 || st.strain > 0.002

  function wake() {
    if (st.running || !st.inView) return
    st.running = true
    gsap.ticker.add(tick)
  }
  function sleep() {
    if (!st.running) return
    st.running = false
    gsap.ticker.remove(tick)
  }

  function tick(_t, dtMs) {
    // physics dt is clamped (≤ 32 ms); pointer speed is measured against real elapsed time
    const dt = clamp(dtMs || 16.7, 1, 32) / 1000
    const dtReal = clamp(dtMs || 16.7, 1, 120) / 1000

    if (st.dragging) {
      const vRaw = (st.p - st.pPrev) / dtReal
      st.pPrev = st.p
      st.vp += (vRaw - st.vp) * (1 - Math.exp(-dtReal / 0.045))
    } else st.vp = 0

    let hand = false
    let target = sim.h
    let u = 0
    let free = true
    if (st.dragging) {
      hand = true
      target = st.p
      u = handSpeed(Math.max(0, st.vp))
    }
    if (st.key) {
      st.keyT += dt
      hand = true
      if (!st.dragging) {
        target = sim.hMax
        free = false
      }
      u = Math.max(u, keySpeed(st.keyT))
    }
    if (st.yankT > 0) {
      hand = true
      if (!st.dragging) target = sim.hMax
      u = Math.max(u, YANK_U)
    }

    const sub = dt / SUB
    for (let i = 0; i < SUB; i++) {
      const hit = step(sim, sub, { hand, target, u, free })
      if (hit) impact(hit)
      if (st.yankT > 0) {
        st.yankT -= sub
        if (st.yankT <= 0) {
          st.yankT = 0
          if (!st.dragging && !st.key) {
            releaseHandle(sim)
            hand = false
          }
        }
      }
    }

    const v = sim.sv
    if (!st.run && v > 0.03) {
      st.run = true
      st.done = false
      hooks.onStart?.()
    }
    if (st.run) {
      if (v > st.peak) {
        st.peak = v
        st.peakS = sim.s
      }
      if (sim.s > st.maxS) st.maxS = sim.s
      const r = ratingIndex(st.peak)
      if (r !== st.rating) {
        st.rating = r
        hooks.onRating?.(r)
      }
      if (!st.fast && st.peak > 4) {
        st.fast = true
        shake(0.7)
      }
    }

    const strainTarget = st.dragging ? clamp(((st.p - sim.h) * g.ppm) / 160, 0, 1) : st.key || st.yankT > 0 ? 0.6 : 0
    st.strain += (strainTarget - st.strain) * (1 - Math.exp(-dt / 0.06))
    if (st.strain < 0.002 && strainTarget === 0) st.strain = 0

    spawn(dt)
    render()
    drawFx(dt)
    texts(false)

    if (st.run && !st.done && !handActive() && sim.sv === 0 && !sim.glide) finish()
    if (!needsLoop() && !st.resetTween) {
      if (st.fxDirty) drawFx(0)
      render()
      texts(true)
      sleep()
    }
  }

  function finish() {
    st.done = true
    texts(true)
    hooks.onStop?.({ peak: Math.round(st.peak * 100) / 100, dist: Math.round(st.maxS * 10) / 10 })
  }

  function impact(v) {
    shake(Math.min(1.2, v / 3))
    if (reduced) return
    const x = g.x0 + TRACK_M * g.ppm
    for (let i = 0; i < 26; i++) {
      const a = Math.PI * (0.5 + Math.random())
      const sp = 80 + Math.random() * 260 * Math.min(1, v / 3)
      parts.push({ k: 1, x, y: g.cy + (Math.random() - 0.5) * g.sledH, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: 2 + Math.random() * 2.5, life: 0.35 + Math.random() * 0.35, age: 0, c: Math.random() < 0.6 ? HEAT : PAPER, a: 0.9 })
    }
  }

  function shake(power) {
    if (reduced) return
    const a = 2.5 + power * 5
    gsap.killTweensOf(el.stage)
    gsap.to(el.stage, {
      keyframes: [
        { x: -a, y: a * 0.45, duration: 0.04 },
        { x: a * 0.85, y: -a * 0.35, duration: 0.05 },
        { x: -a * 0.55, y: a * 0.25, duration: 0.05 },
        { x: a * 0.3, y: -a * 0.1, duration: 0.06 },
        { x: 0, y: 0, duration: 0.08 },
      ],
      ease: 'none',
    })
  }

  /* ---------------- speed lines, dust, wind ---------------- */
  function spawn(dt) {
    const v = Math.max(0, sim.sv)
    if (v < 0.25 || !g.W) return
    const scale = g.small ? 0.62 : 1
    const sx = g.x0 + sim.s * g.ppm
    const back = sx - g.sledW * 0.95
    st.acc += v * (g.small ? 13 : 24) * dt * (reduced ? 0.3 : 1)
    while (st.acc >= 1) {
      st.acc -= 1
      const y = g.cy + (Math.random() - 0.5) * g.sledH * 1.35
      const beside = Math.abs(y - g.cy) > g.sledH * 0.5
      parts.push({
        k: 0,
        x: beside ? back + Math.random() * g.sledW : back + Math.random() * 10,
        y,
        vx: -v * g.ppm * (0.2 + Math.random() * 0.5),
        vy: 0,
        len: (16 + v * 15 + v * v * 3.2) * scale * (0.55 + Math.random() * 0.9),
        w: Math.random() < 0.3 ? 2 : 1,
        life: 0.22 + Math.random() * 0.24,
        age: 0,
        c: Math.random() < 0.2 ? HEAT : PAPER,
        a: 0.35 + Math.random() * 0.55,
      })
    }
    if (reduced) return
    if (v > 1.2) {
      st.dacc += v * 7 * dt
      while (st.dacc >= 1) {
        st.dacc -= 1
        const side = Math.random() < 0.5 ? -1 : 1
        parts.push({
          k: 1,
          x: back + 4,
          y: g.cy + side * g.sledH * 0.44,
          vx: -(20 + Math.random() * 50) * v * scale,
          vy: side * (10 + Math.random() * 40),
          size: 1.5 + Math.random() * 2,
          life: 0.35 + Math.random() * 0.35,
          age: 0,
          c: CHROME,
          a: 0.55,
        })
      }
    }
    if (v > 2.6) {
      st.wacc += (v - 2.4) * 6 * dt
      while (st.wacc >= 1) {
        st.wacc -= 1
        const top = Math.random() < 0.5
        parts.push({
          k: 0,
          x: Math.random() * g.W * 1.1,
          y: top ? 8 + Math.random() * g.H * 0.24 : g.H * (0.74 + Math.random() * 0.2),
          vx: -v * g.ppm * 3.2,
          vy: 0,
          len: (70 + Math.random() * 170) * scale,
          w: 1,
          life: 0.22 + Math.random() * 0.2,
          age: 0,
          c: PAPER,
          a: 0.1 + Math.random() * 0.16,
        })
      }
    }
    if (parts.length > MAX_PARTS) parts.splice(0, parts.length - MAX_PARTS)
  }

  /** streaks shooting right while the sled is yanked back to the start */
  function backBurst() {
    if (reduced || !g.W) return
    const sx = g.x0 + sim.s * g.ppm
    const n = Math.min(26, 8 + sim.s * 1.2)
    for (let i = 0; i < n; i++) {
      parts.push({
        k: 0,
        x: sx + Math.random() * 40,
        y: g.cy + (Math.random() - 0.5) * g.sledH * 1.4,
        vx: 300 + Math.random() * 500,
        vy: 0,
        len: -(40 + Math.random() * 120) * (g.small ? 0.6 : 1),
        w: Math.random() < 0.3 ? 2 : 1,
        life: 0.25 + Math.random() * 0.2,
        age: 0,
        c: Math.random() < 0.25 ? HEAT : PAPER,
        a: 0.6,
      })
    }
  }

  function drawFx(dt) {
    if (!parts.length && !st.fxDirty) return
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0)
    ctx.clearRect(0, 0, g.W, g.H)
    st.fxDirty = parts.length > 0
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]
      p.age += dt
      if (p.age >= p.life) {
        parts[i] = parts[parts.length - 1]
        parts.pop()
        continue
      }
      p.x += p.vx * dt
      p.y += p.vy * dt
      const f = 1 - p.age / p.life
      ctx.globalAlpha = p.a * f
      ctx.fillStyle = p.c
      if (p.k === 0) {
        const len = p.len * (0.45 + 0.55 * f)
        if (len >= 0) ctx.fillRect(p.x - len, p.y, len, p.w)
        else ctx.fillRect(p.x, p.y, -len, p.w)
      } else {
        ctx.fillRect(p.x, p.y, p.size, p.size)
      }
    }
    ctx.globalAlpha = 1
  }

  /* ---------------- render ---------------- */
  function render() {
    if (!g.W) return
    const { ppm, x0, cy, sledW } = g
    const v = Math.max(0, sim.sv)
    const sx = x0 + sim.s * ppm
    const hx = x0 + (sim.h + st.hint) * ppm

    let skew = -12 - Math.min(v, MAX_V) * 1.7
    let sc = 1 + v * 0.034
    if (st.back > 0.002) {
      skew = -12 + st.back * 30
      sc = 1 + st.back * 0.32
    }
    el.sled.style.transform = `translate3d(${r1(sx - sledW)}px,0,0) skewX(${r2(skew)}deg) scaleX(${r4(sc)})`
    el.handle.style.transform = `translate3d(${r1(hx)}px,0,0)`
    el.hint.style.transform = `translate3d(${r1(hx)}px,0,0)`
    el.grip.style.transform =
      st.strain > 0.004 ? `scaleX(${r4(1 + st.strain * 0.24)}) skewX(${r2(-st.strain * 16)}deg)` : ''

    // rope: straight when taut, a sagging quadratic when slack (sag from the parabola arc length)
    const ax = sx - 3
    const bx = hx + 4
    const dpx = Math.max(0, bx - ax)
    const Lpx = sim.L * ppm
    let sag = 0
    if (dpx < Lpx) sag = Math.min(g.H * 0.3, Math.sqrt((3 * Math.max(dpx, Lpx * 0.22) * (Lpx - dpx)) / 8))
    const taut = sim.tension > 0.05
    const wob = taut && v > 0.6 && !reduced ? (Math.random() - 0.5) * Math.min(3, v * 0.45) : 0
    const d = `M${r1(ax)} ${r1(cy)}Q${r1((ax + bx) / 2)} ${r1(cy + 2 * sag + wob)} ${r1(bx)} ${r1(cy)}`
    el.rope.setAttribute('d', d)
    el.braid.setAttribute('d', d)
    el.braid.style.strokeDashoffset = `${r1(-sim.s * ppm)}`
    if (taut !== st.taut) {
      st.taut = taut
      el.ropeSvg.classList.toggle('is-taut', taut)
      el.handle.classList.toggle('is-taut', taut)
    }

    // heat smear trailing the sled: length and strength follow speed
    const sm = Math.min(1, v / 6.5)
    el.smear.style.transform = `translate3d(${r1(sx - sledW * 0.6)}px,0,0) scaleX(${r4(sm)})`
    el.smear.style.opacity = sm > 0.02 && !reduced ? `${r2(0.35 + sm * 0.65)}` : '0'
    el.chip.style.transform = `translate3d(${r1(sx)}px,0,0)`
    el.flag.style.transform = `translate3d(${r1(x0 + st.peakS * ppm)}px,0,0)`
    const reach = Math.max(st.maxS, sim.s)
    el.prog.style.transform = `scaleX(${r4(reach / TRACK_M)})`
    el.trail.style.transform = `scaleX(${r4(sim.s / TRACK_M)})`
    const fill = r2(100 - (v / MAX_V) * 100)
    el.meterFill.style.transform = `translate3d(${-fill}%,0,0)`
    el.meterIn.style.transform = `translate3d(${fill}%,0,0)`
    el.meterPeak.style.transform = `translate3d(${r2((st.peak / MAX_V) * 100)}%,0,0)`

    const live = v > 0.03
    if (live !== st.live) {
      st.live = live
      el.readout.classList.toggle('is-live', live)
      el.track.classList.toggle('is-live', live)
    }
    if (live !== st.chipOn) {
      st.chipOn = live
      el.chip.classList.toggle('is-on', live)
    }
    const flagOn = st.peak > 0.2
    if (flagOn !== st.flagOn) {
      st.flagOn = flagOn
      el.flag.classList.toggle('is-on', flagOn)
    }

    // the word FASTER stretches with the sled (quantised: re-shaping big type is not free)
    if (el.faster && !reduced) {
      const w = v > 0.05 ? 75 + Math.round(Math.min(1, v / 7) * 15) * 3 : 0
      if (w !== st.fasterW) {
        st.fasterW = w
        el.faster.style.fontStretch = w ? `${w}%` : ''
        el.faster.style.transform = w ? `skewX(${r1(-Math.min(1, v / 7) * 10)}deg)` : ''
      }
    }
  }

  function put(key, node, text) {
    if (!node || shown[key] === text) return
    shown[key] = text
    node.textContent = text
  }
  function texts(force) {
    const now = performance.now()
    if (!force && now - st.textT < 50) return
    st.textT = now
    const v = Math.max(0, sim.sv)
    put('speed', el.speed, v.toFixed(2))
    put('peak', el.peak, st.peak.toFixed(2))
    put('dist', el.dist, st.maxS.toFixed(1))
    put('chip', el.chipText, v.toFixed(2))
    put('flag', el.flagText, st.peak.toFixed(2))
  }

  /* ---------------- idle hint ---------------- */
  function startHint() {
    if (reduced || st.first || st.hintTl || !st.ready || !g.W) return
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 2.15, delay: 0.7 })
    tl.to(st, { hint: () => 30 / g.ppm, duration: 0.11, ease: 'power3.out', onUpdate: render })
    tl.to(st, { hint: 0, duration: 0.75, ease: 'expo.out', onUpdate: render })
    st.hintTl = tl
    if (!st.inView) tl.pause()
  }
  function first() {
    if (st.first) return
    st.first = true
    st.hintTl?.kill()
    st.hintTl = null
    st.hint = 0
    hooks.onFirst?.()
  }

  /* ---------------- input ---------------- */
  function beginHand() {
    if (st.resetTween) st.resetTween.progress(1)
    sim.glide = null
    first()
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (st.done) {
      reset()
      return
    }
    beginHand()
    try {
      el.handle.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
    st.pid = e.pointerId
    st.left = el.track.getBoundingClientRect().left
    st.grabOff = e.clientX - st.left - (g.x0 + sim.h * g.ppm)
    st.dragging = true
    st.p = st.pPrev = sim.h
    st.vp = 0
    el.handle.classList.add('is-grab')
    wake()
  }
  function onMove(e) {
    if (!st.dragging || e.pointerId !== st.pid) return
    const px = e.clientX - st.left - st.grabOff
    st.p = clamp((px - g.x0) / g.ppm, sim.s + sim.gap, sim.hMax)
  }
  function onUp(e) {
    if (!st.dragging || (e && e.pointerId !== st.pid)) return
    st.dragging = false
    st.pid = null
    el.handle.classList.remove('is-grab')
    if (!st.key && st.yankT <= 0) releaseHandle(sim)
    wake()
  }
  const isPullKey = (k) => k === 'ArrowRight' || k === ' ' || k === 'Spacebar'
  function onKeyDown(e) {
    if (isPullKey(e.key)) {
      e.preventDefault()
      if (e.repeat || st.key) return
      if (st.done) {
        reset()
        return
      }
      beginHand()
      st.key = true
      st.keyT = 0
      wake()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.repeat) return
      if (st.done) {
        reset()
        return
      }
      beginHand()
      st.yankT = YANK_T
      wake()
    }
  }
  function endKey() {
    if (!st.key) return
    st.key = false
    if (!st.dragging && st.yankT <= 0) releaseHandle(sim)
    wake()
  }
  function onKeyUp(e) {
    if (!isPullKey(e.key)) return
    e.preventDefault()
    endKey()
  }
  const onCtx = (e) => e.preventDefault()
  // touch-action: none does the job in modern browsers; this also stops the page scrolling
  // under a drag where touch-action is ignored (older iOS Safari, synthesized touches)
  const onTouchMove = (e) => {
    if (e.cancelable) e.preventDefault()
  }

  const h = el.handle
  h.addEventListener('pointerdown', onDown)
  h.addEventListener('pointermove', onMove)
  h.addEventListener('pointerup', onUp)
  h.addEventListener('pointercancel', onUp)
  h.addEventListener('lostpointercapture', onUp)
  h.addEventListener('keydown', onKeyDown)
  h.addEventListener('keyup', onKeyUp)
  h.addEventListener('blur', endKey)
  h.addEventListener('contextmenu', onCtx)
  h.addEventListener('touchmove', onTouchMove, { passive: false })

  /* ---------------- public ---------------- */
  function reset() {
    if (st.resetTween) return
    st.dragging = false
    st.key = false
    st.yankT = 0
    st.run = false
    st.done = false
    st.peak = 0
    st.peakS = 0
    st.maxS = 0
    st.fast = false
    st.rating = -1
    sim.sv = 0
    sim.hv = 0
    sim.glide = null
    sim.tension = 0
    hooks.onReset?.()
    texts(true)
    const hRest = sim.L * REST
    if (reduced || !st.inView) {
      sim.s = 0
      sim.h = hRest
      st.back = 0
      render()
      return
    }
    backBurst()
    st.resetTween = gsap.to(sim, {
      s: 0,
      h: hRest,
      duration: 0.75,
      ease: 'expo.out',
      onUpdate() {
        st.back = Math.pow(1 - this.progress(), 2.4)
        render()
      },
      onComplete() {
        st.resetTween = null
        st.back = 0
        render()
      },
    })
    wake()
  }

  function setInView(v) {
    st.inView = v
    if (!v) {
      sleep()
      st.hintTl?.pause()
    } else {
      st.hintTl?.resume()
      if (needsLoop()) wake()
    }
  }

  function setReady() {
    st.ready = true
    startHint()
  }

  function destroy() {
    sleep()
    st.hintTl?.kill()
    st.resetTween?.kill()
    gsap.killTweensOf(el.stage)
    h.removeEventListener('pointerdown', onDown)
    h.removeEventListener('pointermove', onMove)
    h.removeEventListener('pointerup', onUp)
    h.removeEventListener('pointercancel', onUp)
    h.removeEventListener('lostpointercapture', onUp)
    h.removeEventListener('keydown', onKeyDown)
    h.removeEventListener('keyup', onKeyUp)
    h.removeEventListener('blur', endKey)
    h.removeEventListener('contextmenu', onCtx)
    h.removeEventListener('touchmove', onTouchMove)
    if (el.faster) {
      el.faster.style.fontStretch = ''
      el.faster.style.transform = ''
    }
  }

  return { measure, reset, setInView, setReady, destroy }
}
