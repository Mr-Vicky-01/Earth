import * as THREE from 'three'
import { BlendFunction, Effect } from 'postprocessing'

/**
 * The camera's response, in one effect that merges into the final post pass (after the bloom):
 *  - tone curve: Khronos PBR Neutral's highlight shoulder and desaturation (the chalk whites stay clean and neutral),
 *    with a softer toe. Neutral subtracts a black offset of 0.04 with a quadratic toe under 0.08: meant to remove
 *    the specular floor of a bright product shot, in a dim room it maps the rubber floor and the props (linear
 *    0.01 - 0.05) to near black and multiplies any slight tint in the shadows into navy. Here the offset is 0.02
 *    (the toe under 0.04), so the room keeps its shadow detail and its neutral colour.
 *  - natural vignetting: cos^4 of the angle off the lens axis, a little stronger than a pinhole (a fast lens open)
 *  - very fine film grain, even across the tones (added in a square-root space), animated
 * Linear HDR in, linear display-referred out (the pass encodes to sRGB).
 */
const frag = /* glsl */ `
uniform float uTime;
uniform float uGrain;
uniform float uVig;
uniform float uAspect;
uniform float uTanHalf;
uniform float uExposure;

float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 chalkTone(vec3 c) {
  c *= uExposure;
  const float K = 0.02;
  float x = min(c.r, min(c.g, c.b));
  float offset = x < 2.0 * K ? x - x * x / (4.0 * K) : K;
  c -= offset;
  const float start = 0.8 - K;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return c;
  const float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  c *= newPeak / peak;
  float g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
  return mix(c, vec3(newPeak), g);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = chalkTone(max(inputColor.rgb, 0.0));
  vec2 d = (uv - 0.5) * 2.0 * vec2(uAspect, 1.0) * uTanHalf;
  c *= 1.0 / pow(1.0 + uVig * dot(d, d), 2.0);
  float n = grainHash(gl_FragCoord.xy + floor(uTime * 60.0) * vec2(17.3, 41.7)) +
            grainHash(gl_FragCoord.xy * 1.31 + floor(uTime * 60.0) * vec2(29.1, 7.9)) - 1.0;
  vec3 g = max(sqrt(max(c, 0.0)) + n * uGrain, 0.0);
  outputColor = vec4(g * g, inputColor.a);
}
`

export class ChalkLensEffect extends Effect {
  constructor({ grain = 0.012, vignette = 1.7, exposure = 1 } = {}) {
    super('ChalkLensEffect', frag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['uTime', new THREE.Uniform(0)],
        ['uGrain', new THREE.Uniform(grain)],
        ['uVig', new THREE.Uniform(vignette)],
        ['uAspect', new THREE.Uniform(1.6)],
        ['uTanHalf', new THREE.Uniform(0.268)],
        ['uExposure', new THREE.Uniform(exposure)],
      ]),
    })
    this.animate = true
  }

  update(_renderer, _inputBuffer, deltaTime) {
    if (this.animate) this.uniforms.get('uTime').value += deltaTime || 0
  }

  setSize(width, height) {
    this.uniforms.get('uAspect').value = width / Math.max(1, height)
  }
}
