import * as THREE from 'three'
import { layoutText, glyphPath2D, CAP_HEIGHT } from '../glyphs'
import { headlineLayout } from './frame.js'

/**
 * Procedural canvas textures for THE DROP: nothing is downloaded. Every builder is deterministic (seeded) so the
 * scene looks the same on every load, and sized down in lite mode.
 */

const PAPER = '#efeee9'
const HEAT = '#ff4b1f'

function makeCanvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/** Small seeded PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Tileable 2D value noise with period `p` (in lattice cells). Returns n(x, y) in 0..1. */
function valueNoise(seed, p) {
  const r = prng(seed)
  const grid = new Float32Array(p * p)
  for (let i = 0; i < grid.length; i++) grid[i] = r()
  return (x, y) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const xf = x - xi
    const yf = y - yi
    const x0 = ((xi % p) + p) % p
    const y0 = ((yi % p) + p) % p
    const x1 = (x0 + 1) % p
    const y1 = (y0 + 1) % p
    const u = xf * xf * (3 - 2 * xf)
    const v = yf * yf * (3 - 2 * yf)
    const a = grid[y0 * p + x0]
    const b = grid[y0 * p + x1]
    const c = grid[y1 * p + x0]
    const d = grid[y1 * p + x1]
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
  }
}

function fbm(noises, x, y) {
  let s = 0
  let amp = 0.5
  let f = 1
  let norm = 0
  for (let i = 0; i < noises.length; i++) {
    s += noises[i](x * f, y * f) * amp
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return s / norm
}

function finish(tex, { srgb = true, repeat = null, aniso = 8 } = {}) {
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(repeat[0], repeat[1])
  }
  tex.anisotropy = aniso
  tex.needsUpdate = true
  return tex
}

