import * as THREE from 'three'
import { NOISE } from './shaders'

/*
 * The forge workshop around the word: a soot-stained brick back wall (and a side wall the phone camera sees),
 * a rack of tongs and hammers lit by the forge, out-of-focus props (an anvil on its stump, a hoist chain), and
 * a floor of cast-iron plates with a rough, blurred reflection and contact shadows.
 *
 * Scale: 1 world unit = 0.5 m (the letters' cap height). Everything is lit by the same few lights with
 * inverse-square falloff: the forge (off-screen left, flickering), a dim cool window high on the right, and the
 * hot letters themselves. The same lights scatter in the haze between the camera and every surface, so hot
 * steel glows in the air instead of only in the lens. Background surfaces are shaded out of focus by
 * construction (detail is filtered by the circle of confusion), so no depth-of-field pass is needed.
 */

export const WALL_Z = -10
export const SIDE_X = 13
export const NLIGHTS = 7 // 0 forge, 1 window, 2..6 letters
export const FORGE_POS = [-10.2, 1.45, -8.9] // the fire bed in the hearth, off-screen left (y is world)
export const WINDOW_POS = [9, 6.4, -5]

/* ------------------------------------------------------------------ */
/* GLSL shared by every workshop surface                               */
/* ------------------------------------------------------------------ */
export const WORLD_PARS = /* glsl */ `
uniform vec4 uLPos[${NLIGHTS}]; // xyz, softening radius² (area sources)
uniform vec3 uLCol[${NLIGHTS}]; // linear colour × intensity
uniform vec4 uHaze;  // x extinction per unit, y in-scatter gain, z smoke, w time (s)
uniform vec3 uHazeCol;
uniform vec3 uAmb;
uniform vec2 uFocus; // focus distance, lens aperture (world units)
uniform float uFloorY;
uniform float uMirror;
${NOISE}
// in-scattered light from a point source along a ray segment (closed form of the airlight integral)
float hfAir(vec3 o, vec3 d, float T, vec3 L, float r2) {
  vec3 q = L - o;
  float b = dot(q, d);
  float h = sqrt(max(dot(q, q) - b * b, 0.0) + r2);
  return (atan((T - b) / h) + atan(b / h)) / h;
}
// irradiance from every light; light index 0 (the forge) is returned separately so it can be shadowed
vec3 hfIrr(vec3 p, vec3 n, out vec3 forge) {
  vec3 e = uAmb * (0.55 + 0.45 * n.y);
  forge = vec3(0.0);
  for (int i = 0; i < ${NLIGHTS}; i++) {
    vec3 q = uLPos[i].xyz - p;
    float qq = dot(q, q);
    // a little wrap: these are area sources, they light a touch past the terminator
    float c = clamp((dot(n, q) * inversesqrt(qq) + 0.08) / 1.08, 0.0, 1.0);
    vec3 v = uLCol[i] * c / (qq + uLPos[i].w);
    if (i == 0) forge = v;
    else e += v;
  }
  return e;
}
vec3 hfIrrIso(vec3 p) {
  vec3 e = uAmb;
  for (int i = 0; i < ${NLIGHTS}; i++) {
    vec3 q = uLPos[i].xyz - p;
    e += uLCol[i] * 0.5 / (dot(q, q) + uLPos[i].w);
  }
  return e;
}
// circle of confusion at p, in world units at that distance
float hfCoc(vec3 p) {
  float d = distance(cameraPosition, p);
  return uFocus.y * abs(d - uFocus.x) / max(d, 0.1);
}
// haze between the camera and p: extinction, plus light scattered toward the eye, broken up by drifting smoke
vec3 hfAtmos(vec3 col, vec3 p) {
  vec3 o = cameraPosition;
  vec3 d = p - o;
  float T = length(d);
  d /= T;
  float tr = exp(-uHaze.x * T);
  vec3 s = vec3(0.0);
  for (int i = 0; i < ${NLIGHTS}; i++) s += uLCol[i] * hfAir(o, d, T, uLPos[i].xyz, uLPos[i].w + 0.25);
  float t = uHaze.w;
  vec3 sp = o + d * min(T, 24.0) * 0.72;
  float sm = hfFbm(sp * vec3(0.32, 0.5, 0.32) + vec3(t * 0.035, -t * 0.09, t * 0.025));
  float smoke = mix(1.0, 0.25 + 1.6 * sm * sm, uHaze.z);
  return col * tr + s * uHaze.y * smoke + uHazeCol * (1.0 - tr);
}
float hfBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float hfSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
float hfSmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
// height above the floor, stored in alpha during the reflection pass (the floor blurs by it)
float hfMirrorA(float y) { return uMirror > 0.5 ? clamp((y - uFloorY) * 0.25, 0.0, 1.0) : 1.0; }
`

