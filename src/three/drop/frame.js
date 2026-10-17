import * as THREE from 'three'
import { PLATE_R } from './sim.js'

/**
 * Framing for THE DROP, shared by the scene (render camera), the section (pointer → lift mapping) and the node
 * verification tools. Pure three.js math: no DOM, no React.
 *
 * The solver is constraint based. Per aspect a preset gives the camera angle, lens and how wide the bar spans;
 * then, in the free band the HTML leaves between the top row and the copy:
 *   1. the lowest point of the plates (the floor contact, where the dust bursts) sits just above the copy row,
 *   2. the painted headline starts at the band's top-left (lined up with the copy) and is as large as it can be
 *      while line 2 ("FAST.", right-aligned under "MOVE IT") stays clear above the bar, and the plates only bite
 *      the foot of line 1,
 *   3. the lift range and the camera's crane-follow are fitted so a full lift stays in frame.
 */

export const BAR_HALF = 1.1
const SHAFT_HALF = 0.655
// plate stack on the right sleeve (inner → outer), same numbers as parts.js PLATES / plateLayout
const PLATE_T = [0.062, 0.052, 0.03]
const PLATE_RS = [PLATE_R, PLATE_R, 0.1625]
export const STACK = (() => {
  let x = SHAFT_HALF + 0.0306 + 0.0012
  return PLATE_T.map((t, i) => {
    const c = x + t / 2
    x += t + 0.0012
    return { x: c, t, R: PLATE_RS[i] }
  })
})()

export const DOLLY_BACK = 0.38 // entrance: the camera starts this far back and snaps in with the slam
const PULL = 0.3 // crane follow also eases the camera back a little
const LEAN_X = 0.11
const LEAN_Y = 0.03
const FOLLOW_Y0 = 0.22 // no camera follow for small lifts and bounces
export const LIFT_MAX = 1.0 // m: drag and power-clean ceiling (bar axis above its resting height)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const lerp = (a, b, t) => a + (b - a) * t

/* ------------------------------------------------------------------ */
/* Presets per aspect (interpolated)                                   */
/* yaw/el: camera angles (rad) · span: bar end-to-end / width ·        */
/* bx: bar centre x (fraction) · tw: max headline width (fraction)     */
/* ------------------------------------------------------------------ */
const PRESETS = [
  { a: 0.44, yaw: 0.86, el: 0.15, fov: 40, span: 1.1, bx: 0.5, tw: 0.91, top: 0.22 },
  { a: 0.6, yaw: 0.74, el: 0.14, fov: 38, span: 1.06, bx: 0.5, tw: 0.88, top: 0.22 },
  { a: 1.0, yaw: 0.52, el: 0.12, fov: 32, span: 1.0, bx: 0.52, tw: 0.82, top: 0.22 },
  { a: 1.5, yaw: 0.36, el: 0.1, fov: 28, span: 1.06, bx: 0.54, tw: 0.8, top: 0.22 },
  { a: 2.2, yaw: 0.3, el: 0.09, fov: 26, span: 1.0, bx: 0.54, tw: 0.72, top: 0.22 },
]
function preset(a) {
  if (a <= PRESETS[0].a) return { ...PRESETS[0] }
  for (let i = 1; i < PRESETS.length; i++) {
    const p1 = PRESETS[i]
    if (a <= p1.a) {
      const p0 = PRESETS[i - 1]
      const t = (a - p0.a) / (p1.a - p0.a)
      const out = {}
      for (const k of Object.keys(p0)) out[k] = lerp(p0[k], p1[k], t)
      return out
    }
  }
  return { ...PRESETS[PRESETS.length - 1] }
}

/* ------------------------------------------------------------------ */
/* Headline layout: shared by the wall painter and the solver          */
/* ------------------------------------------------------------------ */
/**
 * layout(text) → { items: [{ char, x, glyph }], width } in font units (glyphs.layoutText). `cap` = CAP_HEIGHT.
 * Line 1 is set flush left, line 2 flush right under it (a stagger: the bar's face-on plates sit in the empty
 * wall left of "FAST." instead of hiding a letter).
 */
