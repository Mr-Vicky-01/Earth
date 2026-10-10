import * as THREE from 'three'

/**
 * Procedural competition kettlebell (28 kg, which competition colour-coding makes orange). Units: bell radius = 1.
 * - Body: lathe of a sphere with a flat machined base; the upper half is slightly squashed toward the horns.
 * - Handle: one cast piece, a rounded "window" whose horns thicken into fillets where they meet the body.
 * - Front badge: "28 KG" plate on the lower front of the belly (canvas texture on a sphere patch).
 * Everything is built once; call `disposeKettlebell` on unmount.
 */
export const KB_BASE_Y = -0.9
export const KB_TOP_Y = 1.92
/** Shift that centres the whole object (base → top of handle) on the group origin. */
export const KB_CENTER_Y = (KB_BASE_Y + KB_TOP_Y) / 2

const SHOULDER = 0.9 // vertical squash of the upper hemisphere
const T_FOOT = Math.asin(-0.86) // where the sphere meets the flat base
const R_FOOT = Math.cos(T_FOOT)

function bellProfile() {
  const pts = []
  // flat base → small chamfer → sphere → squashed crown
  pts.push(new THREE.Vector2(0.0001, KB_BASE_Y))
  pts.push(new THREE.Vector2(R_FOOT * 0.55, KB_BASE_Y))
  pts.push(new THREE.Vector2(R_FOOT - 0.05, KB_BASE_Y))
  pts.push(new THREE.Vector2(R_FOOT - 0.012, KB_BASE_Y + 0.022))
  pts.push(new THREE.Vector2(R_FOOT, -0.86))
  const steps = 96
  for (let i = 1; i <= steps; i++) {
    const t = T_FOOT + (i / steps) * (Math.PI / 2 - T_FOOT)
    const x = Math.cos(t)
    const s = Math.sin(t)
    const y = s > 0 ? SHOULDER * Math.pow(s, 0.92) : s
    pts.push(new THREE.Vector2(Math.max(x, 0.0001), y))
  }
  return pts
}

/** Rounded-rectangle "window" handle, competition style: straight horns, flat top bar. */
function handleCurve() {
  const half = [
    [-0.47, 0.36],
    [-0.5, 0.6],
    [-0.535, 0.86],
    [-0.565, 1.16],
    [-0.57, 1.42],
    [-0.53, 1.64],
    [-0.4, 1.77],
    [-0.2, 1.81],
    [0, 1.815],
  ]
  const pts = [...half, ...half.slice(0, -1).reverse().map(([x, y]) => [-x, y])]
  return new THREE.CatmullRomCurve3(
    pts.map(([x, y]) => new THREE.Vector3(x, y, 0)),
    false,
    'centripetal',
  )
}

