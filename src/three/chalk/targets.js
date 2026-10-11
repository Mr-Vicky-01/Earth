import { CAP_HEIGHT, drawText } from '../glyphs/index.js'
import { BLOCK, LAYOUTS } from './layout.js'

/**
 * Point targets for the chalk headline and the chalk block of the opening slam.
 * Everything is in cap-height units (1 = the cap height of "MOVE"), y up, the headline block centred on 0.
 *
 * The letters are a real volume: a thin powdery face at z ≈ 0 and walls that run back WALL_DEPTH behind every
 * contour. Grains are stored walls first, then the face, each part sorted back to front, so that drawing them in
 * index order paints the volume correctly without a depth buffer (the face always covers the walls behind it).
 */

/** Small deterministic PRNG (mulberry32), so the dust lands the same way on every load. */
export function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

export const WALL_SHARE = 0.2
export const WALL_DEPTH = 0.24
/** info.b of a face grain (wall grains hold their outward normal's angle there instead) */
export const FACE_TAG = 9

function canvas2d(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return { c, ctx: c.getContext('2d', { willReadFrequently: true }) }
}

/** Two-pass separable box blur of an 8-bit mask → 0..1 floats (a cheap soft distance field). */
function boxBlur(mask, w, h, r, passes = 2) {
  let a = new Float32Array(w * h)
  for (let i = 0; i < a.length; i++) a[i] = mask[i] / 255
  let b = new Float32Array(w * h)
  const inv = 1 / (2 * r + 1)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w
      let acc = 0
      for (let x = 0; x <= r && x < w; x++) acc += a[row + x]
      for (let x = 0; x < w; x++) {
        b[row + x] = acc * inv
        const add = x + r + 1
        const sub = x - r
        if (add < w) acc += a[row + add]
        if (sub >= 0) acc -= a[row + sub]
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let y = 0; y <= r && y < h; y++) acc += b[y * w + x]
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * inv
        const add = y + r + 1
        const sub = y - r
        if (add < h) acc += b[add * w + x]
        if (sub >= 0) acc -= b[sub * w + x]
      }
    }
  }
  return a
}

function alphaOf(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3]
  return out
}

/** Filled pixels and the filled pixels that touch the outside (the letter edges). */
function scanMask(alpha, w, h) {
  const filled = []
  const edge = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (alpha[i] < 128) continue
      filled.push(i)
      if (alpha[i - 1] < 128 || alpha[i + 1] < 128 || alpha[i - w] < 128 || alpha[i + w] < 128) edge.push(i)
    }
  }
  return { filled: Int32Array.from(filled), edge: Int32Array.from(edge) }
}

/** Raster of the headline (a layout from layout.js) at `res` px per cap height. */
export function rasterHeadline(layout, res) {
  const pad = Math.ceil(res * 0.22)
  const bw = layout.W * res
  const bh = layout.H * res
  const w = Math.ceil(bw) + pad * 2
  const h = Math.ceil(bh) + pad * 2
  const { c, ctx } = canvas2d(w, h)
  ctx.fillStyle = '#fff'
  for (const line of layout.lines) {
    const size = res * line.scale
    const s = size / CAP_HEIGHT
    drawText(ctx, line.text, pad - line.ink.minx * s, pad + line.top * res + layout.top * s, size, { instance: line.instance })
  }
  return { canvas: c, ctx, w, h, pad, res, cx: pad + bw / 2, cy: pad + bh / 2 }
}

/**
 * Samples `count` dust grains in the headline volume.
 * target: xyz, w = per-grain seed
 * info:   r = baked key-light shade, g = edge-ness (0 deep inside a stroke … 1 on the edge),
 *         b = the outward normal angle of a wall grain (radians, y up) or FACE_TAG for the face,
 *         a = how far back a wall grain sits (0 … 1)
 * Returns { target, info, nWall }.
 */
export function sampleHeadline(count, res, seed = 11, variant = 'wide') {
  return drain(headlineSteps(count, res, seed, variant))
}

/** Same as sampleHeadline, but gives the main thread back every few thousand grains. */
export function sampleHeadlineAsync(count, res, seed = 11, variant = 'wide', signal) {
  return drainAsync(headlineSteps(count, res, seed, variant), signal)
}

const CHUNK = 12000

function drain(gen) {
  for (;;) {
    const r = gen.next()
    if (r.done) return r.value
  }
}

const yieldToMain = () =>
  typeof globalThis.scheduler?.yield === 'function'
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0))

async function drainAsync(gen, signal) {
  for (;;) {
    const r = gen.next()
    if (r.done) return r.value
    await yieldToMain()
    if (signal?.aborted) return null
  }
}