export function headlineLayout(lines, layout, cap, { W = 2304, align = ['left', 'right'] } = {}) {
  const laid = lines.map((l) => layout(l))
  const maxW = Math.max(...laid.map((l) => l.width))
  const pad = W * 0.012
  const k = (W - pad * 2) / maxW
  const capPx = cap * k
  const lead = capPx * 1.12
  const H = Math.ceil(pad * 2 + capPx + lead * (lines.length - 1))
  return {
    W,
    H,
    k,
    cap: capPx,
    pad,
    aspect: W / H,
    lines: laid.map((l, i) => {
      const w = l.width * k
      const x = (align[i] || 'left') === 'right' ? W - pad - w : pad
      const base = pad + capPx + lead * i
      const items = l.items.map((it) => ({ ...it, px: x + it.x * k, adv: it.glyph.advance * k }))
      const stop = items.find((it) => it.char === '.')
      return {
        text: lines[i],
        items,
        x,
        w,
        base,
        // fractions of the texture, for the solver
        x0: x / W,
        x1: (x + w) / W,
        b: base / H,
        t: (base - capPx) / H,
        stop: stop ? { x0: stop.px / W, x1: (stop.px + stop.adv) / W } : null,
      }
    }),
  }
}

/* ------------------------------------------------------------------ */
/* Camera pose (shared by render + pointer mapping)                    */
/* ------------------------------------------------------------------ */
/** Camera-follow amount (m) for a lift `y`: none for small lifts, then a soft crane that saturates the bar's
 *  on-screen rise, so 1 m of lift stays in frame. Exactly 0 at y ≤ FOLLOW_Y0 (bounces never move the camera). */
export function followFor(y, f) {
  if (!f || !(f.followT > 0) || !Number.isFinite(f.followT)) return 0
  const u = y - FOLLOW_Y0
  if (u <= 0) return 0
  const T = f.followT
  return u - T * (1 - Math.exp(-u / T))
}

/**
 * Base pose: resting framing + entrance push-back + crane follow + pointer lean. Writes P (position) and L
 * (look-at); returns the fov. s = { dolly, follow, px, py, lean }.
 */
export function poseCamera(f, s, P, L) {
  P.copy(f.pos)
  L.copy(f.target)
  const ph = s.follow || 0
  P.addScaledVector(f.dir, (1 - s.dolly) * DOLLY_BACK + ph * PULL)
  P.y += ph
  L.y += ph
  const lean = s.lean ?? 1
  P.x += (s.px || 0) * LEAN_X * lean
  P.y -= (s.py || 0) * LEAN_Y * lean
  return f.fov + (1 - s.dolly) * 2
}

/** Apply a pose to a PerspectiveCamera (with the framing's view offset). */
export function applyPose(cam, f, s, w, h, P, L) {
  const fov = poseCamera(f, s, P, L)
  cam.fov = fov
  cam.aspect = w / h
  cam.position.copy(P)
  cam.lookAt(L)
  cam.setViewOffset(w, h, f.offX, f.offY, w, h)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld()
  return cam
}

/* ------------------------------------------------------------------ */
/* Solver                                                               */
/* ------------------------------------------------------------------ */
const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 80)
const _v = new THREE.Vector3()
const _P = new THREE.Vector3()
const _L = new THREE.Vector3()
const _ray = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
const _plane = new THREE.Plane()

function toPx(p, w, h, out) {
  _v.copy(p).project(cam)
  out.x = ((_v.x + 1) / 2) * w
  out.y = ((1 - _v.y) / 2) * h
  return out
}
function rayAt(px, py, w, h) {
  _ndc.set((px / w) * 2 - 1, 1 - (py / h) * 2)
  _ray.setFromCamera(_ndc, cam)
  return _ray.ray
}

/** World sample points on the bar's silhouette (for the screen envelope). lift = bar axis above rest. */
function barPoints(lift = 0) {
  const pts = []
  const y0 = PLATE_R + lift
  for (let x = -BAR_HALF; x <= BAR_HALF + 1e-6; x += 0.02) {
    const r = Math.abs(x) <= SHAFT_HALF ? 0.014 : 0.025
    pts.push(new THREE.Vector3(x, y0 + r, 0), new THREE.Vector3(x, y0 - r, 0))
  }
  for (const side of [-1, 1]) {
    for (const p of STACK) {
      for (const dx of [-p.t / 2, p.t / 2]) {
        for (let i = 0; i < 64; i++) {
          const a = (i / 64) * Math.PI * 2
          pts.push(new THREE.Vector3(side * (p.x + dx), y0 + Math.cos(a) * p.R, Math.sin(a) * p.R))
        }
      }
    }
  }
  return pts
}
const BAR_PTS = barPoints(0)

