/**
 * Bar physics for THE DROP hero. Plain JS (no three.js), so the section can step it and read it without loading
 * the WebGL chunk. Units are metres, seconds and m/s².
 *
 * Time: a fixed-step integrator. Real frame time goes into an accumulator and the world advances in exact
 * 1/240 s steps, so a bounce, a roll or a clean comes out identical at 30, 60, 120 or 144 Hz. The renderer reads
 * `rig.v`, the state blended between the last two steps by the leftover time, so nothing judders when the display
 * rate and the step rate don't divide. dt is clamped to 1/20 s (tab switches never fast-forward the physics).
 *
 * `y` is the lift: how far the bar's axis is above where it rests on the platform (plates touching the floor).
 * The floor is a stiff spring-damper (bumper rubber on a rubber-topped platform, ≈17 ms contact, restitution
 * ≈0.36), so bounces, the slam's deceleration and everything it shakes come out of one contact force.
 *
 * modes
 *   hold    above the frame, waiting for the entrance drop
 *   fall    gravity + floor contact (+ the hands letting go, which takes a few tens of ms)
 *   rest    the same physics, flagged as settled
 *   drag    a person lifts it: a grip that can pull up (force falls with speed: muscle force-velocity) or hold
 *           it back, to the filtered pointer target, never above the lift the camera can show (`liftCap`)
 *   clean   a power clean: hands take the slack (the shaft flexes, the plates knock), a two-stage pull fitted to
 *           reach `cleanTop`, a float, a short spring-damper catch, a brief hold, then the drop
 *
 * Lift framing (`follow`, 0..1): the operator zooms out (and tilts just enough to keep the platform in place) as
 * a person lifts, through a speed-limited critically damped spring that leads the bar a little; on a clean it
 * opens as the lifter sets. When the bar is let go the camera holds the frame through the fall and the slam,
 * then eases back in, so the drop is seen in full and the impact isn't softened by a moving camera.
 *
 * The slam's floor force excites the camera mount (a damped spring in pitch, yaw and roll), the pendant lamp's
 * swing, the plates and a short roll of the bar. The rig also carries the slow look state: two banks of
 * fluorescent tubes striking (pendant first, then the wall wash), the dolly-in and the filtered lean / exit.
 */
export const G = 9.81
export const PLATE_R = 0.225 // 450 mm competition bumpers
export const LOAD_KG = 120 // 20 kg bar + 2 × (25 + 20 + 5)
export const PLATE_COUNT = 6 // per side, inner to outer: 25, 20, 5
export const LIFT_MAX = 1.0 // m: drag and power-clean ceiling (bar axis above its resting height)
export const FOLLOW_Y0 = 0.22 // no camera follow for small lifts and bounces

