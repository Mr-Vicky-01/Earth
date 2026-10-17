import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { EffectComposer, Bloom, ToneMapping, Vignette, Noise } from '@react-three/postprocessing'
import { ToneMappingMode, BlendFunction, EffectPass } from 'postprocessing'
import { PLATE_R } from './sim'
import { LIFT_MAX, followFor, liftUnder, pointOnBarPlane, poseCamera, solveFrame } from './frame.js'
import {
  PLATES,
  PLATFORM,
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
  blockWallTextures,
  headlineTexture,
  knurlTextures,
  noiseTexture,
  plateLabel,
  rubberTextures,
  spotCookie,
  woodTextures,
} from './textures'
import { barFx, createBarUniforms, flareMaterial, ghostMaterial, motesGeometry, motesMaterial, puffGeometry, puffMaterial } from './fx'
import { DropLensEffect } from './lens'
import {
  FLOOR_Y,
  WALL_H,
  WALL_W,
  ceilingGeometry,
  coveGeometry,
  floorFx,
  layoutProps,
  placeHeadline,
  roomMaterials,
  roomProps,
  wallMaterial,
} from './room'

/**
 * THE DROP: a gym in low light, one pendant lamp over a lifting platform, a loaded bar. The section owns the
 * physics and look state (`rig`, see sim.js); this scene reads the rig each frame and renders it. Framing
 * (camera, headline placement, lift range, crane follow) lives in frame.js so the pointer mapping uses the same
 * camera. Every shader and texture is compiled and uploaded before the first visible frame (see `warm`).
 */

const BG = '#0b0c10'
const COLOURS = { heat: '#ff4b1f', cobalt: '#2236ff', paper: '#efeee9' }
const INK = { heat: '#f4f3ee', cobalt: '#f4f3ee', paper: '#16161e' }
// the pendant lamp hangs 0.7 m from a ceiling pivot and swings after a slam
const LAMP_PIVOT = new THREE.Vector3(0.15, 5.1, 0.45)
const LAMP_DROP = 0.7
const SPOT_POS = LAMP_PIVOT.clone().add(new THREE.Vector3(0, -LAMP_DROP, 0))
const SPOT_AIM = new THREE.Vector3(0, 0, -0.1)
const SPOT_ANGLE = 0.38 // the cookie shapes the pool inside this cone
const POOL = { halfX: 1.45, halfZ: 0.68, offZ: -0.16 } // barn-door slot of light on the floor (m)
const SPOT_I = 140
const KEY_I = 440 // distant low wall wash from camera-left: lights the wall, throws the plates' shadows on "FAST."
const BOUNCE_I = 2.6 // the lit platform bounces warm light back up
const HEADLINE = ['Move it', 'fast.']
const SHADOWS = { enabled: true, type: THREE.PCFShadowMap }
const GHOST_ALPHA = [0.4, 0.32, 0.24, 0.16, 0.08]
const GHOSTS = GHOST_ALPHA.length
const SHUTTER = 0.9 / 60 // s: a 324° shutter at 60 fps
// haze (linear radiance units; tuned against the lights above)
const HAZE_SCATTER = 0.0105
const HAZE_SIGMA = 0.028
const HAZE_AMB = new THREE.Color(0.0046, 0.005, 0.0062)
const LAMP_COL = new THREE.Color('#f7f5f0')
const BOUNCE_COL = new THREE.Color('#ffcf9e')

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/* ------------------------------------------------------------------ */
/* Studio environment for the steel only (never lights the room)       */
/* ------------------------------------------------------------------ */
function buildEnv(gl) {
  const scene = new THREE.Scene()
  const mats = []
  const geos = []
  const add = (geo, color, k, pos, rot) => {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide })
    const mesh = new THREE.Mesh(geo, m)
    mesh.position.set(...pos)
    if (rot) mesh.rotation.set(...rot)
    scene.add(mesh)
    mats.push(m)
    geos.push(geo)
  }
  // dim room: mid slate so satin steel never reflects black
  add(new THREE.BoxGeometry(24, 12, 24), '#3a3d48', 0.55, [0, 3, 0])
  // overhead softbox (the lamp) → bright crown highlight along the bar
  add(new THREE.PlaneGeometry(5, 5), '#ffffff', 5.2, [0, 5.5, 0.6], [Math.PI / 2, 0, 0])
  // tall side strips → long highlights down the sleeves and plate hubs
  add(new THREE.PlaneGeometry(1.4, 8), '#ffffff', 2.6, [-7, 1.5, 2], [0, Math.PI / 2.4, 0])
  add(new THREE.PlaneGeometry(1.0, 8), '#e8ecff', 1.7, [7, 1.5, 1], [0, -Math.PI / 2.4, 0])
  // camera-side panel → the front of the shaft and collars read silver
  add(new THREE.PlaneGeometry(9, 2.4), '#f2f2f0', 1.1, [0, 1.2, 8], [0, Math.PI, 0])
  // warm floor bounce off the lit platform → undersides stay silver, a touch warm
  add(new THREE.PlaneGeometry(24, 24), '#d4cbbf', 0.7, [0, -2.5, 0], [-Math.PI / 2, 0, 0])
  // one warm accent, low behind-right
  add(new THREE.PlaneGeometry(1.2, 3), '#ff4b1f', 1.4, [5, 0.4, -5], [0, -Math.PI / 4, 0])
  const pmrem = new THREE.PMREMGenerator(gl)
  const rt = pmrem.fromScene(scene, 0.035)
  pmrem.dispose()
  mats.forEach((m) => m.dispose())
  geos.forEach((g) => g.dispose())
  return rt
}

