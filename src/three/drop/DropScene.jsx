import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { EffectComposer, Bloom, ChromaticAberration, ToneMapping, Vignette, Noise } from '@react-three/postprocessing'
import { ToneMappingMode, BlendFunction } from 'postprocessing'
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
import { concreteTexture, headlineTexture, knurlTextures, plateLabel, rubberTextures, spotCookie, woodTextures } from './textures'
import {
  barFx,
  coneMaterial,
  createBarUniforms,
  dustGeometry,
  dustMaterial,
  flareMaterial,
  ghostMaterial,
  motesGeometry,
  motesMaterial,
} from './fx'

/**
 * THE DROP: a dark gym, one hard spotlight, a lifting platform and a loaded bar. The section owns the physics
 * (`rig`, see sim.js) and choreography; this scene reads the rig each frame and renders it. Framing (camera,
 * headline placement, lift range, crane follow) lives in frame.js so the pointer mapping uses the same camera.
 */

const BG = '#060609'
const COLOURS = { heat: '#ff4b1f', cobalt: '#2236ff', paper: '#efeee9' }
const INK = { heat: '#f4f3ee', cobalt: '#f4f3ee', paper: '#16161e' }
// the pendant lamp hangs 0.7 m from a ceiling pivot and swings after a slam
const LAMP_PIVOT = new THREE.Vector3(0.15, 5.1, 0.45)
const LAMP_DROP = 0.7
const SPOT_POS = LAMP_PIVOT.clone().add(new THREE.Vector3(0, -LAMP_DROP, 0))
const SPOT_AIM = new THREE.Vector3(0, 0, -0.1)
const SPOT_ANGLE = 0.38 // the cookie shapes the pool inside this cone
const POOL = { halfX: 1.45, halfZ: 0.68, offZ: -0.16 } // barn-door slot of light on the floor (m)
const CONE_ANGLE = 0.15 // the visible core of the beam (haze is only seen where the light is brightest)
const LIT_ANGLE = 0.36 // where motes catch the light
const SPOT_I = 140
const KEY_I = 440 // distant low key from camera-left: lights the wall, throws the plates' shadows on "FAST."
const HEADLINE = ['Move it', 'fast.']
const SHADOWS = { enabled: true, type: THREE.PCFShadowMap }
const GHOST_ALPHA = [0.24, 0.15, 0.08, 0.035]
const GHOSTS = GHOST_ALPHA.length

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
  // light floor bounce → undersides stay silver
  add(new THREE.PlaneGeometry(24, 24), '#c9ccd6', 0.7, [0, -2.5, 0], [-Math.PI / 2, 0, 0])
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
    const concrete = new THREE.CanvasTexture(concreteTexture({ lite }))
    concrete.colorSpace = THREE.SRGBColorSpace
    concrete.wrapS = concrete.wrapT = THREE.RepeatWrapping
    concrete.repeat.set(9, 4)
    const headline = headlineTexture({ lines: HEADLINE, lite })
    const cookie = spotCookie({ angle: SPOT_ANGLE, height: SPOT_POS.distanceTo(SPOT_AIM), ...POOL, size: lite ? 128 : 256 })

    const steel = (o = {}) =>
      barFx(
        new THREE.MeshStandardMaterial({
          color: '#d3d6de',
          metalness: 1,
          roughness: 0.3,
          envMapIntensity: 1,
          ...o,
        }),
        uniforms,
      )
    const rubber = (key) =>
      barFx(
        new THREE.MeshPhysicalMaterial({
          color: COLOURS[key],
          roughness: key === 'paper' ? 0.6 : 0.56,
          metalness: 0,
          sheen: key === 'cobalt' ? 0.1 : 0.2,
          sheenRoughness: 0.5,
          sheenColor: new THREE.Color(COLOURS[key]).lerp(new THREE.Color('#ffffff'), key === 'cobalt' ? 0.05 : 0.2),
          envMapIntensity: 0.3,
        }),
        uniforms,
      )

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
      grip: barFx(new THREE.MeshStandardMaterial({ color: '#1c1c22', roughness: 0.55, envMapIntensity: 0.4 }), uniforms),
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
      floor: new THREE.MeshStandardMaterial({
        map: floorTex.map,
        roughnessMap: floorTex.roughnessMap,
        roughness: 1,
        color: '#b4b4ba',
        envMapIntensity: 0.12,
      }),
      wall: new THREE.MeshStandardMaterial({ map: concrete, roughness: 0.94, color: '#5c5e6a' }),
      paint: new THREE.MeshStandardMaterial({
        map: headline.texture,
        color: '#ebeae6',
        transparent: true,
        roughness: 0.78,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
      shade: new THREE.MeshStandardMaterial({ color: '#17181f', metalness: 0.7, roughness: 0.38, side: THREE.DoubleSide }),
      refl: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false }),
      lens: new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff4e4').multiplyScalar(14), fog: false }),
      lensRim: new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff1dc').multiplyScalar(24), fog: false, side: THREE.DoubleSide }),
      cable: new THREE.MeshBasicMaterial({ color: '#040405' }),
      guard: new THREE.MeshStandardMaterial({ color: '#2a2b33', metalness: 0.6, roughness: 0.5 }),
      ao: new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, depthWrite: false, alphaMap: aoTexture(), opacity: 0.85 }),
      cone: coneMaterial(),
      motes: motesMaterial(),
      dust: [dustMaterial(), dustMaterial()],
      ghosts: PLATES.map((p) => ghostMaterial(new THREE.Color(COLOURS[p.key]).multiplyScalar(0.5))),
      flare: flareMaterial(),
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
      labels[spec.kg] = barFx(
        new THREE.MeshStandardMaterial({
          map,
          transparent: true,
          roughness: 0.48,
          metalness: 0,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          envMapIntensity: 0.3,
        }),
        uniforms,
      )
    }

    const layout = plateLayout()
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
      cone: (() => {
        const H = SPOT_POS.distanceTo(SPOT_AIM) * 1.03
        const g = new THREE.ConeGeometry(Math.tan(CONE_ANGLE) * H, H, 72, 1, true)
        g.translate(0, -H / 2, 0)
        return { g, H }
      })(),
      motes: motesGeometry(lite ? 150 : 320),
      dust: [dustGeometry(lite ? 520 : 1100, 41), dustGeometry(lite ? 520 : 1100, 42)],
      // motion ghosts: low-res copies of the plate bodies with a per-instance alpha (two sides × GHOSTS echoes)
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
      wall: new THREE.PlaneGeometry(36, 14),
      paint: new THREE.PlaneGeometry(1, 1),
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
      concrete,
      headline.texture,
      cookie,
      mats.ao.alphaMap,
      ...Object.values(labels).map((m) => m.map),
    ]
    return { uniforms, mats, labels, geo, layout, headline, cookie, textures }
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
  ;[g.shaft, g.sleeveR, g.collar.coil, g.collar.grips, g.flare, g.ao, g.floor, g.wall, g.paint, g.motes, ...g.dust, ...g.ghosts].forEach((x) =>
    x.dispose(),
  )
  g.plates.forEach((p) => [p.rubber, p.hub, p.label].forEach((x) => x.dispose()))
  Object.values(g.platform).forEach((x) => x?.dispose?.())
  Object.values(g.lamp).forEach((x) => x.dispose())
  g.cone.g.dispose()
}

