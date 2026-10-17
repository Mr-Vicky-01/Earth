/**
 * Bar physics for THE DROP hero. Plain JS (no three.js), so the section can step it and read it without loading
 * the WebGL chunk. Units are metres, seconds and m/s². Everything integrates with real dt in fixed 1/240 s
 * substeps, so it behaves the same at 30, 60, 120 or 144 Hz.
 *
 * `y` is the lift: how far the bar's axis is above where it rests on the platform (plates touching the floor).
 * The floor is a stiff spring-damper (bumper rubber on a rubber-topped platform, ≈17 ms contact, restitution
 * ≈0.36), so bounces, the slam's deceleration and everything it shakes come out of one contact force.
 *
 * modes
 *   hold    above the frame, waiting for the entrance drop
 *   fall    gravity + floor contact (+ the hands letting go, which takes a few tens of ms)
 *   rest    the same physics, flagged as settled
 *   drag    a person lifts it: a heavy spring to the (filtered) pointer target through muscle-lagged force
 *   clean   a power clean: two pulls (force profile), a float, a spring-damper catch, a hold, then the drop
 *
 * `lifted` is true from the moment a person lifts the bar until it comes to rest again: only then does the
 * camera crane with the bar. The entrance drop never moves the camera.
 *
 * The rig also carries the slow "look" state the scene reads: lamp output (strike flicker + warm-up through a
 * phosphor lag), the wall wash warming up, the dolly, the camera mount's shake, the pendant lamp's swing and the
 * filtered pointer lean / scroll exit.
 */
export const G = 9.81
export const PLATE_R = 0.225 // 450 mm competition bumpers
export const LOAD_KG = 120 // 20 kg bar + 2 × (25 + 20 + 5)
export const PLATE_COUNT = 6 // per side, inner to outer: 25, 20, 5

const STEP = 1 / 240
const DT_MAX = 1 / 20 // tab switches and long stalls never fast-forward the physics
// floor contact (per unit mass)
const CONTACT_W = 190
const CONTACT_Z = 0.37
// rolling on the platform: smooth Coulomb rolling resistance + a little air/rubber drag
const ROLL_MU = 0.028
const ROLL_V0 = 0.012
const ROLL_C = 0.35
// drag lift
const LIFT_K = 120
const LIFT_C = 17
const LIFT_AMAX = 26 // m/s² above holding the weight: how hard a person can yank 120 kg
const MUSCLE_TAU = 0.03 // hand force can't step
const RELEASE_TAU = 0.035 // fingers opening
const POINTER_W = 22 // pointer target low-pass (critically damped)
// shaft whip: lightly damped steel, loaded by where the force acts (floor at the ends, hands in the middle)
const BEND_W = 2 * Math.PI * 5.4
const BEND_Z = 0.07
const BEND_K = 0.12
// plates rocking on the sleeves
const WOB_Z = 0.12
// pendant lamp: 0.7 m drop → 1.68 s period
const SWING_W = Math.sqrt(G / 0.7)
const SWING_Z = 0.06
// camera mount (tripod on the same floor): a damped spring the slam's floor shock excites
const CAM_W = [2 * Math.PI * 4.6, 2 * Math.PI * 6.2, 2 * Math.PI * 5.1] // x, y, roll
const CAM_Z = 0.24
// look
const STRIKE = [
  // [from s, lamp power] — a fluorescent strike: two blinks, a dim flutter, then on
  [0.0, 1],
  [0.05, 0],
  [0.11, 0.78],
  [0.145, 0.06],
  [0.2, 1],
]
const WARM_TAU = 0.45 // the tube creeps from 84 % to full
const WALL_DELAY = 0.08
const WALL_TAU = 0.24 // wall wash: critically damped warm-up (zero slope at the start)
const DOLLY_W = 2.7
const LEAN_W = 5
const EXIT_W = 12
export const RELEASE_DELAY = 0.1 // s after the strike before the bar is let go above the frame