const SURF_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
varying vec2 vL;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vL = position.xy;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

/* ------------------------------------------------------------------ */
/* Walls: soot-stained brick, raking forge light, a rack of tools      */
/* ------------------------------------------------------------------ */
const WALL_FRAG = /* glsl */ `
${WORLD_PARS}
uniform float uRack;
varying vec3 vW;
varying vec3 vN;
// tools hanging on a rail near the forge, in wall coordinates (x, height above the floor)
float hfTools(vec2 p) {
  if (p.x < -7.4 || p.x > -2.9 || p.y < 0.55 || p.y > 2.4) return 1.0;
  float d = hfBox(p - vec2(-5.2, 2.2), vec2(1.95, 0.042)) - 0.006;
  // tongs
  d = min(d, hfSeg(p, vec2(-6.62, 2.17), vec2(-6.71, 1.0)) - 0.015);
  d = min(d, hfSeg(p, vec2(-6.55, 2.17), vec2(-6.47, 1.0)) - 0.015);
  d = min(d, hfSeg(p, vec2(-6.71, 1.0), vec2(-6.6, 0.8)) - 0.021);
  d = min(d, hfSeg(p, vec2(-6.47, 1.0), vec2(-6.57, 0.8)) - 0.021);
  d = min(d, length(p - vec2(-6.59, 1.02)) - 0.03);
  // sledge
  d = min(d, hfSeg(p, vec2(-5.98, 2.18), vec2(-5.98, 1.3)) - 0.022);
  d = min(d, hfBox(p - vec2(-5.98, 1.24), vec2(0.14, 0.06)) - 0.01);
  // long tongs, hung a little askew
  d = min(d, hfSeg(p, vec2(-5.33, 2.17), vec2(-5.5, 0.82)) - 0.014);
  d = min(d, hfSeg(p, vec2(-5.25, 2.17), vec2(-5.2, 0.82)) - 0.014);
  d = min(d, hfSeg(p, vec2(-5.5, 0.82), vec2(-5.37, 0.64)) - 0.02);
  d = min(d, hfSeg(p, vec2(-5.2, 0.82), vec2(-5.3, 0.64)) - 0.02);
  // cross-pein hammer
  d = min(d, hfSeg(p, vec2(-4.6, 2.18), vec2(-4.6, 1.5)) - 0.019);
  d = min(d, hfBox(p - vec2(-4.6, 1.45), vec2(0.105, 0.045)) - 0.008);
  // fuller
  d = min(d, hfSeg(p, vec2(-4.05, 2.18), vec2(-4.05, 1.62)) - 0.017);
  d = min(d, hfBox(p - vec2(-4.05, 1.56), vec2(0.05, 0.07)) - 0.01);
  // poker with a hook
  d = min(d, hfSeg(p, vec2(-3.42, 2.18), vec2(-3.42, 0.95)) - 0.012);
  d = min(d, max(abs(length(p - vec2(-3.34, 0.95)) - 0.08) - 0.012, p.y - 0.95));
  return d;
}
void main() {
  vec3 p = vW;
  vec3 N = normalize(vN);
  bool back = N.z > 0.5;
  vec3 Tg = back ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec2 wc = vec2(back ? p.x : p.z, p.y - uFloorY);
  float bl = max(hfCoc(p), length(fwidth(wc)) * 0.7);
  float t = uHaze.w;

  // running bond: 215 x 65 mm bricks, 10 mm joints
  const float CH = 0.15;
  const float BL = 0.45;
  const float MW = 0.011;
  float row = floor(wc.y / CH);
  float u = wc.x / BL + 0.5 * mod(row, 2.0) + (back ? 0.0 : 0.27);
  vec2 id = vec2(floor(u), row);
  vec2 f = vec2(fract(u) * BL, fract(wc.y / CH) * CH);
  vec2 e = min(f, vec2(BL, CH) - f);
  float ed = min(e.x, e.y);
  float brick = smoothstep(MW - bl, MW + bl, ed);
  // worn arrises: the face rolls down into the joint; blur flattens the relief with distance from focus
  const float W = 0.03;
  float k = clamp((ed - MW) / (W + bl), 0.0, 1.0);
  float slope = 6.0 * k * (1.0 - k) * 0.22 * W / (W + 2.0 * bl);
  vec2 g = e.x < e.y ? vec2(f.x < BL * 0.5 ? -1.0 : 1.0, 0.0) : vec2(0.0, f.y < CH * 0.5 ? -1.0 : 1.0);
  float r1 = hfHash(vec3(id, 1.7));
  float r2 = hfHash(vec3(id, 5.3));
  float r3 = hfHash(vec3(id, 9.1));
  // bricks are never laid perfectly flush: each face catches the raking light a little differently
  vec2 tilt = (vec2(r2, r3) - 0.5) * 0.12 * brick / (1.0 + bl * 8.0);
  vec2 nl = g * slope * brick + tilt;
  vec3 n = normalize(N + Tg * nl.x + vec3(0.0, 1.0, 0.0) * nl.y);

  // fired clay, a few over-burnt headers, mottled; grey lime mortar
  vec3 clay = mix(vec3(0.17, 0.078, 0.05), vec3(0.12, 0.066, 0.05), r1);
  clay = mix(clay, vec3(0.055, 0.042, 0.038), step(0.88, r2) * 0.85);
  float fine = 1.0 / (1.0 + bl * 14.0);
  float mott = hfFbm(vec3(wc * 2.6, 1.3));
  clay *= 0.72 + 0.56 * mix(0.5, mott, fine);
  vec3 alb = mix(vec3(0.1, 0.094, 0.085), clay, brick);

  // soot: heavier up high, a plume above the forge, rain-down streaks; splash grime at the foot
  float plume = back ? exp(-pow((wc.x - uLPos[0].x) / (0.9 + 0.5 * max(wc.y - 2.0, 0.0)), 2.0)) * smoothstep(1.6, 3.2, wc.y) : 0.0;
  float streak = hfNoise(vec3(wc.x * 2.4, wc.y * 0.22, 2.0));
  float soot = clamp(0.42 + 0.5 * plume + 0.32 * smoothstep(1.2, 6.0, wc.y) + 0.3 * (streak - 0.5) + 0.12 * (mott - 0.5), 0.0, 0.96);
  alb *= 1.0 - 0.82 * soot;
  alb *= mix(0.62, 1.0, smoothstep(0.0, 0.9, wc.y));

  vec3 forge;
  vec3 E = hfIrr(p, n, forge);

  // the rack: dark iron and a wooden rail, rim-lit from the forge side, each casting a long soft shadow
  float tools = 1.0;
  vec3 tcol = vec3(0.0);
  if (back && uRack > 0.5) {
    float d = hfTools(wc);
    vec3 q = uLPos[0].xyz - p;
    float off = 0.07 / max(q.z, 0.08);
    float sd = hfTools(wc + q.xy * off);
    float soft = 0.012 + bl + 0.06 * off * length(q.xy);
    forge *= mix(0.12, 1.0, smoothstep(-soft, soft, sd));
    tools = smoothstep(-bl - 0.004, bl + 0.004, d);
    if (tools < 0.999) {
      vec2 ge = vec2(hfTools(wc + vec2(0.006, 0.0)) - d, hfTools(wc + vec2(0.0, 0.006)) - d) / 0.006;
      float c = clamp(-d / 0.02, 0.0, 1.0);
      vec3 tn = normalize(N * max(c, 0.3) + (Tg * ge.x + vec3(0.0, 1.0, 0.0) * ge.y) * (1.0 - c));
      vec3 tf;
      vec3 te = hfIrr(p + N * 0.07, tn, tf);
      vec3 talb = abs(wc.y - 2.2) < 0.06 ? vec3(0.055, 0.036, 0.024) : vec3(0.032, 0.031, 0.033);
      // iron catches a little sheen on the edge that faces the fire
      tcol = talb * (te + tf) + tf * 0.02 * (1.0 - c);
    }
  }
  vec3 col = mix(tcol, alb * (E + forge), tools);

  // smoke hugging the wall, drifting up and away from the forge, lit by whatever light reaches it
  float sm = hfFbm(vec3(wc.x * 0.38 - t * 0.05, wc.y * 0.55 - t * 0.12, t * 0.04 + (back ? 0.0 : 3.0)));
  float smD = smoothstep(0.42, 0.86, sm) * (0.2 + 0.8 * smoothstep(0.8, 4.0, wc.y)) * (0.6 + 0.8 * plume) * uHaze.z;
  col = mix(col, vec3(0.16, 0.14, 0.12) * hfIrrIso(p + N * 0.4), clamp(smD * 0.75, 0.0, 0.85));

  col = hfAtmos(col, p);
  gl_FragColor = vec4(col, hfMirrorA(p.y));
}
`

