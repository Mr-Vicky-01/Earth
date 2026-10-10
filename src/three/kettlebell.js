import * as THREE from 'three'

/**
 * Procedural chrome kettlebell. Units: bell radius = 1.
 * Bell: lathe (flat base with a small chamfer, round belly, shoulders flattened toward the handle).
 * Handle: tube along a Catmull-Rom arch rising from both shoulders.
 * Everything is built once and shared; call `disposeKettlebell` on unmount.
 */
export const KB_BASE_Y = -0.9
export const KB_TOP_Y = 1.78
/** Shift that centres the whole object (base → top of handle) on the group origin. */
export const KB_CENTER_Y = (KB_BASE_Y + KB_TOP_Y) / 2

const SHOULDER = 0.9 // vertical squash of the upper hemisphere

function bellProfile() {
  const pts = []
  const yBase = KB_BASE_Y
  const tFoot = Math.asin(-0.86) // where the sphere meets the foot
  const rFoot = Math.cos(tFoot)
  // flat base → chamfer → sphere
  pts.push(new THREE.Vector2(0.0001, yBase))
  pts.push(new THREE.Vector2(rFoot * 0.55, yBase))
  pts.push(new THREE.Vector2(rFoot - 0.05, yBase))
  pts.push(new THREE.Vector2(rFoot - 0.012, yBase + 0.022))
  pts.push(new THREE.Vector2(rFoot, -0.86))
  const steps = 84
  for (let i = 1; i <= steps; i++) {
    const t = tFoot + (i / steps) * (Math.PI / 2 - tFoot)
    const x = Math.cos(t)
    const s = Math.sin(t)
    // upper half: squash and slightly flatten the crown so the handle sits on shoulders
    const y = s > 0 ? SHOULDER * Math.pow(s, 0.92) : s
    pts.push(new THREE.Vector2(Math.max(x, 0.0001), y))
  }
  return pts
}

function handleCurve() {
  const p = [
    [-0.56, 0.6],
    [-0.645, 0.95],
    [-0.64, 1.24],
    [-0.53, 1.48],
    [-0.29, 1.635],
    [0, 1.66],
    [0.29, 1.635],
    [0.53, 1.48],
    [0.64, 1.24],
    [0.645, 0.95],
    [0.56, 0.6],
  ]
  return new THREE.CatmullRomCurve3(
    p.map(([x, y]) => new THREE.Vector3(x, y, 0)),
    false,
    'centripetal',
  )
}

export function createKettlebellGeometry() {
  const body = new THREE.LatheGeometry(bellProfile(), 112)
  const handle = new THREE.TubeGeometry(handleCurve(), 200, 0.122, 36, false)

  // dark machined foot ring hugging the chamfer
  const tFoot = Math.asin(-0.86)
  const rFoot = Math.cos(tFoot)
  const foot = new THREE.CylinderGeometry(rFoot + 0.012, rFoot - 0.03, 0.07, 112, 1, true)
  foot.translate(0, KB_BASE_Y + 0.035, 0)

  // emissive heat band inlaid around the belly
  const band = new THREE.TorusGeometry(1.0, 0.017, 12, 200)
  band.rotateX(Math.PI / 2)
  band.translate(0, -0.06, 0)

  // curved label patch on the lower front of the belly (pure sphere there, radius 1)
  const label = new THREE.SphereGeometry(1.007, 48, 24, Math.PI / 2 - 0.62, 1.24, 1.8, 0.62)

  return { body, handle, foot, band, label }
}

/** "24 KG" mark as a transparent canvas texture (drawn again once the display font is ready). */
export function createLabelTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 320
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4

  const draw = () => {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#0d0e1c'
    ctx.textBaseline = 'alphabetic'
    try {
      ctx.fontStretch = 'semi-condensed'
    } catch {
      /* older canvas impls */
    }
    ctx.font = 'italic 900 230px Archivo, "Arial Black", Impact, sans-serif'
    const num = '24'
    const nw = ctx.measureText(num).width
    ctx.font = 'italic 900 92px Archivo, "Arial Black", Impact, sans-serif'
    const kw = ctx.measureText('KG').width
    const gap = 18
    const x0 = (canvas.width - (nw + gap + kw)) / 2
    ctx.font = 'italic 900 230px Archivo, "Arial Black", Impact, sans-serif'
    ctx.fillText(num, x0, 248)
    ctx.font = 'italic 900 92px Archivo, "Arial Black", Impact, sans-serif'
    ctx.fillText('KG', x0 + nw + gap, 248)
    // three speed bars under the mark
    ctx.save()
    ctx.translate(x0 + 8, 272)
    ctx.transform(1, 0, -0.21, 1, 0, 0)
    ctx.fillRect(0, 0, nw + gap + kw - 10, 9)
    ctx.restore()
    tex.needsUpdate = true
  }
  draw()
  if (typeof document !== 'undefined' && document.fonts?.load) {
    document.fonts
      .load('italic 900 100px Archivo')
      .then(draw)
      .catch(() => {})
  }
  return tex
}

export function disposeKettlebell(geo, extra = []) {
  Object.values(geo).forEach((g) => g.dispose())
  extra.forEach((x) => x?.dispose?.())
}