const rand = (a, b) => a + Math.random() * (b - a)
const sgn = () => (Math.random() < 0.5 ? -1 : 1)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const hann = (t, a, b) => (t <= a || t >= b ? 0 : 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - a)) / (b - a)))
const ss = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export function createRig({ reduced = false } = {}) {
  return {
    reduced,
    time: 0,
    // bar
    mode: reduced ? 'rest' : 'hold',
    lifted: false,
    y: reduced ? 0 : 3,
    vy: 0,
    ay: 0,
    ac: 0, // floor contact acceleration this step
    hand: 0, // hand force per unit mass (G = holding the weight)
    target: 0,
    tf: 0,
    tfV: 0,
    maxLift: 1.0,
    cleanTop: 1.0,
    dropFrom: 3,
    settle: 0,
    z: 0,
    vz: 0,
    spin: 0,
    spinV: 0,
    skew: 0, // horizontal kick per unit of contact force for the current drop
    bend: 0,
    bendV: 0,
    clean: { ph: 'none', t: 0, yc: 0, k: 1 },
    plates: Array.from({ length: PLATE_COUNT }, (_, i) => ({
      rz: 0,
      rzV: 0,
      ry: 0,
      ryV: 0,
      w: 2 * Math.PI * (3.9 + ((i * 0.37) % 1) * 1.6), // each plate rocks at its own rate
      kz: 0,
      ky: 0,
      ks: 0,
      // the bar is never perfectly squared up: plates sit at random turns on the sleeves
      spin: [0.12, 1.9, 4.2, 2.6, 0.5, 3.4][i],
      spinV: 0,
    })),
    // impacts → camera mount, lamp swing and dust
    inContact: false,
    impacts: 0,
    cam: [0, 0, 0],
    camV: [0, 0, 0],
    camK: [0, 0, 0],
    swingX: 0,
    swingXV: 0,
    swingZ: 0,
    swingZV: 0,
    swingKX: 0,
    swingKZ: 0,
    bursts: [
      { t: -100, e: 0, z: 0 },
      { t: -100, e: 0, z: 0 },
    ],
    burstSeq: 0,
    onImpact: null,
    // look
    strike: reduced ? -100 : -1, // rig.time of the lamp strike (-1: not yet)
    releaseAt: -1,
    light: reduced ? 1 : 0, // lamp output 0..1
    wall: reduced ? 1 : 0, // wall wash 0..1
    dolly: reduced ? 1 : 0,
    dollyV: 0,
    dollyTo: reduced ? 1 : 0,
    exitIn: 0, // raw scroll exit 0..1 (written by the ScrollTrigger)
    exit: 0, // filtered
    exitV: 0,
    px: 0, // raw pointer -1..1
    py: 0,
    lx: 0, // filtered lean
    ly: 0,
    lxV: 0,
    lyV: 0,
    blur: 0, // 0..1 shutter blur on the plates
    // provided by the scene once it is live: pointer → grabbed point / lift through the live camera
    pick: null,
    liftAt: null,
    frame: null,
    band: null,
    grabEl: null,
  }
}

/** Critically damped spring step (in place on obj[k], obj[kV]). */
function spring(o, k, kV, to, w, dt) {
  const a = w * w * (to - o[k]) - 2 * w * o[kV]
  o[kV] += a * dt
  o[k] += o[kV] * dt
}

/** Contact begins at `v` m/s: pick how this impact excites everything; the contact force then drives it. */
function impact(rig, v) {
  const e = clamp(v / 6, 0, 1)
  rig.impacts += 1
  const calm = rig.reduced
  // horizontal kick (the bar never lands perfectly square): first impact sets the direction, bounces follow it
  if (rig.impacts === 1 || Math.abs(rig.skew) < 1e-4 || v > 3) rig.skew = sgn() * rand(0.02, 0.04)
  else rig.skew *= 0.6
  for (const p of rig.plates) {
    p.kz = sgn() * rand(0.03, 0.09) * (calm ? 0.3 : 1)
    p.ky = sgn() * rand(0.02, 0.06) * (calm ? 0.3 : 1)
    p.ks = sgn() * rand(0.02, 0.1) * (calm ? 0.2 : 1)
  }
  if (!calm) {
    // ≈ 8 mm of bounce, a few mm of sway and ~0.1° of roll for a 5 m/s slam
    rig.camK[0] = sgn() * rand(0.014, 0.022)
    rig.camK[1] = -rand(0.045, 0.058)
    rig.camK[2] = sgn() * rand(0.008, 0.013)
    rig.swingKX = sgn() * rand(0.006, 0.01)
    rig.swingKZ = sgn() * rand(0.002, 0.004)
    if (v > 1.1) {
      // reuse the cloud with the least chalk left in it; a small bounce never wipes out the big slam cloud
      const e2 = clamp((v - 0.6) / 5.4, 0.15, 1)
      const left = (b) => b.e * Math.max(0, 1 - (rig.time - b.t) / 6)
      const [b0, b1] = rig.bursts
      const b = left(b0) <= left(b1) ? b0 : b1
      if (e2 > left(b) * 0.7) {
        rig.burstSeq += 1
        b.t = rig.time
        b.e = e2
        b.z = rig.z
      }
    }
  } else {
    rig.camK[0] = rig.camK[1] = rig.camK[2] = 0
    rig.swingKX = rig.swingKZ = 0
  }
  rig.onImpact?.(v, rig.impacts, e)
}

