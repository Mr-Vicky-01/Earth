/**
 * Programs section — the four live instrument graphics (canvas 2D + DOM readouts).
 * Each graphic is a small simulation `{ step(dt), draw(ctx, w, h), prime() }` driven by useViz:
 * DPR-aware canvas, ResizeObserver, runs only while visible, one static frame under reduced motion.
 * Readouts are written straight to the DOM (never React state), and only when the text changes.
 */
import { useEffect, useMemo, useRef } from 'react'
import { gsap, reducedMotion } from '../lib/gsap'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'

const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
const PAPER = '#efeee9'
const INK = '#0a0a10'
const HEAT = '#ff4b1f'
const COBALT = '#2236ff'
const TAU = Math.PI * 2

/** write text only when it changed (no DOM read) */
const put = (el, v) => {
  if (el && el.__v !== v) {
    el.__v = v
    el.textContent = v
  }
}
const rand = (a, b) => a + Math.random() * (b - a)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const easeSine = (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(u))
const easeOutExpo = (u) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * u))
const easeOutCubic = (u) => 1 - Math.pow(1 - clamp01(u), 3)
const fmtInt = (n) => Math.round(n).toLocaleString('en-US')

/** quick "snap" on a readout that just changed: yanked in from the right, stretched, then at rest */
function snap(el, still) {
  if (!el || still) return
  gsap.fromTo(
    el,
    { xPercent: 14, skewX: 16, scaleX: 1.22, transformOrigin: '0% 70%' },
    { xPercent: 0, skewX: 0, scaleX: 1, duration: 0.5, ease: 'expo.out', overwrite: true },
  )
}