/* ------------------------------------------------------------------ */
function World({ rig, lite, reduced, degraded, onFrame, onLive }) {
  const { gl, camera, size } = useThree()
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
      m: new THREE.Matrix4(),
      t: new THREE.Matrix4(),
      eu: new THREE.Euler(),
      sq: new THREE.Quaternion(),
      lampQ: new THREE.Quaternion(),
      coneQ: new THREE.Quaternion(),
      lampPos: new THREE.Vector3(),
      axis: new THREE.Vector3(),
      hang: new THREE.Vector3(),
      aimRel: SPOT_AIM.clone().sub(SPOT_POS),
      pose: { dolly: 1, follow: 0, px: 0, py: 0, lean: 1 },
      follow: 0,
      frames: 0,
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
      s.px = rig.px
      s.py = rig.py
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
    mats.cone.uniforms.uApexY.value = SPOT_POS.y
    mats.cone.uniforms.uHeight.value = SPOT_POS.y
    mats.motes.uniforms.uCos.value = Math.cos(LIT_ANGLE)
  }, [mats, R])

  useFrame((state, delta) => {
    const dt = Math.min(delta, 1 / 20)
    const t = state.clock.elapsedTime
    const { width: w, height: h } = size
    const fr = F.current

    /* ---------- framing (only on resize / layout change) ---------- */
    const band = rig.band && rig.band.h === h ? rig.band : null
    const ver = band ? band.ver : -1
    if (fr.w !== w || fr.h !== h || fr.ver !== ver || !fr.f) {
      fr.w = w
      fr.h = h
      fr.ver = ver
      fr.f = solveFrame(w, h, A.headline.layout, band)
      const f = fr.f
      rig.frame = f
      rig.maxLift = reduced ? f.maxLiftStill : LIFT_MAX
      rig.cleanTop = reduced ? Math.min(LIFT_MAX, f.maxLiftStill) : LIFT_MAX
      rig.dropFrom = f.dropFrom
      if (rig.mode === 'hold') rig.y = f.dropFrom
      // wall + painted headline square to the camera
      if (R.wall) {
        R.wall.position.set(f.wallPoint.x, 7 - 0.045, f.wallPoint.z)
        R.wall.rotation.set(0, f.wallYaw, 0)
      }
      if (R.paint) {
        R.paint.position.copy(f.typeCenter)
        R.paint.rotation.set(0, f.wallYaw, 0)
        R.paint.scale.set(f.typeWidth, f.typeHeight, 1)
      }
      // key light: far out in front-left at plate height, so the plates' shadows land across "FAST."
      if (R.key) {
        R.key.position.copy(f.typeCenter).addScaledVector(f.n, 11.2).addScaledVector(f.right, -2.6)
        R.key.position.y = 1.15
        R.key.target.position.copy(f.typeCenter)
        R.key.target.position.y -= f.typeHeight * 0.12
        R.key.target.updateMatrixWorld()
      }
      if (R.rim) {
        R.rim.position.copy(f.target).addScaledVector(f.n, -2.1).addScaledVector(f.right, 0.6)
        R.rim.position.y = 1.15
        R.rim.target.position.set(0, PLATE_R, 0)
        R.rim.target.updateMatrixWorld()
      }
      // particles fade where the HTML copy sits (NDC rectangle)
      const cb = band && band.blocks && band.blocks[0]
      for (const m of mats.dust) {
        if (cb) m.uniforms.uCopy.value.set((cb.x0 / w) * 2 - 1, 1 - ((cb.y1 ?? h) / h) * 2, (cb.x1 / w) * 2 - 1, 1 - (cb.y0 / h) * 2)
        else m.uniforms.uCopy.value.set(9, 9, 9, 9)
      }
      fr.grab.l = -1
    }
    const f = fr.f

    /* ---------- bar ---------- */
    const ex = reduced ? 0 : rig.exit
    const exitLift = 2.45 * smooth(0.03, 0.45, ex)
    const lift = rig.y + exitLift
    const barY = PLATE_R + lift
    // overhead the bar drifts forward under the lamp, so it crosses the light as the camera looks up
    const barZ = rig.z + 0.42 * smooth(0.12, 0.45, ex)
    if (R.barPos) R.barPos.position.set(0, barY, barZ)
    if (R.barRot) R.barRot.rotation.x = rig.spin
    uniforms.uBend.value = rig.bend
    const vy = rig.vy
    uniforms.uSmearDir.value.set(0, vy >= 0 ? 1 : -1, 0)
    uniforms.uSmear.value = reduced ? 0 : Math.min(0.62, rig.blur * 0.62)
    const pr = plateRefs.current
    for (let i = 0; i < pr.length; i++) {
      const g = pr[i]
      if (!g) continue
      const p = rig.plates[i]
      g.rotation.set(p.spin, p.ry, p.rz)
    }
    // motion ghosts: three fading echoes of each plate, trailing along the motion
    const gAmt = reduced ? 0 : rig.blur
    const ghostsOn = gAmt > 0.02 && ex < 0.02
    for (let k = 0; k < 3; k++) {
      const gm = R[`ghost${k}`]
      if (gm) gm.visible = ghostsOn
    }
    if (ghostsOn && R.barPos) {
      R.barPos.updateMatrixWorld(true)
      // echoes a few centimetres apart: they overlap into a blur rather than reading as separate plates
      const step = Math.min(Math.abs(vy) * 0.014, 0.065) * (vy >= 0 ? -1 : 1)
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
    if (R.cone) {
      R.cone.position.copy(tmp.lampPos)
      R.cone.quaternion.copy(tmp.lampQ)
    }
    if (R.spot) {
      R.spot.position.copy(tmp.lampPos)
      R.spot.target.position.copy(tmp.lampPos).add(tmp.axis)
      R.spot.target.updateMatrixWorld()
    }
    tmp.axis.normalize()
    // where the beam's axis meets the floor → centre of the pool (for the dust)
    const toFloor = tmp.lampPos.y / Math.max(0.2, -tmp.axis.y)
    const poolX = tmp.lampPos.x + tmp.axis.x * toFloor
    const poolZ = tmp.lampPos.z + tmp.axis.z * toFloor + POOL.offZ
    mats.motes.uniforms.uApex.value.copy(tmp.lampPos)
    mats.motes.uniforms.uAxis.value.copy(tmp.axis)

    /* ---------- light ---------- */
    const dark = 1 - smooth(0.55, 0.75, ex)
    const L = rig.light * dark
    const liftDim = rig.lifted ? 1 - 0.3 * smooth(0.3, 1.0, rig.y) : 1
    if (R.spot) R.spot.intensity = SPOT_I * L
    if (R.key) R.key.intensity = KEY_I * rig.wall * dark * liftDim * (1 - smooth(0.08, 0.3, ex))
    if (R.rim) R.rim.intensity = 7 * L
    if (R.hemi) R.hemi.intensity = (0.03 + 0.14 * L) * (0.6 + 0.4 * rig.wall)
    mats.lens.color.setRGB(14 * L + 0.02, 13.2 * L + 0.02, 12.4 * L + 0.02)
    mats.lensRim.color.setRGB(24 * L + 0.02, 22.5 * L + 0.02, 20.5 * L + 0.02)
    mats.refl.color.setScalar(0.06 + 1.5 * L)
    const cu = mats.cone.uniforms
    cu.uIntensity.value = (w / h < 0.8 ? 0.17 : 0.26) * L
    cu.uTime.value = reduced ? 0 : t
    cu.uInside.value = smooth(0.15, 0.45, ex)
    const mu = mats.motes.uniforms
    mu.uTime.value = reduced ? 3 : t
    mu.uLight.value = L
    mu.uPx.value = h * state.viewport.dpr * 0.5
    const proj = (h * state.viewport.dpr * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    for (let k = 0; k < 2; k++) {
      const b = rig.bursts[k]
      const du = mats.dust[k].uniforms
      du.uT.value = reduced ? -1 : rig.time - b.t
      du.uE.value = b.e
      du.uZ.value = b.z
      du.uLight.value = Math.max(L, 0.15)
      du.uPx.value = proj
      du.uPoolC.value.set(poolX, poolZ)
      du.uPoolH.value.set(POOL.halfX, POOL.halfZ)
    }

    /* ---------- camera ---------- */
    // crane follow: only while a person lifts the bar (and while it falls back from that lift), as a pure
    // function of its height: 0 during the entrance, exactly 0 again by the time the plates hit the floor
    const want = !reduced && rig.lifted && rig.mode !== 'hold' ? followFor(Math.min(rig.y, LIFT_MAX + 0.15), f) : 0
    tmp.follow += (want - tmp.follow) * (1 - Math.exp(-delta * 40))
    if (Math.abs(tmp.follow) < 1e-5) tmp.follow = 0
    const ps = tmp.pose
    ps.dolly = rig.dolly
    ps.follow = tmp.follow
    ps.px = rig.px
    ps.py = rig.py
    ps.lean = reduced ? 0 : 1
    const P = tmp.pos
    const Look = tmp.look
    let fov = poseCamera(f, ps, P, Look)
    const breathe = reduced ? 0 : 1
    P.x += Math.sin(t * 0.37) * 0.018 * breathe
    P.y += Math.sin(t * 0.51) * 0.012 * breathe
    Look.y += Math.sin(t * 0.29) * 0.006 * breathe
    // scroll exit: drop under the bar and tilt up to the lamp as it passes overhead
    if (ex > 0) {
      tmp.exitPos.set(f.pos.x * 0.15, 0.3, 0.6)
      tmp.exitLook.set(0.05, 3.6, -0.3)
      P.lerp(tmp.exitPos, smooth(0.0, 0.5, ex))
      Look.lerp(tmp.exitLook, smooth(0.03, 0.55, ex))
    }
    // impact shake: trauma² noise (translation + roll)
    const s = rig.shake * rig.shake
    if (s > 0.0001) {
      P.x += (Math.sin(t * 61.0) * 0.6 + Math.sin(t * 37.3) * 0.4) * 0.028 * s
      P.y += (Math.sin(t * 53.0 + 1.7) * 0.6 + Math.sin(t * 29.1) * 0.4) * 0.034 * s
    }
    camera.position.copy(P)
    camera.lookAt(Look)
    if (s > 0.0001) camera.rotateZ((Math.sin(t * 47.0) * 0.6 + Math.sin(t * 23.0) * 0.4) * 0.012 * s)
    // lens punch on a hard slam, then the exit widens the lens as the camera looks up
    fov += -rig.punch * 1.4 + 10 * smooth(0, 0.5, ex)
    if (camera.fov !== fov) camera.fov = fov
    const vo = 1 - smooth(0.0, 0.4, ex)
    camera.setViewOffset(w, h, f.offX * vo, f.offY * vo, w, h)
    camera.updateProjectionMatrix()

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
      const gz = fr.grab
      if (on !== gz.on) {
        gz.on = on
        el.style.visibility = on ? 'visible' : 'hidden'
      }
      if (on) {
        camera.updateMatrixWorld()
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

    // ChromaticAberration follows the shake only (never splits the motion ghosts)
    if (R.ca) {
      const o = 0.00008 + s * 0.0035
      R.ca.offset.set(o, o * 0.4)
    }

    tmp.frames += 1
    if (tmp.frames === 1) onFrame?.()
    if (tmp.frames === 2) onLive?.()
  })

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
      <hemisphereLight ref={set('hemi')} args={['#3a3d4c', '#060607', 0.05]} />
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
        angle={0.2}
        penumbra={1}
        decay={2}
        distance={0}
        color="#eff1f6"
        intensity={0}
        castShadow={!lite && !degraded}
        shadow-mapSize={[2048, 2048]}
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

      {/* ---------------- room ---------------- */}
      <mesh geometry={geo.floor} material={mats.floor} position-y={-0.045} receiveShadow />
      <mesh ref={set('wall')} geometry={geo.wall} material={mats.wall} receiveShadow />
      <mesh ref={set('paint')} geometry={geo.paint} material={mats.paint} receiveShadow renderOrder={1} />

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

      {/* ---------------- lamp + cone ---------------- */}
      <group ref={set('lamp')} position={SPOT_POS.toArray()} quaternion={baseConeQ}>
        <mesh geometry={geo.lamp.shade} material={mats.shade} />
        <mesh geometry={geo.lamp.refl} material={mats.refl} />
        <mesh geometry={geo.lamp.lens} material={mats.lens} />
        <mesh geometry={geo.lamp.rim} material={mats.lensRim} />
        <mesh geometry={geo.lamp.guard} material={mats.guard} />
        <mesh geometry={geo.lamp.cable} material={mats.cable} />
        <mesh ref={set('flare')} geometry={geo.flare} material={mats.flare} position-y={0.06} renderOrder={10} visible={false} />
      </group>
      <mesh ref={set('cone')} geometry={geo.cone.g} material={mats.cone} position={SPOT_POS.toArray()} quaternion={baseConeQ} renderOrder={5} />
      <points geometry={geo.motes} material={mats.motes} renderOrder={6} frustumCulled={false} />
      <points geometry={geo.dust[0]} material={mats.dust[0]} renderOrder={7} frustumCulled={false} />
      <points geometry={geo.dust[1]} material={mats.dust[1]} renderOrder={7} frustumCulled={false} />

      {/* ---------------- motion ghosts (world space, written per frame) ---------------- */}
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

      <Post lite={lite || degraded} reduced={reduced} caRef={set('ca')} />
    </>
  )
}

/* ------------------------------------------------------------------ */
function Post({ lite, reduced, caRef }) {
  const offset = useMemo(() => new THREE.Vector2(0.00008, 0.00003), [])
  return (
    <EffectComposer multisampling={lite ? 0 : 4}>
      <Bloom mipmapBlur luminanceThreshold={1.1} luminanceSmoothing={0.3} intensity={0.4} radius={0.62} />
      <ChromaticAberration ref={caRef} offset={offset} radialModulation modulationOffset={0.25} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <Vignette offset={0.2} darkness={0.7} />
      {!reduced && <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.32} />}
    </EffectComposer>
  )
}

export function DropScene({ rig, active = true, reduced = false, lite = false, onFrame, onLive }) {
  // a real GPU that can't hold 40 fps drops MSAA, the key light's shadow and resolution (once, never back)
  const [degraded, setDegraded] = useState(false)
  const onDecline = useCallback(() => setDegraded(true), [])
  const dpr = degraded ? [1, 1.25] : [1, 1.5]
  return (
    <Canvas
      dpr={dpr}
      frameloop={active ? 'always' : 'never'}
      shadows={SHADOWS}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' }}
      camera={{ position: [1.2, 0.6, 3.6], fov: 30, near: 0.05, far: 60 }}
    >
      <color attach="background" args={[BG]} />
      <fogExp2 attach="fog" args={[BG, 0.07]} />
      {!lite && !degraded && <PerformanceMonitor onDecline={onDecline} />}
      <World rig={rig} lite={lite} reduced={reduced} degraded={degraded} onFrame={onFrame} onLive={onLive} />
    </Canvas>
  )
}

export default DropScene