/** Hand force the lifter wants this substep (per unit mass, G = holding the weight). */
function handWant(rig, dt) {
  if (rig.mode === 'drag') {
    // the pointer is filtered first, so the bar never steps with the mouse
    rig.tfV += (POINTER_W * POINTER_W * (rig.target - rig.tf) - 2 * POINTER_W * rig.tfV) * dt
    rig.tf += rig.tfV * dt
    return clamp(G + LIFT_K * (rig.tf - rig.y) - LIFT_C * rig.vy, 0, G + LIFT_AMAX)
  }
  if (rig.mode === 'clean') {
    const c = rig.clean
    c.t += dt
    const tt = c.t / c.k
    if (c.ph === 'pull') {
      // first pull to the knee, then the explosive second pull; the hands let go at full extension
      const f = (G + 4.2 * hann(tt, 0.0, 0.52) + 12.5 * hann(tt, 0.4, 0.7)) * ss(0, 0.06, tt) * (1 - ss(0.6, 0.7, tt))
      if (tt >= 0.7) c.ph = 'float'
      return f
    }
    if (c.ph === 'float') {
      if (rig.vy < 0.25) {
        c.ph = 'catch'
        c.t = 0
        c.yc = rig.y
      }
      return 0
    }
    if (c.ph === 'catch') {
      // the bar lands in the rack position: the legs absorb it (a dip of a few cm), then stand
      const target = c.yc - 0.075 * (1 - ss(0.12, 0.6, tt)) - 0.02
      if (tt > 1.05) {
        c.ph = 'none'
        rig.mode = 'fall'
        return rig.hand
      }
      return clamp(G + 140 * (target - rig.y) - 20 * rig.vy, 0, G + 30)
    }
  }
  return 0
}

function substep(rig, dt) {
  if (rig.mode === 'hold') {
    rig.y = rig.dropFrom
    rig.vy = 0
    rig.ay = 0
    rig.ac = 0
    rig.hand = G
    rig.lifted = false
  } else {
    const want = handWant(rig, dt)
    const tau = rig.mode === 'drag' || rig.mode === 'clean' ? MUSCLE_TAU : RELEASE_TAU
    rig.hand += (want - rig.hand) * (1 - Math.exp(-dt / tau))
    if (rig.mode !== 'drag' && rig.mode !== 'clean' && rig.hand < 1e-4) rig.hand = 0
    // floor contact
    let ac = 0
    if (rig.y < 0) ac = Math.max(0, -CONTACT_W * CONTACT_W * rig.y - 2 * CONTACT_Z * CONTACT_W * rig.vy)
    const touching = rig.y < 0
    if (touching && !rig.inContact && rig.vy < -0.12) impact(rig, -rig.vy)
    rig.inContact = touching
    rig.ac = ac
    const a = rig.hand - G + ac
    rig.vy += a * dt
    rig.y += rig.vy * dt
    rig.ay = a
    // settled on the floor
    if (rig.mode === 'fall') {
      if (touching || rig.y < 0.002) {
        if (Math.abs(rig.vy) < 0.03) rig.settle += dt
        else rig.settle = 0
        if (rig.settle > 0.25) {
          rig.mode = 'rest'
          rig.lifted = false
        }
      } else rig.settle = 0
    }
  }

  // floor shock → camera mount, lamp swing, plates (smooth: the force lasts the whole contact)
  const ac = rig.ac
  for (let i = 0; i < 3; i++) {
    const w = CAM_W[i]
    rig.camV[i] += (-w * w * rig.cam[i] - 2 * CAM_Z * w * rig.camV[i] + rig.camK[i] * ac) * dt
    rig.cam[i] += rig.camV[i] * dt
  }
  rig.swingXV += (-SWING_W * SWING_W * rig.swingX - 2 * SWING_Z * SWING_W * rig.swingXV + rig.swingKX * ac) * dt
  rig.swingX += rig.swingXV * dt
  rig.swingZV += (-SWING_W * SWING_W * rig.swingZ - 2 * SWING_Z * SWING_W * rig.swingZV + rig.swingKZ * ac) * dt
  rig.swingZ += rig.swingZV * dt

  // shaft whip: contact at the ends bows the middle down, the hands in the middle bow the ends down
  const ba = -BEND_W * BEND_W * rig.bend - 2 * BEND_Z * BEND_W * rig.bendV + BEND_K * (ac - rig.hand)
  rig.bendV += ba * dt
  rig.bend += rig.bendV * dt

  // plates rock on the sleeves (kicked by the contact force, swung by the bar's acceleration) and turn a little
  const swing = (rig.ay - ac) * 0.0016
  for (let i = 0; i < rig.plates.length; i++) {
    const p = rig.plates[i]
    const side = i < 3 ? -1 : 1
    const w = p.w
    p.rzV += (-w * w * (p.rz - swing * side) - 2 * WOB_Z * w * p.rzV + p.kz * ac) * dt
    p.rz += p.rzV * dt
    p.ryV += (-w * w * 0.8 * p.ry - 2 * WOB_Z * w * p.ryV + p.ky * ac) * dt
    p.ry += p.ryV * dt
    p.spinV += (p.ks * ac - p.spinV * 2.6) * dt
    p.spin += p.spinV * dt
  }

  // horizontal: rolls on the platform with rolling resistance, flies straight in the air, re-centred by a lifter
  const onFloor = rig.y < 0.0015
  let az = rig.skew * ac
  if (rig.mode === 'drag' || rig.mode === 'clean') az += -18 * rig.z - 7 * rig.vz
  else if (onFloor) az += -ROLL_MU * G * Math.tanh(rig.vz / ROLL_V0) - ROLL_C * rig.vz
  rig.vz += az * dt
  rig.z += rig.vz * dt
  if (onFloor) rig.spinV = rig.vz / PLATE_R // rolling without slipping
  rig.spin += rig.spinV * dt
}