/* ------------------------------------------------------------------ */
/* Floor: cast-iron plates, scale and soot, rough blurred reflection    */
/* ------------------------------------------------------------------ */
const FLOOR_VERT = /* glsl */ `
uniform mat4 uReflMat;
varying vec3 vW;
varying vec4 vR;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vR = uReflMat * w;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`
export const FOOT_N = 10
const FLOOR_FRAG = /* glsl */ `
${WORLD_PARS}
uniform sampler2D uRefl;
uniform sampler2D uReflBlur;
uniform vec4 uFoot[${FOOT_N}]; // contact segments on the floor: x0, z0, x1, z1
uniform float uFootK[${FOOT_N}];
uniform float uFootHalf;
varying vec3 vW;
varying vec4 vR;
void main() {
  vec3 p = vW;
  float bl = max(hfCoc(p), length(fwidth(p.xz)) * 0.8);
  float fine = 1.0 / (1.0 + bl * 10.0);

  // 1.2 m cast plates with tight seams; each sits a hair off level
  const float PS = 2.4;
  vec2 q = p.xz / PS + vec2(0.31, 0.47);
  vec2 pid = floor(q);
  vec2 pf = fract(q) * PS;
  vec2 pe = min(pf, PS - pf);
  float ped = min(pe.x, pe.y);
  float seam = (1.0 - smoothstep(0.007, 0.007 + bl * 1.6 + 0.004, ped)) / (1.0 + bl * 18.0);
  float pr = hfHash(vec3(pid, 3.1));
  float pr2 = hfHash(vec3(pid, 8.7));
  float n1 = hfFbm(vec3(p.xz * 1.1, 0.5));
  float n2 = hfNoise(vec3(p.x * 0.7 + pr * 9.0, p.z * 11.0, 4.0));
  float n3 = hfFbm(vec3(p.xz * 4.3, 7.0));
  vec2 tilt = (vec2(pr, pr2) - 0.5) * 0.028;

  // blackened iron with scale, coal dust warmer toward the forge, scuffed brighter where people stand
  float nearForge = exp(-length(p.xz - uLPos[0].xz) * 0.22);
  vec3 alb = vec3(0.036, 0.034, 0.032) * (0.7 + 0.6 * mix(0.5, n1, fine)) * (0.82 + 0.36 * pr);
  alb = mix(alb, vec3(0.05, 0.034, 0.024), smoothstep(0.55, 0.8, n3) * 0.6 * fine + nearForge * 0.3);
  float rough = clamp(0.5 + 0.28 * (n1 - 0.5) + 0.16 * (pr2 - 0.5) - 0.18 * smoothstep(0.6, 0.85, n2) * fine, 0.22, 0.85);
  vec3 n = normalize(vec3(tilt.x + (n3 - 0.5) * 0.05 * fine, 1.0, tilt.y + (n2 - 0.5) * 0.03 * fine));

  // contact shadow under every letter foot (fades as a letter lifts)
  float ao = 1.0;
  for (int i = 0; i < ${FOOT_N}; i++) {
    float k = uFootK[i];
    if (k <= 0.001) continue;
    vec2 a = uFoot[i].xy;
    vec2 ba = uFoot[i].zw - a;
    vec2 pa = p.xz - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    float d = max(length(pa - ba * h) - uFootHalf, 0.0);
    ao *= 1.0 - k * (0.62 * exp(-d / 0.045) + 0.3 * exp(-d / 0.32));
  }
  // where the floor runs into the wall
  ao *= mix(0.55, 1.0, smoothstep(0.0, 1.2, p.z - ${WALL_Z.toFixed(1)}));

  vec3 forge;
  vec3 E = hfIrr(p, n, forge);
  vec3 col = alb * (E + forge) * ao * (1.0 - seam * 0.7);

  // reflection: projective lookup, broken up by the plate tilt; blur grows with the height of what is reflected
  vec2 ruv = vR.xy / vR.w + n.xz * vec2(0.05, 0.11);
  vec4 s0 = texture2D(uRefl, ruv);
  float hgt = s0.a * 4.0;
  float bm = smoothstep(0.0, 0.55, hgt * (0.6 + rough) + rough * 0.2);
  vec3 sb = texture2D(uReflBlur, ruv).rgb;
  vec3 sb2 = 0.5 * (texture2D(uReflBlur, ruv + vec2(0.0, 0.012 * bm)).rgb + texture2D(uReflBlur, ruv - vec2(0.0, 0.02 * bm)).rgb);
  vec3 rc = mix(s0.rgb, mix(sb, sb2, smoothstep(0.4, 1.0, bm)), bm);
  vec3 v = normalize(cameraPosition - p);
  float nv = clamp(dot(n, v), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  float refl = F * (1.0 - 0.72 * rough) * exp(-hgt * 0.75) * mix(0.55, 1.0, ao) * (1.0 - seam);
  col += rc * refl;

  col = hfAtmos(col, p);
  gl_FragColor = vec4(col, 1.0);
}
`