/* ------------------------------------------------------------------ */
/* Everything in the room                                              */
/* ------------------------------------------------------------------ */
function useAssets(lite) {
  return useMemo(() => {
    const uniforms = createBarUniforms()
    const knurl = knurlTextures({ lite })
    const wood = woodTextures({ lite })
    const rubberTop = rubberTextures({ size: lite ? 256 : 512, seed: 9, base: 19 })
    const floorTex = rubberTextures({ size: lite ? 256 : 512, seams: true, seed: 21, base: 15 })
    floorTex.map.wrapS = floorTex.map.wrapT = THREE.RepeatWrapping
    floorTex.roughnessMap.wrapS = floorTex.roughnessMap.wrapT = THREE.RepeatWrapping
    floorTex.map.repeat.set(40, 40)
    floorTex.roughnessMap.repeat.set(40, 40)
    rubberTop.map.wrapS = rubberTop.map.wrapT = THREE.RepeatWrapping
    rubberTop.roughnessMap.wrapS = rubberTop.roughnessMap.wrapT = THREE.RepeatWrapping
    rubberTop.map.repeat.set(1.2, 4.8)
    rubberTop.roughnessMap.repeat.set(1.2, 4.8)
    const block = blockWallTextures({ lite })
    const noise = noiseTexture({ size: 256 })
    const headline = headlineTexture({ lines: HEADLINE, lite })
    const cookie = spotCookie({ angle: SPOT_ANGLE, height: SPOT_POS.distanceTo(SPOT_AIM), ...POOL, size: lite ? 128 : 256 })

    const steel = (o = {}) =>
      new THREE.MeshStandardMaterial({
        color: '#d3d6de',
        metalness: 1,
        roughness: 0.3,
        envMapIntensity: 1,
        ...o,
      })
    const rubber = (key) =>
      new THREE.MeshPhysicalMaterial({
        color: COLOURS[key],
        roughness: key === 'paper' ? 0.6 : 0.56,
        metalness: 0,
        sheen: key === 'cobalt' ? 0.1 : 0.2,
        sheenRoughness: 0.5,
        sheenColor: new THREE.Color(COLOURS[key]).lerp(new THREE.Color('#ffffff'), key === 'cobalt' ? 0.05 : 0.2),
        envMapIntensity: 0.3,
      })

    const mats = {
      shaft: barFx(
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
      sleeve: steel({ roughness: 0.24, color: '#d8dbe2' }),
      hub: steel({ roughness: 0.2, color: '#dcdfe6' }),
      wire: steel({ roughness: 0.32 }),
      grip: new THREE.MeshStandardMaterial({ color: '#1c1c22', roughness: 0.55, envMapIntensity: 0.4 }),
      heat: rubber('heat'),
      cobalt: rubber('cobalt'),
      paper: rubber('paper'),
      // satin varnish: a soft sheen in the pool of light, no mirror glare at the camera's grazing angle
      woodTop: new THREE.MeshStandardMaterial({
        map: wood.map,
        roughnessMap: wood.roughnessMap,
        roughness: 1.35,
      }),
      woodEdge: new THREE.MeshStandardMaterial({ color: '#5e4128', roughness: 0.62, envMapIntensity: 0.3 }),
      rubberTop: new THREE.MeshStandardMaterial({
        map: rubberTop.map,
        roughnessMap: rubberTop.roughnessMap,
        roughness: 1,
        envMapIntensity: 0.3,
      }),
      rubberEdge: new THREE.MeshStandardMaterial({ color: '#121216', roughness: 0.8, envMapIntensity: 0.25 }),
      frame: new THREE.MeshStandardMaterial({ color: '#202129', metalness: 0.75, roughness: 0.42, envMapIntensity: 0.6 }),
      floor: floorFx(
        new THREE.MeshStandardMaterial({
          map: floorTex.map,
          roughnessMap: floorTex.roughnessMap,
          roughness: 1,
          color: '#b4b4ba',
          envMapIntensity: 0.12,
        }),
        noise,
      ),
      wall: wallMaterial({ block, headline: headline.texture, noise }),
      shade: new THREE.MeshStandardMaterial({ color: '#17181f', metalness: 0.7, roughness: 0.38, side: THREE.DoubleSide }),
      refl: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      lens: new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff4e4').multiplyScalar(14) }),
      lensRim: new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff1dc').multiplyScalar(24), side: THREE.DoubleSide }),
      cable: new THREE.MeshBasicMaterial({ color: '#040405' }),
      guard: new THREE.MeshStandardMaterial({ color: '#2a2b33', metalness: 0.6, roughness: 0.5 }),
      ao: new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, depthWrite: false, alphaMap: aoTexture(), opacity: 0.85 }),
      motes: motesMaterial(),
      puffs: [puffMaterial(noise), puffMaterial(noise)],
      ghosts: PLATES.map((p) => ghostMaterial(new THREE.Color(COLOURS[p.key]).multiplyScalar(0.55))),
      flare: flareMaterial(),
      ...roomMaterials(),
    }
    // printed faces, one texture per plate size
    const labels = {}
    for (const spec of PLATES) {
      const { inner, outer } = plateLabelGeometry(spec)
      const map = plateLabel({
        kg: spec.kg,
        ink: INK[spec.key],
        outerR: outer,
        innerR: inner,
        arcR: spec.kg === '5' ? null : outer - 0.0115,
        lite,
      })
      labels[spec.kg] = new THREE.MeshStandardMaterial({
        map,
        transparent: true,
        roughness: 0.48,
        metalness: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        envMapIntensity: 0.3,
      })
    }

    const layout = plateLayout()
    const puffCount = lite ? 26 : 44
    const geo = {
      shaft: shaftGeometry(lite),
      sleeveR: sleeveGeometry(1, lite),
      plates: PLATES.map((spec) => ({
        spec,
        rubber: plateRubberGeometry(spec, lite),
        hub: plateHubGeometry(spec, lite),
        label: plateLabelGeometry(spec).geometry,
        off: labelOffset(spec),
      })),
      collar: springCollarGeometry(lite),
      platform: platformGeometry(),
      lamp: lampGeometry(),
      motes: motesGeometry(lite ? 160 : 300),
      puffs: [puffGeometry(puffCount, 41), puffGeometry(puffCount, 42)],
      // shutter trails: low-res copies of the plate bodies with a per-instance alpha (two sides × GHOSTS echoes)
      ghosts: PLATES.map((spec) => {
        const g = plateRubberGeometry(spec, true)
        const a = new Float32Array(2 * GHOSTS)
        for (let k = 0; k < 2 * GHOSTS; k++) a[k] = GHOST_ALPHA[k % GHOSTS]
        g.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(a, 1))
        return g
      }),
      flare: new THREE.PlaneGeometry(1, 1),
      ao: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      floor: new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
      wall: new THREE.PlaneGeometry(WALL_W, WALL_H),
      cove: coveGeometry(),
      ceiling: ceilingGeometry(),
      props: roomProps(),
    }
    const textures = [
      knurl.map,
      knurl.roughnessMap,
      knurl.normalMap,
      wood.map,
      wood.roughnessMap,
      rubberTop.map,
      rubberTop.roughnessMap,
      floorTex.map,
      floorTex.roughnessMap,
      block.map,
      block.normalMap,
      block.roughnessMap,
      noise,
      headline.texture,
      cookie,
      mats.ao.alphaMap,
      ...Object.values(labels).map((m) => m.map),
    ]
    return { uniforms, mats, labels, geo, layout, headline, cookie, noise, textures }
  }, [lite])
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

