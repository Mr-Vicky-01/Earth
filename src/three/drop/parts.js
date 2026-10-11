import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { PLATE_R } from './sim'
import { SHAFT_HALF } from './textures'

/**
 * Procedural geometry for THE DROP, in metres. Real IWF proportions:
 * 2.2 m men's bar, 28 mm shaft, 50 mm sleeves, 1310 mm between the inner collars, 415 mm sleeves;
 * 450 mm competition bumpers (25 kg, 20 kg) and a 5 kg change plate, a spring collar each side.
 * Lathe profiles are [radius, x] pairs along the bar axis, with a short bevel at every corner so the
 * shading stays crisp on the faces and catches a highlight on the edge.
 */

export const BAR_HALF = 1.1
export const COLLAR_IN = SHAFT_HALF // inner face of the inner collar
export const SLEEVE_R = 0.025

/** Lathe around the x axis. pts: [[r, x], …] ordered so the surface faces outward. */
export function latheX(pts, segments = 64) {
  const v = pts.map(([r, x]) => new THREE.Vector2(Math.max(r, 0.00005), x))
  const g = new THREE.LatheGeometry(v, segments)
  g.rotateZ(-Math.PI / 2)
  return g
}

/** Mirror a profile to the -x side (reverses the order so it still faces outward). */
const mirror = (pts) => pts.map(([r, x]) => [r, -x]).reverse()

/* ---------------- shaft: many rings along the length so it can whip ---------------- */
export function shaftGeometry(lite) {
  const pts = []
  const n = lite ? 90 : 140
  for (let i = 0; i <= n; i++) pts.push([0.014, -SHAFT_HALF + (i / n) * SHAFT_HALF * 2])
  return latheX(pts, lite ? 20 : 28)
}

/* ---------------- inner collar + sleeve + end cap (right side; mirrored for left) ---------------- */
function sleeveProfile() {
  const c0 = COLLAR_IN
  return [
    [0.0141, c0],
    [0.029, c0],
    [0.0322, c0 + 0.0006],
    [0.0336, c0 + 0.0024],
    [0.034, c0 + 0.005],
    [0.034, c0 + 0.025],
    [0.0336, c0 + 0.0276],
    [0.0322, c0 + 0.0294],
    [0.03, c0 + 0.03],
    [0.0262, c0 + 0.03],
    [0.0255, c0 + 0.0306],
    [0.0251, c0 + 0.033],
    [0.0251, 1.04],
    // two turned grooves near the end
    [0.0247, 1.0404],
    [0.0247, 1.0436],
    [0.0251, 1.044],
    [0.0251, 1.054],
    [0.0247, 1.0544],
    [0.0247, 1.0576],
    [0.0251, 1.058],
    [0.0251, 1.093],
    [0.0249, 1.0962],
    [0.0242, 1.0986],
    [0.023, 1.1],
    [0.0128, 1.1],
    [0.0121, 1.0994],
    [0.0116, 1.0975],
    [0.0001, 1.0975],
  ]
}
export function sleeveGeometry(side, lite) {
  const p = sleeveProfile()
  return latheX(side > 0 ? p : mirror(p), lite ? 36 : 56)
}

/* ---------------- bumper plates ---------------- */
export const PLATES = [
  // kg, colour key, outer radius, thickness, hub radius, lip width, sidewall bulge
  { kg: '25', key: 'heat', R: PLATE_R, t: 0.062, hubR: 0.066, lip: 0.03, bulge: 0.0016 },
  { kg: '20', key: 'cobalt', R: PLATE_R, t: 0.052, hubR: 0.066, lip: 0.03, bulge: 0.0014 },
  { kg: '5', key: 'paper', R: 0.1625, t: 0.03, hubR: 0.058, lip: 0.022, bulge: 0.0008 },
]
const GAP = 0.0012
/** Centre x of each plate on the right sleeve, plus where the collar goes. */
export function plateLayout() {
  let x = COLLAR_IN + 0.0306 + GAP
  const centres = PLATES.map((p) => {
    const c = x + p.t / 2
    x += p.t + GAP
    return c
  })
  return { centres, collarX: x + 0.0015 }
}

const RECESS = 0.0042