/** canvas plumbing shared by all four graphics */
function useViz(hostRef, canvasRef, sim) {
  const inView = useInView(hostRef, '10% 10%')
  const still = reducedMotion()
  const st = useRef({ ctx: null, w: 0, h: 0 })

  useEffect(() => {
    const c = canvasRef.current
    const cell = c?.parentElement
    if (!c || !cell) return
    const s = st.current
    s.ctx = c.getContext('2d')
    if (still) sim.prime()
    else if (!sim.warmed) {
      sim.warmed = true
      sim.warm(sim.warmup || 0)
    }
    const fit = () => {
      const w = cell.clientWidth
      const h = cell.clientHeight
      if (!w || !h) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      s.w = w
      s.h = h
      c.width = Math.round(w * dpr)
      c.height = Math.round(h * dpr)
      c.style.width = `${w}px`
      c.style.height = `${h}px`
      s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      sim.draw(s.ctx, w, h)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(cell)
    fit()
    let alive = true
    document.fonts?.ready.then(() => alive && s.w && sim.draw(s.ctx, s.w, s.h))
    const host = hostRef.current
    return () => {
      alive = false
      ro.disconnect()
      if (host) gsap.killTweensOf(host.querySelectorAll('*'))
    }
  }, [canvasRef, hostRef, sim, still])

  useTicker(
    (_t, dtMs) => {
      const s = st.current
      if (!s.w) return
      sim.step(Math.min(dtMs || 16.7, 50) / 1000)
      sim.draw(s.ctx, s.w, s.h)
    },
    inView && !still,
  )
}

/* =====================================================================================
   1 · VELOCITY LAB — bar path trace + mean concentric velocity per rep, 20% cut-off
   ===================================================================================== */
const REPS = [0.92, 0.89, 0.85, 0.8, 0.76, 0.72]
const ROM = 0.55 // metres of bar travel
const CUT = 0.2 // velocity-loss threshold
const TRAIL = 2.3 // seconds of trail
const BAR_MIN = 0.5 // bar chart axis floor (m/s)

function makeVelocity(r) {
  let still = reducedMotion()
  const s = { t: 0, tau: 0, phase: 'down', rep: 0, p: 1, xo: 0, v: 0, jit: 0, pts: [], liveT: 0, best: REPS[0] }
  const D = { down: 0.58, hold: 0.06, top: 0.26, cut: 2.4 }
  // J-curve: forward at the bottom, hooks back early in the drive, then straight up
  const xoUp = (p) => Math.pow(1 - p, 3) * (1 + s.jit)
  const xoDown = (p) => Math.pow(1 - p, 1.45) * 0.86

  const repStart = (i) => put(r.rep.current, `Rep ${i + 1}`)
  const repDone = (i) => {
    const v = REPS[i]
    const loss = 1 - v / s.best
    put(r.big.current, v.toFixed(2))
    snap(r.big.current, still)
    put(r.loss.current, loss > 0.005 ? `−${Math.round(loss * 100)}%` : '0%')
    const fill = r.lossFill.current
    if (fill) {
      const sx = Math.min(1, loss / 0.3)
      if (still) gsap.set(fill, { scaleX: sx })
      else gsap.to(fill, { scaleX: sx, duration: 0.5, ease: 'expo.out', overwrite: true })
    }
    r.lossBox.current?.classList.toggle('is-hot', loss > CUT)
    const bar = r.bars.current?.querySelectorAll('.prg-bar')[i]
    if (bar) {
      const h = clamp01((v - BAR_MIN) / (1 - BAR_MIN))
      const col = bar.firstChild
      bar.classList.toggle('is-hot', loss > CUT)
      put(bar.lastChild, v.toFixed(2))
      if (still) gsap.set(col, { scaleY: h })
      else gsap.fromTo(col, { scaleY: 0 }, { scaleY: h, duration: 0.55, ease: 'expo.out', overwrite: true })
    }
    return loss
  }
  const cutOn = (loss) => {
    put(r.alertLoss.current, `−${Math.round(loss * 100)}% speed`)
    r.alert.current?.classList.add('is-on')
  }
  const reset = () => {
    r.alert.current?.classList.remove('is-on')
    r.lossBox.current?.classList.remove('is-hot')
    put(r.loss.current, '0%')
    put(r.big.current, '0.00')
    const fill = r.lossFill.current
    const bars = r.bars.current ? Array.from(r.bars.current.querySelectorAll('.prg-bar')) : []
    bars.forEach((b) => {
      b.classList.remove('is-hot')
      put(b.lastChild, '')
    })
    if (still) {
      if (fill) gsap.set(fill, { scaleX: 0 })
      gsap.set(
        bars.map((b) => b.firstChild),
        { scaleY: 0 },
      )
      return
    }
    if (fill) gsap.to(fill, { scaleX: 0, duration: 0.35, ease: 'expo.out', overwrite: true })
    gsap.to(
      bars.map((b) => b.firstChild),
      { scaleY: 0, duration: 0.35, ease: 'expo.out', stagger: { each: 0.025, from: 'end' }, overwrite: true },
    )
  }

  const go = (phase) => {
    s.phase = phase
    s.tau = 0
  }

  return {
    /** run the simulation silently so it is mid-story when it first appears */
    warm(sec) {
      const was = still
      still = true
      for (let i = 0; i < sec * 60; i++) this.step(1 / 60)
      still = was
    },
    warmup: 4.4,
    step(dt) {
      s.t += dt
      s.tau += dt
      s.v = 0
      if (s.phase === 'down') {
        const u = s.tau / D.down
        s.p = 1 - easeSine(u)
        s.xo = xoDown(s.p)
        if (u >= 1) go('hold')
      } else if (s.phase === 'hold') {
        s.p = 0
        s.xo = xoDown(0)
        if (s.tau >= D.hold) go('up')
      } else if (s.phase === 'up') {
        const dur = ROM / REPS[s.rep]
        const u = s.tau / dur
        s.p = easeSine(u)
        s.xo = xoUp(s.p)
        s.v = ((ROM * Math.PI) / (2 * dur)) * Math.sin(Math.PI * clamp01(u))
        if (u >= 1) {
          s.p = 1
          const loss = repDone(s.rep)
          if (loss > CUT) {
            cutOn(loss)
            go('cut')
          } else go('top')
        }
      } else if (s.phase === 'top') {
        s.p = 1
        s.xo = 0
        if (s.tau >= D.top) {
          s.rep += 1
          s.jit = rand(-0.12, 0.12)
          repStart(s.rep)
          go('down')
        }
      } else if (s.phase === 'cut') {
        s.p = 1
        s.xo = 0
        if (s.tau >= D.cut) {
          reset()
          s.rep = 0
          s.jit = rand(-0.12, 0.12)
          repStart(0)
          go('down')
        }
      }
      s.pts.push({ p: s.p, xo: s.xo, t: s.t, up: s.phase === 'up' })
      while (s.pts.length && s.t - s.pts[0].t > TRAIL) s.pts.shift()
      if (s.t - s.liveT > 0.05) {
        s.liveT = s.t
        put(r.live.current, s.v.toFixed(2))
      }
    },
    prime() {
      repStart(0)
      for (let i = 0; i < 2000 && s.phase !== 'cut'; i++) this.step(1 / 60)
      for (let i = 0; i < 20; i++) this.step(1 / 60)
    },
    draw(ctx, w, h) {
      ctx.clearRect(0, 0, w, h)
      const padL = 38
      const top = 30
      const bot = h - 30
      const span = bot - top
      const A = Math.min(56, (w - padL) * 0.3)
      const cx = padL + (w - padL) * 0.5
      const X = (xo) => cx - A * 0.5 + xo * A
      const Y = (p) => bot - p * span

      // depth scale, every 0.1 m
      ctx.font = `500 9.5px ${MONO}`
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (let m = 0; m <= 0.5001; m += 0.1) {
        const y = bot - (m / ROM) * span
        ctx.fillStyle = 'rgba(239,238,233,0.55)'
        ctx.fillText(m.toFixed(1), padL - 10, y)
        ctx.fillStyle = 'rgba(239,238,233,0.14)'
        ctx.fillRect(padL - 4, y, w - padL + 4, 1)
      }
      ctx.textAlign = 'left'
      ctx.fillStyle = 'rgba(239,238,233,0.55)'
      ctx.fillText('m', padL - 22, top - 16)
      // lockout + depth markers
      ctx.fillStyle = 'rgba(239,238,233,0.75)'
      ctx.fillRect(cx - A, top, A * 2.1, 1.5)
      ctx.fillRect(cx - A, bot, A * 2.1, 1.5)
      ctx.fillStyle = 'rgba(239,238,233,0.6)'
      ctx.textAlign = 'right'
      ctx.fillText('LOCKOUT', w - 6, top - 10)
      ctx.fillText('DEPTH', w - 6, bot + 12)

      // ideal path, dashed
      ctx.setLineDash([3, 5])
      ctx.strokeStyle = 'rgba(239,238,233,0.3)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i <= 30; i++) {
        const p = i / 30
        const x = X(Math.pow(1 - p, 3))
        if (i) ctx.lineTo(x, Y(p))
        else ctx.moveTo(x, Y(p))
      }
      ctx.stroke()
      ctx.setLineDash([])

      // fading trail
      const pts = s.pts
      ctx.lineCap = 'round'
      for (let i = 1; i < pts.length; i++) {
        const a = 1 - (s.t - pts[i].t) / TRAIL
        if (a <= 0) continue
        ctx.globalAlpha = a * a
        ctx.strokeStyle = PAPER
        ctx.lineWidth = pts[i].up ? 3.2 : 1.6
        ctx.beginPath()
        ctx.moveTo(X(pts[i - 1].xo), Y(pts[i - 1].p))
        ctx.lineTo(X(pts[i].xo), Y(pts[i].p))
        ctx.stroke()
      }
      ctx.globalAlpha = 1

      // the bar end (plate seen from the side) + velocity vector
      const hx = X(s.xo)
      const hy = Y(s.p)
      const R = Math.max(10, Math.min(17, w * 0.065))
      if (s.v > 0.05) {
        const len = s.v * 34
        ctx.strokeStyle = HEAT
        ctx.fillStyle = HEAT
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(hx, hy - R - 3)
        ctx.lineTo(hx, hy - R - 3 - len)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(hx - 5, hy - R - len + 2)
        ctx.lineTo(hx + 5, hy - R - len + 2)
        ctx.lineTo(hx, hy - R - len - 7)
        ctx.closePath()
        ctx.fill()
      }
      ctx.fillStyle = '#1626c9'
      ctx.strokeStyle = PAPER
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(hx, hy, R, 0, TAU)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(hx, hy, R * 0.62, 0, TAU)
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = s.phase === 'up' ? HEAT : PAPER
      ctx.beginPath()
      ctx.arc(hx, hy, R * 0.3, 0, TAU)
      ctx.fill()
    },
  }
}

