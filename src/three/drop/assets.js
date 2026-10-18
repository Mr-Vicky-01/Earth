import * as THREE from 'three'
import {
  PLATES,
  lampGeometry,
  plateHubGeometry,
  plateLabelGeometry,
  plateLayout,
  plateRubberGeometry,
  platformGeometry,
  shaftGeometry,
  sleeveGeometry,
  springCollarGeometry,
  labelOffset,
} from './parts'
import {
  blockWallTexturesGen,
  headlineTextureGen,
  knurlTexturesGen,
  noiseTextureGen,
  plateLabelGen,
  rubberTexturesGen,
  runSliced,
  spotCookieGen,
  woodTexturesGen,
} from './textures'
import { barFx, createBarUniforms, flareMaterial, knurlFx, motesGeometry, motesMaterial, puffGeometry, puffMaterial, rubberFx } from './fx'
import { WALL_H, WALL_W, ceilingGeometry, coveGeometry, floorFx, roomMaterials, roomProps, wallMaterial } from './room'

/**
 * Everything THE DROP needs before its first frame, built off the critical path: the procedural textures are
 * generators run in ≤ 6 ms slices (the page keeps painting and handling input while they build), cached per
 * quality level so a remount (or React's dev double-mount) never builds them twice; geometry and materials are
 * built in slices after them. The scene mounts only once this resolves, then compiles and warms everything
 * before the entrance (see DropScene).
 */

export const COLOURS = { heat: '#ff4b1f', cobalt: '#2236ff', paper: '#efeee9' }
const INK = { heat: '#f4f3ee', cobalt: '#f4f3ee', paper: '#16161e' }
export const HEADLINE = ['Move it', 'fast.']
// the pendant lamp hangs 0.7 m from a ceiling pivot and swings after a slam
export const LAMP_PIVOT = new THREE.Vector3(0.15, 5.1, 0.45)
export const LAMP_DROP = 0.7
export const SPOT_POS = LAMP_PIVOT.clone().add(new THREE.Vector3(0, -LAMP_DROP, 0))
export const SPOT_AIM = new THREE.Vector3(0, 0, -0.1)
export const SPOT_ANGLE = 0.38 // the cookie shapes the pool inside this cone
export const POOL = { halfX: 1.45, halfZ: 0.68, offZ: -0.16 } // barn-door slot of light on the floor (m)

const texCache = new Map()

/** The procedural textures for a quality level (built once, in slices; GPU copies are re-uploaded on reuse). */
function texturesFor(lite) {
  if (!texCache.has(lite)) texCache.set(lite, buildTextures(lite))
  return texCache.get(lite)
}

const mark = (k) => {
  if (import.meta.env.DEV) (window.__dropMarks ||= []).push([k, Math.round(performance.now())])
}

async function buildTextures(lite) {
  const S = async (g, k) => {
    const v = await runSliced(g)
    mark(k)
    return v
  }
  const t = {}
  t.knurl = await S(knurlTexturesGen({ lite }), 'knurl')
  t.wood = await S(woodTexturesGen({ lite }), 'wood')
  t.rubberTop = await S(rubberTexturesGen({ size: lite ? 256 : 512, seed: 9, base: 19 }), 'rubberTop')
  t.floor = await S(rubberTexturesGen({ size: lite ? 256 : 512, seams: true, seed: 21, base: 15 }), 'floor')
  t.block = await S(blockWallTexturesGen({ lite }), 'block')
  t.noise = await S(noiseTextureGen({ size: 256 }), 'noise')
  t.headline = await S(headlineTextureGen({ lines: HEADLINE, lite }), 'headline')
  t.cookie = await S(spotCookieGen({ angle: SPOT_ANGLE, height: SPOT_POS.distanceTo(SPOT_AIM), ...POOL, size: lite ? 128 : 256 }), 'cookie')
  t.labels = {}
  for (const spec of PLATES) {
    const { inner, outer } = plateLabelGeometry(spec)
    t.labels[spec.kg] = await S(
      plateLabelGen({ kg: spec.kg, ink: INK[spec.key], outerR: outer, innerR: inner, arcR: spec.kg === '5' ? null : outer - 0.0115, lite }),
      'label' + spec.kg,
    )
  }
  t.ao = aoTexture()
  // tiling
  const rep = (tex, x, y) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(x, y)
  }
  rep(t.floor.map, 40, 40)
  rep(t.floor.roughnessMap, 40, 40)
  rep(t.rubberTop.map, 1.2, 4.8)
  rep(t.rubberTop.roughnessMap, 1.2, 4.8)
  t.list = [
    t.knurl.map,
    t.knurl.roughnessMap,
    t.knurl.normalMap,
    t.wood.map,
    t.wood.roughnessMap,
    t.rubberTop.map,
    t.rubberTop.roughnessMap,
    t.floor.map,
    t.floor.roughnessMap,
    t.block.map,
    t.block.normalMap,
    t.block.roughnessMap,
    t.noise,
    t.headline.texture,
    t.cookie,
    t.ao,
    ...Object.values(t.labels),
  ]
  return t
}

function aoTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, 'rgb(255,255,255)')
  g.addColorStop(0.35, 'rgb(150,150,150)')
  g.addColorStop(1, 'rgb(0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.needsUpdate = true
  return t
}

const pause = () => runSliced((function* () {})())

/** Textures (cached) + this mount's geometry and materials. */
export async function buildAssets(lite) {
  const tx = await texturesFor(lite)
  await pause()
  mark('tex-done')
  const { knurl, wood, rubberTop, floor: floorTex, block, noise, headline, cookie } = tx
  const uniforms = createBarUniforms()

  const steel = (o = {}) =>
    new THREE.MeshStandardMaterial({
      color: '#d3d6de',
      metalness: 1,
      roughness: 0.3,
      envMapIntensity: 1,
      ...o,
    })
  const rubber = (key, spec) =>
    rubberFx(
      new THREE.MeshPhysicalMaterial({
        color: COLOURS[key],
        roughness: key === 'paper' ? 0.62 : 0.58,
        metalness: 0,
        sheen: key === 'cobalt' ? 0.1 : 0.2,
        sheenRoughness: 0.5,
        sheenColor: new THREE.Color(COLOURS[key]).lerp(new THREE.Color('#ffffff'), key === 'cobalt' ? 0.05 : 0.2),
        envMapIntensity: 0.3,
      }),
      { noise, radius: spec.R, lip: spec.lip, tint: 0.07 },
    )
  const spec = Object.fromEntries(PLATES.map((p) => [p.key, p]))
  const room = roomMaterials()
  rubberFx(room.kitRubber, { noise, kit: true })

  const mats = {
    shaft: knurlFx(
      barFx(
        new THREE.MeshStandardMaterial({
          color: '#cdd0d8',
          metalness: 1,
          roughness: 1,
          map: knurl.map,
          roughnessMap: knurl.roughnessMap,
          normalMap: knurl.normalMap,
          normalScale: new THREE.Vector2(0.7, 0.7),
          envMapIntensity: 1,
        }),
        uniforms,
        { bend: true },
      ),
    ),
    sleeve: steel({ roughness: 0.24, color: '#d8dbe2' }),
    hub: steel({ roughness: 0.2, color: '#dcdfe6' }),
    wire: steel({ roughness: 0.32 }),
    grip: new THREE.MeshStandardMaterial({ color: '#1c1c22', roughness: 0.55, envMapIntensity: 0.4 }),
    heat: rubber('heat', spec.heat),
    cobalt: rubber('cobalt', spec.cobalt),
    paper: rubber('paper', spec.paper),
    // satin varnish: a soft sheen in the pool of light, no mirror glare at the camera's grazing angle
    woodTop: new THREE.MeshStandardMaterial({ map: wood.map, roughnessMap: wood.roughnessMap, roughness: 1.35 }),
    woodEdge: new THREE.MeshStandardMaterial({ color: '#5e4128', roughness: 0.62, envMapIntensity: 0.3 }),
    rubberTop: new THREE.MeshStandardMaterial({ map: rubberTop.map, roughnessMap: rubberTop.roughnessMap, roughness: 1, envMapIntensity: 0.3 }),
    rubberEdge: new THREE.MeshStandardMaterial({ color: '#121216', roughness: 0.8, envMapIntensity: 0.25 }),
    frame: new THREE.MeshStandardMaterial({ color: '#202129', metalness: 0.75, roughness: 0.42, envMapIntensity: 0.6 }),
    floor: floorFx(
      new THREE.MeshStandardMaterial({ map: floorTex.map, roughnessMap: floorTex.roughnessMap, roughness: 1, color: '#b4b4ba', envMapIntensity: 0.12 }),
      noise,
    ),
    wall: wallMaterial({ block, headline: headline.texture, noise }),
    shade: new THREE.MeshStandardMaterial({ color: '#17181f', metalness: 0.7, roughness: 0.38, side: THREE.DoubleSide }),
    refl: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    lens: new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff4e4').multiplyScalar(14) }),
    lensRim: new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff1dc').multiplyScalar(24), side: THREE.DoubleSide }),
    cable: new THREE.MeshBasicMaterial({ color: '#040405' }),
    guard: new THREE.MeshStandardMaterial({ color: '#2a2b33', metalness: 0.6, roughness: 0.5 }),
    ao: new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, depthWrite: false, alphaMap: tx.ao, opacity: 0.85 }),
    kitAo: new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, depthWrite: false, alphaMap: tx.ao, opacity: 0.7 }),
    motes: motesMaterial(),
    puffs: [puffMaterial(noise), puffMaterial(noise)],
    flare: flareMaterial(),
    ...room,
  }
  const labels = {}
  for (const sp of PLATES) {
    labels[sp.kg] = new THREE.MeshStandardMaterial({
      map: tx.labels[sp.kg],
      transparent: true,
      roughness: 0.48,
      metalness: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      envMapIntensity: 0.3,
    })
  }
  await pause()

  const layout = plateLayout()
  const puffCount = lite ? 72 : 120
  const geo = {
    shaft: shaftGeometry(lite),
    sleeveR: sleeveGeometry(1, lite),
    plates: PLATES.map((sp) => ({
      spec: sp,
      rubber: plateRubberGeometry(sp, lite),
      hub: plateHubGeometry(sp, lite),
      label: plateLabelGeometry(sp).geometry,
      off: labelOffset(sp),
    })),
  }
  await pause()
  geo.collar = springCollarGeometry(lite)
  mark('collar')
  await pause()
  Object.assign(geo, {
    platform: platformGeometry(),
    lamp: lampGeometry(),
    motes: motesGeometry(lite ? 160 : 300),
    puffs: [puffGeometry(puffCount, 41), puffGeometry(puffCount, 42)],
    flare: new THREE.PlaneGeometry(1, 1),
    ao: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    floor: new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
    wall: new THREE.PlaneGeometry(WALL_W, WALL_H),
    cove: coveGeometry(),
    ceiling: ceilingGeometry(),
  })
  await pause()
  mark('misc')
  await pause()
  geo.props = roomProps()
  mark('props')
  await pause()
  return { uniforms, mats, labels, geo, layout, headline, cookie, noise, textures: tx.list }
}

export function disposeAssets(A) {
  for (const v of Object.values(A.mats)) (Array.isArray(v) ? v : [v]).forEach((m) => m.dispose())
  for (const m of Object.values(A.labels)) m.dispose()
  // GPU copies only: the cached canvases are re-uploaded if the scene mounts again
  A.textures.forEach((t) => t.dispose())
  const g = A.geo
  ;[g.shaft, g.sleeveR, g.collar.coil, g.collar.grips, g.flare, g.ao, g.floor, g.wall, g.cove, g.motes, ...g.puffs].forEach((x) => x.dispose())
  g.ceiling.deck.dispose()
  g.ceiling.joists.dispose()
  g.props.forEach((p) => p.parts.forEach((q) => q.geo.dispose()))
  g.plates.forEach((p) => [p.rubber, p.hub, p.label].forEach((x) => x.dispose()))
  Object.values(g.platform).forEach((x) => x?.dispose?.())
  Object.values(g.lamp).forEach((x) => x.dispose())
}