function disposeAssets(A) {
  for (const v of Object.values(A.mats)) (Array.isArray(v) ? v : [v]).forEach((m) => m.dispose())
  for (const m of Object.values(A.labels)) m.dispose()
  A.textures.forEach((t) => t.dispose())
  const g = A.geo
  ;[g.shaft, g.sleeveR, g.collar.coil, g.collar.grips, g.flare, g.ao, g.floor, g.wall, g.cove, g.motes, ...g.puffs, ...g.ghosts].forEach((x) =>
    x.dispose(),
  )
  g.ceiling.deck.dispose()
  g.ceiling.joists.dispose()
  g.props.forEach((p) => p.parts.forEach((q) => q.geo.dispose()))
  g.plates.forEach((p) => [p.rubber, p.hub, p.label].forEach((x) => x.dispose()))
  Object.values(g.platform).forEach((x) => x?.dispose?.())
  Object.values(g.lamp).forEach((x) => x.dispose())
}

/* ------------------------------------------------------------------ */
function World({ rig, lite, reduced, onWarm, composerRef, lens }) {
  const { gl, camera, scene, size } = useThree()
  const A = useAssets(lite)
  const { mats, labels, geo, layout, uniforms } = A

  // env map for reflective surfaces only (the room is lit by real lights)
  useEffect(() => {
    const rt = buildEnv(gl)
    const list = [
      mats.shaft,
      mats.sleeve,
      mats.hub,
      mats.wire,
      mats.grip,
      mats.heat,
      mats.cobalt,
      mats.paper,
      mats.frame,
      mats.shade,
      mats.powder,
      mats.rubber,
      mats.iron,
      mats.cove,
      mats.joist,
      mats.ball,
      ...Object.values(labels),
    ]
    list.forEach((m) => {
      m.envMap = rt.texture
      m.needsUpdate = true
    })
    return () => {
      list.forEach((m) => {
        m.envMap = null
        m.needsUpdate = true
      })
      rt.dispose()
    }
  }, [gl, mats, labels])
  useEffect(() => () => disposeAssets(A), [A])

  const r = useRef({})
  const R = r.current
  const set = (k) => (el) => {
    R[k] = el
  }
  const plateRefs = useRef([])
  const rubberRefs = useRef([])
  const propRefs = useRef([])

  const F = useRef({ w: 0, h: 0, ver: -1, f: null, grab: { x: -1, y: -1, l: -1, a: 9, t: -1, on: null } })
  const tmp = useMemo(
    () => ({
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      c: new THREE.Vector3(),
      look: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      exitPos: new THREE.Vector3(),
      exitLook: new THREE.Vector3(),
      hit: new THREE.Vector3(),
      bar: new THREE.Vector3(),
      m: new THREE.Matrix4(),
      t: new THREE.Matrix4(),
      eu: new THREE.Euler(),
      sq: new THREE.Quaternion(),
      lampQ: new THREE.Quaternion(),
      lampPos: new THREE.Vector3(),
      axis: new THREE.Vector3(),
      lx: new THREE.Vector3(),
      ly: new THREE.Vector3(),
      up: new THREE.Vector3(0, 0, -1),
      keyDir: new THREE.Vector3(),
      col: new THREE.Color(),
      aimRel: SPOT_AIM.clone().sub(SPOT_POS),
      pose: { dolly: 1, follow: 0, px: 0, py: 0, lean: 1 },
      follow: 0,
      frames: 0,
      dt: 0,
    }),
    [],
  )
  const baseConeQ = useMemo(() => {
    const d = SPOT_AIM.clone().sub(SPOT_POS).normalize()
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), d)
  }, [])

  // pointer → lift, through the live camera (the section calls these while dragging)
  useEffect(() => {
    const local = (cx, cy) => {
      const f = F.current.f
      const rect = gl.domElement.getBoundingClientRect()
      if (!f || !rect.width) return null
      return { f, sx: ((cx - rect.left) / rect.width) * f.w, sy: ((cy - rect.top) / rect.height) * f.h }
    }
    const pose = () => {
      const s = tmp.pose
      s.dolly = rig.dolly
      s.follow = tmp.follow
      s.px = rig.lx
      s.py = rig.ly
      s.lean = reduced ? 0 : 1
      return s
    }
    // where on the bar the pointer pressed: world x along the bar, height above the bar's axis
    rig.pick = (cx, cy) => {
      const L = local(cx, cy)
      if (!L || !pointOnBarPlane(L.f, pose(), L.sx, L.sy, rig.z, tmp.hit)) return null
      return { gx: clamp(tmp.hit.x, -1.1, 1.1), gy: clamp(tmp.hit.y - (PLATE_R + rig.y), -0.3, 0.3) }
    }
    // the lift that puts that grabbed point under the pointer, with the camera posed for that lift
    rig.liftAt = (cx, cy, g) => {
      const L = local(cx, cy)
      if (!L || !g) return rig.target
      const s = { ...pose(), followOn: !reduced }
      return liftUnder(L.f, s, L.sy, g.gx, g.gy, rig.z, 0, rig.maxLift)
    }
    return () => {
      rig.pick = null
      rig.liftAt = null
    }
  }, [rig, gl, tmp, reduced])

  useEffect(() => {
    // cookie orientation: u along world x, v along world -z
    if (R.spot) R.spot.shadow.camera.up.set(0, 0, -1)
    mats.motes.uniforms.uSlot.value.set(POOL.halfX / SPOT_POS.y, POOL.halfZ / SPOT_POS.y)
    for (const m of mats.puffs) m.uniforms.uSlot.value.set(POOL.halfX / SPOT_POS.y, POOL.halfZ / SPOT_POS.y)
  }, [mats, R])

  /* ---------- framing: only on resize / layout change ---------- */
  const frameFor = (w, h) => {
    const fr = F.current
    const band = rig.band && rig.band.h === h ? rig.band : null
    const ver = band ? band.ver : -1
    if (fr.w === w && fr.h === h && fr.ver === ver && fr.f) return fr.f
    fr.w = w
    fr.h = h
    fr.ver = ver
    fr.f = solveFrame(w, h, A.headline.layout, band)
    const f = fr.f
    rig.frame = f
    rig.maxLift = reduced ? f.maxLiftStill : LIFT_MAX
    rig.cleanTop = reduced ? Math.min(LIFT_MAX, f.maxLiftStill) : LIFT_MAX
    // just above the top of the frame (entrance pose): the drop is seen from its first centimetre
    rig.dropFrom = f.dropFrom
    if (rig.mode === 'hold') rig.y = f.dropFrom
    // wall with the painted headline, square to the camera
    if (R.wall) {
      R.wall.position.set(f.wallPoint.x, FLOOR_Y + WALL_H / 2, f.wallPoint.z)
      R.wall.rotation.set(0, f.wallYaw, 0)
    }
    placeHeadline(mats.wall, f)
    // the kit along the wall, placed from the headline; anything that would cover a letter stays out
    if (R.room) {
      R.room.position.set(f.wallPoint.x, FLOOR_Y, f.wallPoint.z)
      R.room.rotation.set(0, f.wallYaw, 0)
    }
    const spots = layoutProps(geo.props, f, A.headline.layout, f.pos)
    spots.forEach((s, i) => {
      const g = propRefs.current[i]
      if (!g) return
      g.position.set(s.u, 0, 0)
      g.visible = s.visible
    })
    // key light: far out in front-left at plate height, so the plates' shadows land across "FAST."
    if (R.key) {
      R.key.position.copy(f.typeCenter).addScaledVector(f.n, 11.2).addScaledVector(f.right, -2.6)
      R.key.position.y = 1.15
      R.key.target.position.copy(f.typeCenter)
      R.key.target.position.y -= f.typeHeight * 0.12
      R.key.target.updateMatrixWorld()
      tmp.keyDir.copy(R.key.position).sub(f.target).normalize()
      for (const m of mats.puffs) m.uniforms.uKeyDir.value.copy(tmp.keyDir)
    }
    if (R.rim) {
      R.rim.position.copy(f.target).addScaledVector(f.n, -2.1).addScaledVector(f.right, 0.6)
      R.rim.position.y = 1.15
      R.rim.target.position.set(0, PLATE_R, 0)
      R.rim.target.updateMatrixWorld()
    }
    // particles fade where the HTML copy sits (NDC rectangle)
    const cb = band && band.blocks && band.blocks[0]
    for (const m of mats.puffs) {
      if (cb) m.uniforms.uCopy.value.set((cb.x0 / w) * 2 - 1, 1 - ((cb.y1 ?? h) / h) * 2, (cb.x1 / w) * 2 - 1, 1 - (cb.y0 / h) * 2)
      else m.uniforms.uCopy.value.set(9, 9, 9, 9)
    }
    fr.grab.l = -1
    return f
  }

  /* ---------- per-frame: pose everything from the rig ---------- */
  const drive = (t, w, h, dpr) => {
    const f = frameFor(w, h)

    /* ---------- bar ---------- */
    const ex = reduced ? 0 : rig.exit
    const exitLift = 2.45 * smooth(0.03, 0.45, ex)
    const lift = rig.y + exitLift
    const barY = PLATE_R + lift
    // overhead the bar drifts forward under the lamp, so it crosses the light as the camera looks up
    const barZ = rig.z + 0.42 * smooth(0.12, 0.45, ex)
    tmp.bar.set(0, barY, barZ)
    if (R.barPos) R.barPos.position.copy(tmp.bar)
    if (R.barRot) R.barRot.rotation.x = rig.spin
    uniforms.uBend.value = rig.bend
    const vy = rig.vy
    const pr = plateRefs.current
    for (let i = 0; i < pr.length; i++) {
      const g = pr[i]
      if (!g) continue
      const p = rig.plates[i]
      g.rotation.set(p.spin, p.ry, p.rz)
    }
    // shutter trails: echoes spread over speed × shutter time, trailing the motion
    const sp = Math.abs(vy)
    const gAmt = reduced ? 0 : smooth(0.7, 1.8, sp)
    const ghostsOn = gAmt > 0.01 && ex < 0.02
    for (let k = 0; k < 3; k++) {
      const gm = R[`ghost${k}`]
      if (gm) gm.visible = ghostsOn
    }
    if (ghostsOn && R.barPos) {
      R.barPos.updateMatrixWorld(true)
      const step = ((sp * SHUTTER) / GHOSTS) * (vy >= 0 ? -1 : 1)
      const rr = rubberRefs.current
      for (let k = 0; k < 3; k++) {
        const gm = R[`ghost${k}`]
        if (!gm) continue
        mats.ghosts[k].uniforms.uAmt.value = gAmt
        for (let side = 0; side < 2; side++) {
          const src = rr[side * 3 + k]
          if (!src) continue
          for (let e = 0; e < GHOSTS; e++) {
            tmp.t.makeTranslation(0, step * (e + 1), 0)
            tmp.m.multiplyMatrices(tmp.t, src.matrixWorld)
            gm.setMatrixAt(side * GHOSTS + e, tmp.m)
          }
        }
        gm.instanceMatrix.needsUpdate = true
      }
    }
    // contact shadows fade as the bar leaves the floor
    if (R.ao) {
      const o = clamp(1 - lift / 0.35, 0, 1)
      mats.ao.opacity = 0.78 * o
      R.ao.visible = o > 0.01
      R.ao.position.z = rig.z
    }

    /* ---------- lamp: hangs from a pivot, swings after a slam ---------- */
    const sx = reduced ? 0 : rig.swingX
    const sz = reduced ? 0 : rig.swingZ
    tmp.eu.set(sz, 0, -sx)
    tmp.sq.setFromEuler(tmp.eu)
    tmp.lampPos.set(0, -LAMP_DROP, 0).applyQuaternion(tmp.sq).add(LAMP_PIVOT)
    tmp.axis.copy(tmp.aimRel).applyQuaternion(tmp.sq)
    tmp.lampQ.multiplyQuaternions(tmp.sq, baseConeQ)
    if (R.lamp) {
      R.lamp.position.copy(tmp.lampPos)
      R.lamp.quaternion.copy(tmp.lampQ)
    }
    if (R.spot) {
      R.spot.position.copy(tmp.lampPos)
      R.spot.target.position.copy(tmp.lampPos).add(tmp.axis)
      R.spot.target.updateMatrixWorld()
    }
    tmp.axis.normalize()
    // the cookie's frame, exactly as three's spot shadow camera builds it (up = -z)
    tmp.c.copy(tmp.axis).negate()
    tmp.lx.crossVectors(tmp.up, tmp.c).normalize()
    tmp.ly.crossVectors(tmp.c, tmp.lx)
    const toFloor = tmp.lampPos.y / Math.max(0.2, -tmp.axis.y)
    if (R.bounce) R.bounce.position.set(tmp.lampPos.x + tmp.axis.x * toFloor, 0.32, tmp.lampPos.z + tmp.axis.z * toFloor + POOL.offZ)

    /* ---------- light ---------- */
    const dark = 1 - smooth(0.55, 0.75, ex)
    const L = rig.light * dark
    const wallK = rig.wall * dark * (1 - smooth(0.08, 0.3, ex))
    if (R.spot) R.spot.intensity = SPOT_I * L
    if (R.key) R.key.intensity = KEY_I * wallK
    if (R.rim) R.rim.intensity = 7 * L
    if (R.bounce) R.bounce.intensity = BOUNCE_I * L
    if (R.hemi) R.hemi.intensity = (0.04 + 0.12 * L) * (0.6 + 0.4 * rig.wall)
    mats.lens.color.setRGB(14 * L + 0.02, 13.2 * L + 0.02, 12.4 * L + 0.02)
    mats.lensRim.color.setRGB(24 * L + 0.02, 22.5 * L + 0.02, 20.5 * L + 0.02)
    mats.refl.color.setScalar(0.06 + 1.5 * L)
    const beams = [mats.motes, ...mats.puffs]
    for (const m of beams) {
      const u = m.uniforms
      u.uLampPos.value.copy(tmp.lampPos)
      u.uLampX.value.copy(tmp.lx)
      u.uLampY.value.copy(tmp.ly)
      u.uLampAxis.value.copy(tmp.axis)
    }
    const mu = mats.motes.uniforms
    mu.uTime.value = reduced ? 3 : t
    mu.uLight.value = L
    mu.uPx.value = h * dpr * 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    // chalk cloud: lit like chalk (albedo ≈ 0.85) by the lamp inside the beam, the wall wash and the room
    for (let k = 0; k < 2; k++) {
      const b = rig.bursts[k]
      const pu = mats.puffs[k].uniforms
      const age = rig.time - b.t
      const on = !reduced && b.e > 0 && age >= 0 && age < 6
      pu.uT.value = on ? age : -1
      pu.uE.value = b.e
      pu.uZ.value = b.z
      pu.uLamp.value.copy(LAMP_COL).multiplyScalar((0.85 / Math.PI) * ((SPOT_I * L) / (SPOT_POS.y * SPOT_POS.y)))
      pu.uKey.value.setRGB(0.93, 0.95, 1).multiplyScalar((0.85 / Math.PI) * ((KEY_I * wallK) / 125) * 0.7)
      pu.uAmb.value.setRGB(0.012, 0.013, 0.016).multiplyScalar(0.4 + 0.6 * L)
      if (R[`puff${k}`]) R[`puff${k}`].visible = on
    }

    /* ---------- camera ---------- */
    // crane follow: only while a person lifts the bar (and while it falls back from that lift), as a pure
    // function of its height: 0 during the entrance, exactly 0 again by the time the plates hit the floor
    const want = !reduced && rig.lifted && rig.mode !== 'hold' ? followFor(Math.min(rig.y, LIFT_MAX + 0.15), f) : 0
    tmp.follow += (want - tmp.follow) * (1 - Math.exp(-tmp.dt * 40))
    if (Math.abs(tmp.follow) < 1e-5) tmp.follow = 0
    const ps = tmp.pose
    ps.dolly = rig.dolly
    ps.follow = tmp.follow
    ps.px = rig.lx
    ps.py = rig.ly
    ps.lean = reduced ? 0 : 1
    const P = tmp.pos
    const Look = tmp.look
    let fov = poseCamera(f, ps, P, Look)
    if (!reduced) {
      // handheld: a slow drift of a few millimetres from incommensurate low-frequency sines (all < 0.12 Hz)
      P.x += (Math.sin(t * 0.31 + 0.4) * 0.6 + Math.sin(t * 0.53 + 2.1) * 0.4) * 0.004
      P.y += (Math.sin(t * 0.41 + 1.3) * 0.6 + Math.sin(t * 0.67 + 0.2) * 0.4) * 0.003
      Look.x += Math.sin(t * 0.23 + 0.9) * 0.003
      Look.y += Math.sin(t * 0.29) * 0.0025
    }
    // scroll exit: drop under the bar and tilt up to the lamp as it passes overhead
    if (ex > 0) {
      tmp.exitPos.set(f.pos.x * 0.15, 0.3, 0.6)
      tmp.exitLook.set(0.05, 3.6, -0.3)
      P.lerp(tmp.exitPos, smooth(0.0, 0.5, ex))
      Look.lerp(tmp.exitLook, smooth(0.03, 0.55, ex))
    }
    // the slam shakes the tripod: the camera mount is a damped spring in the sim, driven by the floor's force
    if (!reduced) {
      P.x += rig.cam[0]
      P.y += rig.cam[1]
    }
    camera.position.copy(P)
    camera.lookAt(Look)
    if (!reduced) camera.rotateZ(rig.cam[2] + Math.sin(t * 0.19 + 0.6) * 0.0005)
    fov += 10 * smooth(0, 0.5, ex)
    if (camera.fov !== fov) camera.fov = fov
    const vo = 1 - smooth(0.0, 0.4, ex)
    camera.setViewOffset(w, h, f.offX * vo, f.offY * vo, w, h)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    /* ---------- lens: haze + depth of field ---------- */
    if (lens) {
      const U = lens.uniforms
      U.get('uCam').value.copy(camera.position)
      U.get('uInvProj').value.copy(camera.projectionMatrixInverse)
      U.get('uCamWorld').value.copy(camera.matrixWorld)
      U.get('uLampPos').value.copy(tmp.lampPos)
      U.get('uLampX').value.copy(tmp.lx)
      U.get('uLampY').value.copy(tmp.ly)
      U.get('uLampAxis').value.copy(tmp.axis)
      U.get('uLampTan').value = Math.tan(SPOT_ANGLE)
      U.get('uLampCol').value.set(LAMP_COL.r, LAMP_COL.g, LAMP_COL.b).multiplyScalar((SPOT_I * L * HAZE_SCATTER) / (4 * Math.PI))
      if (R.bounce) U.get('uBouncePos').value.copy(R.bounce.position)
      U.get('uBounceCol').value.set(BOUNCE_COL.r, BOUNCE_COL.g, BOUNCE_COL.b).multiplyScalar(0.0042 * L)
      U.get('uAmb').value.set(HAZE_AMB.r, HAZE_AMB.g, HAZE_AMB.b).multiplyScalar(0.35 + 0.65 * Math.max(L, wallK))
      U.get('uSigma').value = HAZE_SIGMA
      U.get('uTime').value = reduced ? 5 : t
      U.get('uFrame').value = reduced ? 0 : (U.get('uFrame').value + 1) % 64
      // focus on the bar (rack focus follows it overhead on the exit)
      U.get('uFocus').value = camera.position.distanceTo(tmp.bar)
      const px = h * dpr
      U.get('uCocK').value = 10.5 * (px / 900)
      U.get('uCocMax').value = 6 * (px / 900)
    }

    /* ---------- flare on the lamp ---------- */
    if (R.flare) {
      const amt = reduced ? 0 : smooth(0.22, 0.36, ex) * (1 - smooth(0.5, 0.64, ex)) * rig.light
      mats.flare.uniforms.uAmt.value = amt * 1.4
      R.flare.visible = amt > 0.002
      R.flare.scale.set(6.5, 1.6, 1)
    }

    /* ---------- grab zone over the bar (screen space, for the cursor + taps) ---------- */
    const el = rig.grabEl
    if (el) {
      const on = ex < 0.03 && rig.mode !== 'hold'
      const gz = F.current.grab
      if (on !== gz.on) {
        gz.on = on
        el.style.visibility = on ? 'visible' : 'hidden'
      }
      if (on) {
        const pa = tmp.a.set(-0.96, barY, barZ).project(camera)
        const pb = tmp.b.set(0.96, barY, barZ).project(camera)
        const ax = ((pa.x + 1) / 2) * w
        const ay = ((1 - pa.y) / 2) * h
        const bx = ((pb.x + 1) / 2) * w
        const by = ((1 - pb.y) / 2) * h
        // plate radius on screen at each end, and where the plate stacks give way to the shaft
        const rA = Math.abs(((1 - tmp.c.set(-0.77, barY + PLATE_R, barZ).project(camera).y) / 2) * h - ay)
        const rB = Math.abs(((1 - tmp.c.set(0.77, barY + PLATE_R, barZ).project(camera).y) / 2) * h - by)
        const ia = tmp.c.set(-0.64, barY, barZ).project(camera)
        const la = Math.hypot(((ia.x + 1) / 2) * w - ax, ((1 - ia.y) / 2) * h - ay)
        const ib = tmp.c.set(0.64, barY, barZ).project(camera)
        const lb = Math.hypot(bx - ((ib.x + 1) / 2) * w, by - ((1 - ib.y) / 2) * h)
        const hA = Math.max(48, rA * 2.16)
        const hB = Math.max(48, rB * 2.16)
        const th = Math.max(hA, hB)
        const len = Math.hypot(bx - ax, by - ay)
        const ang = Math.atan2(by - ay, bx - ax)
        if (Math.abs(ax - gz.x) > 0.6 || Math.abs(ay - gz.y) > 0.6 || Math.abs(len - gz.l) > 0.6 || Math.abs(th - gz.t) > 0.6) {
          gz.x = ax
          gz.y = ay
          gz.l = len
          gz.a = ang
          gz.t = th
          el.style.width = `${len.toFixed(1)}px`
          el.style.height = `${th.toFixed(1)}px`
          el.style.transform = `translate(${ax.toFixed(1)}px, ${(ay - th / 2).toFixed(1)}px) rotate(${ang.toFixed(4)}rad)`
          // full height over the plates, a 96 px band along the shaft
          const c = th / 2
          const hs = Math.min(96, hA, hB) / 2
          const p = (x, y) => `${x.toFixed(1)}px ${y.toFixed(1)}px`
          el.style.clipPath = `polygon(${[
            p(0, c - hA / 2),
            p(la, c - hA / 2),
            p(la + 18, c - hs),
            p(len - lb - 18, c - hs),
            p(len - lb, c - hB / 2),
            p(len, c - hB / 2),
            p(len, c + hB / 2),
            p(len - lb, c + hB / 2),
            p(len - lb - 18, c + hs),
            p(la + 18, c + hs),
            p(la, c + hA / 2),
            p(0, c + hA / 2),
          ].join(', ')})`
        }
      }
    }
  }

  useFrame((state, delta) => {
    gl.info.reset()
    tmp.dt = Math.min(delta, 1 / 20)
    drive(state.clock.elapsedTime, size.width, size.height, state.viewport.dpr)
    tmp.frames += 1
  })

  /* ---------- warm-up: compile every program, upload every texture, render once, then go ---------- */
  useEffect(() => {
    let dead = false
    let id = 0
    gl.info.autoReset = false
    const start = performance.now()
    const run = async () => {
      const comp = composerRef.current
      const ready = comp && comp.passes.some((p) => p instanceof EffectPass)
      if (!ready && performance.now() - start < 4000) {
        id = setTimeout(run, 20)
        return
      }
      // pose the scene as the first frame will see it (dark, bar above the frame)
      drive(0, size.width, size.height, gl.getPixelRatio())
      // compile against the composer's input target, so the variants match what will render
      const prev = gl.getRenderTarget()
      if (comp) gl.setRenderTarget(comp.inputBuffer)
      try {
        await gl.compileAsync(scene, camera)
      } catch {
        /* compile errors surface on the warm render */
      }
      gl.setRenderTarget(prev)
      if (dead) return
      for (const tex of A.textures) gl.initTexture(tex)
      // a dark warm frame: shadow maps, post passes and any lazily built state, before anything moves
      if (comp) comp.render(0)
      else gl.render(scene, camera)
      if (dead) return
      if (import.meta.env.DEV) rig.warmMs = Math.round(performance.now() - start)
      onWarm?.()
    }
    run()
    return () => {
      dead = true
      clearTimeout(id)
    }
    // the assets are fixed per mount; size changes re-pose on the next frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [A])

  // dev-only probes for the virtual-clock captures
  useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__dropProbe = () => ({
      camX: +camera.position.x.toFixed(5),
      camY: +camera.position.y.toFixed(5),
      camZ: +camera.position.z.toFixed(5),
      fov: +camera.fov.toFixed(4),
      barY: R.barPos ? +R.barPos.position.y.toFixed(5) : null,
      barZ: R.barPos ? +R.barPos.position.z.toFixed(5) : null,
      spot: R.spot ? +R.spot.intensity.toFixed(3) : null,
      key: R.key ? +R.key.intensity.toFixed(3) : null,
      exit: +rig.exit.toFixed(5),
      bend: +rig.bend.toFixed(5),
    })
    window.__dropInfo = () => ({
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      points: gl.info.render.points,
      programs: gl.info.programs?.length,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      passes: composerRef.current ? composerRef.current.passes.map((p) => p.name) : null,
      dpr: gl.getPixelRatio(),
      size: [size.width, size.height],
    })
    return () => {
      delete window.__dropProbe
      delete window.__dropInfo
    }
  }, [gl, camera, rig, R, size, composerRef])

  const P = geo.platform
  const plateNodes = []
  ;[-1, 1].forEach((side) => {
    geo.plates.forEach((pg, i) => {
      const idx = (side < 0 ? 0 : 3) + i
      const x = side * layout.centres[i]
      plateNodes.push(
        <group
          key={`${side}-${i}`}
          position={[x, 0, 0]}
          rotation-order="ZYX"
          ref={(el) => {
            plateRefs.current[idx] = el
          }}
        >
          <group rotation-y={side < 0 ? Math.PI : 0}>
            <mesh
              geometry={pg.rubber}
              material={mats[pg.spec.key]}
              castShadow
              receiveShadow
              ref={(el) => {
                rubberRefs.current[idx] = el
              }}
            />
            <mesh geometry={pg.hub} material={mats.hub} castShadow receiveShadow />
            <mesh geometry={pg.label} material={labels[pg.spec.kg]} position-x={pg.off} receiveShadow renderOrder={2} />
            <mesh
              geometry={pg.label}
              material={labels[pg.spec.kg]}
              position-x={-pg.off}
              rotation-y={Math.PI}
              receiveShadow
              renderOrder={2}
            />
          </group>
        </group>,
      )
    })
  })

  return (
    <>
      {/* ---------------- lights ---------------- */}
      <hemisphereLight ref={set('hemi')} args={['#3a3d4c', '#0a0908', 0.05]} />
      <spotLight
        ref={set('spot')}
        position={SPOT_POS.toArray()}
        angle={SPOT_ANGLE}
        penumbra={0.2}
        decay={2}
        distance={0}
        color="#f7f5f0"
        intensity={0}
        map={A.cookie}
        castShadow
        shadow-mapSize={lite ? [1024, 1024] : [2048, 2048]}
        shadow-bias={-0.00012}
        shadow-normalBias={0.012}
        shadow-radius={lite ? 3 : 5}
        shadow-camera-near={1.8}
        shadow-camera-far={7}
      >
        <object3D attach="target" position={SPOT_AIM.toArray()} />
      </spotLight>
      <spotLight
        ref={set('key')}
        angle={0.24}
        penumbra={1}
        decay={2}
        distance={0}
        color="#eff1f6"
        intensity={0}
        castShadow={!lite}
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0002}
        shadow-normalBias={0.02}
        shadow-radius={4}
        shadow-intensity={0.5}
        shadow-camera-near={6}
        shadow-camera-far={16}
      >
        <object3D attach="target" />
      </spotLight>
      <spotLight ref={set('rim')} angle={0.7} penumbra={0.8} decay={2} distance={0} color="#cdd6ff" intensity={0}>
        <object3D attach="target" />
      </spotLight>
      <pointLight ref={set('bounce')} color="#ffd2a6" decay={2} distance={0} intensity={0} position={[0, 0.32, -0.26]} />

      {/* ---------------- room ---------------- */}
      <mesh geometry={geo.floor} material={mats.floor} position-y={FLOOR_Y} receiveShadow />
      <mesh ref={set('wall')} geometry={geo.wall} material={mats.wall} receiveShadow />
      <group ref={set('room')}>
        <mesh geometry={geo.cove} material={mats.cove} />
        <mesh geometry={geo.ceiling.deck} material={mats.ceiling} />
        <mesh geometry={geo.ceiling.joists} material={mats.joist} />
        {geo.props.map((p, i) => (
          <group
            key={p.name}
            ref={(el) => {
              propRefs.current[i] = el
            }}
          >
            {p.parts.map((q, j) => (
              <mesh key={j} geometry={q.geo} material={mats[q.mat]} />
            ))}
          </group>
        ))}
      </group>

      {/* platform: steel frame, oak centre, rubber sides (plates land on the rubber) */}
      <group>
        <mesh geometry={P.frame} material={mats.frame} position-y={-PLATFORM.thick / 2 - 0.006} receiveShadow />
        <mesh geometry={P.wood} material={mats.woodEdge} position-y={-PLATFORM.thick / 2} receiveShadow />
        <mesh geometry={P.woodTop} material={mats.woodTop} position-y={0.0004} receiveShadow />
        {[-1, 1].map((sd) => (
          <group key={sd} position-x={sd * (PLATFORM.wood / 2 + P.side / 2)}>
            <mesh geometry={P.rubber} material={mats.rubberEdge} position-y={-PLATFORM.thick / 2} receiveShadow />
            <mesh geometry={P.rubberTop} material={mats.rubberTop} position-y={0.0004} receiveShadow />
          </group>
        ))}
      </group>

      {/* contact darkening under each plate stack */}
      <group ref={set('ao')}>
        {[-1, 1].map((sd) => (
          <mesh key={sd} geometry={geo.ao} material={mats.ao} position={[sd * 0.765, 0.0012, 0]} scale={[0.26, 1, 0.62]} renderOrder={1} />
        ))}
      </group>

      {/* ---------------- lamp ---------------- */}
      <group ref={set('lamp')} position={SPOT_POS.toArray()} quaternion={baseConeQ}>
        <mesh geometry={geo.lamp.shade} material={mats.shade} />
        <mesh geometry={geo.lamp.refl} material={mats.refl} />
        <mesh geometry={geo.lamp.lens} material={mats.lens} />
        <mesh geometry={geo.lamp.rim} material={mats.lensRim} />
        <mesh geometry={geo.lamp.guard} material={mats.guard} />
        <mesh geometry={geo.lamp.cable} material={mats.cable} />
        <mesh ref={set('flare')} geometry={geo.flare} material={mats.flare} position-y={0.06} renderOrder={10} visible={false} />
      </group>
      <points geometry={geo.motes} material={mats.motes} renderOrder={6} frustumCulled={false} />

      {/* ---------------- shutter trails (world space, written per frame) ---------------- */}
      {geo.plates.map((pg, k) => (
        <instancedMesh
          key={pg.spec.kg}
          ref={set(`ghost${k}`)}
          args={[geo.ghosts[k], mats.ghosts[k], 2 * GHOSTS]}
          renderOrder={4}
          frustumCulled={false}
          visible={false}
        />
      ))}

      {/* ---------------- the bar ---------------- */}
      <group ref={set('barPos')} position={[0, PLATE_R + rig.y, 0]}>
        <group ref={set('barRot')}>
          <mesh geometry={geo.shaft} material={mats.shaft} castShadow receiveShadow />
          <mesh geometry={geo.sleeveR} material={mats.sleeve} castShadow receiveShadow />
          <mesh geometry={geo.sleeveR} material={mats.sleeve} rotation-y={Math.PI} castShadow receiveShadow />
          {plateNodes}
          {[-1, 1].map((sd) => (
            <group key={sd} position-x={sd * layout.collarX} rotation-y={sd < 0 ? Math.PI : 0}>
              <mesh geometry={geo.collar.coil} material={mats.wire} castShadow />
              <mesh geometry={geo.collar.grips} material={mats.grip} castShadow />
            </group>
          ))}
        </group>
      </group>

      {/* ---------------- chalk clouds (after the opaque world, before the lens) ---------------- */}
      <mesh ref={set('puff0')} geometry={geo.puffs[0]} material={mats.puffs[0]} renderOrder={7} frustumCulled={false} visible={false} />
      <mesh ref={set('puff1')} geometry={geo.puffs[1]} material={mats.puffs[1]} renderOrder={7} frustumCulled={false} visible={false} />
    </>
  )
}