/* ------------------------------------------------------------------ */
/* Props: out-of-focus cards (anvil on its stump, a hoist chain)        */
/* ------------------------------------------------------------------ */
const PROP_FRAG = /* glsl */ `
${WORLD_PARS}
uniform float uKind;
uniform float uSway;
varying vec3 vW;
varying vec3 vN;
varying vec2 vL;
float hfAnvil(vec2 p, out float wood) {
  float stump = hfBox(p - vec2(0.0, 0.55), vec2(0.43 + 0.04 * (0.55 - p.y), 0.55)) - 0.02;
  float feet = hfBox(p - vec2(0.04, 1.17), vec2(0.5 - (p.y - 1.1) * 1.6, 0.07)) - 0.01;
  float waist = hfBox(p - vec2(0.06, 1.33), vec2(0.24, 0.1));
  float body = hfBox(p - vec2(0.12, 1.5), vec2(0.5, 0.1)) - 0.014;
  float heel = hfBox(p - vec2(0.72, 1.555), vec2(0.18, 0.045)) - 0.006;
  vec2 a = vec2(-0.36, 1.53);
  vec2 b = vec2(-1.08, 1.6);
  vec2 ba = b - a;
  float h = clamp(dot(p - a, ba) / dot(ba, ba), 0.0, 1.0);
  float horn = length(p - a - ba * h) - mix(0.095, 0.022, h);
  float anv = hfSmin(hfSmin(feet, waist, 0.07), hfSmin(body, horn, 0.05), 0.05);
  anv = min(anv, heel);
  wood = step(stump, anv);
  return min(stump, anv);
}
float hfChain(vec2 p) {
  // links alternate face-on rings and edge-on bars; a hook at the bottom
  float P = 0.15;
  float y = p.y - 0.36;
  float id = floor(y / P);
  vec2 c = vec2(p.x, y - (id + 0.5) * P);
  float ring = abs(hfBox(c, vec2(0.032, 0.062)) - 0.024) - 0.011;
  float bar = hfBox(c, vec2(0.011, 0.085)) - 0.004;
  float d = mod(id, 2.0) < 0.5 ? ring : bar;
  d = y < 0.0 ? 1.0 : d;
  // a J hook: the lower half of a ring, its point turned up, and the shank into the last link
  float hook = max(abs(length(p - vec2(0.05, 0.17)) - 0.1) - 0.022, p.y - 0.17);
  hook = min(hook, hfSeg(p, vec2(0.15, 0.17), vec2(0.14, 0.24)) - 0.018);
  hook = min(hook, hfSeg(p, vec2(-0.05, 0.17), vec2(0.0, 0.38)) - 0.026);
  return min(d, hook);
}
float hfProp(vec2 p, out float wood) {
  wood = 0.0;
  if (uKind < 0.5) return hfAnvil(p, wood);
  // a slow pendulum sway about the top of the chain
  p.x -= uSway * (7.0 - p.y);
  return hfChain(p);
}
void main() {
  float bl = max(hfCoc(vW), length(fwidth(vL)) * 0.7);
  float wood;
  float d = hfProp(vL, wood);
  float a = 1.0 - smoothstep(-bl, bl, d);
  if (a < 0.004) discard;
  float w2;
  vec2 g = vec2(hfProp(vL + vec2(0.008, 0.0), w2) - d, hfProp(vL + vec2(0.0, 0.008), w2) - d) / 0.008;
  float th = uKind < 0.5 ? 0.09 : 0.02;
  float c = clamp(-d / th, 0.0, 1.0);
  vec3 N = normalize(vN);
  vec3 R = normalize(cross(vec3(0.0, 1.0, 0.0), N));
  vec3 n = normalize(N * max(c, 0.25) + (R * g.x + vec3(0.0, 1.0, 0.0) * g.y) * (1.0 - c));
  vec3 forge;
  vec3 E = hfIrr(vW, n, forge);
  vec3 alb = wood > 0.5 ? vec3(0.06, 0.04, 0.028) * (0.8 + 0.4 * hfNoise(vec3(vL.x * 3.0, vL.y * 18.0, 1.0))) : vec3(0.034, 0.034, 0.036);
  vec3 col = alb * (E + forge);
  // forged steel shows a sheen along the edge that faces the light
  if (wood < 0.5) col += (forge + E * 0.3) * 0.03 * (1.0 - c);
  col = hfAtmos(col, vW);
  gl_FragColor = vec4(col, a);
}
`