/** Rubber body: recessed faces, raised outer lip, rounded corners, slightly bulged sidewall. */
export function plateRubberGeometry(spec, lite) {
  const { R, t, hubR, lip, bulge } = spec
  const h = t / 2
  const b = 0.0045
  // starts just under the hub's protruding edge, so there is never a gap between rubber and steel
  const half = [
    [hubR - 0.0025, -h + RECESS],
    [R - lip - 0.01, -h + RECESS],
    [R - lip - 0.004, -h + RECESS * 0.55],
    [R - lip, -h + 0.0004],
    [R - lip + 0.003, -h],
    [R - b * 1.4, -h],
    [R - b * 0.62, -h + b * 0.18],
    [R - b * 0.15, -h + b * 0.62],
    [R, -h + b * 1.4],
  ]
  const side = []
  const n = 6
  for (let i = 1; i < n; i++) {
    const xx = -h + b * 1.4 + ((2 * (h - b * 1.4)) * i) / n
    const k = xx / (h - b * 1.4)
    side.push([R + bulge * (1 - k * k), xx])
  }
  const top = half.map(([r, x]) => [r, -x]).reverse()
  return latheX([...half, ...side, ...top], lite ? 64 : 96)
}

/** Steel hub insert: machined face standing proud of the rubber, chamfered bore. */
export function plateHubGeometry(spec, lite) {
  const { t, hubR } = spec
  const bore = 0.0254
  const f = t / 2 - RECESS + 0.0026 // face position
  const e = hubR - 0.0015
  const half = [
    [bore + 0.0002, -f + 0.0016],
    [bore + 0.0018, -f],
    [bore + 0.012, -f],
    [bore + 0.0128, -f - 0.0006], // a turned step in the face
    [bore + 0.0134, -f],
    [e - 0.004, -f],
    [e - 0.0012, -f + 0.0007],
    [e, -f + 0.0018],
  ]
  const top = half.map(([r, x]) => [r, -x]).reverse()
  // the bore runs back from +f to -f facing the axis
  return latheX([...half, ...top, [bore, f - 0.0016], [bore, -f + 0.0016]], lite ? 40 : 64)
}

/** Flat ring for the printed face (faces +x; rotate for -x). */
export function plateLabelGeometry(spec) {
  const inner = spec.hubR + 0.004
  const outer = spec.R - spec.lip - 0.002
  const g = new THREE.RingGeometry(inner, outer, 96, 1)
  g.rotateY(Math.PI / 2)
  return { geometry: g, inner, outer }
}
export const labelOffset = (spec) => spec.t / 2 - RECESS + 0.0003

/* ---------------- spring collar: a coiled wire with two handles and rubber grips ---------------- */
export function springCollarGeometry(lite) {
  const wire = 0.0031
  const rh = SLEEVE_R + wire + 0.0003
  const len = 0.03
  const turns = 3.15
  const a0 = -0.95 // start angle of the coil (handles point up and back)
  const pts = []
  const at = (ang, x, r) => new THREE.Vector3(x, Math.cos(ang) * r, Math.sin(ang) * r)
  const aEnd = a0 + turns * Math.PI * 2
  // handle A: tip → base
  pts.push(at(a0 - 0.32, len * 0.2, 0.088))
  pts.push(at(a0 - 0.18, len * 0.08, 0.066))
  pts.push(at(a0 - 0.06, 0.002, 0.042))
  const steps = 120
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    pts.push(at(a0 + u * turns * Math.PI * 2, 0.0035 + u * (len - 0.007), rh))
  }
  pts.push(at(aEnd + 0.06, len - 0.002, 0.042))
  pts.push(at(aEnd + 0.18, len * 0.92, 0.066))
  pts.push(at(aEnd + 0.32, len * 0.8, 0.088))
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
  const coil = new THREE.TubeGeometry(curve, lite ? 260 : 420, wire, lite ? 6 : 8, false)
  // grips over the two handle ends
  const grip = (ang, x) => {
    const g = new THREE.CylinderGeometry(0.0062, 0.0062, 0.03, 14, 1)
    // rounded ends
    const cap1 = new THREE.SphereGeometry(0.0062, 14, 8)
    cap1.translate(0, 0.015, 0)
    const cap2 = cap1.clone()
    cap2.translate(0, -0.03, 0)
    const merged = mergeSimple([g, cap1, cap2])
    // point radially outward from the bar axis at angle `ang`, centred ~78 mm out
    const m = new THREE.Matrix4()
    const dir = new THREE.Vector3(0, Math.cos(ang), Math.sin(ang))
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    m.compose(dir.clone().multiplyScalar(0.078).add(new THREE.Vector3(x, 0, 0)), q, new THREE.Vector3(1, 1, 1))
    merged.applyMatrix4(m)
    return merged
  }
  const grips = mergeSimple([grip(a0 - 0.27, len * 0.17), grip(aEnd + 0.27, len * 0.83)])
  return { coil, grips, length: len }
}