/** Lamp power at `s` seconds after the strike (before the phosphor lag). */
function lampPower(s) {
  if (s < 0) return 0
  let p = 0
  for (const [from, v] of STRIKE) if (s >= from) p = v
  if (s >= STRIKE[STRIKE.length - 1][0]) p *= 0.84 + 0.16 * (1 - Math.exp(-(s - STRIKE[STRIKE.length - 1][0]) / WARM_TAU))
  return p
}

/** Advance the simulation by `dt` seconds (clamped to 1/20 s; fixed 1/240 s substeps). */
export function stepRig(rig, dtIn) {
  const dt = clamp(dtIn, 0, DT_MAX)
  if (dt <= 0) return
  let left = dt
  while (left > 1e-7) {
    const h = Math.min(STEP, left)
    rig.time += h
    if (rig.mode === 'hold' && rig.releaseAt >= 0 && rig.time >= rig.releaseAt) {
      rig.mode = 'fall'
      rig.hand = 0 // let go out of frame
    }
    substep(rig, h)
    // look state, integrated with the same substeps
    if (!rig.reduced) {
      if (rig.strike >= 0) {
        const s = rig.time - rig.strike
        const P = lampPower(s)
        // phosphor + ballast: quick to light, slower to die
        const tau = P > rig.light ? 0.018 : 0.045
        rig.light += (P - rig.light) * (1 - Math.exp(-h / tau))
        const tw = s - WALL_DELAY
        rig.wall = tw > 0 ? 1 - (1 + tw / WALL_TAU) * Math.exp(-tw / WALL_TAU) : 0
      }
      spring(rig, 'dolly', 'dollyV', rig.dollyTo, DOLLY_W, h)
      spring(rig, 'lx', 'lxV', rig.px, LEAN_W, h)
      spring(rig, 'ly', 'lyV', rig.py, LEAN_W, h)
      spring(rig, 'exit', 'exitV', rig.exitIn, EXIT_W, h)
    }
    left -= h
  }
  // shutter blur follows speed (both ways quickly: it is a property of the exposure, not an effect)
  const target = clamp((Math.abs(rig.vy) - 0.8) / 2.4, 0, 1)
  rig.blur += (target - rig.blur) * (1 - Math.exp(-dt * 40))
}

/** The lamp strikes and the bar is let go just above the frame a moment later. */
export function startEntrance(rig) {
  if (rig.strike >= 0 || rig.reduced) return
  rig.strike = rig.time
  rig.releaseAt = rig.time + RELEASE_DELAY
  rig.dollyTo = 1
}

/** Snap the look to its final state (reduced motion, or the scene arrived after the copy). */
export function settleLook(rig) {
  rig.light = 1
  rig.wall = 1
  rig.dolly = rig.dollyTo = 1
  rig.dollyV = 0
}

/** Begin a power clean from the floor. */
export function beginClean(rig) {
  rig.mode = 'clean'
  rig.lifted = true
  rig.clean.ph = 'pull'
  rig.clean.t = 0
  rig.clean.k = Math.sqrt(clamp(rig.cleanTop / 0.96, 0.25, 1.2)) // time scale: the same lift, scaled in height
}

/** Begin a drag lift from wherever the bar is. */
export function beginDrag(rig) {
  rig.mode = 'drag'
  rig.lifted = true
  rig.tf = rig.target = Math.max(0, rig.y)
  rig.tfV = Math.max(0, rig.vy)
  rig.clean.ph = 'none'
}

/** Let go: the hands open over a few tens of ms and the bar keeps its velocity (a fast lift tosses it). */
export function release(rig) {
  if (rig.mode === 'drag' || rig.mode === 'clean' || rig.mode === 'hold') {
    rig.mode = 'fall'
    rig.clean.ph = 'none'
    rig.settle = 0
  }
}