export function VelocityViz() {
  const host = useRef(null)
  const canvas = useRef(null)
  const r = {
    rep: useRef(null),
    big: useRef(null),
    live: useRef(null),
    loss: useRef(null),
    lossFill: useRef(null),
    lossBox: useRef(null),
    bars: useRef(null),
    alert: useRef(null),
    alertLoss: useRef(null),
  }
  const sim = useMemo(() => makeVelocity(r), [])
  useViz(host, canvas, sim)

  return (
    <div ref={host} className="prg-viz-body prg-vl" aria-hidden="true">
      <div className="prg-cell prg-vl-path">
        <canvas ref={canvas} className="prg-cv" />
      </div>
      <div className="prg-vl-read">
        <div className="prg-vl-hero">
          <p className="mono prg-k">
            <span ref={r.rep}>Rep 1</span> · mean concentric
          </p>
          <p className="prg-big d tnum">
            <span ref={r.big} className="prg-big-n">
              0.00
            </span>
            <small className="mono">m/s</small>
          </p>
          <p className="mono prg-k">
            Bar now <b ref={r.live} className="tnum">0.00</b> m/s
          </p>
          <div ref={r.alert} className="prg-vl-alert">
            <span className="d prg-alert-big">Set ends</span>
            <span className="mono">
              <b ref={r.alertLoss}>−22% speed</b> · rack it
            </span>
          </div>
        </div>
        <div ref={r.lossBox} className="prg-loss">
          <p className="mono prg-k prg-row">
            <span>Velocity loss</span>
            <b ref={r.loss} className="tnum">
              0%
            </b>
          </p>
          <div className="prg-meter">
            <i ref={r.lossFill} />
            <em style={{ left: `${(CUT / 0.3) * 100}%` }}>
              <span className="mono">20% cut</span>
            </em>
          </div>
        </div>
        <div className="prg-bars-wrap">
          <div ref={r.bars} className="prg-bars">
            {REPS.map((_, i) => (
              <div key={i} className="prg-bar">
                <i />
                <span className="mono tnum" />
              </div>
            ))}
            <span className="prg-bars-cut" style={{ bottom: `${((REPS[0] * (1 - CUT) - BAR_MIN) / (1 - BAR_MIN)) * 100}%` }} />
          </div>
          <p className="mono prg-k prg-row prg-nowrap">
            <span>Per rep</span>
            <span>0.50–1.00 m/s</span>
          </p>
        </div>
      </div>
    </div>
  )
}

