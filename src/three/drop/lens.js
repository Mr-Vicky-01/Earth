import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'

/**
 * The camera + air for THE DROP, in one effect that merges into the final post pass (no extra full-screen pass):
 *  - depth of field: a depth-aware gather (Vogel disc) that only runs where the circle of confusion is > 0.6 px,
 *    so the bar stays crisp and the wall, kit and floor go soft like a real lens focused on the bar. A tap only
 *    counts if its own blur reaches this pixel, so a sharp bar never bleeds into the soft background.
 *  - motion blur of the bar: a real exposure (1/60 s) of a rigid body. For every pixel near the bar, samples
 *    along the bar's own screen motion (from its world velocity, projected through the camera at the pixel's
 *    point on the bar's plane, centred on mid-exposure) ask "was the bar here at this instant?" by testing the
 *    depth buffer against the bar's envelope. Bar samples bring the bar's colour, the rest the background, so
 *    plates, print, hubs and steel all smear together and the smear runs past the silhouette both ways.
 *  - haze: single scattering of the pendant lamp in a lightly hazy room, integrated along each view ray up to
 *    the depth buffer with equiangular samples (inverse-square falloff, Henyey-Greenstein phase), shaped by the
 *    same barn-door cookie as the light on the floor; extra samples only where a ray passes near the lamp. The
 *    jitter is a fixed per-pixel pattern (no frame-to-frame boiling; the film grain hides it).
 *  - the platform's warm bounce lighting the low air: a broad, low layer over the lit pool (height and
 *    distance falloff, three samples through the slab), never a glowing point.
 *  - extinction toward the room's dim ambient haze with distance (atmospheric perspective), and exposure.
 * Sample counts are uniforms (the quality governor lowers them without recompiling). Linear HDR, before tone
 * mapping.
 */
export const DOF_MAX = 12
export const HAZE_MAX = 6
const MB_N = 20

const frag = /* glsl */ `
uniform vec3 uCam;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uViewProj;
uniform vec3 uLampPos;
uniform vec3 uLampX;
uniform vec3 uLampY;
uniform vec3 uLampAxis;
uniform float uLampTan;
uniform sampler2D uCookie;
uniform vec3 uLampCol;
uniform vec3 uPool;
uniform vec3 uBounceCol;
uniform vec3 uAmb;
uniform float uSigma;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uFocus;
uniform float uCocK;
uniform float uCocMax;
uniform float uDofN;
uniform float uHazeN;
uniform float uExposure;
uniform float uMbOn;
uniform vec4 uMbBox;
uniform vec3 uBarPos;
uniform vec3 uBarMove;
uniform float uBend;

float dropCoc(float vz) {
  return min(uCocMax, uCocK * abs(1.0 / uFocus - 1.0 / max(-vz, 0.05)));
}
float dropIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
// white-ish per-pixel hash (no diagonal structure, for the motion-blur taps)
float dropHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec3 dropWorld(vec2 uv, float d) {
  vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return (uCamWorld * vec4(vp.xyz / vp.w, 1.0)).xyz;
}
vec2 dropUv(vec3 p) {
  vec4 c = uViewProj * vec4(p, 1.0);
  return c.xy / c.w * 0.5 + 0.5;
}
// is the surface seen at uv part of the bar (shaft, sleeves, collars, plates)?
float dropIsBar(vec2 uv) {
  vec3 q = dropWorld(uv, readDepth(uv)) - uBarPos;
  if (q.y + uBarPos.y < 0.004) return 0.0; // the platform under it
  float ax = abs(q.x);
  float r = length(q.yz);
  float lim = ax > 0.645 ? 0.233 : 0.045 + abs(uBend);
  return (ax < 1.112 && r < lim) ? 1.0 : 0.0;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 col = inputColor.rgb;
  float jit = dropIgn(gl_FragCoord.xy);

  float c0 = dropCoc(getViewZ(depth));
  if (c0 > 0.6 && uDofN > 0.5) {
    vec3 acc = col;
    float wsum = 1.0;
    float rot = jit * 6.2831853;
    for (int i = 0; i < ${DOF_MAX}; i++) {
      if (float(i) >= uDofN) break;
      float fi = float(i) + 0.5;
      float r = sqrt(fi / uDofN) * c0;
      float a = fi * 2.3999632 + rot;
      vec2 suv = uv + vec2(cos(a), sin(a)) * r * texelSize;
      float cs = dropCoc(getViewZ(readDepth(suv)));
      float w = clamp(cs - r + 1.0, 0.0, 1.0);
      acc += texture2D(inputBuffer, suv).rgb * w;
      wsum += w;
    }
    col = acc / wsum;
  }

  // motion blur of the bar (only near it, only while it moves)
  if (uMbOn > 0.5 && uv.x > uMbBox.x && uv.y > uMbBox.y && uv.x < uMbBox.z && uv.y < uMbBox.w) {
    vec3 far = dropWorld(uv, 1.0);
    vec3 rd = normalize(far - uCam);
    float tp = (uBarPos.z - uCam.z) / (abs(rd.z) > 1e-4 ? rd.z : 1e-4);
    vec3 pp = uCam + rd * max(tp, 0.1);
    vec2 dv = dropUv(pp + uBarMove * 0.5) - dropUv(pp - uBarMove * 0.5);
    if (dot(dv / texelSize, dv / texelSize) > 0.5) {
      float self = dropIsBar(uv);
      vec3 bar = vec3(0.0);
      float nb = 0.0;
      vec3 bgs = vec3(0.0);
      float ng = 0.0;
      float mj = dropHash(gl_FragCoord.xy);
      for (int i = 0; i < ${MB_N}; i++) {
        float s = (float(i) + mj) / ${MB_N}.0 - 0.5;
        vec2 suv = uv - dv * s;
        vec3 c = texture2D(inputBuffer, suv).rgb;
        if (dropIsBar(suv) > 0.5) {
          bar += c;
          nb += 1.0;
        } else {
          bgs += c;
          ng += 1.0;
        }
      }
      vec3 bg = self > 0.5 ? (ng > 0.0 ? bgs / ng : col) : col;
      col = (bar + bg * (${MB_N}.0 - nb)) / ${MB_N}.0;
    }
  }

  // the view ray to this pixel's surface
  vec3 wp = dropWorld(uv, depth);
  vec3 dvw = wp - uCam;
  float D = length(dvw);
  vec3 rd = dvw / max(D, 1e-4);
  D = min(D, 30.0);
  float T = exp(-uSigma * D);

  // the lamp's beam: equiangular samples round the point of closest approach (twice as many near the lamp)
  float t0 = dot(uLampPos - uCam, rd);
  float h = max(length(uCam + rd * t0 - uLampPos), 0.1); // the lamp is a 25 cm lens, not a point
  float a0 = atan(-t0 / h);
  float a1 = atan((D - t0) / h);
  float n = uHazeN * (h < 0.9 ? 2.0 : 1.0);
  float sum = 0.0;
  for (int i = 0; i < ${HAZE_MAX * 2}; i++) {
    if (float(i) >= n) break;
    float th = mix(a0, a1, (float(i) + jit) / n);
    vec3 p = uCam + rd * (t0 + h * tan(th));
    vec3 l = normalize(p - uLampPos);
    float cz = dot(l, uLampAxis);
    if (cz > 0.3) {
      vec2 c = vec2(dot(l, uLampX), dot(l, uLampY)) / (cz * uLampTan) * 0.5 + 0.5;
      vec2 inb = step(vec2(0.0), c) * step(c, vec2(1.0));
      float k = texture2D(uCookie, c).r * inb.x * inb.y;
      // drifting haze: two slow noise layers (air moving a few cm a second)
      float nz = texture2D(uNoise, p.xz * 0.23 + vec2(uTime * 0.021, uTime * 0.011)).r
               * texture2D(uNoise, p.xy * 0.31 + vec2(-uTime * 0.016, uTime * 0.024)).g;
      float dens = 0.35 + 2.6 * nz;
      // Henyey-Greenstein, g = 0.35 (haze scatters forward)
      float ct = dot(l, -rd);
      float ph = 0.8775 / pow(1.1225 - 0.7 * ct, 1.5);
      sum += k * dens * ph;
    }
  }
  vec3 ins = uLampCol * sum * (a1 - a0) / (h * n);

  // the lit platform's warm bounce in the low air: a broad layer over the pool, through the slab y 0..1.3 m
  {
    float ry = abs(rd.y) > 1e-4 ? rd.y : 1e-4;
    float ta = (0.0 - uCam.y) / ry;
    float tb = (1.3 - uCam.y) / ry;
    float s0 = max(0.0, min(ta, tb));
    float s1 = min(D, max(ta, tb));
    if (s1 > s0) {
      float e = 0.0;
      for (int i = 0; i < 3; i++) {
        vec3 p = uCam + rd * mix(s0, s1, (float(i) + jit) / 3.0);
        vec2 dxz = (p.xz - uPool.xy) / vec2(1.25, 0.75);
        e += exp(-max(p.y, 0.0) / 0.45) * exp(-0.5 * dot(dxz, dxz));
      }
      ins += uBounceCol * e * (s1 - s0) / 3.0;
    }
  }

  outputColor = vec4((col * T + uAmb * (1.0 - T) + ins) * uExposure, inputColor.a);
}
`

