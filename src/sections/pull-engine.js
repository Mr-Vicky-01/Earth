import { gsap, reducedMotion } from '../lib/gsap'
import {
  FINISH_V,
  FR,
  MAX_V,
  REST,
  TRACK_M,
  YANK_T,
  YANK_V,
  clocked,
  createSim,
  keySpeed,
  ratingIndex,
  step,
  stopDistance,
  worldFor,
} from './pull-physics'

const SLANT = Math.tan((12 * Math.PI) / 180)
const SUB = 4
const PAPER = '#efeee9'
const HEAT = '#ff4b1f'
const CHROME = '#c8cbd6'
const MAX_PARTS = 340

const r1 = (n) => Math.round(n * 10) / 10
const r2 = (n) => Math.round(n * 100) / 100
const r4 = (n) => Math.round(n * 10000) / 10000
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const rnd = (a, b) => a + Math.random() * (b - a)

/**
 * Imperative driver for the sled-pull track: geometry, pointer + keyboard input, the physics loop
 * (gsap.ticker, only while something moves and the track is in view), a camera that scrolls the turf
 * after the sled, rendering to transforms, the speed-line canvas and throttled readouts.
 * React only wires refs and reacts to hooks.
 *
 * Screen x of a world metre m: x0 + (m − cam)·ppm. While a pointer holds the handle the camera glides
 * to a stop, so the handle stays exactly under the pointer; once the hand lets go the camera chases the
 * sled to a hold point and the turf streams past.
 *
 * hooks: onFirst(), onStart(), onRating(index, up), onResult({ peak, dist }), onSettled({ peak, dist }),
 *        onReset()
 */
