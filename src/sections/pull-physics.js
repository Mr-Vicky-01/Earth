/**
 * Sled-pull physics. Pure (no DOM, no gsap) so it can be tuned in isolation.
 *
 * Two scales live side by side:
 *  - the WORLD: metres on the turf. The camera scrolls it, ticks are labelled in it, Distance reads it.
 *    The sled moves through it fast (a hard flick launches it down the whole 30 m lane in about a second).
 *  - the CLOCK: the m/s the sensor shows. It is a compressed read of the sled's world speed
 *    (`clocked(w)`), so a lazy tow reads ~1 m/s and a hard flick ~6–7 m/s, never more than MAX_V.
 *
 * The hand (handle) is wherever the pointer is. The rope is a stiff spring + damper that only pulls
 * once it is longer than its rest length L, so the sled lunges after the hand and tows behind it.
 * Off the rope the sled coasts against turf drag (linear) and kinetic friction (constant), which
 * gives a punchy launch and a short, decisive stop. A dropped handle recoils to a slack rest gap
 * ahead of the sled and rides along with it.
 */
export const TRACK_M = 30
export const MAX_V = 9.5

// clocked speed: VCAP·(1 − e^(−(q/Q0)^E)), q = sled speed in track-widths per second, so the same
// effort reads the same on a phone and a desktop. Generous when slow, saturating when fast.
export const VCAP = 8.6
export const Q0 = 2.4
const E = 0.85

// rope (per unit sled mass): stiffness 1/s², damping 1/s, max force-bearing stretch in m
export const K = 720
export const C = 40
export const SMAX = 2.2
// coasting: linear turf drag 1/s, kinetic friction m/s² (world)
export const CD = 2.1
export const FR = 12.5
export const W_MAX = 160 // world m/s hard cap
export const REST = 0.62 // dropped-handle gap ahead of the sled, as a fraction of L
export const FINISH_V = 0.6 // clocked m/s under which the result is called (the sled settles on its own)
export const RIP_V = 5 // world m/s: a sled closing on a stopped hand faster than this tears the handle away

export const RATINGS = ['Warm-up pace', 'Working set', 'Explosive', 'Elite pull']
export const ratingIndex = (v) => (v >= 5 ? 3 : v >= 3 ? 2 : v >= 1.5 ? 1 : 0)

/** world m/s → clocked m/s; vis = metres of turf across the track */
export const clocked = (w, vis) => (w > 0 ? Math.min(MAX_V, VCAP * (1 - Math.exp(-Math.pow(w / vis / Q0, E)))) : 0)
/** clocked m/s → world m/s (keyboard pulls aim at a clocked speed) */
export const worldFor = (v, vis) => Q0 * vis * Math.pow(-Math.log(1 - Math.min(v, VCAP * 0.985) / VCAP), 1 / E)

/** keyboard hold: ramps to a steady strong pull (clocked m/s) */
export const keySpeed = (t) => Math.min(4.6, 2.4 + t * 6)
export const YANK_V = 7.3 // clocked m/s of the hand in an Enter "hard yank"
export const YANK_T = 0.2 // its duration (s)

/**
 * s, w: sled front (m) and speed (world m/s) · h, hv: handle (m) and its speed · gv: dropped handle's
 * speed relative to the sled · L: rope rest length · gap: closest the handle gets to the sled ·
 * hMax: furthest the handle may go · fr: friction (scaled per track) · rip: set when a fast sled tore
 * the handle out of the hand (the caller ends the drag and clears it)
 */
export function createSim() {
  return { s: 0, w: 0, h: 1.6, hv: 0, gv: 0, L: 2.6, gap: 0.1, hMax: 33, fr: FR, tension: 0, rip: false }
}

/** where a coasting sled stops: integral of dw/dt = −CD·w − FR from w to 0 */
export function stopDistance(w, fr = FR) {
  if (!(w > 0)) return 0
  const t = Math.log(1 + (CD * w) / fr) / CD
  return (w - fr * t) / CD
}

/**
 * Advance one sub-step.
 * input: { held: bool, h: hand position (m, world) while held, hv: hand velocity (m/s, world) }
 * Returns the impact speed (world m/s) if the sled hit the 30 m end this step, else 0.
 */
export function step(sim, dt, input) {
  const { L, gap } = sim
  if (input.held) {
    sim.h = Math.min(sim.hMax, Math.max(input.h, sim.s + gap))
    sim.hv = input.hv
    sim.gv = sim.hv - sim.w
  }

  const d = sim.h - sim.s
  let T = 0
  if (input.held && d > L) T = Math.max(0, K * Math.min(d - L, SMAX) + C * (sim.hv - sim.w))
  sim.tension = T

  const fr = sim.fr
  let w = sim.w
  if (w > 0) {
    w += (T - CD * w - fr) * dt
    if (w < 0 && T < fr) w = 0
  } else if (w < 0) {
    w += (T - CD * w + fr) * dt
    if (w > 0 && T < fr) w = 0
  } else if (T > fr) {
    w += (T - fr) * dt
  }
  if (w > W_MAX) w = W_MAX
  sim.w = w
  sim.s += w * dt

  // a held hand is a wall for a slow sled; a fast one tears the handle out of it (sim.rip)
  if (input.held && sim.s > sim.h - gap) {
    if (sim.w - sim.hv > RIP_V) {
      sim.rip = true
      sim.h = sim.s + gap
    } else {
      sim.s = sim.h - gap
      if (sim.w > sim.hv) sim.w = Math.max(0, sim.hv)
    }
  }

  let hit = 0
  if (sim.s >= TRACK_M) {
    sim.s = TRACK_M
    if (sim.w > 2) {
      hit = sim.w
      sim.w = -sim.w * 0.16
    } else if (sim.w > 0) sim.w = 0
  } else if (sim.s < 0) {
    sim.s = 0
    if (sim.w < 0) sim.w = 0
  }

  if (!input.held) {
    // dropped handle: the gap springs back to a slack rest (a stretched rope recoils) and rides along
    let g = sim.h - sim.s
    const gRest = L * REST
    const om = 15
    sim.gv += (om * om * (gRest - g) - 2 * 0.72 * om * sim.gv) * dt
    g += sim.gv * dt
    if (g < gap) {
      g = gap
      if (sim.gv < 0) sim.gv = 0
    }
    if (sim.s + g >= sim.hMax) {
      g = sim.hMax - sim.s
      if (sim.gv > 0) sim.gv = 0
    }
    sim.h = sim.s + g
    sim.hv = sim.w + sim.gv
  }
  return hit
}
