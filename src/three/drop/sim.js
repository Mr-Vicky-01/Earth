/**
 * Bar physics for THE DROP hero. Plain JS (no three.js), so the section can step it and read it without loading
 * the WebGL chunk. Units are metres and seconds.
 *
 * `y` is the lift: how far the bar's axis is above where it rests on the platform (plates touching the floor).
 * modes
 *   hold    above the frame, waiting for the entrance drop
 *   fall    free flight under gravity, bounces on the platform
 *   rest    lying on the platform
 *   drag    following the pointer through a heavy spring (mouse lift)
 *   script  driven by a tween on `scriptY` (the power clean); velocity is derived from the motion
 *
 * `lifted` is true from the moment a person lifts the bar (drag or clean) until it comes to rest again: only
 * then does the camera crane with the bar. The entrance drop (hold → fall) never moves the camera.
 */
export const G = 9.81
export const PLATE_R = 0.225 // 450 mm competition bumpers
export const LOAD_KG = 120 // 20 kg bar + 2 × (25 + 20 + 5)
export const PLATE_COUNT = 6 // per side, inner to outer: 25, 20, 5

const RESTITUTION = 0.34 // bumper plates on a rubber-topped platform
const BOUNCE_MAX = 2.3 // m/s: even a drop from overhead only kicks back ≈ 0.27 m
const STEP = 1 / 240
const LIFT_K = 120 // drag spring (per unit mass)
const LIFT_C = 17 // drag damping
const LIFT_AMAX = 26 // m/s², how hard a person can yank 120 kg
const BEND_W = 2 * Math.PI * 6.5 // shaft whip frequency
const BEND_Z = 0.1 // shaft whip damping ratio
const WOB_W = 2 * Math.PI * 4.2 // plate rocking frequency
const WOB_Z = 0.14
const SWING_W = (2 * Math.PI) / 1.7 // the pendant lamp: ≈0.7 m drop, swings after a slam shakes the ceiling
const SWING_Z = 0.13

const rand = (a, b) => a + Math.random() * (b - a)
const sgn = () => (Math.random() < 0.5 ? -1 : 1)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

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
    target: 0,
    scriptY: 0,
    maxLift: 1.15,
    cleanTop: 1.12,
    dropFrom: 2.4,
    z: 0,
    vz: 0,
    spin: 0,
    bend: 0,
    bendV: 0,
    plates: Array.from({ length: PLATE_COUNT }, (_, i) => ({
      rz: 0,
      rzV: 0,
      ry: 0,
      ryV: 0,
      // the bar is never perfectly squared up: plates sit at random turns on the sleeves
      spin: [0.12, 1.9, 4.2, 2.6, 0.5, 3.4][i],
      spinV: 0,
    })),
    // impacts → camera shake, lens punch, lamp swing and dust
    shake: 0,
    punch: 0,
    swingX: 0,
    swingXV: 0,
    swingZ: 0,
    swingZV: 0,
    impacts: 0,
    bursts: [
      { t: -100, e: 0, z: 0 },
      { t: -100, e: 0, z: 0 },
    ],
    burstSeq: 0,
    onImpact: null,
    // look + choreography (tweened by the section)
    light: reduced ? 1 : 0, // overhead spot, 0..1 (flicker)
    wall: reduced ? 1 : 0, // wash that reveals the headline wall
    dolly: reduced ? 1 : 0, // small push-in after the slam
    exit: 0, // scroll exit 0..1
    px: 0,
    py: 0,
    blur: 0, // 0..1 speed smear on the plates
    // provided by the scene once it is live: pointer → grabbed point / lift through the live camera
    pick: null,
    liftAt: null,
    frame: null,
    band: null,
    grabEl: null,
  }
}