/** Light/haze uniforms shared by every workshop material (same objects, updated once per frame). */
export function createWorldUniforms(floorY, mirror) {
  const lpos = []
  const lcol = []
  for (let i = 0; i < NLIGHTS; i++) {
    lpos.push(new THREE.Vector4(0, -100, 0, 1))
    lcol.push(new THREE.Vector3())
  }
  return {
    uLPos: { value: lpos },
    uLCol: { value: lcol },
    uHaze: { value: new THREE.Vector4(0.012, 0.0026, 0.85, 0) },
    uHazeCol: { value: new THREE.Vector3(0.0036, 0.0032, 0.0034) },
    uAmb: { value: new THREE.Vector3(0.016, 0.018, 0.024) },
    uFocus: { value: new THREE.Vector2(12, 0.1) },
    uFloorY: { value: floorY },
    uMirror: mirror,
  }
}

// alpha keeps what is behind (the height channel of the reflection pass); colour blends normally
const keepAlpha = (m) => {
  m.blending = THREE.CustomBlending
  m.blendEquation = THREE.AddEquation
  m.blendSrc = THREE.SrcAlphaFactor
  m.blendDst = THREE.OneMinusSrcAlphaFactor
  m.blendSrcAlpha = THREE.ZeroFactor
  m.blendDstAlpha = THREE.OneFactor
}

