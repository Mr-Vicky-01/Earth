import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { EffectComposer, Bloom, ToneMapping, Vignette, Noise } from '@react-three/postprocessing'
import { ToneMappingMode, BlendFunction, EffectPass } from 'postprocessing'
import { PLATE_R } from './sim'
import { liftCap, liftUnder, pointOnBarPlane, poseCamera, solveFrame } from './frame.js'
import { PLATFORM } from './parts'
import { DropLensEffect, DOF_MAX, HAZE_MAX } from './lens'
import { FLOOR_Y, WALL_H, layoutProps, placeHeadline } from './room'
import { LAMP_DROP, LAMP_PIVOT, POOL, SPOT_AIM, SPOT_ANGLE, SPOT_POS, buildAssets, disposeAssets } from './assets'
import { nextTask } from './textures'

/**
 * THE DROP: a gym in low light, one pendant lamp over a lifting platform, a loaded bar. The section owns the
 * physics and look state (`rig`, see sim.js); this scene reads the rig's blended view (`rig.v`) each frame and
 * renders it. Framing (camera, headline placement, lift range, the operator's zoom for lifts) lives in frame.js
 * so the pointer mapping uses the same camera.
 *
 * Smoothness: the procedural assets are built in small slices before the scene mounts (assets.js); then every
 * program is compiled and every texture, buffer and shadow map is warmed before the first visible frame. The
 * quality governor steps down without ever rebuilding a program: MSAA off and half the lens samples, then a
 * lower resolution and smaller shadow maps.
 */