/** Minimal merge for non-indexed + indexed geometries with position/normal (uv dropped). */
function mergeSimple(list) {
  const pos = []
  const nor = []
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0
    pos.push(...g.attributes.position.array)
    nor.push(...g.attributes.normal.array)
    if (g !== g0) g.dispose()
    g0.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  return out
}

/* ---------------- platform: 2.4 × 2.4 m, oak centre, rubber sides, steel frame ---------------- */
export const PLATFORM = { size: 2.4, wood: 1.2, top: 0, thick: 0.04 }
export function platformGeometry() {
  const { size, wood, thick } = PLATFORM
  const side = (size - wood) / 2
  return {
    frame: new RoundedBoxGeometry(size + 0.05, thick - 0.006, size + 0.05, 2, 0.006),
    wood: new RoundedBoxGeometry(wood - 0.004, thick, size, 2, 0.0045),
    rubber: new RoundedBoxGeometry(side - 0.004, thick, size, 2, 0.006),
    woodTop: new THREE.PlaneGeometry(wood - 0.016, size - 0.012).rotateX(-Math.PI / 2),
    rubberTop: new THREE.PlaneGeometry(side - 0.018, size - 0.014).rotateX(-Math.PI / 2),
    side,
  }
}

/* ---------------- light fixture: industrial shade above the platform ---------------- */
// local frame: +y up, the opening faces -y; the lens sits 10 cm up inside the shade
export const LENS_Y = 0.1
export function lampGeometry() {
  const shade = latheX(
    [
      [0.2, -0.0],
      [0.207, 0.004],
      [0.208, 0.01],
      [0.2, 0.014],
      [0.12, 0.12],
      [0.06, 0.17],
      [0.03, 0.2],
      [0.02, 0.26],
      [0.0001, 0.26],
    ],
    48,
  )
  // lathe axis is x; stand it up so the opening faces down
  shade.rotateZ(Math.PI / 2)
  // inside of the shade: a spun reflector, brightest round the lens, falling off to the lip
  const refl = latheX(
    [
      [0.128, LENS_Y + 0.002],
      [0.15, 0.08],
      [0.175, 0.045],
      [0.196, 0.012],
    ],
    48,
  )
  refl.rotateZ(Math.PI / 2)
  const pos = refl.attributes.position
  const col = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const k = Math.pow(Math.min(1, Math.max(0, (y - 0.012) / (LENS_Y - 0.012))), 1.6)
    const v = 0.16 + 0.84 * k
    col[i * 3] = v
    col[i * 3 + 1] = v * 0.97
    col[i * 3 + 2] = v * 0.92
  }
  refl.setAttribute('color', new THREE.BufferAttribute(col, 3))
  const lens = new THREE.CircleGeometry(0.122, 48).rotateX(Math.PI / 2).translate(0, LENS_Y, 0)
  const rim = new THREE.RingGeometry(0.118, 0.13, 48, 1).rotateX(Math.PI / 2).translate(0, LENS_Y - 0.001, 0)
  const cable = new THREE.CylinderGeometry(0.006, 0.006, 6, 6).translate(0, 3.25, 0)
  // wire guard across the opening (a gym high-bay): two rings and four spokes, dark against the hot lens
  const parts = []
  for (const r of [0.09, 0.172]) parts.push(new THREE.TorusGeometry(r, 0.0052, 6, 64).rotateX(Math.PI / 2).translate(0, 0.012, 0))
  for (let i = 0; i < 4; i++) {
    const bar = new THREE.CylinderGeometry(0.0044, 0.0044, 0.4, 6).rotateZ(Math.PI / 2).rotateY((i * Math.PI) / 4)
    parts.push(bar.translate(0, 0.01, 0))
  }
  const guard = mergeSimple(parts)
  return { shade, refl, lens, rim, guard, cable }
}