const STEP = 1 / 240
const DT_MAX = 1 / 20
// floor contact (per unit mass)
const CONTACT_W = 190
const CONTACT_Z = 0.37
// rolling on the platform: smooth Coulomb rolling resistance + a little air/rubber drag
const ROLL_MU = 0.035
const ROLL_V0 = 0.012
const ROLL_C = 0.35
// drag lift: a PD grip on the filtered pointer target, limited by what a strong lifter can do with 120 kg
const LIFT_K = 120
const LIFT_C = 19
const F_MAX = G + 14 // isometric pull per unit mass (≈ 2.4 × bodyweight of the bar)
const V_MAX = 3.4 // m/s: the pull falls to zero here (Hill force-velocity, linearised) → ≈ 2 m/s peak
const F_DOWN = -G // the grip can hold the bar back / pull it down at most this hard
const MUSCLE_TAU = 0.03 // hand force can't step
const RELEASE_TAU = 0.035 // fingers opening
const POINTER_W = 22 // pointer target low-pass (critically damped)
// shaft whip: lightly damped steel, loaded by where the force acts (floor at the ends, hands in the middle)
const BEND_W = 2 * Math.PI * 5.4
const BEND_Z = 0.07
const BEND_K = 0.12
const BEND_HAND = 0.3
// plates rocking on the sleeves
const WOB_Z = 0.12
// pendant lamp: 0.7 m drop → 1.68 s period; a heavy fixture on a cable, damped by its cable
const SWING_W = Math.sqrt(G / 0.7)
const SWING_Z = 0.2
// camera mount (tripod on the same floor): yaw, pitch, roll springs the slam's floor shock excites
const CAM_W = [2 * Math.PI * 4.6, 2 * Math.PI * 6.2, 2 * Math.PI * 5.1]
const CAM_Z = 0.24
// lift framing (the operator's zoom + tilt, 0..1): opens ahead of a rising bar, holds through a drop, then
// eases back in after the slam
const FOLLOW_LEAD = 0.16 // s: the operator leads a moving bar a little
const FOLLOW_W_UP = 8
const FOLLOW_W_DOWN = 4.2
const FOLLOW_V_UP = 2.4 // per second
const FOLLOW_V_DOWN = 1.1
// look: two banks of fluorescent tubes. [from s, power]: the cathodes glow first, then flashes as the tube tries
// to strike, then it holds and creeps from 84 % to full as it warms
const STRIKE_PENDANT = [
  [0.11, 0.92],
  [0.15, 0.1],
  [0.22, 0.72],
  [0.25, 0.14],
  [0.31, 1],
]
const STRIKE_WALL = [
  [0.27, 0.78],
  [0.3, 0.16],
  [0.36, 1],
]
const PREGLOW_LEVEL = 0.1
const WARM_TAU = 0.45
const DOLLY_W = 2.7
const LEAN_W = 5
const EXIT_W = 12
export const RELEASE_DELAY = 0.12 // s after the strike before the bar is let go above the frame
const IMPACT_T = 0.04 // s: how long a contact counts as an impact (its excess force drives the shake etc.)
// power clean (per unit mass, before fitting): slack, first pull, second pull, then the hands leave the bar
const CLEAN_SET = 0.055
const CLEAN_DIP = 0.025 // m the legs give in the catch
const CLEAN_HOLD = 0.3 // s from the catch until the hands open

const rand = (a, b) => a + Math.random() * (b - a)
const sgn = () => (Math.random() < 0.5 ? -1 : 1)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)
const hann = (t, a, b) => (t <= a || t >= b ? 0 : 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - a)) / (b - a)))
const ss = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** How far the shot opens (0..1, see frame.js poseCamera) to frame a lift `y`: the framing's table, interpolated. */
export function followFor(y, f) {
  const tab = f && f.followTab
  if (!tab || !(f.maxLift > 0)) return 0
  const n = tab.length - 1
  const x = clamp(y / f.maxLift, 0, 1) * n
  const i = Math.min(n - 1, Math.floor(x))
  return tab[i] + (tab[i + 1] - tab[i]) * (x - i)
}

// render channels blended between the last two fixed steps
const KEYS = ['time', 'y', 'vy', 'z', 'vz', 'spin', 'bend', 'swingX', 'swingZ', 'light', 'wall', 'dolly', 'lx', 'ly', 'exit', 'follow']
const N_PREV = KEYS.length + 3 + PLATE_COUNT * 3

export function createRig({ reduced = false } = {}) {
  const rig = {
    reduced,
    time: 0,
    acc: 0,
    // bar
    mode: reduced ? 'rest' : 'hold',
    lifted: false,
    y: reduced ? 0 : 3,
    vy: 0,
    ay: 0,
    ac: 0, // floor contact acceleration this step
    ai: 0, // its impulsive part
    hand: 0, // hand force per unit mass (G = holding the weight)
    target: 0,
    tf: 0,
    tfV: 0,
    maxLift: LIFT_MAX,
    liftCap: LIFT_MAX, // set by the scene each frame: the highest lift the camera can show right now
    cleanTop: LIFT_MAX,
    dropFrom: 3,
    settle: 0,
    z: 0,
    vz: 0,
    spin: 0,
    spinV: 0,
    skew: 0, // horizontal kick per unit of contact force for the current drop
    bend: 0,
    bendV: 0,
    clean: { ph: 'none', t: 0, yc: 0, s: 1, k: 1, tc: 0, knock: false },
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
    contactT: 0,
    impacts: 0,
    cam: [0, 0, 0], // yaw, pitch, roll (rad)
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
    // lift framing
    follow: 0,
    followV: 0,
    followHold: false,
    // look
    strike: reduced ? -100 : -1, // rig.time of the lamp strike (-1: not yet)
    releaseAt: -1,
    light: reduced ? 1 : 0, // pendant output 0..1
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
    // provided by the scene once it is live: pointer → grabbed point / lift through the live camera
    pick: null,
    liftAt: null,
    frame: null,
    band: null,
    grabEl: null,
    prev: new Float64Array(N_PREV),
    // what the renderer reads (blended between steps)
    v: {
      cam: [0, 0, 0],
      plates: Array.from({ length: PLATE_COUNT }, () => ({ rz: 0, ry: 0, spin: 0 })),
    },
  }
  save(rig, rig.prev)
  blend(rig, 1)
  return rig
}