/* ------------------------------------------------------------------ */
/* Rubber: black EPDM with fine grey granules (platform sides, floor)  */
/* ------------------------------------------------------------------ */
export function rubberTextures({ size = 512, seams = false, seed = 7, base = 17 } = {}) {
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(size, size)
  const rough = makeCanvas(size, size)
  const rctx = rough.getContext('2d')
  const rimg = rctx.createImageData(size, size)
  const n1 = valueNoise(seed, 8)
  const n2 = valueNoise(seed + 1, 16)
  const n3 = valueNoise(seed + 2, 64)
  const rnd = prng(seed + 3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const cloud = fbm([n1, n2], u * 8, v * 8)
      const grain = n3(u * 64, v * 64)
      let l = base + (cloud - 0.5) * 7 + (grain - 0.5) * 5
      let rv = 200 + (cloud - 0.5) * 30
      const fleck = rnd()
      if (fleck > 0.986) {
        l += 22 + rnd() * 26
        rv -= 40
      } else if (fleck < 0.02) l -= 5
      const i = (y * size + x) * 4
      img.data[i] = l
      img.data[i + 1] = l
      img.data[i + 2] = l + 2
      img.data[i + 3] = 255
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = rv
      rimg.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  rctx.putImageData(rimg, 0, 0)
  if (seams) {
    // 1 m interlocking tiles: a dark seam on the tile edge (the texture repeats once per metre)
    ctx.fillStyle = 'rgba(0,0,0,0.75)'
    ctx.fillRect(0, 0, size, 2)
    ctx.fillRect(0, 0, 2, size)
    ctx.fillStyle = 'rgba(255,255,255,0.05)'
    ctx.fillRect(0, 2, size, 1)
    ctx.fillRect(2, 0, 1, size)
    rctx.fillStyle = 'rgb(255,255,255)'
    rctx.fillRect(0, 0, size, 2)
    rctx.fillRect(0, 0, 2, size)
  }
  return {
    map: finish(new THREE.CanvasTexture(c)),
    roughnessMap: finish(new THREE.CanvasTexture(rough), { srgb: false }),
  }
}

/* ------------------------------------------------------------------ */
/* Wood centre panel: oak boards front-to-back, satin varnish, FORGE   */
/* mark painted in front of the bar, chalk where the lifter stands.    */
/* Canvas top = far edge of the platform (-z), bottom = camera side.   */
/* ------------------------------------------------------------------ */
export function woodTextures({ lite = false } = {}) {
  const W = lite ? 512 : 768
  const H = W * 2
  const c = makeCanvas(W, H)
  const ctx = c.getContext('2d')
  const r = makeCanvas(W, H)
  const rctx = r.getContext('2d')
  const rnd = prng(31)
  const planks = 8
  const pw = W / planks
  rctx.fillStyle = 'rgb(118,118,118)'
  rctx.fillRect(0, 0, W, H)
  for (let p = 0; p < planks; p++) {
    const x0 = p * pw
    // a few boards per strip, butt-jointed at staggered lengths
    let y = -rnd() * H * 0.6
    while (y < H) {
      const len = H * (0.45 + rnd() * 0.5)
      const hue = 32 + rnd() * 6
      const sat = 15 + rnd() * 8
      const lit = 50 + rnd() * 11
      const g = ctx.createLinearGradient(0, y, 0, y + len)
      g.addColorStop(0, `hsl(${hue} ${sat}% ${lit}%)`)
      g.addColorStop(0.5, `hsl(${hue + 2} ${sat + 4}% ${lit + 4 + rnd() * 4}%)`)
      g.addColorStop(1, `hsl(${hue - 1} ${sat}% ${lit - 2}%)`)
      ctx.fillStyle = g
      ctx.fillRect(x0, y, pw, len)
      // grain: long wavy strokes along the board
      const lines = lite ? 22 : 34
      for (let k = 0; k < lines; k++) {
        const gx = x0 + rnd() * pw
        const amp = 1 + rnd() * 3.5
        const freq = 0.004 + rnd() * 0.01
        const ph = rnd() * 6.28
        const dark = rnd() < 0.7
        ctx.strokeStyle = dark ? `rgba(60,34,14,${0.08 + rnd() * 0.18})` : `rgba(255,226,180,${0.04 + rnd() * 0.07})`
        ctx.lineWidth = 0.6 + rnd() * (dark ? 2.2 : 1.4)
        ctx.beginPath()
        for (let s = 0; s <= 48; s++) {
          const yy = y + (len * s) / 48
          const xx = gx + Math.sin(yy * freq + ph) * amp + Math.sin(yy * freq * 3.1 + ph * 2) * amp * 0.3
          if (s === 0) ctx.moveTo(xx, yy)
          else ctx.lineTo(Math.min(x0 + pw - 1, Math.max(x0 + 1, xx)), yy)
        }
        ctx.stroke()
        // grain lines are slightly rougher than the varnish around them
        if (dark) {
          rctx.strokeStyle = 'rgba(170,170,170,0.25)'
          rctx.lineWidth = ctx.lineWidth
          rctx.stroke()
        }
      }
      // butt joint
      ctx.fillStyle = 'rgba(20,10,4,0.75)'
      ctx.fillRect(x0, y + len - 1, pw, 2)
      y += len
    }
    // seam between strips
    ctx.fillStyle = 'rgba(18,9,3,0.85)'
    ctx.fillRect(x0, 0, 1.5, H)
    ctx.fillStyle = 'rgba(255,220,170,0.08)'
    ctx.fillRect(x0 + 1.5, 0, 1, H)
  }

  // wear: the centre of the board, where lifters stand, is scuffed lighter and rougher
  const wear = ctx.createRadialGradient(W / 2, H * 0.5, 0, W / 2, H * 0.5, W * 0.55)
  wear.addColorStop(0, 'rgba(255,240,215,0.10)')
  wear.addColorStop(1, 'rgba(255,240,215,0)')
  ctx.fillStyle = wear
  ctx.fillRect(0, 0, W, H)

  // FORGE mark, painted on the camera side of the bar, plus the speed bars
  const s = W / 768
  const mark = 'FORGE'
  const capPx = 92 * s
  const { items, width } = layoutText(mark)
  const k = capPx / CAP_HEIGHT
  const tw = width * k
  const bars = 120 * s
  const total = tw + 26 * s + bars
  const mx = (W - total) / 2
  const my = H * 0.33
  ctx.save()
  ctx.fillStyle = 'rgba(239,238,233,0.86)'
  for (const it of items) {
    ctx.save()
    ctx.translate(mx + it.x * k, my)
    ctx.fill(glyphPath2D(it.glyph, capPx))
    ctx.restore()
  }
  // three slanted heat bars, the site's speed glyph
  ctx.fillStyle = 'rgba(255,75,31,0.92)'
  const bx = mx + tw + 26 * s
  const bh = capPx * 0.2
  const slant = Math.tan((12 * Math.PI) / 180)
  const bar = (x, y, w) => {
    ctx.beginPath()
    ctx.moveTo(x + bh * slant, y)
    ctx.lineTo(x + w + bh * slant, y)
    ctx.lineTo(x + w, y + bh)
    ctx.lineTo(x, y + bh)
    ctx.closePath()
    ctx.fill()
  }
  bar(bx, my - capPx, bars)
  bar(bx + bars * 0.3, my - capPx / 2 - bh / 2, bars * 0.7)
  bar(bx + bars * 0.6, my - bh, bars * 0.4)
  ctx.restore()
  // paint wear: knock flecks out of the mark
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 900 * s; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.4})`
    ctx.fillRect(mx - 10 + rnd() * (total + 20), my - capPx - 6 + rnd() * (capPx + 12), 1 + rnd() * 3 * s, 1 + rnd() * 2 * s)
  }
  ctx.restore()
  // the knocked-out flecks show bare wood again
  ctx.save()
  ctx.globalCompositeOperation = 'destination-over'
  ctx.fillStyle = 'hsl(30 40% 40%)'
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
  rctx.fillStyle = 'rgba(200,200,200,0.5)'
  rctx.fillRect(mx, my - capPx, total, capPx)

  // chalk: hand prints and foot scuffs behind the bar, a dusting all over
  ctx.save()
  for (let i = 0; i < 26; i++) {
    const cx = W * (0.25 + rnd() * 0.5)
    const cy = H * (0.28 + rnd() * 0.22)
    const rr = (14 + rnd() * 50) * s
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr)
    const a = 0.05 + rnd() * 0.09
    g.addColorStop(0, `rgba(245,244,238,${a})`)
    g.addColorStop(1, 'rgba(245,244,238,0)')
    ctx.fillStyle = g
    ctx.fillRect(cx - rr, cy - rr, rr * 2, rr * 2)
    rctx.fillStyle = `rgba(230,230,230,${a * 2.5})`
    rctx.beginPath()
    rctx.arc(cx, cy, rr * 0.7, 0, Math.PI * 2)
    rctx.fill()
  }
  for (let i = 0; i < 3000 * s; i++) {
    ctx.fillStyle = `rgba(240,238,230,${0.03 + rnd() * 0.06})`
    ctx.fillRect(rnd() * W, rnd() * H, 1, 1)
  }
  ctx.restore()

  return {
    map: finish(new THREE.CanvasTexture(c)),
    roughnessMap: finish(new THREE.CanvasTexture(r), { srgb: false }),
  }
}

/* ------------------------------------------------------------------ */
/* Shaft knurling: map + roughness + normal, u = around, v = along x.  */
/* ------------------------------------------------------------------ */
export const SHAFT_HALF = 0.655
export function knurlTextures({ lite = false } = {}) {
  const W = 64
  const H = lite ? 1024 : 2048
  const height = new Float32Array(W * H)
  const zone = new Float32Array(H)
  // knurl layout along the shaft (|x| in metres): centre knurl, smooth, main knurl with the two ring marks
  const knurled = (ax) =>
    ax < 0.06 ||
    (ax > 0.21 && ax < 0.638 && Math.abs(ax - 0.405) > 0.0035 && Math.abs(ax - 0.455) > 0.0035)
  for (let row = 0; row < H; row++) {
    const v = 1 - (row + 0.5) / H // flipY: canvas top row = v 1
    const x = -SHAFT_HALF + v * SHAFT_HALF * 2
    zone[row] = knurled(Math.abs(x)) ? 1 : 0
  }
  // soften the band edges by a couple of texels
  const soft = new Float32Array(H)
  for (let row = 0; row < H; row++) {
    let s = 0
    let n = 0
    for (let d = -2; d <= 2; d++) {
      const rr = row + d
      if (rr >= 0 && rr < H) {
        s += zone[rr]
        n++
      }
    }
    soft[row] = s / n
  }
  const around = 18 // diamonds around the bar
  const pitch = (H / (SHAFT_HALF * 2)) * 0.0042 // texels per diamond along the bar (4.2 mm)
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const a = (col / W) * around
      const b = row / pitch
      const d1 = Math.abs(((a + b) % 1) - 0.5)
      const d2 = Math.abs(((((a - b) % 1) + 1) % 1) - 0.5)
      const pyramid = Math.min(d1, d2) * 2 // 0 in the grooves, 1 on the diamond peaks
      height[row * W + col] = pyramid * soft[row]
    }
  }
  const mapC = makeCanvas(W, H)
  const roughC = makeCanvas(W, H)
  const normC = makeCanvas(W, H)
  const mctx = mapC.getContext('2d')
  const rctx = roughC.getContext('2d')
  const nctx = normC.getContext('2d')
  const mi = mctx.createImageData(W, H)
  const ri = rctx.createImageData(W, H)
  const ni = nctx.createImageData(W, H)
  const strength = 2.2
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const i = row * W + col
      const h = height[i]
      const z = soft[row]
      const hl = height[row * W + ((col + W - 1) % W)]
      const hr = height[row * W + ((col + 1) % W)]
      const hu = height[Math.max(0, row - 1) * W + col]
      const hd = height[Math.min(H - 1, row + 1) * W + col]
      let nx = (hl - hr) * strength
      let ny = (hd - hu) * strength
      const nz = 1
      const len = Math.hypot(nx, ny, nz)
      const o = i * 4
      ni.data[o] = ((nx / len) * 0.5 + 0.5) * 255
      ni.data[o + 1] = ((ny / len) * 0.5 + 0.5) * 255
      ni.data[o + 2] = ((nz / len) * 0.5 + 0.5) * 255
      ni.data[o + 3] = 255
      // grooves hold grime: knurled bands read a touch darker and duller than the polished shaft
      const m = 255 * (1 - z * (0.3 - h * 0.14))
      mi.data[o] = mi.data[o + 1] = mi.data[o + 2] = m
      mi.data[o + 3] = 255
      const rv = 255 * (0.26 + z * (0.3 - h * 0.12))
      ri.data[o] = ri.data[o + 1] = ri.data[o + 2] = rv
      ri.data[o + 3] = 255
    }
  }
  mctx.putImageData(mi, 0, 0)
  rctx.putImageData(ri, 0, 0)
  nctx.putImageData(ni, 0, 0)
  return {
    map: finish(new THREE.CanvasTexture(mapC)),
    roughnessMap: finish(new THREE.CanvasTexture(roughC), { srgb: false }),
    normalMap: finish(new THREE.CanvasTexture(normC), { srgb: false }),
  }
}

/* ------------------------------------------------------------------ */
/* Plate face print: weight, KG, FORGE, an arc of small type           */
/* Drawn for a ring decal; canvas centre = plate centre, edge = outerR */
/* ------------------------------------------------------------------ */
function drawLine(ctx, text, x, y, cap, { center = false, instance } = {}) {
  const { items, width } = layoutText(text, instance ? { instance } : undefined)
  const k = cap / CAP_HEIGHT
  const ox = center ? x - (width * k) / 2 : x
  for (const it of items) {
    ctx.save()
    ctx.translate(ox + it.x * k, y)
    ctx.fill(glyphPath2D(it.glyph, cap))
    ctx.restore()
  }
  return width * k
}

function drawArc(ctx, text, cx, cy, radius, cap, startAngle, tracking = 60) {
  const { items } = layoutText(text, { tracking })
  const k = cap / CAP_HEIGHT
  for (const it of items) {
    const adv = it.glyph.advance * k
    const mid = it.x * k + adv / 2
    const ang = startAngle + mid / radius
    ctx.save()
    ctx.translate(cx + Math.cos(ang) * radius, cy + Math.sin(ang) * radius)
    ctx.rotate(ang + Math.PI / 2)
    ctx.translate(-adv / 2, cap / 2)
    ctx.fill(glyphPath2D(it.glyph, cap))
    ctx.restore()
  }
}

/**
 * kg: '25' | '20' | '5'; ink: print colour; outerR/innerR/arcR: label ring radii in metres (arcR: centre line of
 * the arc type). Returns a CanvasTexture with alpha.
 */
export function plateLabel({ kg, ink = PAPER, outerR, innerR, arcR, lite = false }) {
  const S = lite ? 512 : 1024
  const c = makeCanvas(S, S)
  const ctx = c.getContext('2d')
  const half = S / 2
  const px = half / outerR // px per metre
  const inner = innerR * px
  ctx.fillStyle = ink
  ctx.strokeStyle = ink

  // fine rule just inside the raised rim and around the hub
  ctx.lineWidth = Math.max(1.5, S * 0.003)
  ctx.beginPath()
  ctx.arc(half, half, half - S * 0.012, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(half, half, inner + S * 0.016, 0, Math.PI * 2)
  ctx.stroke()

  // weight, big, above the hub; KG beside it
  const band = half - S * 0.03 - inner
  const big = band * (kg === '5' ? 0.62 : 0.58)
  const cy = half - inner - band * 0.5
  const numW = layoutText(kg).width * (big / CAP_HEIGHT)
  const kgCap = big * 0.34
  const kgW = layoutText('KG').width * (kgCap / CAP_HEIGHT)
  const gap = big * 0.12
  const x0 = half - (numW + gap + kgW) / 2
  drawLine(ctx, kg, x0, cy + big / 2, big)
  drawLine(ctx, 'KG', x0 + numW + gap, cy + big / 2, kgCap)

  // FORGE below the hub
  const brandCap = band * 0.27
  drawLine(ctx, 'FORGE', half, half + inner + band * 0.5 + brandCap / 2, brandCap, { center: true })

  // speed bars either side of the hub
  const slant = Math.tan((12 * Math.PI) / 180)
  const bh = band * 0.05
  const bw = band * 0.42
  for (const side of [-1, 1]) {
    const bx = side < 0 ? half - inner - band * 0.5 - bw / 2 : half + inner + band * 0.5 - bw / 2
    ;[1, 0.7, 0.4].forEach((f, i) => {
      const y = half - bh * 2.2 + i * bh * 1.6
      const x = bx + bw * (1 - f)
      ctx.beginPath()
      ctx.moveTo(x + bh * slant, y)
      ctx.lineTo(x + bw * f + bh * slant, y)
      ctx.lineTo(x + bw * f, y + bh)
      ctx.lineTo(x, y + bh)
      ctx.closePath()
      ctx.fill()
    })
  }

  // small type running round the outer band (visible past the smaller plate in front)
  if (arcR) {
    const R = arcR * px
    const cap = S * 0.024
    const words = `FORGE VELOCITY LAB  ${kg} KG  CALIBRATED  `
    drawArc(ctx, words + words, half, half, R, cap, -Math.PI * 0.98, 70)
  }

  const tex = new THREE.CanvasTexture(c)
  return finish(tex)
}

/* ------------------------------------------------------------------ */
/* Concrete wall (tileable)                                            */
/* ------------------------------------------------------------------ */
export function concreteTexture({ lite = false } = {}) {
  const S = lite ? 256 : 512
  const c = makeCanvas(S, S)
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(S, S)
  const n = [valueNoise(51, 4), valueNoise(52, 8), valueNoise(53, 16), valueNoise(54, 32)]
  const fine = valueNoise(55, 128)
  const rnd = prng(56)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S
      const v = y / S
      const f = fbm(n, u * 4, v * 4)
      const g = fine(u * 128, v * 128)
      let l = 44 + (f - 0.5) * 34 + (g - 0.5) * 10
      if (rnd() > 0.996) l -= 14 // pores
      const i = (y * S + x) * 4
      img.data[i] = l
      img.data[i + 1] = l + 1
      img.data[i + 2] = l + 5
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/* ------------------------------------------------------------------ */
/* Headline painted on the wall: "MOVE IT" flush left, "FAST." flush    */
/* right under it. Returns { texture, aspect, layout } (layout: the     */
/* shared metrics the framing solver uses, see frame.js).               */
/* ------------------------------------------------------------------ */
export function headlineTexture({ lines, lite = false }) {
  const W = lite ? 1536 : 2304
  const layout = headlineLayout(lines, layoutText, CAP_HEIGHT, { W })
  const H = layout.H
  const c = makeCanvas(W, H)
  const ctx = c.getContext('2d')
  const rnd = prng(77)
  for (const ln of layout.lines) {
    for (const it of ln.items) {
      ctx.save()
      ctx.translate(it.px, ln.base)
      // the full stop is the one heat mark on the wall
      ctx.fillStyle = it.char === '.' ? HEAT : PAPER
      ctx.fill(glyphPath2D(it.glyph, layout.cap))
      ctx.restore()
    }
  }
  // roller-painted on concrete: thin spots, pores and a few chips knocked out of the paint
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  const area = (W * H) / 1e6
  // fine pores
  for (let i = 0; i < 26000 * area; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.06 + rnd() * 0.22})`
    const s = 0.8 + rnd() * 1.6
    ctx.fillRect(rnd() * W, rnd() * H, s, s)
  }
  // roller streaks: long faint horizontal thinning
  for (let i = 0; i < 90 * area; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.06})`
    ctx.fillRect(rnd() * W, rnd() * H, 40 + rnd() * 220, 1 + rnd() * 3)
  }
  // a few small chips
  for (let i = 0; i < 22 * area; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.5 + rnd() * 0.4})`
    ctx.beginPath()
    ctx.ellipse(rnd() * W, rnd() * H, 1 + rnd() * 3, 0.6 + rnd() * 2, rnd() * 3, 0, Math.PI * 2)
    ctx.fill()
  }
  // the paint thins out toward the floor where mops and plates have scuffed it
  const g = ctx.createLinearGradient(0, H * 0.7, 0, H)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.22)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
  ctx.restore()
  const texture = finish(new THREE.CanvasTexture(c))
  return { texture, aspect: layout.aspect, layout }
}