/** Screen-space envelope of the bar: min y per 4 px column, plus the lowest point. skipLeft: leave out the
 *  left (face-on) plate stack, which the solver places beside "FAST." rather than under it. */
function envelope(w, h, skipLeft = false) {
  const cols = Math.ceil(w / 4) + 1
  const top = new Float32Array(cols).fill(Infinity)
  let bottom = -Infinity
  const o = { x: 0, y: 0 }
  const lim = -(STACK[0].x - 0.04)
  for (const p of BAR_PTS) {
    if (skipLeft && p.x < lim) continue
    toPx(p, w, h, o)
    const c = Math.round(o.x / 4)
    if (c >= 0 && c < cols && o.y < top[c]) top[c] = o.y
    if (o.y > bottom) bottom = o.y
  }
  return { top, bottom, at: (x) => top[clamp(Math.round(x / 4), 0, cols - 1)] }
}

function stackBox(side, w, h) {
  const o = { x: 0, y: 0 }
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const p of BAR_PTS) {
    if (Math.sign(p.x) !== side || Math.abs(p.x) < STACK[0].x - 0.04) continue
    toPx(p, w, h, o)
    b.x0 = Math.min(b.x0, o.x)
    b.x1 = Math.max(b.x1, o.x)
    b.y0 = Math.min(b.y0, o.y)
    b.y1 = Math.max(b.y1, o.y)
  }
  return b
}

/**
 * w, h: viewport (px). type: headlineLayout(...). band: { top, bottom, left } (px) — the free band between the
 * HTML top row and the copy; null = defaults.
 */