/** The bar hits the platform at `v` m/s (positive). */
function hit(rig, v) {
  const e = clamp(v / 6, 0, 1)
  rig.impacts += 1
  rig.bendV += v * 0.25
  if (!rig.reduced) {
    rig.shake = Math.min(1, rig.shake + 0.18 + e * 0.75)
    rig.punch = Math.max(rig.punch, e * e)
    // the slam jolts the ceiling: the lamp swings, mostly along the bar
    rig.swingXV += sgn() * rand(0.1, 0.16) * e
    rig.swingZV += sgn() * rand(0.03, 0.06) * e
    for (const p of rig.plates) {
      p.rzV += sgn() * rand(0.25, 0.7) * e
      p.ryV += sgn() * rand(0.15, 0.45) * e
      p.spinV += sgn() * rand(0.3, 1.6) * e
    }
    rig.vz += sgn() * rand(0.06, 0.13) * e
    if (v > 1.1) {
      // reuse the cloud with the least dust left in it; a small bounce never wipes out the big slam cloud
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
    for (const p of rig.plates) p.rzV += sgn() * 0.12 * e
  }
  rig.onImpact?.(v, rig.impacts)
}

function substep(rig, dt) {
  const prevV = rig.vy
  if (rig.mode === 'fall') {
    rig.vy -= G * dt
    rig.y += rig.vy * dt
    if (rig.y <= 0 && rig.vy < 0) {
      const v = -rig.vy
      rig.y = 0
      if (v > 0.5) {
        rig.vy = Math.min(v * RESTITUTION, BOUNCE_MAX)
      } else {
        rig.vy = 0
        rig.mode = 'rest'
        rig.lifted = false
      }
      if (v > 0.12) hit(rig, v)
      rig.ay = 0
      return
    }
    rig.ay = 0 // free flight: no bending load
  } else if (rig.mode === 'drag') {
    const a = clamp(LIFT_K * (rig.target - rig.y) - LIFT_C * rig.vy, -LIFT_AMAX, LIFT_AMAX)
    rig.vy += a * dt
    rig.y += rig.vy * dt
    if (rig.y <= 0) {
      const v = -rig.vy
      rig.y = 0
      rig.vy = 0
      if (v > 0.4) hit(rig, v)
    }
    rig.ay = (rig.vy - prevV) / dt
  } else if (rig.mode === 'rest') {
    rig.y = 0
    rig.vy = 0
    rig.ay = 0
  } else if (rig.mode === 'hold') {
    rig.y = rig.dropFrom
    rig.vy = 0
    rig.ay = 0
    rig.lifted = false
  }

  // pendant lamp: two small damped pendulums
  rig.swingXV += (-SWING_W * SWING_W * rig.swingX - 2 * SWING_Z * SWING_W * rig.swingXV) * dt
  rig.swingX += rig.swingXV * dt
  rig.swingZV += (-SWING_W * SWING_W * rig.swingZ - 2 * SWING_Z * SWING_W * rig.swingZV) * dt
  rig.swingZ += rig.swingZV * dt

  // shaft whip: a damped spring, loaded by acceleration (the plates lag behind the hands)
  const ba = -BEND_W * BEND_W * rig.bend - 2 * BEND_Z * BEND_W * rig.bendV - rig.ay * 0.9
  rig.bendV += ba * dt
  rig.bend += rig.bendV * dt

  // plates rock on the sleeves and swing a little with the bar's acceleration
  const swing = rig.ay * 0.0016
  for (let i = 0; i < rig.plates.length; i++) {
    const p = rig.plates[i]
    const side = i < 3 ? -1 : 1
    const aRz = -WOB_W * WOB_W * (p.rz - swing * side) - 2 * WOB_Z * WOB_W * p.rzV
    p.rzV += aRz * dt
    p.rz += p.rzV * dt
    const aRy = -WOB_W * WOB_W * 0.8 * p.ry - 2 * WOB_Z * WOB_W * p.ryV
    p.ryV += aRy * dt
    p.ry += p.ryV * dt
    p.spinV *= Math.exp(-dt * 2.2)
    p.spin += p.spinV * dt
  }

  // rolling on the platform after a slam; re-centred while the bar is in the air
  if (rig.y < 0.002) {
    rig.vz *= Math.exp(-dt * 2.4)
    rig.z += rig.vz * dt
    if (Math.abs(rig.z) > 0.12) {
      rig.z = clamp(rig.z, -0.12, 0.12)
      rig.vz = 0
    }
    rig.spin = rig.z / PLATE_R
  } else {
    rig.vz += (-rig.z * 18 - rig.vz * 7) * dt
    rig.z += rig.vz * dt
  }
}

/** Advance the simulation by `dt` seconds (clamped to 0.1 s; fixed 1/240 s substeps keep it stable). */
export function stepRig(rig, dtIn) {
  const dt = Math.min(Math.max(dtIn, 0), 0.1)
  rig.time += dt
  if (rig.mode === 'script') {
    // the tween runs on real time: differentiate over the real frame time, not the clamped step
    const real = Math.max(dtIn * (dt > 0 ? 1 : 0), 1e-3)
    const prev = rig.y
    const prevV = rig.vy
    rig.y = Math.max(0, rig.scriptY)
    rig.vy = clamp((rig.y - prev) / real, -6, 6)
    rig.ay = clamp((rig.vy - prevV) / real, -40, 40)
  }
  let left = dt
  while (left > 1e-6) {
    const h = Math.min(STEP, left)
    substep(rig, h)
    left -= h
  }
  rig.shake = Math.max(0, rig.shake - dt * 1.6)
  rig.punch *= Math.exp(-dt * 9)
  const speed = Math.abs(rig.vy)
  const target = clamp((speed - 1.0) / 2.6, 0, 1)
  rig.blur += (target - rig.blur) * (1 - Math.exp(-dt * (target > rig.blur ? 30 : 9)))
}

/** Starts the drop from wherever the bar is (keeps its velocity, so a fast lift tosses it). */
export function release(rig) {
  if (rig.mode === 'drag' || rig.mode === 'script' || rig.mode === 'hold') rig.mode = 'fall'
}