const BG = '#0b0c10'
const SPOT_I = 140
const KEY_I = 440 // the far wall wash from camera-left (a second bank of tubes), low enough that lifted plates shade "FAST."
const BOUNCE_I = 2.6 // the lit platform bounces warm light back up
const SHADOWS = { enabled: true, type: THREE.PCFShadowMap }
const SHUTTER = 1 / 60 // s
// haze (linear radiance units; tuned against the lights above)
const HAZE_SCATTER = 0.032
const HAZE_SIGMA = 0.034
const HAZE_AMB = new THREE.Color(0.0062, 0.0066, 0.008)
const LAMP_COL = new THREE.Color('#f7f5f0')
const BOUNCE_COL = new THREE.Color('#ffcf9e')
const FAR_GLOW_R = new THREE.Color(0.78, 0.7, 0.58) // an old warm tube somewhere off to the right
const FAR_GLOW_L = new THREE.Color(0.55, 0.62, 0.78) // a cool fixture off to the left
// quality ladder: [dpr cap, MSAA on, lens samples ×, shadow map ×]
const LADDER = [
  [1.5, true, 1, 1],
  [1.25, false, 0.5, 1],
  [1, false, 0.5, 0.5],
  [0.85, false, 0.5, 0.5],
]

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
// dev-only timeline marks for the mount (read by the long-task tool)
const mark = (k) => {
  if (import.meta.env.DEV) (window.__dropMarks ||= []).push([k, Math.round(performance.now())])
}
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const dsmooth = (a, b, x) => {
  const t = (x - a) / (b - a)
  return t <= 0 || t >= 1 ? 0 : (6 * t * (1 - t)) / (b - a)
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
function World({ A, rig, lite, reduced, level, onWarm, composerRef, bloomRef, lens }) {
  const { gl, camera, scene, size } = useThree()
  const { mats, labels, geo, layout, uniforms } = A

  // the reflective materials (the env map for them is built in the warm-up below)
  const envMats = useMemo(
    () => [
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
      mats.kitRubber,
      mats.kitHub,
      mats.iron,
      mats.cove,
      mats.joist,
      mats.ball,
      ...Object.values(labels),
    ],
    [mats, labels],
  )
  // reflections come from the same lamp and room: they dim with it (a uniform, no recompile)
  const envList = useMemo(() => {
    const list = Object.values(mats)
      .flat()
      .concat(Object.values(labels))
      .filter((m) => m && m.isMeshStandardMaterial)
    return list.map((m) => [m, m.envMapIntensity])
  }, [mats, labels])
  const beams = useMemo(() => [mats.motes, ...mats.puffs], [mats])

  const r = useRef({})
  const R = r.current
  const set = (k) => (el) => {
    R[k] = el
  }
  const plateRefs = useRef([])
  const propRefs = useRef([])

  const F = useRef({ w: 0, h: 0, ver: -1, f: null, grab: { x: -1, y: -1, l: -1, a: 9, t: -1, on: null, n: 0 } })
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
      move: new THREE.Vector3(),
      m: new THREE.Matrix4(),
      eu: new THREE.Euler(),
      sq: new THREE.Quaternion(),
      lampQ: new THREE.Quaternion(),
      lampPos: new THREE.Vector3(),
      axis: new THREE.Vector3(),
      lx: new THREE.Vector3(),
      ly: new THREE.Vector3(),
      up: new THREE.Vector3(0, 0, -1),
      keyDir: new THREE.Vector3(),
      aimRel: SPOT_AIM.clone().sub(SPOT_POS),
      pose: { dolly: 1, follow: 0, px: 0, py: 0, lean: 1 },
      envK: -1,
      frames: 0,
      dt: 0,
      quality: -1,
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
      s.dolly = rig.v.dolly
      s.follow = reduced ? 0 : rig.v.follow
      s.px = rig.v.lx
      s.py = rig.v.ly
      s.lean = reduced ? 0 : 1
      return s
    }
    // where on the bar the pointer pressed: world x along the bar, height above the bar's axis
    rig.pick = (cx, cy) => {
      const L = local(cx, cy)
      if (!L || !pointOnBarPlane(L.f, pose(), L.sx, L.sy, rig.z, tmp.hit)) return null
      return { gx: clamp(tmp.hit.x, -1.1, 1.1), gy: clamp(tmp.hit.y - (PLATE_R + rig.y), -0.3, 0.3) }
    }
    // the lift that puts that grabbed point under the pointer, with the shot framed for that lift
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

  // quality ladder: everything here changes buffers or uniforms only (no program is rebuilt)
  useEffect(() => {
    const [, msaa, lensK, shadowK] = LADDER[level]
    const comp = composerRef.current
    if (comp) comp.multisampling = msaa && !lite ? 4 : 0
    if (lens) {
      lens.uniforms.get('uDofN').value = Math.max(4, Math.round((lite ? 8 : DOF_MAX) * lensK))
      lens.uniforms.get('uHazeN').value = Math.max(3, Math.round((lite ? 4 : HAZE_MAX) * lensK))
    }
    const resize = (light, s) => {
      if (!light || light.shadow.mapSize.x === s) return
      light.shadow.mapSize.set(s, s)
      light.shadow.map?.dispose()
      light.shadow.map = null
    }
    resize(R.spot, (lite ? 1024 : 2048) * shadowK)
    resize(R.key, 1024 * shadowK)
  }, [level, lite, lens, composerRef, R])

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
    rig.frame = reduced ? null : f
    rig.maxLift = reduced ? f.maxLiftStill : f.maxLift
    rig.liftCap = rig.maxLift
    rig.cleanTop = reduced ? f.maxLiftStill : f.cleanTop
    // just above the top of the frame (entrance pose): the drop is seen from its first centimetre
    rig.dropFrom = f.dropFrom
    if (rig.mode === 'hold') rig.y = f.dropFrom
    // wall with the painted headline, square to the camera
    if (R.wall) {
      R.wall.position.set(f.wallPoint.x, FLOOR_Y + WALL_H / 2, f.wallPoint.z)
      R.wall.rotation.set(0, f.wallYaw, 0)
    }
    placeHeadline(mats.wall, f)
    // the kit along the wall, placed from the headline and the frame edges
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
    // off-frame lights on the same circuit as the wall wash: a far fixture beyond each edge of the frame. They
    // light the dark corners so the kit there reads against the wall, and fall off before the letters.
    const wu = mats.wall.userData.u
    wu.uWallN.value.copy(f.n)
    const view = f.wallView
    wu.uGlowP.value[0].copy(f.wallPoint).addScaledVector(f.right, view.u1 + 0.45).addScaledVector(f.n, 0.8).setY(2.3)
    wu.uGlowP.value[1].copy(f.wallPoint).addScaledVector(f.right, view.u0 - 1.1).addScaledVector(f.n, 1.4).setY(2.3)
    // key light: far out in front-left, low (below the plate tops), so lifted plates shade the type
    if (R.key) {
      R.key.position.copy(f.typeCenter).addScaledVector(f.n, 11.2).addScaledVector(f.right, -2.6)
      R.key.position.y = 0.95
      R.key.target.position.copy(f.typeCenter)
      R.key.target.position.y -= f.typeHeight * 0.2
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

  /* ---------- per-frame: pose everything from the rig's blended view ---------- */
  const drive = (w, h, dpr) => {
    const f = frameFor(w, h)
    const v = rig.v
    const t = v.time

    /* ---------- bar ---------- */
    const ex = reduced ? 0 : v.exit
    const exitLift = 2.45 * smooth(0.03, 0.45, ex)
    const lift = v.y + exitLift
    const barY = PLATE_R + lift
    // overhead the bar drifts forward under the lamp, so it crosses the light as the camera looks up
    const barZ = v.z + 0.42 * smooth(0.12, 0.45, ex)
    tmp.bar.set(0, barY, barZ)
    if (R.barPos) R.barPos.position.copy(tmp.bar)
    if (R.barRot) R.barRot.rotation.x = v.spin
    uniforms.uBend.value = v.bend
    const pr = plateRefs.current
    for (let i = 0; i < pr.length; i++) {
      const g = pr[i]
      if (!g) continue
      const p = v.plates[i]
      g.rotation.set(p.spin, p.ry, p.rz)
    }
    // contact shadows fade as the bar leaves the floor
    if (R.ao) {
      const o = clamp(1 - lift / 0.35, 0, 1)
      mats.ao.opacity = 0.78 * o
      R.ao.visible = o > 0.01
      R.ao.position.z = v.z
    }

    /* ---------- lamp: hangs from a pivot, swings after a slam ---------- */
    const sx = reduced ? 0 : v.swingX
    const sz = reduced ? 0 : v.swingZ
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
    const poolX = tmp.lampPos.x + tmp.axis.x * toFloor
    const poolZ = tmp.lampPos.z + tmp.axis.z * toFloor + POOL.offZ
    if (R.bounce) R.bounce.position.set(poolX, 0.32, poolZ)

    /* ---------- light: two banks of tubes (the pendant, the wall wash) ---------- */
    const dark = 1 - smooth(0.55, 0.75, ex)
    const L = v.light * dark
    const wallK = v.wall * dark * (1 - smooth(0.08, 0.3, ex))
    if (R.spot) R.spot.intensity = SPOT_I * L
    if (R.key) R.key.intensity = KEY_I * wallK
    if (R.rim) R.rim.intensity = 7 * L
    if (R.bounce) R.bounce.intensity = BOUNCE_I * L
    if (R.hemi) R.hemi.intensity = (0.04 + 0.12 * L) * (0.6 + 0.4 * v.wall)
    const envK = 0.06 + 0.94 * Math.max(L, 0.7 * wallK)
    if (Math.abs(envK - tmp.envK) > 1e-4) {
      tmp.envK = envK
      for (const [m, base] of envList) m.envMapIntensity = base * envK
    }
    mats.lens.color.setRGB(14 * L + 0.02, 13.2 * L + 0.02, 12.4 * L + 0.02)
    mats.lensRim.color.setRGB(24 * L + 0.02, 22.5 * L + 0.02, 20.5 * L + 0.02)
    mats.refl.color.setScalar(0.06 + 1.5 * L)
    const wu = mats.wall.userData.u
    wu.uGlowC.value[0].copy(FAR_GLOW_R).multiplyScalar(7 * wallK)
    wu.uGlowC.value[1].copy(FAR_GLOW_L).multiplyScalar(4 * wallK)
    for (let i = 0; i < beams.length; i++) {
      const u = beams[i].uniforms
      u.uLampPos.value.copy(tmp.lampPos)
      u.uLampX.value.copy(tmp.lx)
      u.uLampY.value.copy(tmp.ly)
      u.uLampAxis.value.copy(tmp.axis)
    }
    const mu = mats.motes.uniforms
    mu.uTime.value = reduced ? 3 : t
    mu.uLight.value = L
    mu.uPx.value = (h * dpr * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)
    // chalk cloud: lit like chalk (albedo ≈ 0.85) by the lamp inside the beam, the wall wash and the room
    for (let k = 0; k < 2; k++) {
      const b = rig.bursts[k]
      const pu = mats.puffs[k].uniforms
      const age = t - b.t
      const on = !reduced && b.e > 0 && age >= 0 && age < 3.4
      pu.uT.value = on ? age : -1
      pu.uE.value = b.e
      pu.uZ.value = b.z
      pu.uLamp.value.copy(LAMP_COL).multiplyScalar((0.85 / Math.PI) * ((SPOT_I * L) / (SPOT_POS.y * SPOT_POS.y)))
      pu.uKey.value.setRGB(0.93, 0.95, 1).multiplyScalar((0.85 / Math.PI) * ((KEY_I * wallK) / 125) * 0.35)
      pu.uAmb.value.setRGB(0.01, 0.011, 0.014).multiplyScalar(0.4 + 0.6 * L)
      const pm = k ? R.puff1 : R.puff0
      if (pm) pm.visible = on
    }

    /* ---------- camera ---------- */
    const ps = tmp.pose
    ps.dolly = v.dolly
    ps.follow = reduced ? 0 : v.follow
    ps.px = v.lx
    ps.py = v.ly
    ps.lean = reduced ? 0 : 1
    // the drag can't lift the plates past what the camera shows right now (it opens up as the lift goes on)
    if (rig.mode === 'drag') rig.liftCap = liftCap(f, ps, v.z, rig.maxLift)
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
    camera.position.copy(P)
    camera.lookAt(Look)
    // the slam jolts the tripod head: yaw, pitch and roll from the damped mount springs (sim.js)
    if (!reduced) {
      camera.rotateY(v.cam[0])
      camera.rotateX(v.cam[1])
      camera.rotateZ(v.cam[2] + Math.sin(t * 0.19 + 0.6) * 0.0005)
    }
    fov += 10 * smooth(0, 0.5, ex)
    if (camera.fov !== fov) camera.fov = fov
    const vo = 1 - smooth(0.0, 0.4, ex)
    camera.setViewOffset(w, h, f.offX * vo, f.offY * vo, w, h)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()

    /* ---------- exposure: the camera stops down as it looks up into the lamp ---------- */
    const exposure = 1 - 0.48 * smooth(0.14, 0.42, ex)
    if (bloomRef.current) bloomRef.current.intensity = 0.4 * exposure

    /* ---------- lens: haze, depth of field, motion blur ---------- */
    if (lens) {
      const U = lens.uniforms
      U.get('uCam').value.copy(camera.position)
      U.get('uInvProj').value.copy(camera.projectionMatrixInverse)
      U.get('uCamWorld').value.copy(camera.matrixWorld)
      U.get('uViewProj').value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      U.get('uLampPos').value.copy(tmp.lampPos)
      U.get('uLampX').value.copy(tmp.lx)
      U.get('uLampY').value.copy(tmp.ly)
      U.get('uLampAxis').value.copy(tmp.axis)
      U.get('uLampTan').value = Math.tan(SPOT_ANGLE)
      U.get('uLampCol').value.set(LAMP_COL.r, LAMP_COL.g, LAMP_COL.b).multiplyScalar((SPOT_I * L * HAZE_SCATTER) / (4 * Math.PI))
      U.get('uPool').value.set(poolX, poolZ, 0)
      U.get('uBounceCol').value.set(BOUNCE_COL.r, BOUNCE_COL.g, BOUNCE_COL.b).multiplyScalar(0.0026 * L)
      U.get('uAmb').value.set(HAZE_AMB.r, HAZE_AMB.g, HAZE_AMB.b).multiplyScalar(0.35 + 0.65 * Math.max(L, wallK))
      U.get('uSigma').value = HAZE_SIGMA
      U.get('uTime').value = reduced ? 5 : t
      U.get('uExposure').value = exposure
      // focus on the bar (rack focus follows it overhead on the exit); a wider zoom has more depth of field
      U.get('uFocus').value = camera.position.distanceTo(tmp.bar)
      const zoom = Math.tan(THREE.MathUtils.degToRad(f.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(fov) / 2)
      const px = h * dpr
      U.get('uCocK').value = 15 * (px / 900) * zoom * zoom
      U.get('uCocMax').value = 6 * (px / 900)
      // motion blur: the bar's displacement over the exposure (lifts, drops, the exit's hoist)
      const vyExit = reduced ? 0 : 2.45 * dsmooth(0.03, 0.45, ex) * rig.exitV
      const mv = tmp.move.set(0, (reduced ? 0 : v.vy + vyExit) * SHUTTER, (reduced ? 0 : v.vz) * SHUTTER)
      const pa = tmp.a.copy(tmp.bar).addScaledVector(mv, -0.5).project(camera)
      const pb = tmp.b.copy(tmp.bar).addScaledVector(mv, 0.5).project(camera)
      const blurPx = Math.hypot((pb.x - pa.x) * w * 0.5, (pb.y - pa.y) * h * 0.5) * 1.25
      const mbOn = blurPx > 0.75 && ex < 0.6
      U.get('uMbOn').value = mbOn ? 1 : 0
      if (mbOn) {
        U.get('uBarPos').value.copy(tmp.bar)
        U.get('uBarMove').value.copy(mv)
        U.get('uBend').value = v.bend
        // screen box of the bar over the whole exposure
        let x0 = 9
        let y0 = 9
        let x1 = -9
        let y1 = -9
        for (let i = 0; i < 8; i++) {
          const q = tmp.c.set(i & 1 ? 1.12 : -1.12, barY + (i & 2 ? 1 : -1) * (0.24 + Math.abs(mv.y) * 0.5), barZ + (i & 4 ? 1 : -1) * (0.24 + Math.abs(mv.z) * 0.5))
          q.project(camera)
          if (q.x < x0) x0 = q.x
          if (q.y < y0) y0 = q.y
          if (q.x > x1) x1 = q.x
          if (q.y > y1) y1 = q.y
        }
        U.get('uMbBox').value.set(x0 * 0.5 + 0.5 - 0.01, y0 * 0.5 + 0.5 - 0.01, x1 * 0.5 + 0.5 + 0.01, y1 * 0.5 + 0.5 + 0.01)
      }
    }

    /* ---------- halo on the lamp ---------- */
    if (R.flare) {
      const amt = reduced ? 0 : smooth(0.22, 0.36, ex) * (1 - smooth(0.5, 0.64, ex)) * v.light
      mats.flare.uniforms.uAmt.value = amt
      R.flare.visible = amt > 0.002
      R.flare.scale.set(1.3, 1.3, 1)
    }

    /* ---------- grab zone over the bar (screen space, for the cursor + taps; ≤ 30 Hz, ≥ 2 px moves) ---------- */
    const el = rig.grabEl
    if (el) {
      const on = ex < 0.03 && rig.mode !== 'hold'
      const gz = F.current.grab
      if (on !== gz.on) {
        gz.on = on
        el.style.visibility = on ? 'visible' : 'hidden'
        gz.l = -1
      }
      gz.n += 1
      if (on && (gz.n & 1 || gz.l < 0)) updateGrab(el, gz, barY, barZ, w, h)
    }
  }

  const updateGrab = (el, gz, barY, barZ, w, h) => {
    const pa = tmp.a.set(-0.96, barY, barZ).project(camera)
    const pb = tmp.b.set(0.96, barY, barZ).project(camera)
    const ax = ((pa.x + 1) / 2) * w
    const ay = ((1 - pa.y) / 2) * h
    const bx = ((pb.x + 1) / 2) * w
    const by = ((1 - pb.y) / 2) * h
    const len = Math.hypot(bx - ax, by - ay)
    if (gz.l >= 0 && Math.abs(ax - gz.x) < 2 && Math.abs(ay - gz.y) < 2 && Math.abs(len - gz.l) < 2) return
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
    const ang = Math.atan2(by - ay, bx - ax)
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
    el.style.clipPath =
      `polygon(${p(0, c - hA / 2)}, ${p(la, c - hA / 2)}, ${p(la + 18, c - hs)}, ${p(len - lb - 18, c - hs)}, ` +
      `${p(len - lb, c - hB / 2)}, ${p(len, c - hB / 2)}, ${p(len, c + hB / 2)}, ${p(len - lb, c + hB / 2)}, ` +
      `${p(len - lb - 18, c + hs)}, ${p(la + 18, c + hs)}, ${p(la, c + hA / 2)}, ${p(0, c + hA / 2)})`
  }

  useFrame((state, delta) => {
    gl.info.reset()
    tmp.dt = Math.min(delta, 1 / 20)
    drive(size.width, size.height, state.viewport.dpr)
    tmp.frames += 1
  })

  /* ---------- warm-up: compile every program, upload every texture, render once, then go ----------
     Each GPU job is its own task (the page keeps responding between them): the environment map, the scene's
     programs, the post passes' programs, each texture upload, a tiny render that uploads every buffer and draws
     the shadow maps, then one full dark frame through the composer. */
  useEffect(() => {
    let dead = false
    let id = 0
    let env = null
    gl.info.autoReset = false
    const start = performance.now()
    const run = async () => {
      const comp = composerRef.current
      const ready = comp && comp.passes.some((p) => p instanceof EffectPass)
      if (!ready && performance.now() - start < 4000) {
        id = setTimeout(run, 20)
        return
      }
      await nextTask()
      if (dead) return
      // reflections for the steel (a small studio env, never lighting the room)
      mark('env0')
      env = buildEnv(gl)
      for (const m of envMats) {
        m.envMap = env.texture
        m.needsUpdate = true
      }
      mark('env1')
      await nextTask()
      if (dead) return
      // pose the scene as the first frame will see it (dark, bar above the frame)
      drive(size.width, size.height, gl.getPixelRatio())
      // compile against the composer's input target, so the variants match what will render
      const prev = gl.getRenderTarget()
      mark('compile0')
      if (comp) gl.setRenderTarget(comp.inputBuffer)
      try {
        await gl.compileAsync(scene, camera)
      } catch {
        /* compile errors surface on the warm render */
      }
      gl.setRenderTarget(prev)
      mark('compile1')
      // the post passes (and bloom's blur chain), one material at a time. (Bloom's luminance filter settles its
      // defines on its first update, so it is left to the warm frame rather than compiled twice.)
      const bloom = bloomRef.current
      const passes = [...(comp ? comp.passes : []), bloom?.mipmapBlurPass].filter(Boolean)
      for (const p of passes) {
        if (!p.scene || !p.camera || !p.fullscreenMaterial) continue
        const keep = p.fullscreenMaterial
        const list = p.downsamplingMaterial ? [p.downsamplingMaterial, p.upsamplingMaterial] : [keep]
        for (const m of list) {
          await nextTask()
          if (dead) return
          p.fullscreenMaterial = m
          try {
            await gl.compileAsync(p.scene, p.camera)
          } catch {
            /* surfaces on the warm render */
          }
        }
        p.fullscreenMaterial = keep
      }
      mark('post1')
      for (const tex of A.textures) {
        await nextTask()
        if (dead) return
        gl.initTexture(tex)
      }
      mark('tex1')
      await nextTask()
      if (dead) return
      // Everything that only appears later (chalk clouds, the halo, hidden kit) is drawn once here, invisibly (zero
      // alpha / off-screen), so its first real frame never stalls on program setup. Nothing is culled either, so
      // every vertex buffer is uploaded now (the bar is still above the frame). The motion blur branch is on.
      const hidden = []
      const culled = []
      scene.traverse((o) => {
        if (!o.visible) {
          hidden.push(o)
          o.visible = true
        }
        if (o.frustumCulled) {
          culled.push(o)
          o.frustumCulled = false
        }
      })
      const restore = () => {
        culled.forEach((o) => (o.frustumCulled = true))
        hidden.forEach((o) => (o.visible = false))
      }
      const mb = lens ? lens.uniforms.get('uMbOn') : null
      if (mb) {
        mb.value = 1
        lens.uniforms.get('uMbBox').value.set(0, 0, 1, 1)
      }
      if (comp) comp.render(0)
      else gl.render(scene, camera)
      mark('warm1')
      if (mb) mb.value = 0
      restore()
      if (dead) return
      if (import.meta.env.DEV) rig.warmMs = Math.round(performance.now() - start)
      onWarm?.()
    }
    run()
    return () => {
      dead = true
      clearTimeout(id)
      if (env) {
        for (const m of envMats) {
          m.envMap = null
          m.needsUpdate = true
        }
        env.dispose()
      }
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
      pitch: +rig.v.cam[1].toFixed(6),
      barY: R.barPos ? +R.barPos.position.y.toFixed(5) : null,
      barZ: R.barPos ? +R.barPos.position.z.toFixed(5) : null,
      spot: R.spot ? +R.spot.intensity.toFixed(3) : null,
      key: R.key ? +R.key.intensity.toFixed(3) : null,
      follow: +rig.v.follow.toFixed(5),
      exit: +rig.v.exit.toFixed(5),
      bend: +rig.v.bend.toFixed(5),
      mb: lens ? lens.uniforms.get('uMbOn').value : null,
    })
    window.__dropInfo = () => ({
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      points: gl.info.render.points,
      programs: gl.info.programs?.length,
      programNames: gl.info.programs?.map((p) => `${p.name}:${p.usedTimes}`),
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      passes: composerRef.current ? composerRef.current.passes.map((p) => p.name) : null,
      msaa: composerRef.current ? composerRef.current.multisampling : null,
      dpr: gl.getPixelRatio(),
      size: [size.width, size.height],
      level,
    })
    return () => {
      delete window.__dropProbe
      delete window.__dropInfo
    }
  }, [gl, camera, rig, R, size, composerRef, lens, level])

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
            <mesh geometry={pg.rubber} material={mats[pg.spec.key]} castShadow receiveShadow />
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
        shadow-bias={-0.0001}
        shadow-normalBias={0.035}
        shadow-radius={lite ? 3 : 5}
        shadow-camera-near={1.5}
        shadow-camera-far={5.3}
      >
        <object3D attach="target" position={SPOT_AIM.toArray()} />
      </spotLight>
      <spotLight
        ref={set('key')}
        angle={0.225}
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
        <mesh geometry={geo.cove} material={mats.cove} receiveShadow />
        <mesh geometry={geo.ceiling.deck} material={mats.ceiling} />
        <mesh geometry={geo.ceiling.joists} material={mats.joist} />
        {geo.props.map((p, i) => (
          <group
            key={p.name}
            ref={(el) => {
              propRefs.current[i] = el
            }}
          >
            {p.parts.map((q, j) =>
              q.ao ? (
                <mesh key={j} geometry={q.geo} material={mats[q.mat]} renderOrder={1} />
              ) : (
                <mesh key={j} geometry={q.geo} material={mats[q.mat]} castShadow receiveShadow />
              ),
            )}
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
function Post({ lite, reduced, composerRef, bloomRef, lens }) {
  return (
    <EffectComposer ref={composerRef} multisampling={lite ? 0 : 4}>
      {!(import.meta.env.DEV && /[?&]dd=[^&]*nolens/.test(location.search)) && <primitive object={lens} />}
      <Bloom ref={bloomRef} mipmapBlur luminanceThreshold={1.1} luminanceSmoothing={0.3} intensity={0.4} radius={0.62} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      <Vignette offset={0.28} darkness={0.5} />
      {!reduced && <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.26} />}
    </EffectComposer>
  )
}

function Stage({ A, rig, lite, reduced, level, onWarm }) {
  const composerRef = useRef(null)
  const bloomRef = useRef(null)
  // the lens effect shares the scene's cookie and noise textures
  const lens = useMemo(() => new DropLensEffect({ cookie: A.cookie, noise: A.noise }), [A])
  useEffect(() => () => lens.dispose(), [lens])
  return (
    <>
      <World A={A} rig={rig} lite={lite} reduced={reduced} level={level} onWarm={onWarm} composerRef={composerRef} bloomRef={bloomRef} lens={lens} />
      <Post lite={lite} reduced={reduced} composerRef={composerRef} bloomRef={bloomRef} lens={lens} />
    </>
  )
}

/** Builds the assets in slices (off the critical path), then mounts the stage. */
function useSlicedAssets(lite) {
  const [A, setA] = useState(null)
  useEffect(() => {
    let alive = true
    let built = null
    mark('assets0')
    buildAssets(lite).then((a) => {
      mark('assets1')
      built = a
      if (alive) setA(a)
      else disposeAssets(a)
    })
    return () => {
      alive = false
      if (built) disposeAssets(built)
      setA(null)
    }
  }, [lite])
  return A
}

export function DropScene({ rig, active = true, reduced = false, lite = false, onLive }) {
  // the quality governor: a real GPU that can't hold 40 fps steps down the ladder (never back up). No step
  // rebuilds a program.
  const [level, setLevel] = useState(0)
  const onDecline = useCallback(() => setLevel((l) => Math.min(LADDER.length - 1, l + 1)), [])
  const [warm, setWarm] = useState(false)
  const onWarm = useCallback(() => {
    setWarm(true)
    onLive?.()
  }, [onLive])
  const A = useSlicedAssets(lite)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    // dev-only: step the quality ladder from the capture tools
    window.__dropLevel = (n) => setLevel(Math.max(0, Math.min(LADDER.length - 1, n)))
    return () => delete window.__dropLevel
  }, [])
  const cap = LADDER[level][0]
  const dpr = cap < 1 ? [cap, cap] : [1, cap]
  return (
    <Canvas
      dpr={dpr}
      frameloop={active && warm ? 'always' : 'never'}
      shadows={SHADOWS}
      gl={{ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' }}
      camera={{ position: [1.2, 0.6, 3.6], fov: 30, near: 0.05, far: 60 }}
    >
      <color attach="background" args={[BG]} />
      {warm && level < LADDER.length - 1 && !(import.meta.env.DEV && /[?&]dd=[^&]*nogov/.test(location.search)) && (
        <PerformanceMonitor onDecline={onDecline} />
      )}
      {A && <Stage A={A} rig={rig} lite={lite} reduced={reduced} level={level} onWarm={onWarm} />}
    </Canvas>
  )
}

export default DropScene