export function createPullEngine(el, hooks = {}) {
  const reduced = reducedMotion()
  const sim = createSim()
  const g = {
    W: 0,
    H: 0,
    cy: 0,
    ppm: 1,
    x0: 0,
    vis: 20,
    sl: 0,
    sledW: 0,
    sledH: 0,
    handleW: 0,
    small: false,
    dpr: 1,
    xHandMax: 0,
    xFinish: 0,
    holdX: 0,
    camMax: 0,
    mapW: 0,
  }
  const st = {
    dragging: false,
    pid: null,
    left: 0,
    grabOff: 0,
    px: 0,
    hPrev: 0,
    hvS: 0,
    key: false,
    keyT: 0,
    yankT: 0,
    run: false,
    done: false,
    settled: true,
    peak: 0,
    peakS: 0,
    maxS: 0,
    vS: 0,
    fast: false,
    rating: -1,
    cam: 0,
    camV: 0,
    rewindPx: 0,
    rewindTween: null,
    resetTween: null,
    introTween: null,
    introS: 0,
    introV: 0,
    introDone: reduced,
    first: false,
    hint: 0,
    jolt: 0,
    hintTl: null,
    strain: 0,
    back: 0,
    backX: null,
    running: false,
    inView: false,
    ready: false,
    textT: 0,
    fxDirty: false,
    acc: 0,
    dacc: 0,
    wacc: 0,
    taut: null,
    ropeW: 0,
    live: null,
    flagOn: null,
    fasterW: 0,
    speedW: 0,
  }
  const shown = {}
  const parts = []
  const ctx = el.canvas.getContext('2d')

  /* ---------------- geometry ---------------- */
  const X = (m) => g.x0 + (m - st.cam) * g.ppm

  function measure() {
    const W = el.track.clientWidth
    const H = el.track.clientHeight
    if (!W || !H) return
    const small = W < 640
    // the track's slanted ends (CSS --sl, 0 on phones): keep the sled and handle inside them
    const sl = Math.min(H * SLANT, parseFloat(getComputedStyle(el.track).getPropertyValue('--sl')) || 0)
    const sMetres = sim.s
    g.W = W
    g.H = H
    g.cy = H / 2
    g.sl = sl
    g.small = small
    g.sledW = el.sled.offsetWidth
    g.sledH = el.sled.offsetHeight
    g.handleW = el.handle.offsetWidth
    // phones: the sled starts partly off the left edge so the lane gets the width
    g.x0 = small ? g.sledW + 12 : Math.round(sl / 2 + g.sledW + 26)
    g.ppm = small ? clamp(W / 16.2, 22, 34) : clamp(W * 0.044, 34, 60)
    g.vis = W / g.ppm
    sim.L = ((small ? 0.16 : 0.12) * W) / g.ppm
    sim.gap = 5 / g.ppm
    // smaller tracks coast a little further per metre so a phone flick still reaches the line
    sim.fr = FR * clamp(0.75 + ((W - 390) / 935) * 0.25, 0.75, 1)
    g.xHandMax = W - sl / 2 - g.handleW - 8
    // at the far end the camera stops with room for the sled's slack handle past the line
    g.xFinish = g.xHandMax - REST * sim.L * g.ppm - 6
    g.camMax = Math.max(0, TRACK_M - (g.xFinish - g.x0) / g.ppm)
    sim.hMax = TRACK_M + (g.xHandMax - g.xFinish) / g.ppm
    g.holdX = Math.max(g.x0 + W * 0.14, W * (small ? 0.42 : 0.38))
    g.mapW = el.map ? el.map.clientWidth : 0

    const ts = el.track.style
    ts.setProperty('--x0', `${g.x0}px`)
    ts.setProperty('--ppm', `${r4(g.ppm)}px`)
    ts.setProperty('--bay', `${Math.round(g.x0 + (TRACK_M + 4) * g.ppm)}px`)
    ts.setProperty('--sledw', `${g.sledW}px`)
    g.dpr = Math.min(1.75, window.devicePixelRatio || 1)
    el.canvas.width = Math.round(W * g.dpr)
    el.canvas.height = Math.round(H * g.dpr)
    st.fxDirty = true
    el.ropeSvg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    // until it arrives, the sled waits off the left edge (the track itself is hidden until then)
    if (!st.introDone && !st.introTween) st.introS = -(g.x0 + g.sledW + 80) / g.ppm
    if (!st.run && !handActive() && !st.resetTween && !st.rewindTween && sMetres === 0) {
      sim.s = 0
      sim.h = sim.L * REST
      st.cam = 0
    } else {
      sim.h = clamp(sim.h, sim.s + sim.gap, sim.hMax)
      st.cam = Math.min(st.cam, g.camMax)
    }
    render()
    texts(true)
    startHint()
  }

  /* ---------------- loop ---------------- */
  const handActive = () => st.dragging || st.key || st.yankT > 0
  const needsLoop = () =>
    handActive() ||
    sim.w !== 0 ||
    Math.abs(sim.gv) > 0.002 ||
    Math.abs(st.camV) > 0.002 ||
    parts.length > 0 ||
    st.strain > 0.002 ||
    !!st.introTween ||
    !!st.rewindTween ||
    (st.done && !st.settled)

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
    const dt = clamp(dtMs || 16.7, 1, 32) / 1000
    const sub = dt / SUB
    const L = sim.L

    // ---- the hand
    let mode = 0 // 0 free, 1 pointer, 2 keys
    let hA = sim.h
    let hB = sim.h
    let u = 0
    if (st.dragging) {
      mode = 1
      const x = clamp(st.px, X(sim.s) + 5, g.xHandMax)
      hB = st.cam + (x - g.x0) / g.ppm
      hA = st.hPrev
      st.hvS += ((hB - hA) / dt - st.hvS) * (1 - Math.exp(-dt / 0.03))
      st.hPrev = hB
    } else if (st.key || st.yankT > 0) {
      mode = 2
      if (st.key) st.keyT += dt
      u = worldFor(Math.max(st.yankT > 0 ? YANK_V : 0, st.key ? keySpeed(st.keyT) : 0), g.vis)
      st.hvS = u
    }

    for (let i = 0; i < SUB; i++) {
      let input = { held: false }
      if (mode === 1) input = { held: true, h: hA + ((hB - hA) * (i + 1)) / SUB, hv: st.hvS }
      else if (mode === 2) input = { held: true, h: Math.min(sim.s + L * 2.2, sim.h + u * sub, sim.hMax), hv: u }
      const hit = step(sim, sub, input)
      if (hit) impact(hit)
      if (sim.rip) {
        sim.rip = false
        rip()
        mode = 0
      }
      if (st.yankT > 0) {
        st.yankT -= sub
        if (st.yankT <= 0) {
          st.yankT = 0
          if (!st.key && mode === 2) {
            letGo(u)
            mode = 0
          }
        }
      }
    }

    camera(dt, mode)

    const vRaw = clocked(sim.w, g.vis)
    st.vS += (vRaw - st.vS) * (1 - Math.exp(-dt / 0.035))
    if (st.vS < 0.004 && vRaw === 0) st.vS = 0
    const v = st.vS
    if (!st.run && v > 0.05) {
      st.run = true
      st.done = false
      st.settled = false
      hooks.onStart?.()
    }
    if (st.run && !st.done) {
      if (v > st.peak) {
        st.peak = v
        st.peakS = sim.s
      }
      if (sim.s > st.maxS) st.maxS = sim.s
      const r = ratingIndex(st.peak)
      if (r !== st.rating) {
        const up = r > st.rating
        st.rating = r
        hooks.onRating?.(r, up)
        if (up && r >= 1) flashEdges(r / 3)
      }
      if (!st.fast && st.peak > 4) {
        st.fast = true
        shake(0.6)
      }
    } else if (st.done && sim.s > st.maxS) st.maxS = sim.s

    // the grip strains with the rope's stretch
    const Lpx = L * g.ppm
    const gapPx = (sim.h - sim.s) * g.ppm
    const strainTarget = mode ? clamp((gapPx - Lpx) / (Lpx * 0.9), 0, 1) : 0
    st.strain += (strainTarget - st.strain) * (1 - Math.exp(-dt / 0.05))
    if (st.strain < 0.002 && strainTarget === 0) st.strain = 0

    spawn(dt, v)
    render()
    drawFx(dt)
    texts(false)

    if (st.run && !st.done && !handActive() && v < FINISH_V && !st.introTween) result()
    if (st.done && !st.settled && sim.w === 0) {
      st.settled = true
      texts(true)
      hooks.onSettled?.({ peak: r2(st.peak), dist: r1(st.maxS) })
    }
    if (!needsLoop() && !st.resetTween) {
      if (st.fxDirty) drawFx(0)
      render()
      texts(true)
      sleep()
    }
  }

  function camera(dt, mode) {
    const holdX = g.holdX
    if (mode === 1) {
      // a hand on the rope: the camera glides to a stop (a moving camera would drag the hand along)
      st.camV *= Math.exp(-dt / 0.06)
    } else if (st.done && sim.w <= 0.5) {
      // parked: frame the sled at the hold point (past the line if need be) so the next grab has room
      const want = sim.s - (holdX - g.x0) / g.ppm
      const k = 1 - Math.exp(-dt / 0.16)
      st.camV = want > st.cam + 0.01 ? ((want - st.cam) * k) / dt : 0
      st.cam += st.camV * dt
      return
    } else {
      const holdM = (g.holdX - g.x0) / g.ppm
      const target = Math.min(g.camMax, sim.s - holdM)
      let want = 0
      if (target > st.cam && sim.w > 0) want = sim.w * (1 + 2.6 * Math.min(1, (target - st.cam) / Math.max(1, holdM)))
      st.camV += (want - st.camV) * (1 - Math.exp(-dt / 0.07))
    }
    st.cam += st.camV * dt
    if (mode !== 1) {
      // never let the sled (or a keyboard hand) run off the right of the lane
      let minCam = sim.s - (g.xFinish - g.x0) / g.ppm
      if (mode === 2) minCam = Math.max(minCam, sim.h - (g.xHandMax - g.x0) / g.ppm)
      if (st.cam < minCam) {
        st.cam = minCam
        if (st.camV < sim.w) st.camV = Math.max(0, sim.w)
      }
    }
    if (st.cam >= g.camMax) {
      st.cam = g.camMax
      if (st.camV > 0) st.camV = 0
    }
    if (Math.abs(st.camV) < 0.002) st.camV = 0
  }

  function result() {
    st.done = true
    const dist = Math.min(TRACK_M, Math.max(st.maxS, sim.s + stopDistance(sim.w, sim.fr)))
    texts(true)
    hooks.onResult?.({ peak: r2(st.peak), dist: r1(dist) })
  }

  function impact(w) {
    const p = Math.min(1, clocked(w, g.vis) / 6)
    shake(0.5 + p * 0.8)
    flashEdges(1)
    el.track.classList.remove('is-hit')
    void el.track.offsetWidth // restart the finish-line flash
    el.track.classList.add('is-hit')
    if (reduced) return
    const x = X(TRACK_M) + camPx()
    for (let i = 0; i < 34; i++) {
      const a = Math.PI * (0.55 + Math.random() * 0.9)
      const sp = (90 + Math.random() * 380) * (0.4 + p)
      parts.push({
        k: 1,
        x,
        y: g.cy + rnd(-0.5, 0.5) * g.sledH,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: rnd(2, 4.5),
        life: rnd(0.3, 0.7),
        age: 0,
        c: Math.random() < 0.65 ? HEAT : PAPER,
        a: 1,
      })
    }
  }

  function shake(power) {
    if (reduced) return
    const a = 2 + power * 5
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
      onComplete: () => gsap.set(el.stage, { clearProps: 'transform' }),
    })
  }

  function flashEdges(power = 1) {
    if (!el.edges?.length) return
    gsap.killTweensOf(el.edges)
    if (reduced) return
    gsap.fromTo(
      el.edges,
      { opacity: 0.45 + power * 0.55, scaleY: 1 + power },
      { opacity: 0, scaleY: 1, duration: 0.55, ease: 'power2.out' },
    )
  }

  /* ---------------- speed lines, dust, wind (world px, drawn relative to the camera) ---------------- */
  const camPx = () => st.cam * g.ppm - st.rewindPx

  function streak(x, y, o) {
    parts.push({ k: 0, x, y, vx: 0, vy: 0, len: 40, w: 1, life: 0.3, age: 0, c: PAPER, a: 0.6, ...o })
  }

  function spawn(dt, v) {
    if (!g.W) return
    const iv = st.introV
    const sv = Math.max(v, iv)
    if (sv < 0.25) return
    const scale = g.small ? 0.6 : 1
    const sx = X(sim.s + st.introS) + camPx()
    const back = sx - g.sledW * 0.92
    const fast = sv > 3
    st.acc += sv * (g.small ? 16 : 28) * dt * (reduced ? 0.3 : 1)
    while (st.acc >= 1) {
      st.acc -= 1
      const y = g.cy + rnd(-0.5, 0.5) * g.sledH * 1.5
      const beside = Math.abs(y - g.cy) > g.sledH * 0.5
      streak(beside ? back + Math.random() * g.sledW : back + Math.random() * 12, y, {
        vx: -sv * g.ppm * rnd(0.05, 0.35),
        len: (24 + sv * 20 + sv * sv * 4.5) * scale * rnd(0.55, 1.4),
        w: fast ? (Math.random() < 0.4 ? 4 : Math.random() < 0.6 ? 3 : 2) : Math.random() < 0.3 ? 2 : 1,
        life: rnd(0.22, 0.48),
        c: Math.random() < (fast ? 0.32 : 0.18) ? HEAT : PAPER,
        a: rnd(0.45, 0.95),
      })
    }
    if (reduced) return
    if (sv > 1.1) {
      // turf kicked up off the runners
      st.dacc += sv * 9 * dt
      while (st.dacc >= 1) {
        st.dacc -= 1
        parts.push({
          k: 1,
          x: back + rnd(0, g.sledW * 0.4),
          y: g.cy + g.sledH * rnd(0.3, 0.46),
          vx: -rnd(25, 80) * sv * scale,
          vy: -rnd(5, 70) * scale,
          size: rnd(1.5, 3.5),
          life: rnd(0.3, 0.6),
          age: 0,
          c: Math.random() < 0.25 ? HEAT : CHROME,
          a: 0.75,
        })
      }
    }
    // wind in the outer lanes, faster than the turf
    const turf = Math.abs(st.camV) * g.ppm
    if (sv > 2.2 || turf > 300) {
      st.wacc += Math.max(sv - 2, turf / 260) * 9 * dt
      while (st.wacc >= 1) {
        st.wacc -= 1
        const top = Math.random() < 0.5
        streak(camPx() + rnd(0, g.W * 1.15), top ? rnd(0.04, 0.3) * g.H : rnd(0.7, 0.96) * g.H, {
          vx: -(turf * 0.9 + sv * g.ppm * 1.6 + 300),
          len: rnd(90, 280) * scale,
          w: Math.random() < 0.5 ? 2 : 3,
          life: rnd(0.2, 0.42),
          c: Math.random() < 0.15 ? HEAT : PAPER,
          a: rnd(0.3, 0.5),
        })
      }
    }
    if (parts.length > MAX_PARTS) parts.splice(0, parts.length - MAX_PARTS)
  }

  /** a short puff behind the sled (idle tug, arrival) */
  function puff(n, power = 1) {
    if (reduced || !g.W) return
    const back = X(sim.s + st.introS) + camPx() - g.sledW * 0.9
    for (let i = 0; i < n; i++) {
      streak(back - rnd(0, 10), g.cy + rnd(-0.5, 0.5) * g.sledH * 1.2, {
        vx: -rnd(60, 220) * power,
        len: rnd(18, 60) * power * (g.small ? 0.6 : 1),
        w: Math.random() < 0.4 ? 2 : 1,
        life: rnd(0.2, 0.36),
        a: rnd(0.5, 0.9),
      })
    }
    for (let i = 0; i < Math.ceil(n / 2); i++) {
      parts.push({
        k: 1,
        x: back + rnd(0, 12),
        y: g.cy + g.sledH * rnd(0.32, 0.46),
        vx: -rnd(30, 120) * power,
        vy: -rnd(10, 60),
        size: rnd(1.5, 3),
        life: rnd(0.25, 0.45),
        age: 0,
        c: CHROME,
        a: 0.7,
      })
    }
  }

  /** streaks left on the path the sled snaps back over; they trail the sled instead of flying off */
  function backTrail(fromX, toX) {
    if (reduced || !g.W) return
    const d = fromX - toX
    if (d < 4) return
    const n = Math.min(8, Math.ceil(d / 26))
    for (let i = 0; i < n; i++) {
      streak(toX + Math.random() * d, g.cy + rnd(-0.5, 0.5) * g.sledH * 1.3, {
        scr: 1,
        vx: rnd(10, 60),
        len: -rnd(30, 110) * (g.small ? 0.6 : 1),
        w: Math.random() < 0.35 ? 2 : 1,
        life: rnd(0.18, 0.34),
        c: Math.random() < 0.25 ? HEAT : PAPER,
        a: 0.65,
      })
    }
  }

  function drawFx(dt) {
    if (!parts.length && !st.fxDirty) return
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0)
    ctx.clearRect(0, 0, g.W, g.H)
    st.fxDirty = parts.length > 0
    const cx = camPx()
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
      if (p.k === 1) p.vy += 260 * dt
      const x = p.scr ? p.x : p.x - cx
      const f = 1 - p.age / p.life
      ctx.globalAlpha = p.a * f
      ctx.fillStyle = p.c
      if (p.k === 0) {
        const len = p.len * (0.4 + 0.6 * f)
        if (len >= 0) ctx.fillRect(x - len, p.y - p.w / 2, len, p.w)
        else ctx.fillRect(x, p.y - p.w / 2, -len, p.w)
      } else {
        ctx.fillRect(x, p.y, p.size, p.size)
      }
    }
    ctx.globalAlpha = 1
  }

  /* ---------------- render ---------------- */
  function render() {
    if (!g.W) return
    const { ppm, cy, sledW } = g
    const v = Math.max(st.vS, st.introV)
    const sx = X(sim.s + st.introS) + st.jolt
    const hx = Math.min(X(sim.h) + st.hint, g.xHandMax)
    const camShift = -st.cam * ppm + st.rewindPx

    // turf: scrolls with the camera and leans back as it streams past
    const turfV = reduced ? 0 : st.camV * ppm
    const lean = clamp(turfV / 160, 0, 16)
    el.world.style.transform = `translate3d(${r1(camShift)}px,0,0)${lean > 0.05 ? ` skewX(${r2(lean)}deg)` : ''}`

    let skew = -12 - Math.min(v, MAX_V) * 1.7
    let sc = 1 + v * 0.036
    if (st.back > 0.002) {
      skew = -12 + st.back * 30
      sc = 1 + st.back * 0.34
    }
    el.sled.style.transform = `translate3d(${r1(sx - sledW)}px,0,0) skewX(${r2(skew)}deg) scaleX(${r4(sc)})`
    el.handle.style.transform = `translate3d(${r1(hx)}px,0,0)`
    el.hint.style.transform = `translate(${r1(hx)}px,0)`
    el.grip.style.transform =
      st.strain > 0.004 ? `scaleX(${r4(1 + st.strain * 0.26)}) skewX(${r2(-st.strain * 18)}deg)` : ''

    // rope: a sagging quadratic when slack; straight, hot and thinner the more it stretches
    const ax = sx - 2
    const bx = hx + 4
    const dpx = Math.max(0, bx - ax)
    const Lpx = sim.L * ppm
    let sag = 0
    let stretch = 0
    // slack rope sags (arc length of a parabola); at speed it streams out flatter
    if (dpx < Lpx)
      sag = Math.min(g.H * 0.28, Math.sqrt((3 * Math.max(dpx, Lpx * 0.22) * (Lpx - dpx)) / 8)) / (1 + v * 0.35)
    else stretch = dpx / Lpx - 1
    const taut = dpx >= Lpx - 1.5
    const wobAmp = taut && !reduced ? Math.min(7, v * 0.5 + stretch * 7) : 0
    const wob = wobAmp > 0.2 ? (Math.random() - 0.5) * wobAmp : 0
    const d = `M${r1(ax)} ${r1(cy)}Q${r1((ax + bx) / 2)} ${r1(cy + 2 * sag + wob)} ${r1(bx)} ${r1(cy)}`
    el.rope.setAttribute('d', d)
    el.braid.setAttribute('d', d)
    el.braid.style.strokeDashoffset = `${r1(-(sim.s - st.cam) * ppm)}`
    const base = g.small ? 3 : 4
    const rw = Math.round(Math.max(base * 0.5, base - stretch * base * 0.9) * 4) / 4
    if (rw !== st.ropeW) {
      st.ropeW = rw
      el.ropeSvg.style.setProperty('--rw', `${rw}`)
    }
    if (taut !== st.taut) {
      st.taut = taut
      el.ropeSvg.classList.toggle('is-taut', taut)
      el.handle.classList.toggle('is-taut', taut)
    }

    // heat smear trailing the sled: length and strength follow speed
    const sm = Math.min(1, v / 6.5)
    el.smear.style.transform = `translate(${r1(sx - sledW * 0.6)}px,0) scaleX(${r4(sm)})`
    el.smear.style.opacity = sm > 0.02 && !reduced ? `${r2(0.35 + sm * 0.65)}` : '0'
    el.chip.style.transform = `translate(${r1(sx)}px,0)`
    // world-anchored marks (inside the scrolling turf)
    el.flag.style.transform = `translate(${r1(st.peakS * ppm)}px,0)`
    el.trail.style.transform = `scaleX(${r4(Math.max(0, sim.s) / TRACK_M)})`

    // the speed meter
    const fill = r2(100 - (st.vS / MAX_V) * 100)
    el.meterFill.style.transform = `translate(${-fill}%,0)`
    el.meterIn.style.transform = `translate(${fill}%,0)`
    el.meterPeak.style.transform = `translate(${r2((st.peak / MAX_V) * 100)}%,0)`

    // the lane map under the track: reach, sled, camera window
    if (g.mapW) {
      const k = g.mapW / TRACK_M
      el.mapFill.style.transform = `scaleX(${r4(Math.max(st.maxS, sim.s) / TRACK_M)})`
      el.mapSled.style.transform = `translate(${r1(clamp(sim.s, 0, TRACK_M) * k)}px,0)`
      const a = clamp(st.cam - g.x0 / ppm, 0, TRACK_M)
      const b = clamp(st.cam + (g.W - g.x0) / ppm, 0, TRACK_M)
      el.mapWin.style.transform = `translate(${r1(a * k)}px,0) scaleX(${r4((b - a) / TRACK_M)})`
    }

    const live = st.vS > 0.03
    if (live !== st.live) {
      st.live = live
      el.readout.classList.toggle('is-live', live)
      el.track.classList.toggle('is-live', live)
    }
    const flagOn = st.peak > 0.2
    if (flagOn !== st.flagOn) {
      st.flagOn = flagOn
      el.flag.classList.toggle('is-on', flagOn)
      el.meterPeak.classList.toggle('is-on', flagOn)
    }

    // FASTER stretches with the sled (quantised: re-shaping big type is not free)
    if (el.faster && !reduced) {
      const w = st.vS > 0.05 ? 75 + Math.round(Math.min(1, st.vS / 7) * 15) * 3 : 0
      if (w !== st.fasterW) {
        st.fasterW = w
        el.faster.style.fontStretch = w ? `${w}%` : ''
        el.faster.style.transform = w ? `skewX(${r1(-Math.min(1, st.vS / 7) * 10)}deg)` : ''
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
    const v = st.vS
    put('speed', el.speed, v.toFixed(2))
    put('peak', el.peak, st.peak.toFixed(2))
    put('dist', el.dist, st.maxS.toFixed(1))
    put('chip', el.chipText, v.toFixed(2))
    put('flag', el.flagText, st.peak.toFixed(2))
    // the live digits widen with speed
    if (!reduced) {
      const w = 64 + Math.round(Math.min(1, v / 8) * 12) * 3
      if (w !== st.speedW) {
        st.speedW = w
        el.speed.style.setProperty('--w', `${w}`)
      }
    }
  }

  /* ---------------- arrival + idle hint ---------------- */
  function intro() {
    if (reduced || st.first || st.introDone || st.introTween || !g.W) {
      st.introDone = true
      startHint()
      return
    }
    st.introDone = true
    const off = -(g.x0 + g.sledW + 80) / g.ppm
    st.introS = off
    render()
    const proxy = { p: 0 }
    let last = 0
    let lastT = 0
    st.introTween = gsap.to(proxy, {
      p: 1,
      duration: 0.72,
      delay: 0.04,
      ease: 'expo.out',
      onUpdate() {
        const p = proxy.p
        const now = performance.now()
        const dts = lastT ? Math.max(0.008, (now - lastT) / 1000) : 0.016
        const pxs = ((p - last) * -off * g.ppm) / dts
        last = p
        lastT = now
        st.introS = off * (1 - p)
        // the whip reads as speed: skew, smear and streaks follow how fast it is closing
        st.introV = Math.min(8, pxs / (g.W * 0.32))
        st.fxDirty = true
      },
      onComplete() {
        st.introTween = null
        st.introS = 0
        st.introV = 0
        st.jolt = 0
        shake(0.15)
        puff(8, 0.8)
        startHint()
        wake()
      },
    })
    wake()
  }

  function startHint() {
    if (reduced || st.first || st.hintTl || !st.ready || !st.introDone || st.introTween || !g.W) return
    const tug = () => (1 - REST) * sim.L * g.ppm + (g.small ? 12 : 22)
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.55, delay: 0.45 })
    tl.to(st, { hint: tug, duration: 0.12, ease: 'power3.out', onUpdate: render })
    tl.add(() => {
      // the rope snaps taut: the sled jolts and coughs up a little turf
      puff(5, 0.7)
      wake()
    })
    tl.to(st, { jolt: () => (g.small ? 2 : 3), duration: 0.05, ease: 'power2.out', onUpdate: render }, '<')
    tl.to(st, { jolt: 0, duration: 0.35, ease: 'expo.out', onUpdate: render })
    tl.to(st, { hint: 0, duration: 0.6, ease: 'expo.out', onUpdate: render }, '<')
    st.hintTl = tl
    if (!st.inView) tl.pause()
  }
  function first() {
    if (st.first) return
    st.first = true
    st.hintTl?.kill()
    st.hintTl = null
    st.hint = 0
    st.jolt = 0
    if (st.introTween) {
      st.introTween.kill()
      st.introTween = null
      st.introS = 0
      st.introV = 0
    }
    hooks.onFirst?.()
  }

  /* ---------------- input ---------------- */
  function beginHand() {
    if (st.resetTween) st.resetTween.progress(1)
    first()
    st.hvS = 0
    sim.gv = 0
  }

  /** hand lets go: the handle keeps its own momentum relative to the sled and recoils on the rope */
  function letGo(hv) {
    sim.gv = clamp(hv - sim.w, -10, 30)
    wake()
  }

  /** a fast sled tore the handle out of a stopped hand: end the drag, the sled flies on */
  function rip() {
    if (st.dragging) {
      try {
        el.handle.releasePointerCapture(st.pid)
      } catch {
        /* already released */
      }
      st.dragging = false
      st.pid = null
      el.handle.classList.remove('is-grab')
    }
    st.key = false
    st.yankT = 0
    sim.gv = 0
    el.handle.classList.remove('is-rip')
    void el.handle.offsetWidth
    el.handle.classList.add('is-rip')
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (st.dragging) return
    if (st.done) rewind()
    beginHand()
    try {
      el.handle.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
    st.pid = e.pointerId
    st.left = el.track.getBoundingClientRect().left
    const hx = X(sim.h)
    st.grabOff = e.clientX - st.left - hx
    st.px = hx
    st.hPrev = sim.h
    st.dragging = true
    el.handle.classList.add('is-grab')
    wake()
  }
  function onMove(e) {
    if (!st.dragging || e.pointerId !== st.pid) return
    st.px = e.clientX - st.left - st.grabOff
  }
  function onUp(e) {
    if (!st.dragging || (e && e.pointerId !== st.pid)) return
    st.dragging = false
    st.pid = null
    el.handle.classList.remove('is-grab')
    if (!st.key && st.yankT <= 0) letGo(st.hvS)
    wake()
  }
  const isPullKey = (k) => k === 'ArrowRight' || k === ' ' || k === 'Spacebar'
  function onKeyDown(e) {
    if (isPullKey(e.key)) {
      e.preventDefault()
      if (e.repeat || st.key) return
      if (st.done) rewind()
      beginHand()
      st.key = true
      st.keyT = 0
      wake()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.repeat) return
      if (st.done) rewind()
      beginHand()
      st.yankT = YANK_T
      wake()
    }
  }
  function endKey() {
    if (!st.key) return
    st.key = false
    if (!st.dragging && st.yankT <= 0) letGo(st.hvS)
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

  /* ---------------- resets ---------------- */
  function clearRun() {
    st.run = false
    st.done = false
    st.settled = true
    st.peak = 0
    st.peakS = 0
    st.maxS = 0
    st.vS = 0
    st.fast = false
    st.rating = -1
    sim.w = 0
    sim.gv = 0
    sim.tension = 0
    hooks.onReset?.()
    texts(true)
  }

  /**
   * Grabbing (or a pull key) after a run: the lane rewinds under the sled in place. Sled, rope and
   * handle stay exactly where they are on screen (so the grab is 1:1), the turf streams back.
   */
  function rewind() {
    st.rewindTween?.kill()
    st.rewindTween = null
    st.resetTween?.kill()
    st.resetTween = null
    st.back = 0
    const dm = sim.s
    sim.s = 0
    sim.h -= dm
    st.cam -= dm
    st.camV = 0
    // the turf (and anything drawn on it) keeps its screen place: only the metres are renumbered
    const dpx = dm * g.ppm
    clearRun()
    if (reduced || dpx < 1) {
      st.rewindPx = 0
      render()
      return
    }
    // the turf runs back past the sled; streaks flow with it
    st.rewindPx = -dpx
    for (let i = 0; i < Math.min(18, 6 + dm); i++) {
      streak(camPx() + rnd(0, g.W), g.cy + rnd(-0.5, 0.5) * g.H * 0.8, {
        vx: rnd(500, 1200),
        len: -rnd(60, 180) * (g.small ? 0.6 : 1),
        w: Math.random() < 0.3 ? 2 : 1,
        life: rnd(0.18, 0.3),
        a: 0.45,
      })
    }
    st.rewindTween = gsap.to(st, {
      rewindPx: 0,
      duration: 0.32,
      ease: 'expo.out',
      onUpdate: render,
      onComplete() {
        st.rewindTween = null
      },
    })
    render()
    wake()
  }

  /** "Pull again": sled, handle and camera snap back to the start */
  function reset() {
    if (st.resetTween) return
    st.rewindTween?.kill()
    st.rewindTween = null
    st.rewindPx = 0
    st.dragging = false
    st.key = false
    st.yankT = 0
    clearRun()
    const hRest = sim.L * REST
    if (reduced || !st.inView) {
      sim.s = 0
      sim.h = hRest
      st.cam = 0
      st.camV = 0
      st.back = 0
      render()
      return
    }
    st.backX = X(sim.s)
    st.resetTween = gsap.to(
      { s: sim.s, h: sim.h, cam: st.cam },
      {
        s: 0,
        h: hRest,
        cam: 0,
        duration: 0.6,
        ease: 'expo.out',
        onUpdate() {
          const t = this.targets()[0]
          sim.s = t.s
          sim.h = t.h
          st.cam = t.cam
          st.back = Math.pow(1 - this.progress(), 2.2)
          const nx = X(sim.s)
          backTrail(st.backX, nx)
          st.backX = nx
          render()
        },
        onComplete() {
          st.resetTween = null
          st.back = 0
          render()
        },
      },
    )
    wake()
  }

  /* ---------------- public ---------------- */
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

  const isIdle = () => !st.run && !handActive() && !st.first

  /** the arrival already played (engine re-created): go straight to the idle hint */
  function skipIntro() {
    st.introDone = true
    st.introS = 0
    render()
    startHint()
  }

  function destroy() {
    sleep()
    st.hintTl?.kill()
    st.resetTween?.kill()
    st.rewindTween?.kill()
    st.introTween?.kill()
    gsap.killTweensOf(el.stage)
    if (el.edges) gsap.killTweensOf(el.edges)
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

  return { measure, reset, intro, skipIntro, setInView, setReady, isIdle, destroy }
}
