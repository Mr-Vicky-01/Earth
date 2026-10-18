import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BLOCK_TILE } from './textures'
import { PLATES, latheX, plateHubGeometry, plateRubberGeometry } from './parts'

/**
 * The room around THE DROP: a painted concrete-block wall with the headline rolled onto it, the rubber floor,
 * the ceiling (seen on the scroll exit) and the gym's kit along the wall: a plate tree and a rig on the right,
 * bumper plates leaning on the wall, kettlebells and a med ball on the left. The kit is placed relative to the
 * painted headline per viewport and any piece that would cover a letter hides itself, so it stays secondary.
 * Lit only by the scene's real lights; softened by the lens effect's haze and depth of field.
 */

export const WALL_W = 36
export const WALL_H = 14
export const FLOOR_Y = -0.045
export const CEIL_Y = 5.6

/* ------------------------------------------------------------------ */
/* Wall: block texture + the painted headline in one material          */
/* ------------------------------------------------------------------ */
export function wallMaterial({ block, headline, noise }) {
  for (const t of [block.map, block.normalMap, block.roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(WALL_W / BLOCK_TILE, WALL_H / BLOCK_TILE)
  }
  const m = new THREE.MeshStandardMaterial({
    map: block.map,
    normalMap: block.normalMap,
    normalScale: new THREE.Vector2(1, 1),
    roughnessMap: block.roughnessMap,
    roughness: 1,
    metalness: 0,
  })
  const u = {
    uHead: { value: headline },
    uHeadO: { value: new THREE.Vector3() },
    uHeadR: { value: new THREE.Vector3(1, 0, 0) },
    uHeadW: { value: 1 },
    uHeadH: { value: 1 },
    uNoise: { value: noise },
    // two dim far fixtures beyond the frame edges (they light the dark corners)
    uWallN: { value: new THREE.Vector3(0, 0, 1) },
    uGlowP: { value: [new THREE.Vector3(0, -50, 0), new THREE.Vector3(0, -50, 0)] },
    uGlowC: { value: [new THREE.Color(0, 0, 0), new THREE.Color(0, 0, 0)] },
  }
  m.userData.u = u
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDropW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvDropW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uHead;
uniform vec3 uHeadO;
uniform vec3 uHeadR;
uniform float uHeadW;
uniform float uHeadH;
uniform sampler2D uNoise;
uniform vec3 uWallN;
uniform vec3 uGlowP[2];
uniform vec3 uGlowC[2];
varying vec3 vDropW;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// diffuse light from the two off-frame sources (inverse square, Lambert; softened by their size)
for ( int i = 0; i < 2; i++ ) {
  vec3 d = uGlowP[i] - vDropW;
  float r2 = dot( d, d );
  totalEmissiveRadiance += diffuseColor.rgb * uGlowC[i] * max( dot( uWallN, d ) * inversesqrt( r2 ), 0.0 ) / ( r2 + 0.08 );
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float dropCav = texture2D( roughnessMap, vRoughnessMapUv ).r;
vec2 dropHu = vec2( dot( vDropW - uHeadO, uHeadR ) / uHeadW, ( uHeadO.y - vDropW.y ) / uHeadH );
vec4 dropHead = vec4( 0.0 );
if ( dropHu.x > 0.0 && dropHu.x < 1.0 && dropHu.y > 0.0 && dropHu.y < 1.0 ) dropHead = texture2D( uHead, vec2( dropHu.x, 1.0 - dropHu.y ) );
// wear at room scale: patchy repaint, grime and plate scuffs low down, chalk smudges at hand height
float dropWu = dot( vDropW, uHeadR );
vec4 dropNA = texture2D( uNoise, vec2( dropWu, vDropW.y ) * 0.19 );
vec4 dropNB = texture2D( uNoise, vec2( dropWu * 0.8, vDropW.y * 6.0 ) * 0.3 );
float dropLow = 1.0 - smoothstep( 0.04, 0.6, vDropW.y );
float dropScuff = smoothstep( 0.62, 0.74, dropNB.g ) * smoothstep( 0.05, 0.1, vDropW.y ) * ( 1.0 - smoothstep( 0.3, 0.5, vDropW.y ) );
float dropGrime = dropLow * ( 0.22 + 0.3 * dropNA.b );
diffuseColor.rgb *= ( 0.86 + 0.28 * dropNA.r ) * ( 1.0 - dropGrime ) * ( 1.0 - 0.4 * dropScuff );
float dropChalk = smoothstep( 0.76, 0.86, dropNA.a ) * smoothstep( 0.85, 1.1, vDropW.y ) * ( 1.0 - smoothstep( 1.5, 1.9, vDropW.y ) );
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.42 ), dropChalk * 0.22 );
// the headline is paint on the same blocks: it runs into the joints (cavity AO) and wears with the wall
vec3 dropPaint = dropHead.rgb * ( 0.62 + 0.38 * dropCav ) * ( 1.0 - 0.55 * dropGrime ) * ( 1.0 - 0.3 * dropScuff );
diffuseColor.rgb = mix( diffuseColor.rgb, dropPaint, dropHead.a );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, 0.52 + 0.2 * ( 1.0 - dropCav ), dropHead.a );
roughnessFactor = mix( roughnessFactor, 0.9, dropGrime * 0.6 );`,
      )
  }
  m.customProgramCacheKey = () => 'drop-wall'
  return m
}

/** Points the wall shader at the headline rectangle (world space). */
export function placeHeadline(m, f) {
  const u = m.userData.u
  u.uHeadR.value.copy(f.right)
  u.uHeadW.value = f.typeWidth
  u.uHeadH.value = f.typeHeight
  u.uHeadO.value.copy(f.typeCenter).addScaledVector(f.right, -f.typeWidth / 2)
  u.uHeadO.value.y += f.typeHeight / 2
}

/* ------------------------------------------------------------------ */
/* Floor: rubber tiles with chalk dust round the platform and worn,    */
/* slightly shinier lanes; varies at room scale so it never tiles.     */
/* ------------------------------------------------------------------ */
export function floorFx(m, noise) {
  const u = { uNoise: { value: noise } }
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDropW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvDropW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uNoise;\nvarying vec3 vDropW;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
vec4 dropFA = texture2D( uNoise, vDropW.xz * 0.09 );
vec4 dropFB = texture2D( uNoise, vDropW.xz * 0.43 + 0.37 );
float dropNear = 1.0 - smoothstep( 1.4, 3.4, length( vDropW.xz * vec2( 0.8, 1.0 ) ) );
float dropDust = smoothstep( 0.5, 0.85, dropFA.g * 0.6 + dropFB.r * 0.5 ) * ( 0.35 + 0.65 * dropNear );
diffuseColor.rgb *= 0.78 + 0.44 * dropFA.r;
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.3 ), dropDust * 0.16 );`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, 0.5, smoothstep( 0.55, 0.85, dropFB.b ) * 0.55 );
roughnessFactor = mix( roughnessFactor, 0.95, dropDust * 0.5 );`,
      )
  }
  m.customProgramCacheKey = () => 'drop-floor'
  return m
}

/* ------------------------------------------------------------------ */
/* Kit along the wall                                                   */
/* ------------------------------------------------------------------ */
export function roomMaterials(envIntensity = 0.15) {
  return {
    powder: new THREE.MeshStandardMaterial({ color: '#2a2c33', roughness: 0.4, metalness: 0.2, envMapIntensity: envIntensity * 2 }),
    kitRubber: new THREE.MeshStandardMaterial({ color: '#161619', roughness: 0.72, envMapIntensity: envIntensity * 0.6 }),
    kitHub: new THREE.MeshStandardMaterial({ color: '#55585f', roughness: 0.62, metalness: 1, envMapIntensity: 0.08 }),
    iron: new THREE.MeshStandardMaterial({ color: '#1a1a1d', roughness: 0.52, metalness: 0.3, envMapIntensity: envIntensity }),
    ball: new THREE.MeshStandardMaterial({ color: '#26272c', roughness: 0.82, envMapIntensity: envIntensity * 0.5 }),
    cove: new THREE.MeshStandardMaterial({ color: '#0e0e11', roughness: 0.45, envMapIntensity: envIntensity }),
    ceiling: new THREE.MeshStandardMaterial({ color: '#17181c', roughness: 0.95 }),
    joist: new THREE.MeshStandardMaterial({ color: '#1d1e23', roughness: 0.6, metalness: 0.35, envMapIntensity: envIntensity }),
  }
}

const box = (w, h, d, x, y, z, r = 0.004) => {
  const g = new RoundedBoxGeometry(w, h, d, 1, r)
  g.translate(x, y, z)
  return g
}
const cyl = (r, len, axis, x, y, z, seg = 16) => {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1)
  if (axis === 'x') g.rotateZ(Math.PI / 2)
  if (axis === 'z') g.rotateX(Math.PI / 2)
  g.translate(x, y, z)
  return g
}
const merge = (list) => {
  // RoundedBox / Cylinder / Lathe share position+normal+uv; drop anything else so they merge
  const clean = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g
    for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k)
    if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2))
    return n
  })
  const out = mergeGeometries(clean, false)
  clean.forEach((g) => g.dispose())
  list.forEach((g) => g.dispose())
  return out
}

/** A bumper plate standing in the local x/y plane (face toward +z), centre at (x, y, z). */
function plateAt(spec, x, y, z, tilt = 0) {
  const r = plateRubberGeometry(spec, true)
  const h = plateHubGeometry(spec, true)
  for (const g of [r, h]) {
    // lathe axis is x: turn it to face +z, lean it back by `tilt`, place it
    g.rotateY(-Math.PI / 2)
    g.rotateX(-tilt)
    g.translate(x, y, z)
  }
  return { rubber: r, hub: h }
}

/**
 * Builds the kit in wall-local space (x along the wall = `right`, y up from the floor, z out of the wall toward
 * the camera). Every piece has a footprint [x0, x1, height, depth] so it can be hidden if it would cover a letter.
 */
export function roomProps() {
  const pieces = []
  const add = (name, side, footprint, parts) =>
    pieces.push({ name, side, footprint, parts: [...parts, { mat: 'kitAo', geo: aoBlob(footprint[0], footprint[1], footprint[3]), ao: true }] })
  const PLATE = PLATES[1] // 450 mm bumper

  // plate tree (right of the type): a post with two horns toward the room, a 20 and a 15 face-on
  {
    const post = [box(0.07, 1.22, 0.07, 0, 0.61, 0), box(0.5, 0.03, 0.5, 0, 0.015, 0, 0.006)]
    const horns = [cyl(0.025, 0.2, 'z', 0, 0.3, 0.12), cyl(0.025, 0.2, 'z', 0, 0.82, 0.12)]
    const p1 = plateAt(PLATE, 0, 0.3, 0.09)
    const p2 = plateAt({ ...PLATE, R: 0.2, t: 0.045 }, 0, 0.82, 0.08)
    add('tree', 'right', [-0.24, 0.24, 1.22, 0.5], [
      { mat: 'powder', geo: merge([...post, ...horns]) },
      { mat: 'kitRubber', geo: merge([p1.rubber, p2.rubber]) },
      { mat: 'kitHub', geo: merge([p1.hub, p2.hub]) },
    ])
  }
  // rig: two bays of uprights off the wall, crossmembers, a pull-up bar, J-cups
  {
    const s = []
    for (const x of [0, 1.22]) {
      s.push(box(0.075, 2.7, 0.075, x, 1.35, 0.72), box(0.075, 2.7, 0.075, x, 1.35, 0.08))
      s.push(box(0.075, 0.075, 0.72, x, 2.62, 0.4), box(0.075, 0.06, 0.72, x, 0.03, 0.4))
      s.push(box(0.05, 0.11, 0.09, x + (x ? -0.06 : 0.06), 1.32, 0.74))
    }
    s.push(cyl(0.016, 1.22, 'x', 0.61, 2.5, 0.72))
    s.push(box(1.22, 0.075, 0.075, 0.61, 2.62, 0.08))
    add('rig', 'right', [-0.04, 1.26, 2.7, 0.8], [{ mat: 'powder', geo: merge(s) }])
  }
  // three bumpers leaning on the wall (left of "FAST.", under "MOVE IT")
  {
    const r = []
    const h = []
    ;[0.1, 0.165, 0.23].forEach((z, i) => {
      const tilt = 0.2 - i * 0.03
      const p = plateAt({ ...PLATE }, i * 0.012, PLATE.R * Math.cos(tilt) + 0.002, z, tilt)
      r.push(p.rubber)
      h.push(p.hub)
    })
    add('lean', 'left', [-0.23, 0.25, 0.46, 0.28], [
      { mat: 'kitRubber', geo: merge(r) },
      { mat: 'kitHub', geo: merge(h) },
    ])
  }
  // med ball
  {
    const g = new THREE.SphereGeometry(0.17, 24, 16)
    g.translate(0, 0.17, 0.2)
    add('ball', 'left', [-0.17, 0.17, 0.34, 0.4], [{ mat: 'ball', geo: g }])
  }
  // two kettlebells
  {
    const kb = (x, s) => {
      const body = new THREE.SphereGeometry(0.105 * s, 20, 14)
      body.scale(1, 0.92, 1)
      body.translate(x, 0.1 * s, 0.22)
      const handle = new THREE.TorusGeometry(0.075 * s, 0.017 * s, 8, 20, Math.PI)
      handle.translate(x, 0.19 * s, 0.22)
      const posts = [cyl(0.017 * s, 0.06 * s, 'y', x - 0.075 * s, 0.17 * s, 0.22, 8), cyl(0.017 * s, 0.06 * s, 'y', x + 0.075 * s, 0.17 * s, 0.22, 8)]
      return [body, handle, ...posts]
    }
    add('kettlebells', 'left', [-0.12, 0.42, 0.3, 0.35], [{ mat: 'iron', geo: merge([...kb(0, 1), ...kb(0.3, 0.85)]) }])
  }
  return pieces
}

/**
 * Where each piece goes for this framing, and whether it may show (as seen from the camera). Low kit may stand in
 * front of the paint and cover the feet of the letters (up to 15 % of a line's height), the way a real gym's kit
 * sits against a painted wall; anything taller that would cover a letter stays out. The rig stands at the right
 * edge of the frame, partly out of it. `view`: the visible wall span (frame.js wallView).
 */
export function layoutProps(pieces, f, type, camPos) {
  const left = -f.typeWidth / 2
  const typeU0 = f.typeCenter.clone().sub(f.wallPoint).dot(f.right) + left
  const typeU1 = typeU0 + f.typeWidth
  const top = f.typeCenter.y + f.typeHeight / 2
  const rects = type.lines.map((ln) => {
    const y0 = top - ln.b * f.typeHeight
    const y1 = top - ln.t * f.typeHeight
    return {
      u0: typeU0 + ln.x0 * f.typeWidth - 0.03,
      u1: typeU0 + ln.x1 * f.typeWidth + 0.03,
      y0: y0 + 0.15 * (y1 - y0),
      y1: y1 + 0.03,
    }
  })
  // the camera, in wall coordinates, to project a piece standing off the wall back onto it
  const rel = camPos.clone().sub(f.wallPoint)
  const cu = rel.dot(f.right)
  const cd = rel.dot(f.n)
  const cy = camPos.y
  const view = f.wallView || { u0: typeU0 - 1, u1: typeU1 + 1 }
  const anchors = {
    tree: typeU1 + 0.34,
    rig: Math.max(typeU1 + 0.25, view.u1 - 0.42),
    lean: typeU0 + 0.36,
    ball: typeU0 + 0.78,
    kettlebells: typeU0 + 1.08,
  }
  // the tree only if it fits between the type and the rig
  if (anchors.rig - anchors.tree < 0.55) anchors.tree = anchors.rig - 0.62
  return pieces.map((p) => {
    const u = anchors[p.name]
    const [x0, x1, hgt, dep] = p.footprint
    const k = cd / Math.max(0.5, cd - dep)
    const pu0 = cu + (u + x0 - cu) * k
    const pu1 = cu + (u + x1 - cu) * k
    const py1 = cy + (hgt - cy) * k
    const hits = rects.some((r) => pu1 > r.u0 && pu0 < r.u1 && py1 > r.y0 && FLOOR_Y < r.y1)
    return { u, visible: !hits }
  })
}

/** A soft contact-shadow blob for a piece of kit: a floor quad in wall-local space. */
export function aoBlob(x0, x1, depth) {
  const w = x1 - x0 + 0.16
  const d = depth + 0.14
  const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2)
  g.translate((x0 + x1) / 2, 0.0015, d / 2 - 0.02)
  return g
}


/* ------------------------------------------------------------------ */
/* Ceiling: deck, steel joists running out from the wall, a duct.      */
/* Only the scroll exit looks up at it.                                */
/* ------------------------------------------------------------------ */
export function ceilingGeometry() {
  const deck = new THREE.PlaneGeometry(40, 40)
  deck.rotateX(Math.PI / 2)
  deck.translate(0, CEIL_Y, 8)
  const joists = []
  for (let i = -8; i <= 8; i++) joists.push(box(0.12, 0.42, 22, i * 1.6 + 0.3, CEIL_Y - 0.21, 9, 0.01))
  const duct = cyl(0.3, 30, 'x', 0, CEIL_Y - 0.75, 1.7, 24)
  return { deck, joists: merge([...joists, duct]) }
}

export function coveGeometry() {
  return box(WALL_W, 0.08, 0.014, 0, 0.04, 0.007, 0.003)
}

/** Lathe re-export so callers can build round kit without importing parts directly. */
export { latheX }
