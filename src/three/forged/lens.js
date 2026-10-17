import * as THREE from 'three'
import { BlendFunction, Effect } from 'postprocessing'

/*
 * Lens: heat shimmer and film grain in one merged effect (no extra full-screen pass).
 * Shimmer: hot air rises off glowing steel and refracts what is behind it. Each letter supplies a screen-space
 * column (centre x, top y, half width, strength); the image is displaced by slow, rising, smooth noise inside it.
 * Grain: very fine, per-frame, luminance-weighted, so flat darks never band and the frame breathes like film.
 */
const FRAG = /* glsl */ `
uniform vec4 uHot[5];
uniform float uT;
uniform float uGrain;
float lHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float lNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lHash(i), lHash(i + vec2(1.0, 0.0)), f.x), mix(lHash(i + vec2(0.0, 1.0)), lHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void mainUv(inout vec2 uv) {
  float m = 0.0;
  for (int i = 0; i < 5; i++) {
    vec4 h = uHot[i];
    if (h.w <= 0.001) continue;
    float dx = (uv.x - h.x) / h.z;
    float dy = uv.y - h.y;
    // the column of hot air: over the letter's upper part and rising above it, thinning as it goes
    m += h.w * exp(-dx * dx * 1.4) * smoothstep(-0.07, 0.0, dy) * exp(-max(dy, 0.0) * 7.0);
  }
  if (m > 0.0005) {
    vec2 q = vec2(uv.x * aspect * 42.0, uv.y * 30.0 - uT * 2.6);
    vec2 o = vec2(lNoise(q), lNoise(q * 1.7 + vec2(5.2, -uT * 1.1))) - 0.5;
    uv += o * min(m, 1.5) * 0.0032;
  }
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float g = lHash(uv * resolution + fract(uT * 7.31) * 413.0) + lHash(uv * resolution * 1.37 + fract(uT * 3.17) * 211.0) - 1.0;
  float l = dot(inputColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  outputColor = vec4(max(inputColor.rgb + g * uGrain * (0.12 + sqrt(l)), 0.0), inputColor.a);
}
`

export class LensEffect extends Effect {
  constructor() {
    const hot = []
    for (let i = 0; i < 5; i++) hot.push(new THREE.Vector4(0.5, 0.5, 0.1, 0))
    super('ForgedLens', FRAG, {
      blendFunction: BlendFunction.SET,
      uniforms: new Map([
        ['uHot', new THREE.Uniform(hot)],
        ['uT', new THREE.Uniform(0)],
        ['uGrain', new THREE.Uniform(0.014)],
      ]),
    })
  }
}