export function createWallMaterial(world, rack) {
  return new THREE.ShaderMaterial({
    vertexShader: SURF_VERT,
    fragmentShader: WALL_FRAG,
    uniforms: { ...world, uRack: { value: rack ? 1 : 0 } },
  })
}

export function createFloorMaterial(world, reflector) {
  const foot = []
  for (let i = 0; i < FOOT_N; i++) foot.push(new THREE.Vector4())
  return new THREE.ShaderMaterial({
    vertexShader: FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
    uniforms: {
      ...world,
      uRefl: { value: reflector.rt.texture },
      uReflBlur: { value: reflector.rtB.texture },
      uReflMat: { value: reflector.textureMatrix },
      uFoot: { value: foot },
      uFootK: { value: new Array(FOOT_N).fill(0) },
      uFootHalf: { value: 0.2 },
    },
  })
}

export function createPropMaterial(world, kind) {
  const m = new THREE.ShaderMaterial({
    vertexShader: SURF_VERT,
    fragmentShader: PROP_FRAG,
    uniforms: { ...world, uKind: { value: kind }, uSway: { value: 0 } },
    transparent: true,
    depthWrite: false,
  })
  keepAlpha(m)
  return m
}

/* ------------------------------------------------------------------ */
/* Planar reflection of the floor, rendered small and blurred           */
/* ------------------------------------------------------------------ */
const BLUR_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`
// 9-tap gaussian with linear sampling (5 fetches); alpha (height) is blurred with the colour
const BLUR_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv) * 0.2270270270;
  c += texture2D(uTex, vUv + uDir * 1.3846153846) * 0.3162162162;
  c += texture2D(uTex, vUv - uDir * 1.3846153846) * 0.3162162162;
  c += texture2D(uTex, vUv + uDir * 3.2307692308) * 0.0702702703;
  c += texture2D(uTex, vUv - uDir * 3.2307692308) * 0.0702702703;
  gl_FragColor = c;
}
`