/** Indices [from, to) ordered by ascending key (a counting sort on a quantised key: O(n), stable). */
function orderBy(key, from, to, lo, hi, buckets = 1024) {
  const n = to - from
  const q = new Uint16Array(n)
  const counts = new Uint32Array(buckets + 1)
  const k = (buckets - 1) / Math.max(1e-6, hi - lo)
  for (let i = 0; i < n; i++) {
    const b = clamp(Math.round((key[from + i] - lo) * k), 0, buckets - 1)
    q[i] = b
    counts[b + 1]++
  }
  for (let b = 0; b < buckets; b++) counts[b + 1] += counts[b]
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) out[counts[q[i]]++] = from + i
  return out
}

function* headlineSteps(count, res, seed, variant) {
  const layout = LAYOUTS[variant] || LAYOUTS.wide
  const R = rasterHeadline(layout, res)
  const { w, h, pad, cx, cy } = R
  const alpha = alphaOf(R.ctx, w, h)
  const { filled, edge } = scanMask(alpha, w, h)
  const blur = boxBlur(alpha, w, h, Math.max(2, Math.round(res * 0.05)))
  const rand = rng(seed)
  // key light from the upper left (canvas y points down)
  const Lx = -0.62
  const Ly = -0.785
  const bw = layout.W * res
  const bh = layout.H * res
  const freq = 2.4 / res // mottling: chalk never lies perfectly even
  const nWall = Math.round(count * WALL_SHARE)
  const X = new Float32Array(count)
  const Y = new Float32Array(count)
  const Z = new Float32Array(count)
  const SH = new Float32Array(count)
  const ED = new Float32Array(count)
  const DF = new Float32Array(count)
  const NA = new Float32Array(count).fill(FACE_TAG)
  const normalAt = (idx) => {
    const gx = blur[idx + 1] - blur[idx - 1]
    const gy = blur[idx + w] - blur[idx - w]
    const gl = Math.hypot(gx, gy)
    return gl > 1e-5 ? [-gx / gl, -gy / gl] : [0, 0]
  }
  const mottle = (px, py) =>
    0.5 + 0.25 * (Math.sin(px * freq + 1.3) * Math.sin(py * freq * 1.3 + 0.4) + Math.sin((px - py * 0.6) * freq * 0.45))
  yield

  for (let i = 0; i < count; i++) {
    if (i % CHUNK === CHUNK - 1) yield
    const gradeAt = (px, py) => 1.12 - 0.26 * (((px - pad) / bw) * 0.55 + ((py - pad) / bh) * 0.45)
    if (i < nWall) {
      // a wall grain: on the contour, somewhere between the face and the back of the letter
      const idx = edge[(rand() * edge.length) | 0]
      const px = (idx % w) + rand()
      const py = ((idx / w) | 0) + rand()
      const [nx, ny] = normalAt(idx)
      const df = Math.pow(rand(), 0.8)
      const lam = Math.max(0, nx * Lx + ny * Ly)
      // walls that face the key light catch it; the others fall into shadow, darker the deeper they go
      let shade = (0.24 + 0.7 * Math.pow(lam, 1.2)) * (1 - 0.38 * df) * (0.93 + 0.14 * rand())
      shade *= gradeAt(px, py)
      X[i] = (px - cx) / res
      Y[i] = -(py - cy) / res
      Z[i] = -0.014 - (WALL_DEPTH - 0.014) * df
      SH[i] = clamp(shade, 0.16, 1.1)
      ED[i] = 1
      DF[i] = df
      NA[i] = Math.atan2(-ny, nx)
      continue
    }
    let idx = 0
    let px = 0
    let py = 0
    const pick = rand()
    for (let tries = 0; tries < 4; tries++) {
      idx = pick < 0.07 ? edge[(rand() * edge.length) | 0] : filled[(rand() * filled.length) | 0]
      px = (idx % w) + rand()
      py = ((idx / w) | 0) + rand()
      if (rand() < 0.86 + 0.14 * mottle(px, py)) break
    }
    const [nx, ny] = normalAt(idx)
    let inner = clamp((blur[idx] - 0.5) * 2.2, 0, 1)
    let edgeness = 1 - inner
    let z = 0.02 * rand()
    if (pick > 0.988) {
      // dusty fringe: a few grains sit just outside the stroke, like chalk rubbed onto a wall
      const d = -Math.log(1 - rand() * 0.98) * res * 0.018
      px += nx * d
      py += ny * d
      inner = 0
      edgeness = 1
      z = 0.03 * rand()
    }
    const lambert = nx * Lx + ny * Ly
    // raking key light: the rounded shoulders of each stroke facing it flare, the far shoulders fall into shadow
    let shade = 1 + 0.95 * lambert * Math.pow(edgeness, 0.8) + 0.04 * inner
    shade *= gradeAt(px, py)
    // the tooth of the chalk: soft patches a little brighter or duller, never holes
    shade *= 0.9 + 0.2 * mottle(px * 1.7 + 31, py * 1.7 - 17)
    shade *= 0.95 + 0.1 * rand()
    X[i] = (px - cx) / res
    Y[i] = -(py - cy) / res
    Z[i] = z
    SH[i] = clamp(shade, 0.25, 1.24)
    ED[i] = edgeness
    DF[i] = 0
  }
  yield

  // back to front within each part (walls, then the face)
  const order = new Uint32Array(count)
  order.set(orderBy(Z, 0, nWall, -WALL_DEPTH, 0), 0)
  order.set(orderBy(Z, nWall, count, 0, 0.03), nWall)
  const target = new Float32Array(count * 4)
  const info = new Float32Array(count * 4)
  for (let j = 0; j < count; j++) {
    const i = order[j]
    const k = j * 4
    target[k] = X[i]
    target[k + 1] = Y[i]
    target[k + 2] = Z[i]
    target[k + 3] = rand()
    info[k] = SH[i]
    info[k + 1] = ED[i]
    info[k + 2] = NA[i]
    info[k + 3] = DF[i]
  }
  return { target, info, nWall }
}