/** Tube whose radius varies along its length (TubeGeometry can't), with analytic ring normals. */
function variableTube(curve, segments, radial, radiusAt) {
  const frames = curve.computeFrenetFrames(segments, false)
  const pos = []
  const nor = []
  const uv = []
  const idx = []
  const P = new THREE.Vector3()
  const N = new THREE.Vector3()
  const M = new THREE.Vector3()
  const length = curve.getLength()
  for (let i = 0; i <= segments; i++) {
    const u = i / segments
    curve.getPointAt(u, P)
    const r = radiusAt(u)
    // slope of the radius along the tube (per unit length) tilts the normals so flares shade correctly
    const du = 1 / segments
    const slope = (radiusAt(Math.min(1, u + du)) - radiusAt(Math.max(0, u - du))) / ((Math.min(1, u + du) - Math.max(0, u - du)) * length)
    const n = frames.normals[i]
    const b = frames.binormals[i]
    const t = frames.tangents[i]
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2
      const s = Math.sin(v)
      const c = -Math.cos(v)
      N.set(c * n.x + s * b.x, c * n.y + s * b.y, c * n.z + s * b.z).normalize()
      pos.push(P.x + r * N.x, P.y + r * N.y, P.z + r * N.z)
      M.copy(N).addScaledVector(t, -slope).normalize()
      nor.push(M.x, M.y, M.z)
      uv.push(u, j / radial)
    }
  }
  for (let i = 1; i <= segments; i++) {
    for (let j = 1; j <= radial; j++) {
      const a = (radial + 1) * (i - 1) + (j - 1)
      const b2 = (radial + 1) * i + (j - 1)
      const c2 = (radial + 1) * i + j
      const d = (radial + 1) * (i - 1) + j
      idx.push(a, b2, d, b2, c2, d)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setIndex(idx)
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  return g
}

export function createKettlebellGeometry() {
  const body = new THREE.LatheGeometry(bellProfile(), 128)

  // thick competition handle (≈35 mm on a 210 mm bell) whose horns flare into cast fillets at the body
  const R = 0.15
  // the ends are buried inside the bell; the flare peaks there and fades out just above the surface
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)
  }
  const handle = variableTube(handleCurve(), 280, 40, (u) => {
    const d = Math.min(u, 1 - u)
    return R + 0.1 * (1 - smooth(0.05, 0.15, d))
  })

  // dark machined base ring hugging the chamfer
  const foot = new THREE.CylinderGeometry(R_FOOT + 0.012, R_FOOT - 0.03, 0.07, 128, 1, true)
  foot.translate(0, KB_BASE_Y + 0.035, 0)

  // badge patch on the lower front of the belly (pure sphere there, radius 1)
  const label = new THREE.SphereGeometry(1.006, 56, 28, Math.PI / 2 - 0.56, 1.12, 1.62, 0.6)

  return { body, handle, foot, label }
}

/** Front badge: skewed ink plate with "28 KG" and a small FORGE mark. Redrawn once the display font is ready. */
export function createLabelTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 512
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8

  const draw = () => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)
    // slanted ink plate (the site's -12° slant)
    ctx.save()
    ctx.translate(W / 2, H / 2)
    ctx.transform(1, 0, -0.21, 1, 0, 0)
    ctx.fillStyle = '#0a0a10'
    const pw = 700
    const ph = 330
    ctx.fillRect(-pw / 2, -ph / 2, pw, ph)
    ctx.restore()

    ctx.fillStyle = '#efeee9'
    ctx.textBaseline = 'alphabetic'
    ctx.font = 'italic 900 250px Archivo, "Arial Black", Impact, sans-serif'
    const num = '28'
    const nw = ctx.measureText(num).width
    ctx.font = 'italic 900 96px Archivo, "Arial Black", Impact, sans-serif'
    const kw = ctx.measureText('KG').width
    const gap = 22
    const x0 = (W - (nw + gap + kw)) / 2
    ctx.font = 'italic 900 250px Archivo, "Arial Black", Impact, sans-serif'
    ctx.fillText(num, x0, 340)
    ctx.font = 'italic 900 96px Archivo, "Arial Black", Impact, sans-serif'
    ctx.fillText('KG', x0 + nw + gap, 340)
    // small wordmark + heat bar
    ctx.font = 'italic 800 40px Archivo, "Arial Black", Impact, sans-serif'
    ctx.fillText('FORGE', x0 + nw + gap + 2, 236)
    ctx.save()
    ctx.translate(x0 + 6, 372)
    ctx.transform(1, 0, -0.21, 1, 0, 0)
    ctx.fillStyle = '#ff4b1f'
    ctx.fillRect(0, 0, nw + gap + kw - 6, 14)
    ctx.restore()
    tex.needsUpdate = true
  }
  draw()
  if (typeof document !== 'undefined' && document.fonts?.load) {
    Promise.all([document.fonts.load('italic 900 100px Archivo'), document.fonts.load('italic 800 40px Archivo')])
      .then(draw)
      .catch(() => {})
  }
  return tex
}

export function disposeKettlebell(geo, extra = []) {
  Object.values(geo).forEach((g) => g.dispose())
  extra.forEach((x) => x?.dispose?.())
}