export function solveFrame(w, h, type, band) {
  const p = preset(w / h)
  const B = band && band.bottom - band.top > 40 ? band : { top: 0.13 * h, bottom: 0.8 * h, left: 0.04 * w }
  const T = new THREE.Vector3(0, PLATE_R, 0)
  const D = new THREE.Vector3(Math.sin(p.yaw) * Math.cos(p.el), Math.sin(p.el), Math.cos(p.yaw) * Math.cos(p.el))
  cam.fov = p.fov
  cam.aspect = w / h
  cam.clearViewOffset()
  const A = new THREE.Vector3(-BAR_HALF, PLATE_R, 0)
  const Bv = new THREE.Vector3(BAR_HALF, PLATE_R, 0)
  const pa = { x: 0, y: 0 }
  const pb = { x: 0, y: 0 }
  // 1. distance: the bar spans the requested share of the width
  let lo = 1.2
  let hi = 16
  for (let i = 0; i < 24; i++) {
    const d = (lo + hi) / 2
    cam.position.copy(T).addScaledVector(D, d)
    cam.lookAt(T)
    cam.updateMatrixWorld()
    cam.updateProjectionMatrix()
    toPx(A, w, h, pa)
    toPx(Bv, w, h, pb)
    if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > p.span * w) lo = d
    else hi = d
  }
  const pos = cam.position.clone()
  // 2. placement: bar centre at bx; the lowest plate point (floor contact) just above the copy row
  const c = toPx(T, w, h, { x: 0, y: 0 })
  const env0 = envelope(w, h)
  const margin = clamp(0.02 * h, 8, 20)
  let offX = c.x - p.bx * w
  let offY = env0.bottom - (B.bottom - margin)
  // per-stack floor: the HTML block under it (copy on the left, hint + button on the right), else the band
  const floorFor = (box) => {
    let fl = h - margin
    for (const r of B.blocks || []) if (box.x1 > r.x0 && box.x0 < r.x1) fl = Math.min(fl, r.y0 - margin)
    if (!B.blocks || !B.blocks.length) fl = B.bottom - margin
    return fl
  }

  // 3. headline on the wall, square to the camera (horizontally), behind the platform
  const n = new THREE.Vector3(D.x, 0, D.z).normalize()
  const right = new THREE.Vector3(n.z, 0, -n.x)
  const wallPoint = T.clone().addScaledVector(n, -2.75)
  const wallPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, wallPoint)
  const tl = B.left
  const tt = B.top + 6
  const LT = new THREE.Vector3()
  const RT = new THREE.Vector3()
  const place = (tw) => {
    rayAt(tl, tt, w, h).intersectPlane(wallPlane, LT)
    rayAt(tl + tw, tt, w, h).intersectPlane(wallPlane, RT)
    const width = Math.hypot(RT.x - LT.x, RT.z - LT.z)
    return { width, height: width / type.aspect, top: (LT.y + RT.y) / 2 }
  }
  const at = (pl, u, v, out) => out.copy(LT).lerp(RT, u).setY(pl.top - v * pl.height)
  const o = { x: 0, y: 0 }
  const q = new THREE.Vector3()
  const scr = (pl, u, v) => toPx(at(pl, u, v, q), w, h, { x: 0, y: 0 })
  const clear = 14 // px between the shaft and the foot of line 2 (covers the pointer lean)
  let env = null // whole bar
  let envS = null // bar without the left stack
  const fits = (tw) => {
    const pl = place(tw)
    const bite = 0.24 * (scr(pl, 0.5, type.lines[0].b).y - scr(pl, 0.5, type.lines[0].t).y)
    for (let li = 0; li < type.lines.length; li++) {
      const ln = type.lines[li]
      const last = li === type.lines.length - 1
      for (let k = 0; k <= 32; k++) {
        const u = ln.x0 + ((ln.x1 - ln.x0) * k) / 32
        toPx(at(pl, u, ln.b, q), w, h, o)
        const e = last ? envS.at(o.x) : env.at(o.x)
        if (last ? o.y + clear > e : o.y - bite > e) return false
      }
    }
    return true
  }
  // never wider than the band allows (keeps the right margin equal to the left one)
  const twMax = Math.min(p.tw * w, w - 2 * tl)
  const solveType = () => {
    for (let s = 1; s >= 0.3; s -= 0.005) if (fits(s * twMax)) return s * twMax
    return 0.3 * twMax
  }
  let tw = twMax
  let stacks = null
  const l2 = type.lines[type.lines.length - 1]
  for (let it = 0; it < 8; it++) {
    cam.setViewOffset(w, h, offX, offY, w, h)
    cam.updateProjectionMatrix()
    stacks = [stackBox(-1, w, h), stackBox(1, w, h)]
    offY += Math.max(stacks[0].y1 - floorFor(stacks[0]), stacks[1].y1 - floorFor(stacks[1]))
    cam.setViewOffset(w, h, offX, offY, w, h)
    cam.updateProjectionMatrix()
    env = envelope(w, h)
    envS = envelope(w, h, true)
    stacks = [stackBox(-1, w, h), stackBox(1, w, h)]
    tw = solveType()
    // the face-on (left) stack sits in the empty wall left of "FAST.", just overlapping the F's foot
    const pl = place(tw)
    const s0 = scr(pl, l2.x0, l2.b)
    const capL2 = s0.y - scr(pl, l2.x0, l2.t).y
    const need = stacks[0].x1 - 0.12 * capL2 - s0.x
    if (stacks[0].y0 > s0.y || need <= 1) {
      if (it > 0) break
      continue
    }
    offX += Math.min(need, 0.1 * w)
  }
  cam.setViewOffset(w, h, offX, offY, w, h)
  cam.updateProjectionMatrix()
  env = envelope(w, h)
  envS = envelope(w, h, true)
  stacks = [stackBox(-1, w, h), stackBox(1, w, h)]
  tw = solveType()
  // stacked layout (phones): the bar sits entirely under the headline; tuck it up under "FAST." so the lit
  // platform shows below it instead of a band of empty wall above it
  {
    const pl = place(tw)
    const base2 = scr(pl, l2.x1, l2.b).y
    const barTop = Math.min(stacks[0].y0, stacks[1].y0)
    const want = base2 + 0.05 * h
    if (barTop > base2 && barTop > want) {
      offY += barTop - want
      cam.setViewOffset(w, h, offX, offY, w, h)
      cam.updateProjectionMatrix()
      env = envelope(w, h)
      envS = envelope(w, h, true)
      stacks = [stackBox(-1, w, h), stackBox(1, w, h)]
      tw = solveType()
    }
  }
  tw = solveType()
  const pl = place(tw)
  const typeCenter = LT.clone().lerp(RT, 0.5).setY(pl.top - pl.height / 2).addScaledVector(n, 0.004)

  // 4. where the top of the frame is on the bar's plane, seen from the entrance (pushed-back) camera
  const f = {
    pos,
    target: T.clone(),
    dir: pos.clone().sub(T).normalize(),
    fov: p.fov,
    offX,
    offY,
    n,
    right,
    wallPoint,
    wallYaw: Math.atan2(n.x, n.z),
    typeCenter,
    typeWidth: pl.width,
    typeHeight: pl.height,
    typeRect: { x: tl, y: tt, w: tw, h: tw / type.aspect },
    followT: Infinity,
    maxLift: LIFT_MAX,
    cleanTop: LIFT_MAX,
    maxLiftStill: LIFT_MAX,
    restY: 0,
    topY: 0,
    w,
    h,
  }
  applyPose(cam, f, { dolly: 0, follow: 0 }, w, h, _P, _L)
  _plane.set(new THREE.Vector3(0, 0, 1), 0)
  const hit = new THREE.Vector3()
  let frameTop = 0.5
  for (const x of [-0.84, -0.7, 0, 0.7, 0.84]) {
    toPx(_v.set(x, 0, 0), w, h, pa)
    if (rayAt(pa.x, 0, w, h).intersectPlane(_plane, hit)) frameTop = Math.max(frameTop, hit.y)
  }
  // lift at which the plates' lowest point sits just above the top edge: the fall is seen from its first cm
  f.dropFrom = frameTop + 0.035

  // 5. lift range: how high the bar centre may go on screen, and the crane-follow that keeps 1 m inside it
  const topY = Math.max(p.top * h, B.top - 0.02 * h)
  const barY = (lift, follow) => {
    applyPose(cam, f, { dolly: 1, follow }, w, h, _P, _L)
    return toPx(_v.set(0, PLATE_R + lift, 0), w, h, o).y
  }
  f.restY = barY(0, 0)
  f.topY = topY
  // without any follow (reduced motion): the highest lift that stays in frame
  let a = 0
  let b = LIFT_MAX
  if (barY(LIFT_MAX, 0) < topY) {
    for (let i = 0; i < 20; i++) {
      const m = (a + b) / 2
      if (barY(m, 0) >= topY) a = m
      else b = m
    }
    f.maxLiftStill = a
    // follow time-constant so that a full lift lands exactly at topY
    let t0 = 0.02
    let t1 = 20
    for (let i = 0; i < 30; i++) {
      const m = Math.sqrt(t0 * t1)
      f.followT = m
      if (barY(LIFT_MAX, followFor(LIFT_MAX, f)) >= topY) t0 = m
      else t1 = m
    }
    f.followT = t0
  }
  // debug / tooling: the parts of the composition the solver reasoned about
  f.debug = { env, stacks, clear, margin, band: B, preset: p }
  cam.clearViewOffset()
  return f
}