/* ------------------------------------------------------------------ */
/* The chalk block: grains on the surface of a rounded brick           */
/* ------------------------------------------------------------------ */

/**
 * Block-local positions for `count` grains on the surface of the chalk block (xyz), w = the intro time at which
 * the grain leaves the block: `tImpact` for almost all of them; a few are shed earlier and hang in the air as
 * the powder trail of the throw.
 */
export function sampleBlock(count, tImpact, seed = 5) {
  return drain(blockSteps(count, tImpact, seed))
}

export function sampleBlockAsync(count, tImpact, seed = 5, signal) {
  return drainAsync(blockSteps(count, tImpact, seed), signal)
}

function* blockSteps(count, tImpact, seed) {
  const { hx, hy, hz, r } = BLOCK
  const a = hx - r
  const b = hy - r
  const c = hz - r
  const q = (Math.PI * r) / 2
  // surface patches with their areas: 6 faces, 12 quarter-cylinder edges (by axis), 8 sphere-octant corners
  const parts = [
    ['fx', 8 * b * c],
    ['fy', 8 * a * c],
    ['fz', 8 * a * b],
    ['ex', 4 * q * 2 * a],
    ['ey', 4 * q * 2 * b],
    ['ez', 4 * q * 2 * c],
    ['co', 4 * Math.PI * r * r],
  ]
  const total = parts.reduce((s, p) => s + p[1], 0)
  const cdf = []
  let acc = 0
  for (const [k, area] of parts) {
    acc += area / total
    cdf.push([k, acc])
  }
  const rand = rng(seed)
  const sgn = () => (rand() < 0.5 ? -1 : 1)
  const span = (e) => (rand() * 2 - 1) * e
  const out = new Float32Array(count * 4)
  yield
  for (let i = 0; i < count; i++) {
    if (i % CHUNK === CHUNK - 1) yield
    const u = rand()
    let kind = 'co'
    for (const [k, edge] of cdf) {
      if (u <= edge) {
        kind = k
        break
      }
    }
    let x = 0
    let y = 0
    let z = 0
    if (kind === 'fx') [x, y, z] = [sgn() * hx, span(b), span(c)]
    else if (kind === 'fy') [x, y, z] = [span(a), sgn() * hy, span(c)]
    else if (kind === 'fz') [x, y, z] = [span(a), span(b), sgn() * hz]
    else if (kind === 'co') {
      let dx = 0
      let dy = 0
      let dz = 0
      do {
        dx = rand()
        dy = rand()
        dz = rand()
      } while (dx * dx + dy * dy + dz * dz > 1 || dx * dx + dy * dy + dz * dz < 1e-3)
      const l = Math.hypot(dx, dy, dz)
      ;[x, y, z] = [sgn() * (a + (r * dx) / l), sgn() * (b + (r * dy) / l), sgn() * (c + (r * dz) / l)]
    } else {
      const t = rand() * Math.PI * 0.5
      const s1 = sgn()
      const s2 = sgn()
      if (kind === 'ex') [x, y, z] = [span(a), s1 * (b + r * Math.cos(t)), s2 * (c + r * Math.sin(t))]
      else if (kind === 'ey') [x, y, z] = [s1 * (a + r * Math.cos(t)), span(b), s2 * (c + r * Math.sin(t))]
      else [x, y, z] = [s1 * (a + r * Math.cos(t)), s2 * (b + r * Math.sin(t)), span(c)]
    }
    const k = i * 4
    out[k] = x
    out[k + 1] = y
    out[k + 2] = z
    // ~1 % of the powder is shed during the throw (the sim only lets go of grains on the trailing faces)
    // (late in the throw, when it is fast, so the powder streams after it like a comet tail)
    out[k + 3] = rand() < 0.013 ? tImpact * (0.6 + 0.36 * rand()) : tImpact
  }
  return out
}