export class DropLensEffect extends Effect {
  constructor({ cookie, noise } = {}) {
    super('DropLensEffect', frag, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      uniforms: new Map([
        ['uCam', new THREE.Uniform(new THREE.Vector3())],
        ['uInvProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uViewProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uLampPos', new THREE.Uniform(new THREE.Vector3(0, 4.4, 0))],
        ['uLampX', new THREE.Uniform(new THREE.Vector3(1, 0, 0))],
        ['uLampY', new THREE.Uniform(new THREE.Vector3(0, 0, -1))],
        ['uLampAxis', new THREE.Uniform(new THREE.Vector3(0, -1, 0))],
        ['uLampTan', new THREE.Uniform(0.4)],
        ['uCookie', new THREE.Uniform(cookie)],
        ['uLampCol', new THREE.Uniform(new THREE.Vector3())],
        ['uPool', new THREE.Uniform(new THREE.Vector3(0, -0.16, 0))],
        ['uBounceCol', new THREE.Uniform(new THREE.Vector3())],
        ['uAmb', new THREE.Uniform(new THREE.Vector3())],
        ['uSigma', new THREE.Uniform(0.03)],
        ['uNoise', new THREE.Uniform(noise)],
        ['uTime', new THREE.Uniform(0)],
        ['uFocus', new THREE.Uniform(2.5)],
        ['uCocK', new THREE.Uniform(0)],
        ['uCocMax', new THREE.Uniform(6)],
        ['uDofN', new THREE.Uniform(DOF_MAX)],
        ['uHazeN', new THREE.Uniform(HAZE_MAX)],
        ['uExposure', new THREE.Uniform(1)],
        ['uMbOn', new THREE.Uniform(0)],
        ['uMbBox', new THREE.Uniform(new THREE.Vector4())],
        ['uBarPos', new THREE.Uniform(new THREE.Vector3())],
        ['uBarMove', new THREE.Uniform(new THREE.Vector3())],
        ['uBend', new THREE.Uniform(0)],
      ]),
    })
  }
}
