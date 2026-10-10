/**
 * Sled-pull physics, in metres and seconds. Pure (no DOM, no gsap) so it can be tuned in isolation.
 *
 * The handle is the athlete's hand. While the rope is slack the handle follows the pointer 1:1.
 * Once the rope is taut the hand can only advance at a human "hand speed" (screen speed is
 * compressed, since a 30 m track is ~1000 px and a mouse flick would otherwise read 80 m/s).
 * Rope tension: F = k·stretch + c·(hand − sled) while taut. The sled has mass and kinetic friction
 * on turf, so it coasts and stops after the hand lets go.
 */
export const TRACK_M = 30
export const MAX_V = 9.5
export const G = 9.81
export const MU = 0.17 // sled on turf: ~1.67 m/s² of braking, a 6 m/s sled coasts ~11 m
export const KAPPA = 18 // rope damping / sled mass (1/s): how hard a moving hand drags the sled
export const K_M = 0.7 // rope stiffness / sled mass (1/s²): a held, stretched rope alone cannot beat friction
export const STRETCH = 0.28 // max rope stretch as a fraction of its rest length
export const REST = 0.72 // handle distance from the sled at rest, as a fraction of rope length
export const YANK_U = 6.4 // hand speed of a keyboard "hard yank" (m/s)
export const YANK_T = 0.2 // its duration (s)

export const RATINGS = ['Warm-up pace', 'Working set', 'Explosive', 'Elite pull']
export const ratingIndex = (v) => (v >= 5 ? 3 : v >= 3 ? 2 : v >= 1.5 ? 1 : 0)

/** pointer speed (m/s at track scale) → hand speed (m/s). 3 s across the track ≈ 1.25, 0.2 s ≈ 6.8 */
export function handSpeed(vp) {
  const q = vp / TRACK_M
  if (!(q > 0.015)) return 0
  return Math.min(MAX_V, 2.5 * Math.pow(q, 0.62))
}

/** keyboard hold: ramps up to a steady strong pull */
export const keySpeed = (t) => Math.min(4.6, 2.3 + t * 5)

export function createSim() {
  return { s: 0, sv: 0, h: 0, hv: 0, L: 4, hMax: 31, gap: 0.2, tension: 0, glide: null }
}

/** Where a coasting sled will stop (no tension, kinetic friction only). */
export const stopPoint = (sim) => Math.min(TRACK_M, sim.s + (sim.sv > 0 ? (sim.sv * sim.sv) / (2 * MU * G) : 0))

/**
 * Hand let go: the handle skids to rest a little ahead of where the sled will stop, starting at the
 * sled's speed and braking evenly, so the gap closes smoothly and the rope sags as the sled coasts.
 */
export function releaseHandle(sim) {
  const h1 = Math.min(sim.hMax, Math.max(sim.h, stopPoint(sim) + sim.L * 0.5))
  const D = h1 - sim.h
  if (D < 0.01) {
    sim.hv = 0
    sim.glide = null
    return
  }
  let v0 = Math.max(0, sim.sv)
  if (v0 < 0.4) v0 = Math.sqrt(2 * 4 * D)
  sim.hv = v0
  sim.glide = { a: (v0 * v0) / (2 * D), h1 }
}

/**
 * Advance one sub-step.
 * input: { hand: bool, target: m (where the pointer wants the handle), u: hand speed m/s, free: bool
 *          (true → slack rope follows the target 1:1, false → slack is taken up at 9 m/s) }
 * Returns the impact speed if the sled hit the 30 m end this step, else 0.
 */
export function step(sim, dt, input) {
  const { L, gap, hMax } = sim
  const smax = L * STRETCH
  let drive = 0
  const h0 = sim.h

  if (input.hand) {
    sim.glide = null
    const target = Math.min(input.target, hMax)
    if (target <= sim.h + 1e-6) {
      sim.h = Math.max(target, sim.s + gap)
    } else {
      const taut = sim.s + L
      if (sim.h < taut) {
        sim.h = input.free ? Math.min(target, taut) : Math.min(target, taut, sim.h + 9 * dt)
      }
      if (target > sim.h + 1e-6 && sim.h >= taut - 1e-6) {
        const before = sim.h
        sim.h = Math.min(target, sim.h + input.u * dt, sim.s + L + smax)
        // the hand is still trying to move forward: it drives the rope
        if (input.u > 0 && (sim.h > before || sim.h >= sim.s + L + smax - 1e-6)) drive = input.u
      }
    }
  } else if (sim.glide) {
    const g = sim.glide
    const v = Math.max(0, sim.hv - g.a * dt)
    sim.h = Math.min(g.h1, sim.h + ((sim.hv + v) / 2) * dt)
    sim.hv = v
    if (v <= 0 || sim.h >= g.h1 - 1e-4) sim.glide = null
  } else if (sim.h - sim.s > L + smax) {
    // a dropped handle is light: an over-stretched rope just pulls it back
    sim.h -= (sim.h - sim.s - L - smax) * Math.min(1, dt * 12)
  }

  const d = sim.h - sim.s
  let T = 0
  if (input.hand && d > L) T = K_M * Math.min(d - L, smax) + KAPPA * Math.max(0, drive - sim.sv)
  sim.tension = T

  const fr = MU * G
  if (sim.sv > 0) {
    sim.sv += (T - fr) * dt
    if (sim.sv < 0 && T < fr) sim.sv = 0
  } else if (sim.sv < 0) {
    sim.sv += (T + fr) * dt
    if (sim.sv > 0 && T < fr) sim.sv = 0
  } else if (T > fr) {
    sim.sv += (T - fr) * dt
  }
  if (sim.sv > MAX_V) sim.sv = MAX_V
  sim.s += sim.sv * dt

  let hit = 0
  if (sim.s >= TRACK_M) {
    sim.s = TRACK_M
    if (sim.sv > 0) {
      hit = sim.sv
      sim.sv = -sim.sv * 0.2
    }
  } else if (sim.s < 0) {
    sim.s = 0
    if (sim.sv < 0) sim.sv = 0
  }
  if (sim.h > hMax) sim.h = hMax
  if (sim.h < sim.s + gap) {
    sim.h = sim.s + gap
    sim.glide = null
  }
  if (!sim.glide) sim.hv = dt > 0 ? (sim.h - h0) / dt : 0
  return hit
}
