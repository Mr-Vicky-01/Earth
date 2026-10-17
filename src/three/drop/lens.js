import * as THREE from 'three'
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing'

/**
 * The camera + air for THE DROP, in one effect that merges into the final post pass (no extra full-screen pass):
 *  - depth of field: a depth-aware gather (Vogel disc) that only runs where the circle of confusion is > 0.6 px,
 *    so the bar stays crisp and the wall, rig and floor go soft like a real lens focused on the bar. A tap only
 *    counts if its own blur reaches this pixel, so a sharp bar never bleeds into the soft background.
 *  - haze: single scattering of the pendant lamp in a lightly hazy room, integrated along each view ray up to
 *    the depth buffer with equiangular samples (inverse-square falloff, Henyey-Greenstein phase), shaped by the
 *    same barn-door cookie as the light on the floor; plus a closed-form glow from the light bouncing off the
 *    platform, and extinction toward the room's dim ambient haze with distance (atmospheric perspective).
 * Everything is in linear HDR before tone mapping.
 */
const frag = /* glsl */ `
uniform vec3 uCam;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uLampPos;
uniform vec3 uLampX;
uniform vec3 uLampY;
uniform vec3 uLampAxis;
uniform float uLampTan;
uniform sampler2D uCookie;
uniform vec3 uLampCol;
uniform vec3 uBouncePos;
uniform vec3 uBounceCol;
uniform vec3 uAmb;
uniform float uSigma;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uFrame;
uniform float uFocus;
uniform float uCocK;
uniform float uCocMax;

float dropCoc(float vz) {
  return min(uCocMax, uCocK * abs(1.0 / uFocus - 1.0 / max(-vz, 0.05)));
}
float dropIgn(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 col = inputColor.rgb;

#if DOF_TAPS > 0
  float c0 = dropCoc(getViewZ(depth));
  if (c0 > 0.6) {
    vec3 acc = col;
    float wsum = 1.0;
    float rot = dropIgn(gl_FragCoord.xy) * 6.2831853;
    for (int i = 0; i < DOF_TAPS; i++) {
      float fi = float(i) + 0.5;
      float r = sqrt(fi / float(DOF_TAPS)) * c0;
      float a = fi * 2.3999632 + rot;
      vec2 suv = uv + vec2(cos(a), sin(a)) * r * texelSize;
      float cs = dropCoc(getViewZ(readDepth(suv)));
      float w = clamp(cs - r + 1.0, 0.0, 1.0);
      acc += texture2D(inputBuffer, suv).rgb * w;
      wsum += w;
    }
    col = acc / wsum;
  }
#endif

  // the view ray to this pixel's surface
  vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 wp = (uCamWorld * vec4(vp.xyz / vp.w, 1.0)).xyz;
  vec3 dv = wp - uCam;
  float D = length(dv);
  vec3 rd = dv / max(D, 1e-4);
  D = min(D, 30.0);
  float T = exp(-uSigma * D);

  // the lamp's beam: equiangular samples round the point of closest approach
  float t0 = dot(uLampPos - uCam, rd);
  float h = max(length(uCam + rd * t0 - uLampPos), 0.02);
  float a0 = atan(-t0 / h);
  float a1 = atan((D - t0) / h);
  float jit = dropIgn(gl_FragCoord.xy + vec2(17.0, 31.0) * mod(uFrame, 64.0));
  float sum = 0.0;
  for (int i = 0; i < HAZE_N; i++) {
    float th = mix(a0, a1, (float(i) + jit) / float(HAZE_N));
    vec3 p = uCam + rd * (t0 + h * tan(th));
    vec3 l = normalize(p - uLampPos);
    float cz = dot(l, uLampAxis);
    if (cz > 0.3) {
      vec2 c = vec2(dot(l, uLampX), dot(l, uLampY)) / (cz * uLampTan) * 0.5 + 0.5;
      vec2 inb = step(vec2(0.0), c) * step(c, vec2(1.0));
      float k = texture2D(uCookie, c).r * inb.x * inb.y;
      // drifting haze: two slow noise layers
      float n = texture2D(uNoise, p.xz * 0.23 + vec2(uTime * 0.011, uTime * 0.006)).r
              * texture2D(uNoise, p.xy * 0.31 + vec2(-uTime * 0.008, uTime * 0.012)).g;
      float dens = 0.4 + 2.4 * n;
      // Henyey-Greenstein, g = 0.35 (haze scatters forward)
      float ct = dot(l, -rd);
      float ph = 0.8775 / pow(1.1225 - 0.7 * ct, 1.5);
      sum += k * dens * ph;
    }
  }
  vec3 ins = uLampCol * sum * (a1 - a0) / (h * float(HAZE_N));

  // light bouncing off the bright platform lights the low haze (closed form, no samples)
  float tb = dot(uBouncePos - uCam, rd);
  float hb = max(length(uCam + rd * tb - uBouncePos), 0.05);
  ins += uBounceCol * (atan((D - tb) / hb) - atan(-tb / hb)) / hb;

  outputColor = vec4(col * T + uAmb * (1.0 - T) + ins, inputColor.a);
}
`

export class DropLensEffect extends Effect {
  constructor({ cookie, noise, haze = 6, dof = 12 } = {}) {
    super('DropLensEffect', frag, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
      defines: new Map([
        ['HAZE_N', String(haze)],
        ['DOF_TAPS', String(dof)],
      ]),
      uniforms: new Map([
        ['uCam', new THREE.Uniform(new THREE.Vector3())],
        ['uInvProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uLampPos', new THREE.Uniform(new THREE.Vector3(0, 4.4, 0))],
        ['uLampX', new THREE.Uniform(new THREE.Vector3(1, 0, 0))],
        ['uLampY', new THREE.Uniform(new THREE.Vector3(0, 0, -1))],
        ['uLampAxis', new THREE.Uniform(new THREE.Vector3(0, -1, 0))],
        ['uLampTan', new THREE.Uniform(0.4)],
        ['uCookie', new THREE.Uniform(cookie)],
        ['uLampCol', new THREE.Uniform(new THREE.Vector3())],
        ['uBouncePos', new THREE.Uniform(new THREE.Vector3(0, 0.1, -0.15))],
        ['uBounceCol', new THREE.Uniform(new THREE.Vector3())],
        ['uAmb', new THREE.Uniform(new THREE.Vector3())],
        ['uSigma', new THREE.Uniform(0.03)],
        ['uNoise', new THREE.Uniform(noise)],
        ['uTime', new THREE.Uniform(0)],
        ['uFrame', new THREE.Uniform(0)],
        ['uFocus', new THREE.Uniform(2.5)],
        ['uCocK', new THREE.Uniform(0)],
        ['uCocMax', new THREE.Uniform(6)],
      ]),
    })
  }
}