/* =====================================================================================
   2 · ENGINE ROOM — ECG + power trace, surging watts, segmented meter, bpm
   ===================================================================================== */
const SEGS = 24
const W_MAX = 1200
const ON = 8
const OFF = 12
const gauss = (x, mu, sig) => Math.exp(-((x - mu) * (x - mu)) / (2 * sig * sig))
// one heartbeat in seconds since the beat started (QRS width stays fixed as heart rate climbs)
const ecgShape = (tb) =>
  0.11 * gauss(tb, 0.05, 0.018) - 0.12 * gauss(tb, 0.1, 0.006) + 1 * gauss(tb, 0.115, 0.0075) - 0.26 * gauss(tb, 0.132, 0.007) + 0.27 * gauss(tb, 0.25, 0.034)

function makeEngine(r) {
  let still = reducedMotion()
  const s = {
    t: 0,
    tau: 0,
    on: true,
    watts: 310,
    target: 310,
    peakP: 1120,
    bpm: 156,
    beats: [],
    nextBeat: 0.3,
    pow: [],
    powT: 0,
    txtT: 0,
    lit: -1,
    hold: 0,
    holdT: 0,
    sessionPeak: 0,
    from: 310,
  }

  const setPhase = (on) => {
    s.on = on
    s.tau = 0
    s.from = s.watts
    if (on) s.peakP = rand(1060, 1150)
    const el = r.phase.current
    if (el) {
      el.classList.toggle('is-on', on)
      put(el, on ? 'Sprint' : 'Easy')
      snap(el, still)
    }
  }

  return {
    /** run the simulation silently so it is mid-story when it first appears */
    warm(sec) {
      const was = still
      still = true
      for (let i = 0; i < sec * 60; i++) this.step(1 / 60)
      still = was
    },
    warmup: 5.5,
    step(dt) {
      s.t += dt
      s.tau += dt
      if (s.on && s.tau >= ON) setPhase(false)
      else if (!s.on && s.tau >= OFF) setPhase(true)
      // power model: sprint = hard rise then fade, per-pedal-stroke ripple; easy = ~300 W spin
      if (s.on) {
        const rise = 1 - Math.exp(-s.tau / 0.38)
        const fade = 1 - 0.3 * (s.tau / ON)
        s.target = (s.from + (s.peakP - s.from) * rise) * fade * (1 + 0.065 * Math.sin(TAU * 2.1 * s.t))
      } else {
        const base = 300 + 22 * Math.sin(TAU * 0.13 * s.t)
        s.target = (base + (s.from - base) * Math.exp(-s.tau / 0.55)) * (1 + 0.035 * Math.sin(TAU * 1.15 * s.t))
      }
      s.watts += (s.target - s.watts) * Math.min(1, dt * 14)
      if (s.watts > s.sessionPeak) s.sessionPeak = s.watts
      // heart rate lags the work
      const hrT = s.on ? 187 : 150
      s.bpm += (hrT - s.bpm) * (1 - Math.exp(-dt / (s.on ? 3.4 : 4.6)))
      while (s.nextBeat <= s.t) {
        s.beats.push(s.nextBeat)
        if (s.beats.length > 24) s.beats.shift()
        s.nextBeat += 60 / s.bpm
        if (!still && r.beat.current) gsap.fromTo(r.beat.current, { scale: 1.9, opacity: 1 }, { scale: 1, opacity: 0.35, duration: 0.32, ease: 'expo.out', overwrite: true })
      }
      if (s.t - s.powT > 1 / 30) {
        s.powT = s.t
        s.pow.push(s.t, s.watts)
        if (s.pow.length > 260) s.pow.splice(0, 2)
      }
      // readouts ≤ 20/s
      if (s.t - s.txtT >= 0.05) {
        s.txtT = s.t
        put(r.watts.current, fmtInt(s.watts))
        put(r.bpm.current, String(Math.round(s.bpm)))
        put(r.clock.current, `0:${String(Math.ceil((s.on ? ON : OFF) - s.tau)).padStart(2, '0')}`)
        put(r.peak.current, fmtInt(s.sessionPeak))
        const lit = Math.round(clamp01(s.watts / W_MAX) * SEGS)
        if (lit >= s.hold) {
          s.hold = lit
          s.holdT = s.t
        } else if (s.t - s.holdT > 0.9) s.hold = Math.max(lit, s.hold - 1)
        if (lit !== s.lit || s.hold !== s.lastHold) {
          s.lit = lit
          s.lastHold = s.hold
          const segs = r.segs.current?.children
          if (segs)
            for (let i = 0; i < segs.length; i++) {
              const c = i < lit ? (i >= SEGS - 6 ? 'on hot' : 'on') : i === s.hold - 1 ? 'pk' : ''
              if (segs[i].className !== c) segs[i].className = c
            }
        }
      }
    },
    prime() {
      setPhase(true)
      for (let i = 0; i < 60 * 10.5; i++) this.step(1 / 60)
      setPhase(true)
      for (let i = 0; i < 60 * 2.2; i++) this.step(1 / 60)
    },
    draw(ctx, w, h) {
      ctx.clearRect(0, 0, w, h)
      const win = w < 420 ? 2.6 : 3.4
      const pxs = w / win
      const now = s.t
      // scrolling monitor grid
      ctx.fillStyle = 'rgba(10,10,16,0.1)'
      const g0 = Math.floor(now / 0.2) * 0.2
      for (let tt = g0, k = Math.round(g0 / 0.2); tt > now - win - 0.2; tt -= 0.2, k--) {
        const x = Math.round(w - (now - tt) * pxs)
        ctx.fillStyle = k % 5 === 0 ? 'rgba(10,10,16,0.2)' : 'rgba(10,10,16,0.08)'
        ctx.fillRect(x, 0, 1, h)
      }
      ctx.fillStyle = 'rgba(10,10,16,0.08)'
      for (let i = 1; i < 6; i++) ctx.fillRect(0, Math.round((h * i) / 6), w, 1)

      // ECG channel
      const e0 = h * 0.1
      const e1 = h * 0.6
      const base = e0 + (e1 - e0) * 0.74
      const amp = (e1 - e0) * 0.78
      const beats = s.beats
      ctx.strokeStyle = INK
      ctx.lineWidth = 2.4
      ctx.lineJoin = 'round'
      ctx.beginPath()
      let bi = 0
      let lastY = base
      for (let x = 0; x <= w; x += 1.5) {
        const t = now - (w - x) / pxs
        while (bi < beats.length - 1 && beats[bi + 1] <= t) bi++
        const b = beats[bi]
        const tb = b !== undefined && b <= t ? t - b : 9
        const y = base - (ecgShape(tb) + 0.012 * Math.sin(t * 41.3) + 0.03 * Math.sin(t * 1.9)) * amp
        lastY = y
        if (x) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      }
      ctx.stroke()
      ctx.fillStyle = INK
      ctx.beginPath()
      ctx.arc(w - 3, lastY, 4.5, 0, TAU)
      ctx.fill()

      // power channel
      const p0 = h * 0.68
      const p1 = h * 0.97
      const pw = s.pow
      if (pw.length > 4) {
        ctx.beginPath()
        let started = false
        for (let i = 0; i < pw.length; i += 2) {
          const x = w - (now - pw[i]) * pxs
          if (x < -4) continue
          const y = p1 - clamp01(pw[i + 1] / W_MAX) * (p1 - p0)
          if (!started) {
            ctx.moveTo(x, p1)
            ctx.lineTo(x, y)
            started = true
          } else ctx.lineTo(x, y)
        }
        ctx.lineTo(w, p1 - clamp01(s.watts / W_MAX) * (p1 - p0))
        ctx.lineTo(w, p1)
        ctx.closePath()
        ctx.fillStyle = 'rgba(10,10,16,0.16)'
        ctx.fill()
        ctx.strokeStyle = INK
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(10,10,16,0.7)'
      ctx.font = `500 9.5px ${MONO}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText('HR · LEAD II', 10, 8)
      ctx.fillText('POWER · W', 10, p0 - 14)
    },
  }
}

export function EngineViz() {
  const host = useRef(null)
  const canvas = useRef(null)
  const r = {
    watts: useRef(null),
    phase: useRef(null),
    clock: useRef(null),
    segs: useRef(null),
    bpm: useRef(null),
    beat: useRef(null),
    peak: useRef(null),
  }
  const sim = useMemo(() => makeEngine(r), [])
  useViz(host, canvas, sim)

  return (
    <div ref={host} className="prg-viz-body prg-en" aria-hidden="true">
      <div className="prg-en-top">
        <div className="min-w-0">
          <p className="mono prg-k prg-row prg-en-phase">
            <span ref={r.phase} className="prg-phase is-on">
              Sprint
            </span>
            <span>
              <b ref={r.clock} className="tnum">
                0:08
              </b>{' '}
              left
            </span>
          </p>
          <p className="prg-big prg-en-w d tnum">
            <span ref={r.watts} className="prg-big-n">
              310
            </span>
            <small className="mono">W</small>
          </p>
        </div>
        <div className="prg-en-bpm">
          <p className="mono prg-k">
            <i ref={r.beat} className="prg-beat" /> Heart rate
          </p>
          <p className="prg-mid tnum">
            <b ref={r.bpm}>156</b>
            <small className="mono">bpm</small>
          </p>
          <p className="mono prg-k">
            Peak <b ref={r.peak} className="tnum">0</b> W
          </p>
        </div>
      </div>
      <div className="prg-segs-wrap">
        <div ref={r.segs} className="prg-segs">
          {Array.from({ length: SEGS }, (_, i) => (
            <i key={i} />
          ))}
        </div>
        <p className="mono prg-k prg-row">
          <span>0</span>
          <span>600</span>
          <span>1,200 W</span>
        </p>
      </div>
      <div className="prg-cell prg-en-ecg">
        <canvas ref={canvas} className="prg-cv" />
      </div>
    </div>
  )
}

/* =====================================================================================
   3 · RECOVERY DECK — 4 s inhale / 6 s exhale ring, HRV drifting 48 → 62 ms
   ===================================================================================== */
const IN = 4
const OUT = 6
const HRV_LO = 44
const HRV_HI = 66

function makeBreath(r) {
  let still = reducedMotion()
  const s = { t: 0, p: 0, lag: 0, inhale: true, hrv: 48, hrvT: 0, hist: [], cntT: 0 }
  for (let i = 0; i < 36; i++) s.hist.push(48 + Math.sin(i * 1.7) * 0.8)

  const spark = () => {
    const el = r.spark.current
    if (!el) return
    const n = s.hist.length
    let pts = ''
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 100
      const y = 30 - ((s.hist[i] - HRV_LO) / (HRV_HI - HRV_LO)) * 30
      pts += `${x.toFixed(1)},${y.toFixed(1)} `
    }
    el.setAttribute('points', pts)
  }

  const swap = (inhale) => {
    s.inhale = inhale
    const el = r.label.current
    put(el, inhale ? 'Inhale' : 'Exhale')
    if (el && !still) gsap.fromTo(el, { yPercent: inhale ? 40 : -40, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.9, ease: 'power3.out', overwrite: true })
  }

  return {
    /** run the simulation silently so it is mid-story when it first appears */
    warm(sec) {
      const was = still
      still = true
      for (let i = 0; i < sec * 60; i++) this.step(1 / 60)
      still = was
    },
    warmup: 0.6,
    step(dt) {
      s.t += dt
      const c = s.t % (IN + OUT)
      const inhale = c < IN
      if (inhale !== s.inhale) swap(inhale)
      s.p = inhale ? easeSine(c / IN) : 1 - easeSine((c - IN) / OUT)
      s.f = inhale ? c / IN : (c - IN) / OUT
      s.lag += (s.p - s.lag) * Math.min(1, dt * 2.2)
      if (s.t - s.cntT > 0.1) {
        s.cntT = s.t
        put(r.count.current, `${Math.ceil(inhale ? IN - c : IN + OUT - c)} s`)
      }
      // HRV climbs as the breathing settles the nervous system, then hovers near the top
      if (s.t - s.hrvT >= 1) {
        s.hrvT = s.t
        s.hrv += (62 - s.hrv) * 0.05 + (Math.random() - 0.5) * 0.7
        s.hrv = Math.min(62.4, Math.max(47.6, s.hrv))
        s.hist.push(s.hrv)
        if (s.hist.length > 36) s.hist.shift()
        put(r.hrv.current, String(Math.round(s.hrv)))
        spark()
      }
    },
    prime() {
      s.hrv = 57
      s.hist = s.hist.map((_, i) => 48 + (9 * i) / 35 + Math.sin(i * 1.3) * 0.7)
      for (let i = 0; i < 60 * 2.6; i++) this.step(1 / 60)
      put(r.hrv.current, String(Math.round(s.hrv)))
      spark()
    },
    draw(ctx, w, h) {
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2
      const cy = h / 2
      const R = Math.min(w, h) * 0.42 - 14
      const rMin = R * 0.5
      const rad = rMin + (R - rMin) * s.p
      const echo = rMin + (R - rMin) * s.lag

      // guides
      ctx.setLineDash([2, 6])
      ctx.strokeStyle = 'rgba(10,10,16,0.28)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, TAU)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cx, cy, rMin, 0, TAU)
      ctx.stroke()
      ctx.setLineDash([])

      // tick ring fills over the inhale, empties over the exhale
      const N = 72
      const f = s.f || 0
      for (let i = 0; i < N; i++) {
        const a = -Math.PI / 2 + (i / N) * TAU
        const on = s.inhale ? i / N < f : i / N >= f
        const r0 = R + 8
        const r1 = R + (i % 6 === 0 ? 20 : 15)
        ctx.strokeStyle = on ? COBALT : 'rgba(10,10,16,0.16)'
        ctx.lineWidth = on ? 2.2 : 1.2
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
        ctx.stroke()
      }

      // echo + breathing disc
      ctx.strokeStyle = 'rgba(34,54,255,0.3)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(cx, cy, echo + 10, 0, TAU)
      ctx.stroke()
      ctx.fillStyle = 'rgba(34,54,255,0.12)'
      ctx.beginPath()
      ctx.arc(cx, cy, rad, 0, TAU)
      ctx.fill()
      ctx.strokeStyle = COBALT
      ctx.lineWidth = 3
      ctx.stroke()
    },
  }
}

export function BreathViz() {
  const host = useRef(null)
  const canvas = useRef(null)
  const r = { label: useRef(null), count: useRef(null), hrv: useRef(null), spark: useRef(null) }
  const sim = useMemo(() => makeBreath(r), [])
  useViz(host, canvas, sim)

  return (
    <div ref={host} className="prg-viz-body prg-rc" aria-hidden="true">
      <div className="prg-cell prg-rc-ring">
        <canvas ref={canvas} className="prg-cv" />
        <div className="prg-rc-center">
          <span ref={r.label} className="d prg-rc-label">
            Inhale
          </span>
          <span ref={r.count} className="mono prg-k tnum">
            4 s
          </span>
        </div>
      </div>
      <div className="prg-rc-foot">
        <div>
          <p className="mono prg-k">HRV · RMSSD</p>
          <p className="prg-mid tnum">
            <b ref={r.hrv}>48</b>
            <small className="mono">ms</small>
          </p>
        </div>
        <svg className="prg-spark" viewBox="0 0 100 30" preserveAspectRatio="none">
          <polyline ref={r.spark} points="" />
        </svg>
        <div className="prg-rc-side">
          <p className="mono prg-k">Breathing</p>
          <p className="mono">6 / min</p>
        </div>
      </div>
    </div>
  )
}

/* =====================================================================================
   4 · FIGHT FLOOR — pad target, impact bursts, strike counter, peak speed, 3:00 round
   ===================================================================================== */
const STRIKES = [
  ['JAB', 5.4, 7.2],
  ['CROSS', 6.8, 8.9],
  ['HOOK', 7.2, 9.4],
  ['UPPERCUT', 6.4, 8.4],
  ['ELBOW', 6.0, 8.0],
  ['KNEE', 6.6, 8.8],
]
const ROUND = 180

function makeFight(r) {
  let still = reducedMotion()
  const s = { t: 0, next: 0.4, combo: 3, hits: [], marks: [], count: 0, peak: 0, clock: ROUND, rest: 0, sx: 0, sy: 0, vx: 0, vy: 0, txtT: 0, squash: 0, R: 100 }

  const strike = () => {
    const [type, lo, hi] = STRIKES[(Math.random() * STRIKES.length) | 0]
    const v = Math.min(9.4, rand(lo, hi))
    const a = rand(0, TAU)
    const d = Math.sqrt(Math.random()) * 0.42
    const hit = { x: Math.cos(a) * d, y: Math.sin(a) * d, t: s.t, v, type, rot: rand(0, TAU) }
    s.hits.push(hit)
    if (s.hits.length > 8) s.hits.shift()
    s.marks.push(hit)
    if (s.marks.length > 28) s.marks.shift()
    s.vx -= Math.cos(a) * 190 * (v / 9)
    s.vy -= Math.sin(a) * 190 * (v / 9)
    s.squash = Math.min(1, s.squash + 0.6)
    s.count += 1
    put(r.count.current, String(s.count))
    put(r.last.current, v.toFixed(1))
    put(r.lastType.current, type)
    if (v > s.peak) {
      s.peak = v
      put(r.peak.current, v.toFixed(1))
      if (!still && r.peakBox.current) gsap.fromTo(r.peakBox.current, { '--flash': 1 }, { '--flash': 0, duration: 0.7, ease: 'power2.out', overwrite: true })
    }
  }

  const fmtClock = (c) => {
    const m = Math.floor(c / 60)
    const sec = Math.floor(c % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  return {
    /** run the simulation silently so it is mid-story when it first appears */
    warm(sec) {
      const was = still
      still = true
      for (let i = 0; i < sec * 60; i++) this.step(1 / 60)
      still = was
    },
    warmup: 46,
    step(dt) {
      s.t += dt
      if (s.rest > 0) {
        s.rest -= dt
        if (s.rest <= 0) {
          s.clock = ROUND
          s.count = 0
          s.peak = 0
          put(r.count.current, '0')
          put(r.peak.current, '0.0')
          r.clockBox.current?.classList.remove('is-end')
          s.next = s.t + 0.6
        }
      } else {
        s.clock -= dt
        if (s.clock <= 0) {
          s.clock = 0
          s.rest = 2.6
          r.clockBox.current?.classList.add('is-end')
        } else if (s.t >= s.next) {
          strike()
          s.combo -= 1
          if (s.combo > 0) s.next = s.t + rand(0.12, 0.26)
          else {
            s.combo = 2 + ((Math.random() * 3) | 0)
            s.next = s.t + rand(0.5, 1.15)
          }
        }
      }
      // pad recoil spring
      const k = 520
      const c = 17
      s.vx += (-k * s.sx - c * s.vx) * dt
      s.vy += (-k * s.sy - c * s.vy) * dt
      s.sx += s.vx * dt
      s.sy += s.vy * dt
      s.squash *= Math.exp(-dt * 9)
      if (s.t - s.txtT >= 0.1) {
        s.txtT = s.t
        put(r.clock.current, fmtClock(s.clock))
        put(r.tenth.current, `.${Math.floor(s.clock * 10) % 10}`)
      }
    },
    prime() {
      s.clock = 107.6
      for (let i = 0; i < 60 * 22; i++) this.step(1 / 60)
      s.t += 0.001
      strike()
      s.hits[s.hits.length - 1].t = s.t - 0.07
      s.sx = s.sy = 0
    },
    draw(ctx, w, h) {
      ctx.clearRect(0, 0, w, h)
      const R = Math.min(w, h) * 0.4
      s.R = R
      const cx = w / 2 + s.sx * (R / 160)
      const cy = h / 2 + s.sy * (R / 160)
      const sq = 1 - s.squash * 0.035

      // reticle
      ctx.fillStyle = 'rgba(239,238,233,0.1)'
      ctx.fillRect(0, Math.round(h / 2), w, 1)
      ctx.fillRect(Math.round(w / 2), 0, 1, h)
      ctx.font = `500 9.5px ${MONO}`
      ctx.fillStyle = 'rgba(239,238,233,0.45)'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillText('PAD CAM', 12, 10)

      // pad
      ctx.save()
      ctx.translate(cx, cy)
      ctx.scale(sq, sq)
      ctx.fillStyle = 'rgba(239,238,233,0.06)'
      ctx.beginPath()
      ctx.arc(0, 0, R, 0, TAU)
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(239,238,233,0.42)'
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(239,238,233,0.22)'
      for (const f of [0.75, 0.5]) {
        ctx.beginPath()
        ctx.arc(0, 0, R * f, 0, TAU)
        ctx.stroke()
      }
      ctx.strokeStyle = HEAT
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(0, 0, R * 0.2, 0, TAU)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,75,31,0.18)'
      ctx.fill()

      // hit map
      for (const m of s.marks) {
        const age = s.t - m.t
        const a = Math.max(0, 1 - age / 9) * 0.55
        if (a <= 0) continue
        ctx.fillStyle = `rgba(255,75,31,${a.toFixed(3)})`
        ctx.fillRect(m.x * R - 2, m.y * R - 2, 4, 4)
      }

      // impacts
      for (const it of s.hits) {
        const age = s.t - it.t
        if (age > 0.7) continue
        const x = it.x * R
        const y = it.y * R
        if (age < 0.22) {
          const u = age / 0.22
          ctx.fillStyle = `rgba(255,75,31,${(1 - u).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(x, y, 6 + 26 * easeOutExpo(u), 0, TAU)
          ctx.fill()
        }
        if (age < 0.38) {
          const e = easeOutExpo(age / 0.38)
          ctx.strokeStyle = HEAT
          ctx.globalAlpha = 1 - e
          ctx.lineWidth = 3 * (1 - e) + 0.5
          ctx.beginPath()
          for (let i = 0; i < 12; i++) {
            const a = it.rot + (i / 12) * TAU
            const r0 = 10 + R * 0.36 * e
            const r1 = r0 + (i % 2 ? 10 : 22) * (1 - e) + 4
            ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0)
            ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1)
          }
          ctx.stroke()
          ctx.globalAlpha = 1
        }
        const u = age / 0.7
        ctx.strokeStyle = `rgba(239,238,233,${(0.8 * (1 - u)).toFixed(3)})`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, y, 8 + R * 0.72 * easeOutCubic(u), 0, TAU)
        ctx.stroke()
        ctx.fillStyle = `rgba(239,238,233,${(1 - u).toFixed(3)})`
        ctx.font = `600 11px ${MONO}`
        ctx.textBaseline = 'middle'
        ctx.fillText(`${it.type} ${it.v.toFixed(1)}`, x + 16, y - 16 - age * 30)
      }
      ctx.restore()
    },
  }
}

