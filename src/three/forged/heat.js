/**
 * Forging colour temperatures, shared by the WebGL scene (emission ramp) and the HTML readout.
 *
 * Temperature is a 0..1 "heat" value: 0 = cold steel, 1 = white heat. The colour stops follow a smith's chart:
 * dull red ≈ 550 °C, cherry ≈ 750 °C, orange ≈ 950 °C, yellow ≈ 1,100 °C, white ≈ 1,300 °C.
 * The same stops live in GLSL (see shaders.js) so the readout swatch matches what the steel shows.
 */

// t, linear r, g, b
export const RAMP = [
  [0.0, 0, 0, 0],
  [0.06, 0.1, 0.004, 0],
  [0.15, 0.4, 0.02, 0.004],
  [0.35, 0.95, 0.07, 0.012],
  [0.55, 1.0, 0.2, 0.03],
  [0.75, 1.0, 0.5, 0.1],
  [1.0, 1.0, 0.86, 0.62],
]

// heat → °C (below ≈420 °C steel shows no glow, so the first visible stop starts there)
const CELSIUS = [
  [0, 21],
  [0.04, 420],
  [0.15, 550],
  [0.35, 750],
  [0.55, 950],
  [0.75, 1100],
  [1.0, 1300],
  [1.25, 1360],
]

const lerpStops = (stops, t, col) => {
  if (t <= stops[0][0]) return stops[0][col]
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]
    if (t <= b[0]) {
      const a = stops[i - 1]
      return a[col] + ((b[col] - a[col]) * (t - a[0])) / (b[0] - a[0])
    }
  }
  return stops[stops.length - 1][col]
}

/** heat 0..1.25 → degrees Celsius */
export const heatToCelsius = (t) => lerpStops(CELSIUS, t, 1)

/** Writes the linear blackbody colour for heat t into out[0..2]; returns out. */
export function blackbody(t, out) {
  const c = Math.min(Math.max(t, 0), 1)
  out[0] = lerpStops(RAMP, c, 1)
  out[1] = lerpStops(RAMP, c, 2)
  out[2] = lerpStops(RAMP, c, 3)
  return out
}

/** Emission gain for heat t (matches hfHeatGain in GLSL). */
export const heatGain = (t) => 0.2 + 7.5 * Math.pow(Math.max(t, 0), 2.2)

const toSrgb = (v) => {
  const x = Math.min(Math.max(v, 0), 1)
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}

const tmp = [0, 0, 0]
/**
 * CSS colour for the readout swatch: the glow colour at heat t, normalised so its brightest channel is 1,
 * blended toward satin steel grey while it's cold.
 */
export function swatchCss(t) {
  blackbody(t, tmp)
  const m = Math.max(tmp[0], tmp[1], tmp[2], 1e-6)
  const glow = Math.min(1, t / 0.12)
  const steel = 0.62 // linear grey of satin steel
  const r = toSrgb((tmp[0] / m) * glow + steel * (1 - glow))
  const g = toSrgb((tmp[1] / m) * glow + steel * (1 - glow))
  const b = toSrgb((tmp[2] / m) * glow + steel * 1.04 * (1 - glow))
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`
}