function save(rig, o) {
  let k = 0
  for (let i = 0; i < KEYS.length; i++) o[k++] = rig[KEYS[i]]
  for (let i = 0; i < 3; i++) o[k++] = rig.cam[i]
  for (let i = 0; i < rig.plates.length; i++) {
    const p = rig.plates[i]
    o[k++] = p.rz
    o[k++] = p.ry
    o[k++] = p.spin
  }
}

function blend(rig, a) {
  const o = rig.prev
  const v = rig.v
  let k = 0
  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[i]
    v[key] = o[k] + (rig[key] - o[k]) * a
    k++
  }
  for (let i = 0; i < 3; i++) {
    v.cam[i] = o[k] + (rig.cam[i] - o[k]) * a
    k++
  }
  for (let i = 0; i < rig.plates.length; i++) {
    const p = rig.plates[i]
    const q = v.plates[i]
    q.rz = o[k] + (p.rz - o[k]) * a
    q.ry = o[k + 1] + (p.ry - o[k + 1]) * a
    q.spin = o[k + 2] + (p.spin - o[k + 2]) * a
    k += 3
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
  rig.followHold = false
  const calm = rig.reduced
  // horizontal kick (the bar never lands perfectly square): first impact sets the direction, bounces follow it
  if (rig.impacts === 1 || Math.abs(rig.skew) < 1e-4 || v > 3) rig.skew = sgn() * rand(0.007, 0.014)
  else rig.skew *= 0.6
  for (const p of rig.plates) {
    p.kz = sgn() * rand(0.03, 0.09) * (calm ? 0.3 : 1)
    p.ky = sgn() * rand(0.02, 0.06) * (calm ? 0.3 : 1)
    p.ks = sgn() * rand(0.02, 0.1) * (calm ? 0.2 : 1)
  }
  if (!calm) {
    // the tripod's head: ≈ 4 mrad of pitch (≈ 8 px at 1440 × 900), a little yaw and roll for a 5 m/s slam;
    // bounces excite it in proportion to their (much smaller) impulse
    rig.camK[0] = sgn() * rand(0.006, 0.009)
    rig.camK[1] = -rand(0.029, 0.034)
    rig.camK[2] = sgn() * rand(0.007, 0.01)
    rig.swingKX = sgn() * rand(0.0016, 0.0024)
    rig.swingKZ = sgn() * rand(0.0006, 0.001)
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

/**
 * Pull of the power clean at `t` s after the click (per unit mass): `s` scales the effort (fitted to the target
 * height), `k` the timing (taller lifts take longer, so the bar's speed stays human: ≈ 2 m/s at most).
 */
function cleanPull(t, s, k) {
  // hands take the slack: the force comes up to just over the bar's weight; it breaks from the floor ≈ 60 ms
  const set = (G + 3) * ss(0, CLEAN_SET, t)
  const u = t / k
  // first pull off the floor to the knee (strong from the start), the explosive second pull from mid-thigh,
  // then the hands leave the bar as the lifter drops under it
  const pull = s * (4.2 * hann(u, -0.12, 0.56) + 7.5 * hann(u, 0.38, 0.66))
  return (set + pull) * (1 - ss(0.6 * k, 0.68 * k, t))
}

/** Dry run: apex height of a clean with pull scale `s` from rest (no floor, no catch). */
function cleanApex(s, k) {
  let y = 0
  let v = 0
  let hand = 0
  let peak = 0
  for (let t = 0; t < 2; t += STEP) {
    hand += (cleanPull(t, s, k) - hand) * (1 - Math.exp(-STEP / MUSCLE_TAU))
    v += (hand - G) * STEP
    if (y <= 0 && v < 0) v = 0
    y = Math.max(0, y + v * STEP)
    if (y > peak) peak = y
    if (t > 0.7 * k && v < 0) break
  }
  return peak
}

/** Hand force the lifter wants this step (per unit mass, G = holding the weight). */
function handWant(rig, dt) {
  if (rig.mode === 'drag') {
    // the pointer is filtered first, so the bar never steps with the mouse
    rig.tfV += (POINTER_W * POINTER_W * (rig.target - rig.tf) - 2 * POINTER_W * rig.tfV) * dt
    rig.tf += rig.tfV * dt
    const to = Math.min(rig.tf, rig.liftCap, rig.maxLift)
    const v = rig.vy
    // force-velocity: a fast bar can't be pulled as hard; a falling one can be braked harder (eccentric)
    const up = v > 0 ? F_MAX * Math.max(0, 1 - v / V_MAX) : F_MAX * (1 + 0.3 * Math.min(-v, 1))
    return clamp(G + LIFT_K * (to - rig.y) - LIFT_C * v, F_DOWN, Math.max(F_DOWN, up))
  }
  if (rig.mode === 'clean') {
    const c = rig.clean
    c.t += dt
    if (c.ph === 'pull') {
      // the slack comes out of the bar: the plates knock on the sleeves
      if (c.t >= 0.045 && !c.knock) {
        c.knock = true
        for (const p of rig.plates) {
          p.rzV += sgn() * rand(0.35, 0.6)
          p.ryV += sgn() * rand(0.15, 0.3)
        }
      }
      if (c.t >= 0.68 * c.k) c.ph = 'float'
      return cleanPull(c.t, c.s, c.k)
    }
    if (c.ph === 'float') {
      if (rig.vy < 0.3) {
        c.ph = 'catch'
        c.tc = c.t
        c.yc = rig.y
      }
      return 0
    }
    if (c.ph === 'catch') {
      // the bar lands in the rack: the legs give a couple of cm, then stand; the hands open after a short hold
      const tt = c.t - c.tc
      const target = c.yc - CLEAN_DIP * hann(tt, 0, 0.42) - 0.01 * ss(0, 0.15, tt)
      if (tt > CLEAN_HOLD) {
        c.ph = 'none'
        rig.mode = 'fall'
        rig.settle = 0
        rig.followHold = true
        return rig.hand
      }
      return clamp(G + 260 * (target - rig.y) - 30 * rig.vy, 0, G + 30)
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
    rig.ai = 0
    rig.hand = G
    rig.lifted = false
  } else {
    const want = handWant(rig, dt)
    const tau = rig.mode === 'drag' || rig.mode === 'clean' ? MUSCLE_TAU : RELEASE_TAU
    rig.hand += (want - rig.hand) * (1 - Math.exp(-dt / tau))
    if (rig.mode !== 'drag' && rig.mode !== 'clean' && Math.abs(rig.hand) < 1e-4) rig.hand = 0
    // vertical: gravity, hands, floor contact. The contact is stiff (≈17 ms), so near the floor it gets 8 sub-steps
    // (otherwise the integrator under-damps it and the bumpers bounce like steel)
    const n = rig.y < 0.03 || rig.y + rig.vy * dt < 0.03 ? 8 : 1
    const h = dt / n
    let acSum = 0
    let aiSum = 0
    for (let k = 0; k < n; k++) {
      const touching = rig.y < 0
      const ac = touching ? Math.max(0, -CONTACT_W * CONTACT_W * rig.y - 2 * CONTACT_Z * CONTACT_W * rig.vy) : 0
      if (touching && !rig.inContact) {
        rig.contactT = 0
        if (rig.vy < -0.12) impact(rig, -rig.vy)
      }
      if (touching) rig.contactT += h
      rig.inContact = touching
      // the impulsive part of the floor's push (above holding the bar up), only during an impact: this is what
      // jolts the camera, kicks the plates and rolls the bar; a bar lying still drives nothing
      aiSum += touching && rig.contactT < IMPACT_T ? Math.max(0, ac - G) : 0
      acSum += ac
      rig.vy += (rig.hand - G + ac) * h
      rig.y += rig.vy * h
    }
    rig.ac = acSum / n
    rig.ai = aiSum / n
    rig.ay = rig.hand - G + rig.ac
    const touching = rig.inContact
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
  const ai = rig.ai || 0
  for (let i = 0; i < 3; i++) {
    const w = CAM_W[i]
    rig.camV[i] += (-w * w * rig.cam[i] - 2 * CAM_Z * w * rig.camV[i] + rig.camK[i] * ai) * dt
    rig.cam[i] += rig.camV[i] * dt
  }
  rig.swingXV += (-SWING_W * SWING_W * rig.swingX - 2 * SWING_Z * SWING_W * rig.swingXV + rig.swingKX * ai) * dt
  rig.swingX += rig.swingXV * dt
  rig.swingZV += (-SWING_W * SWING_W * rig.swingZ - 2 * SWING_Z * SWING_W * rig.swingZV + rig.swingKZ * ai) * dt
  rig.swingZ += rig.swingZV * dt

  // shaft whip: contact at the ends bows the middle down, the hands in the middle bow the ends down
  const ba = -BEND_W * BEND_W * rig.bend - 2 * BEND_Z * BEND_W * rig.bendV + BEND_K * ac - BEND_HAND * rig.hand
  rig.bendV += ba * dt
  rig.bend += rig.bendV * dt

  // plates rock on the sleeves (kicked by the contact force, swung by the bar's acceleration) and turn a little
  const swing = (rig.ay - ac) * 0.0016
  for (let i = 0; i < rig.plates.length; i++) {
    const p = rig.plates[i]
    const side = i < 3 ? -1 : 1
    const w = p.w
    p.rzV += (-w * w * (p.rz - swing * side) - 2 * WOB_Z * w * p.rzV + p.kz * ai) * dt
    p.rz += p.rzV * dt
    p.ryV += (-w * w * 0.8 * p.ry - 2 * WOB_Z * w * p.ryV + p.ky * ai) * dt
    p.ry += p.ryV * dt
    p.spinV += (p.ks * ai - p.spinV * 2.6) * dt
    p.spin += p.spinV * dt
  }

  // horizontal: rolls on the platform with rolling resistance, flies straight in the air, re-centred by a lifter
  const onFloor = rig.y < 0.0015
  let az = rig.skew * ai
  if (rig.mode === 'drag' || rig.mode === 'clean') az += -18 * rig.z - 7 * rig.vz
  else if (onFloor) az += -ROLL_MU * G * Math.tanh(rig.vz / ROLL_V0) - ROLL_C * rig.vz
  rig.vz += az * dt
  rig.z += rig.vz * dt
  if (onFloor) rig.spinV = rig.vz / PLATE_R // rolling without slipping
  rig.spin += rig.spinV * dt
}

/** Lamp power at `s` seconds after its strike (before the phosphor lag). */
function lampPower(s, table) {
  if (s < 0) return 0
  const first = table[0][0]
  // cathode glow: comes up on a smooth curve before the first flash
  let p = PREGLOW_LEVEL * ss(first - 0.11, first, s)
  for (let i = 0; i < table.length; i++) if (s >= table[i][0]) p = table[i][1]
  const on = table[table.length - 1][0]
  if (s >= on) p *= 0.84 + 0.16 * (1 - Math.exp(-(s - on) / WARM_TAU))
  return p
}
/** Phosphor + ballast: quick to light, slower to die. */
const phosphor = (cur, to, h) => cur + (to - cur) * (1 - Math.exp(-h / (to > cur ? 0.018 : 0.045)))

/** Lift framing: where the shot wants to be for this lift, and how it gets there. */
function crane(rig, h) {
  let to = 0
  if (!rig.reduced && rig.lifted && rig.frame) {
    // the operator frames where the lift is going (the hand's target), and leads the bar itself a little
    if (rig.mode === 'drag') to = followFor(Math.max(rig.y + rig.vy * FOLLOW_LEAD, Math.min(rig.tf, rig.maxLift)), rig.frame)
    else if (rig.mode === 'clean') to = followFor(rig.cleanFor ?? rig.cleanTop, rig.frame)
    else if (rig.followHold) to = rig.follow // let go: hold the frame until the bar lands
  }
  const w = to > rig.follow ? FOLLOW_W_UP : FOLLOW_W_DOWN
  rig.followV += (w * w * (to - rig.follow) - 2 * w * rig.followV) * h
  rig.followV = clamp(rig.followV, -FOLLOW_V_DOWN, FOLLOW_V_UP)
  rig.follow += rig.followV * h
  if (to === 0 && Math.abs(rig.follow) < 1e-5 && Math.abs(rig.followV) < 1e-4) rig.follow = rig.followV = 0
}

function fixedStep(rig, h) {
  rig.time += h
  if (rig.mode === 'hold' && rig.releaseAt >= 0 && rig.time >= rig.releaseAt) {
    rig.mode = 'fall'
    rig.hand = 0 // let go out of frame
  }
  substep(rig, h)
  crane(rig, h)
  if (!rig.reduced) {
    if (rig.strike >= 0) {
      const s = rig.time - rig.strike
      rig.light = phosphor(rig.light, lampPower(s, STRIKE_PENDANT), h)
      rig.wall = phosphor(rig.wall, lampPower(s, STRIKE_WALL), h)
    }
    spring(rig, 'dolly', 'dollyV', rig.dollyTo, DOLLY_W, h)
    spring(rig, 'lx', 'lxV', rig.px, LEAN_W, h)
    spring(rig, 'ly', 'lyV', rig.py, LEAN_W, h)
    spring(rig, 'exit', 'exitV', rig.exitIn, EXIT_W, h)
  }
}

/** Advance the simulation by `dt` seconds (clamped to 1/20 s) in exact 1/240 s steps; blend the view. */
export function stepRig(rig, dtIn) {
  const dt = clamp(dtIn, 0, DT_MAX)
  rig.acc += dt
  while (rig.acc >= STEP - 1e-9) {
    save(rig, rig.prev)
    fixedStep(rig, STEP)
    rig.acc = Math.max(0, rig.acc - STEP)
  }
  blend(rig, clamp(rig.acc / STEP, 0, 1))
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
  save(rig, rig.prev)
  blend(rig, 1)
}

/** Begin a power clean from the floor: the pull is fitted so the bar floats up to `cleanTop`. */
export function beginClean(rig) {
  const top = clamp(Math.min(rig.cleanTop, rig.maxLift), 0.2, LIFT_MAX)
  if (rig.cleanFor !== top) {
    // bisection on the pull's strength (a dry run of the same force profile), cached per height
    const k = Math.max(1, Math.sqrt(top / 0.66))
    let a = 0
    let b = 2.5
    for (let i = 0; i < 24; i++) {
      const m = (a + b) / 2
      if (cleanApex(m, k) < top) a = m
      else b = m
    }
    rig.cleanFor = top
    rig.cleanS = (a + b) / 2
    rig.cleanK = k
  }
  rig.mode = 'clean'
  rig.lifted = true
  rig.settle = 0
  const c = rig.clean
  c.ph = 'pull'
  c.t = 0
  c.s = rig.cleanS
  c.k = rig.cleanK
  c.knock = false
}

/** Begin a drag lift from wherever the bar is. */
export function beginDrag(rig) {
  rig.mode = 'drag'
  rig.lifted = true
  rig.tf = rig.target = Math.max(0, rig.y)
  rig.tfV = Math.max(0, rig.vy)
  rig.clean.ph = 'none'
}

/** Let go: the hands open over a few tens of ms and the bar keeps its velocity. */
export function release(rig) {
  if (rig.mode === 'drag' || rig.mode === 'clean' || rig.mode === 'hold') {
    if (rig.mode !== 'hold') rig.followHold = rig.y > 0.02
    rig.mode = 'fall'
    rig.clean.ph = 'none'
    rig.settle = 0
  }
}