const _rp = new THREE.Vector3()
const _cp = new THREE.Vector3()
const _rm = new THREE.Matrix4()
const _la = new THREE.Vector3()
const _tg = new THREE.Vector3()
const _vw = new THREE.Vector3()
const _nrm = new THREE.Vector3(0, 1, 0)
const _pl = new THREE.Plane()
const _cl = new THREE.Vector4()
const _q = new THREE.Vector4()

export class Reflector {
  constructor(floorY) {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false }
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: false })
    this.rtA = new THREE.WebGLRenderTarget(4, 4, opts)
    this.rtB = new THREE.WebGLRenderTarget(4, 4, opts)
    for (const t of [this.rt, this.rtA, this.rtB]) {
      t.texture.minFilter = THREE.LinearFilter
      t.texture.magFilter = THREE.LinearFilter
    }
    this.floorY = floorY
    this.cam = new THREE.PerspectiveCamera()
    this.textureMatrix = new THREE.Matrix4()
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
    })
    this.quadGeo = new THREE.PlaneGeometry(2, 2)
    this.quad = new THREE.Mesh(this.quadGeo, this.blurMat)
    this.quad.frustumCulled = false
    this.quadScene = new THREE.Scene()
    this.quadScene.add(this.quad)
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.w = 0
    this.h = 0
  }

  setSize(w, h) {
    w = Math.max(16, Math.round(w))
    h = Math.max(16, Math.round(h))
    if (w === this.w && h === this.h) return
    this.w = w
    this.h = h
    this.rt.setSize(w, h)
    this.rtA.setSize(Math.round(w / 2), Math.round(h / 2))
    this.rtB.setSize(Math.round(w / 2), Math.round(h / 2))
  }

  /** Mirror `camera` in the floor (after three's Reflector), render `scene` into rt, blur into rtB. */
  render(gl, scene, camera, hide, mirrorUniform, blurPx = 1.6) {
    _rp.set(0, this.floorY, 0)
    _cp.setFromMatrixPosition(camera.matrixWorld)
    _vw.subVectors(_rp, _cp)
    if (_vw.dot(_nrm) > 0) return
    _vw.reflect(_nrm).negate().add(_rp)
    _rm.extractRotation(camera.matrixWorld)
    _la.set(0, 0, -1).applyMatrix4(_rm).add(_cp)
    _tg.subVectors(_rp, _la).reflect(_nrm).negate().add(_rp)
    const vc = this.cam
    vc.position.copy(_vw)
    vc.up.set(0, 1, 0).applyMatrix4(_rm).reflect(_nrm)
    vc.lookAt(_tg)
    vc.far = camera.far
    vc.near = camera.near
    vc.updateMatrixWorld()
    vc.projectionMatrix.copy(camera.projectionMatrix)
    vc.projectionMatrixInverse.copy(camera.projectionMatrixInverse)
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    this.textureMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse)
    // oblique near plane on the floor: nothing under it is drawn
    _pl.setFromNormalAndCoplanarPoint(_nrm, _rp).applyMatrix4(vc.matrixWorldInverse)
    _cl.set(_pl.normal.x, _pl.normal.y, _pl.normal.z, _pl.constant)
    const pm = vc.projectionMatrix.elements
    _q.x = (Math.sign(_cl.x) + pm[8]) / pm[0]
    _q.y = (Math.sign(_cl.y) + pm[9]) / pm[5]
    _q.z = -1
    _q.w = (1 + pm[10]) / pm[14]
    _cl.multiplyScalar(2 / _cl.dot(_q))
    pm[2] = _cl.x
    pm[6] = _cl.y
    pm[10] = _cl.z + 1
    pm[14] = _cl.w

    const prevTarget = gl.getRenderTarget()
    const prevAuto = gl.autoClear
    const prevXr = gl.xr.enabled
    const prevShadow = gl.shadowMap.autoUpdate
    gl.xr.enabled = false
    gl.shadowMap.autoUpdate = false
    gl.autoClear = true
    for (const o of hide) o.visible = false
    mirrorUniform.value = 1
    gl.setRenderTarget(this.rt)
    gl.render(scene, vc)
    mirrorUniform.value = 0
    for (const o of hide) o.visible = true
    // blur: horizontal into A, vertical (wider: rough reflections streak toward the viewer) into B
    const bm = this.blurMat.uniforms
    bm.uTex.value = this.rt.texture
    bm.uDir.value.set(blurPx / this.rt.width, 0)
    gl.setRenderTarget(this.rtA)
    gl.render(this.quadScene, this.quadCam)
    bm.uTex.value = this.rtA.texture
    bm.uDir.value.set(0, (blurPx * 2.2) / this.rtA.height)
    gl.setRenderTarget(this.rtB)
    gl.render(this.quadScene, this.quadCam)
    gl.autoClear = prevAuto
    gl.xr.enabled = prevXr
    gl.shadowMap.autoUpdate = prevShadow
    gl.setRenderTarget(prevTarget)
  }

  dispose() {
    this.rt.dispose()
    this.rtA.dispose()
    this.rtB.dispose()
    this.blurMat.dispose()
    this.quadGeo.dispose()
  }
}