/**
 * Pointer → lift. Finds the lift at which the grabbed point of the bar (world x `gx`, `gy` metres above the bar
 * axis) projects under the pointer's screen y, with the camera posed for that lift (follow included), so the bar
 * stays under the hand while the camera cranes. Bisection: the bar's screen height is monotonic in the lift.
 */
export function liftUnder(f, s, sy, gx, gy, z, lo = 0, hi = LIFT_MAX) {
  const { w, h } = f
  const yAt = (lift) => {
    applyPose(cam, f, { ...s, follow: s.followOn ? followFor(lift, f) : 0 }, w, h, _P, _L)
    _v.set(gx, PLATE_R + lift + gy, z).project(cam)
    return ((1 - _v.y) / 2) * h
  }
  if (yAt(lo) <= sy) return lo
  if (yAt(hi) >= sy) return hi
  let a = lo
  let b = hi
  for (let i = 0; i < 22; i++) {
    const m = (a + b) / 2
    if (yAt(m) > sy) a = m
    else b = m
  }
  cam.clearViewOffset()
  return (a + b) / 2
}

/** World point under a screen point on the bar's plane (z = const), with a given pose. */
export function pointOnBarPlane(f, s, sx, sy, z, out) {
  const { w, h } = f
  applyPose(cam, f, s, w, h, _P, _L)
  _plane.set(new THREE.Vector3(0, 0, 1), -z)
  const ok = rayAt(sx, sy, w, h).intersectPlane(_plane, out)
  cam.clearViewOffset()
  return ok
}