/* ------------------------------------------------------------------ */
/* Spot cookie: the lamp has barn doors. A long, soft-edged slot of     */
/* light along the bar (both plate stacks lit) that stops short of the  */
/* near edge of the platform, so the floor under the copy stays dark.   */
/* u runs along world x, v along world z (shadow camera up = -z).       */
/* ------------------------------------------------------------------ */
export function spotCookie({ angle, height, halfX = 1.2, halfZ = 0.82, offZ = -0.12, size = 256 } = {}) {
  const c = makeCanvas(size, size)
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(size, size)
  const span = Math.tan(angle) * height // floor half-size covered by the texture
  const rnd = prng(91)
  const n = valueNoise(92, 8)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const wx = ((x + 0.5) / size) * 2 - 1
      const wz = ((y + 0.5) / size) * 2 - 1
      const fx = (wx * span) / halfX
      const fz = (wz * span - offZ) / halfZ
      // superellipse: squarer than a circle, like a beam cut by barn doors
      const r = Math.pow(Math.pow(Math.abs(fx), 3.2) + Math.pow(Math.abs(fz), 3.2), 1 / 3.2)
      let k = 1 - smoothstep(0.62, 1.0, r)
      // a slightly hotter core and a touch of lamp texture in the beam
      k *= 0.86 + 0.14 * (1 - smoothstep(0, 0.7, r))
      k *= 0.94 + 0.06 * n((x / size) * 8, (y / size) * 8) + (rnd() - 0.5) * 0.01
      const v = Math.max(0, Math.min(255, Math.round(255 * Math.pow(k, 1.1))))
      const i = (y * size + x) * 4
      img.data[i] = v
      img.data[i + 1] = v
      img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  t.needsUpdate = true
  return t
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