/* ------------------------------------------------------------------ */
function Post({ lite, reduced, composerRef, lens }) {
  return (
    <EffectComposer ref={composerRef} multisampling={lite ? 0 : 4}>
      <primitive object={lens} />
      <Bloom mipmapBlur luminanceThreshold={1.1} luminanceSmoothing={0.3} intensity={0.4} radius={0.62} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <Vignette offset={0.28} darkness={0.5} />
      {!reduced && <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.26} />}
    </EffectComposer>
  )
}

function Stage({ rig, lite, reduced, onWarm }) {
  const composerRef = useRef(null)
  return (
    <LensHost lite={lite}>
      {(lens) => (
        <>
          <World rig={rig} lite={lite} reduced={reduced} onWarm={onWarm} composerRef={composerRef} lens={lens} />
          <Post lite={lite} reduced={reduced} composerRef={composerRef} lens={lens} />
        </>
      )}
    </LensHost>
  )
}

/** Owns the lens effect (its own small cookie + noise textures; fixed per quality level). */
function LensHost({ lite, children }) {
  const lens = useMemo(() => {
    const cookie = spotCookie({ angle: SPOT_ANGLE, height: SPOT_POS.distanceTo(SPOT_AIM), ...POOL, size: 128 })
    const noise = noiseTexture({ size: 128 })
    const fx = new DropLensEffect({ cookie, noise, haze: lite ? 4 : 6, dof: lite ? 8 : 12 })
    fx.userData = { cookie, noise }
    return fx
  }, [lite])
  useEffect(
    () => () => {
      lens.userData.cookie.dispose()
      lens.userData.noise.dispose()
      lens.dispose()
    },
    [lens],
  )
  return children(lens)
}

export function DropScene({ rig, active = true, reduced = false, lite = false, onLive }) {
  // a real GPU that can't hold 40 fps drops resolution (once, never back). Nothing else changes, so no program
  // or pass has to be rebuilt mid-session.
  const [degraded, setDegraded] = useState(false)
  const onDecline = useCallback(() => setDegraded(true), [])
  const [warm, setWarm] = useState(false)
  const onWarm = useCallback(() => {
    setWarm(true)
    onLive?.()
  }, [onLive])
  const dpr = degraded ? [1, 1.25] : [1, 1.5]
  return (
    <Canvas
      dpr={dpr}
      frameloop={active && warm ? 'always' : 'never'}
      shadows={SHADOWS}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' }}
      camera={{ position: [1.2, 0.6, 3.6], fov: 30, near: 0.05, far: 60 }}
    >
      <color attach="background" args={[BG]} />
      {!lite && !degraded && warm && <PerformanceMonitor onDecline={onDecline} />}
      <Stage rig={rig} lite={lite} reduced={reduced} onWarm={onWarm} />
    </Canvas>
  )
}

export default DropScene