export function FightViz() {
  const host = useRef(null)
  const canvas = useRef(null)
  const r = {
    clock: useRef(null),
    tenth: useRef(null),
    clockBox: useRef(null),
    count: useRef(null),
    last: useRef(null),
    lastType: useRef(null),
    peak: useRef(null),
    peakBox: useRef(null),
  }
  const sim = useMemo(() => makeFight(r), [])
  useViz(host, canvas, sim)

  return (
    <div ref={host} className="prg-viz-body prg-ff" aria-hidden="true">
      <div className="prg-cell prg-ff-pad">
        <canvas ref={canvas} className="prg-cv" />
        <div ref={r.clockBox} className="prg-ff-clock">
          <p className="mono prg-k">
            <span className="prg-ff-rl">Round 2</span>
            <span className="prg-ff-end">Round over</span>
          </p>
          <p className="prg-mid tnum">
            <b ref={r.clock}>3:00</b>
            <small ref={r.tenth} className="mono">
              .0
            </small>
          </p>
        </div>
      </div>
      <div className="prg-ff-stats">
        <div>
          <p className="mono prg-k">Strikes</p>
          <p className="prg-stat tnum">
            <b ref={r.count}>0</b>
          </p>
        </div>
        <div>
          <p className="mono prg-k">
            Last · <span ref={r.lastType}>JAB</span>
          </p>
          <p className="prg-stat tnum">
            <b ref={r.last}>0.0</b>
            <small className="mono">m/s</small>
          </p>
        </div>
        <div ref={r.peakBox} className="prg-ff-peak">
          <p className="mono prg-k">Peak strike</p>
          <p className="prg-stat tnum">
            <b ref={r.peak}>0.0</b>
            <small className="mono">m/s</small>
          </p>
        </div>
      </div>
    </div>
  )
}
