import * as THREE from 'three'
import { NOISE } from './shaders'

/*
 * The forge workshop around the word: a soot-stained brick back wall (and a side wall the phone camera sees),
 * a rack of tongs and hammers lit by the forge, an oak roof post in the mid-ground, and
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
export const NLIGHTS = 7 // 0 forge, 1 work lamp, 2..6 letters
export const FORGE_POS = [-8.9, 0.85, -9.2] // the fire bed in the hearth, just off-screen left (y is world)
export const LAMP_POS = [5.6, 5.3, -4.4] // a caged work lamp hanging off-screen, top right

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
// irradiance split three ways: the room (ambient + lamp), the forge, and the hot letters (lights 2..)
void hfIrr3(vec3 p, vec3 n, out vec3 room, out vec3 forge, out vec3 hot) {
  room = uAmb * (0.55 + 0.45 * n.y);
  forge = vec3(0.0);
  hot = vec3(0.0);
  for (int i = 0; i < ${NLIGHTS}; i++) {
    vec3 q = uLPos[i].xyz - p;
    float qq = dot(q, q);
    float c = clamp((dot(n, q) * inversesqrt(qq) + 0.08) / 1.08, 0.0, 1.0);
    vec3 v = uLCol[i] * c / (qq + uLPos[i].w);
    if (i == 0) forge = v;
    else if (i == 1) room += v;
    else hot += v;
  }
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
  float T = max(length(d), 1e-4);
  d /= T;
  float tr = exp(-uHaze.x * T);
  vec3 s = vec3(0.0);
  // the forge sits in its hood: only part of its light gets out into the room's air
  for (int i = 0; i < ${NLIGHTS}; i++) s += uLCol[i] * hfAir(o, d, T, uLPos[i].xyz, uLPos[i].w + 0.25) * (i == 0 ? 0.4 : 1.0);
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
// a single NaN or Inf pixel would be smeared over the whole frame by the bloom's mip chain: never emit one
vec3 hfSafe(vec3 c) { return (any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : c; }
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
  if (p.x < -7.0 || p.x > -3.7 || p.y < 0.6 || p.y > 2.48) return 1.0;
  // a short rail, with hammer heads resting on it and their handles hanging through
  float d = hfBox(p - vec2(-5.35, 2.2), vec2(1.45, 0.034)) - 0.006;
  // tongs hung by the reins: reins close together, a boss at the rivet, short heavy jaws
  d = min(d, hfSeg(p, vec2(-6.66, 2.17), vec2(-6.61, 1.06)) - 0.02);
  d = min(d, hfSeg(p, vec2(-6.56, 2.17), vec2(-6.59, 1.06)) - 0.02);
  d = min(d, length(p - vec2(-6.6, 1.04)) - 0.03);
  d = min(d, hfSeg(p, vec2(-6.61, 1.03), vec2(-6.66, 0.84)) - 0.02);
  d = min(d, hfSeg(p, vec2(-6.59, 1.03), vec2(-6.56, 0.86)) - 0.018);
  // sledge
  d = min(d, hfBox(p - vec2(-5.98, 2.32), vec2(0.19, 0.085)) - 0.012);
  d = min(d, hfSeg(p, vec2(-5.98, 2.25), vec2(-5.97, 1.42)) - 0.026);
  // a longer pair of tongs, hung a touch askew
  d = min(d, hfSeg(p, vec2(-5.38, 2.17), vec2(-5.42, 0.98)) - 0.015);
  d = min(d, hfSeg(p, vec2(-5.29, 2.17), vec2(-5.39, 0.98)) - 0.015);
  d = min(d, length(p - vec2(-5.41, 0.96)) - 0.026);
  d = min(d, hfSeg(p, vec2(-5.42, 0.95), vec2(-5.45, 0.78)) - 0.018);
  d = min(d, hfSeg(p, vec2(-5.4, 0.95), vec2(-5.37, 0.79)) - 0.016);
  // cross-pein hammer
  d = min(d, hfBox(p - vec2(-4.62, 2.3), vec2(0.13, 0.06)) - 0.01);
  d = min(d, hfSeg(p, vec2(-4.62, 2.24), vec2(-4.63, 1.6)) - 0.022);
  // fuller
  d = min(d, hfBox(p - vec2(-4.08, 2.31), vec2(0.06, 0.085)) - 0.01);
  d = min(d, hfSeg(p, vec2(-4.08, 2.23), vec2(-4.07, 1.72)) - 0.02);
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
  // hand-laid: each course sits a little off the bond
  float u = wc.x / BL + 0.5 * mod(row, 2.0) + (hfHash(vec3(row, 2.0, 3.0)) - 0.5) * 0.16 + (back ? 0.0 : 0.27);
  vec2 id = vec2(floor(u), row);
  vec2 f = vec2(fract(u) * BL, fract(wc.y / CH) * CH);
  vec2 e = min(f, vec2(BL, CH) - f);
  float fine0 = 1.0 / (1.0 + bl * 30.0);
  // chipped arrises: old brick loses its corners and edges unevenly
  float chip = hfNoise(vec3(wc * 34.0, 5.0 + hfHash(vec3(id, 2.2)) * 7.0));
  float ed = min(e.x, e.y) - chip * chip * 0.016 * fine0;
  // joints raked out to different depths, wider here and there
  float mw = MW * (0.75 + 0.7 * hfNoise(vec3(wc * 3.1, 9.0)));
  float brick = smoothstep(mw - bl, mw + bl, ed);
  // worn arrises: the face rolls down into the joint; blur flattens the relief with distance from focus
  const float W = 0.03;
  float k = clamp((ed - mw) / (W + bl), 0.0, 1.0);
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
  vec3 clay = mix(vec3(0.16, 0.08, 0.056), vec3(0.115, 0.07, 0.056), r1) * (0.82 + 0.36 * r3);
  clay = mix(clay, vec3(0.07, 0.052, 0.046), step(0.93, r2) * 0.5);
  float fine = 1.0 / (1.0 + bl * 14.0);
  float mott = hfFbm(vec3(wc * 2.6, 1.3));
  clay *= 0.72 + 0.56 * mix(0.5, mott, fine);
  vec3 mortar = vec3(0.1, 0.094, 0.085) * (0.55 + 0.8 * mix(0.5, hfNoise(vec3(wc * 5.0, 8.0)), fine));
  vec3 alb = mix(mortar, clay, brick);

  // soot: heavier up high, a plume above the forge, rain-down streaks; splash grime at the foot
  float pq = (wc.x - uLPos[0].x) / (0.9 + 0.5 * max(wc.y - 2.0, 0.0));
  float plume = back ? exp(-pq * pq) * smoothstep(1.6, 3.2, wc.y) : 0.0;
  float streak = hfNoise(vec3(wc.x * 2.4, wc.y * 0.22, 2.0));
  float patches = hfFbm(vec3(wc * 0.32, 4.0));
  // most of the wall is soot-dark; it is thinnest low down at the sides, where the wash survives
  float soot = clamp(0.58 + 0.45 * plume + 0.3 * smoothstep(1.0, 5.0, wc.y) + 0.3 * (streak - 0.5) + 0.12 * (mott - 0.5) + 0.55 * (patches - 0.5), 0.0, 0.97);
  // what is left of an old lime wash, low on the wall where the soot is thinnest
  float wash = smoothstep(0.58, 0.78, hfFbm(vec3(wc * 0.5 + 11.0, 2.0))) * (1.0 - smoothstep(0.6, 2.4, wc.y)) * (1.0 - soot);
  alb = mix(alb, vec3(0.19, 0.18, 0.165) * (0.7 + 0.3 * mott), wash * 0.55);
  alb *= 1.0 - 0.88 * soot;
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
      vec3 talb = abs(wc.y - 2.2) < 0.05 ? vec3(0.04, 0.027, 0.018) : vec3(0.017, 0.016, 0.017);
      // black iron: a thin sheen only on the edge that faces the fire
      float rim = (1.0 - c) * (1.0 - c) * (1.0 - c);
      tcol = talb * (te + tf) + tf * 0.03 * rim;
    }
  }
  // joints sit back from the face: in raking light they are in shadow
  float joint = mix(0.3, 1.0, brick);
  vec3 col = mix(tcol, alb * (E + forge) * joint, tools);

  // smoke hugging the wall, drifting up and away from the forge, lit by whatever light reaches it
  float sm = hfFbm(vec3(wc.x * 0.38 - t * 0.05, wc.y * 0.55 - t * 0.12, t * 0.04 + (back ? 0.0 : 3.0)));
  float smD = smoothstep(0.42, 0.86, sm) * (0.2 + 0.8 * smoothstep(0.8, 4.0, wc.y)) * (0.6 + 0.8 * plume) * uHaze.z;
  col = mix(col, vec3(0.16, 0.14, 0.12) * hfIrrIso(p + N * 0.4), clamp(smD * 0.75, 0.0, 0.85));

  col = hfAtmos(col, p);
  // the side wall's low courses would streak across the rough iron in its reflection: keep it faint there
  if (uMirror > 0.5 && !back) col *= 0.35;
  gl_FragColor = vec4(hfSafe(col), hfMirrorA(p.y));
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
uniform vec3 uFootC[${FOOT_N}]; // glow of a hot foot on the plate (linear)
uniform float uFootHalf;
uniform vec4 uPostFoot; // the roof post's footing: x, z, half width, on
uniform float uDbg;
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
  // worn, polished patches where people stand (isotropic: a streaky pattern here would band the reflection)
  float n2 = hfNoise(vec3(p.xz * 1.7 + pr * 9.0, 4.0));
  float n3 = hfFbm(vec3(p.xz * 4.3, 7.0));
  vec2 tilt = (vec2(pr, pr2) - 0.5) * 0.028;

  // blackened iron with scale, coal dust warmer toward the forge, scuffed brighter where people stand
  float nearForge = exp(-length(p.xz - uLPos[0].xz) * 0.22);
  vec3 alb = vec3(0.036, 0.034, 0.032) * (0.7 + 0.6 * mix(0.5, n1, fine)) * (0.82 + 0.36 * pr);
  alb = mix(alb, vec3(0.05, 0.034, 0.024), smoothstep(0.55, 0.8, n3) * 0.6 * fine + nearForge * 0.3);
  float rough = clamp(0.5 + 0.28 * (n1 - 0.5) + 0.16 * (pr2 - 0.5) - 0.18 * smoothstep(0.6, 0.85, n2) * fine, 0.22, 0.85);
  float n4 = hfFbm(vec3(p.xz * 4.3, 11.0));
  vec3 n = normalize(vec3(tilt.x + (n3 - 0.5) * 0.04 * fine, 1.0, tilt.y + (n4 - 0.5) * 0.04 * fine));

  // contact shadow under every letter foot (fades as a letter lifts); a hot foot lights the plate instead
  float ao = 1.0;
  vec3 footGlow = vec3(0.0);
  for (int i = 0; i < ${FOOT_N}; i++) {
    float k = uFootK[i];
    if (k <= 0.001) continue;
    vec2 a = uFoot[i].xy;
    vec2 ba = uFoot[i].zw - a;
    vec2 pa = p.xz - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    float d = max(length(pa - ba * h) - uFootHalf, 0.0);
    ao *= 1.0 - k * (0.62 * exp(-d / 0.045) + 0.3 * exp(-d / 0.32));
    footGlow += uFootC[i] * (exp(-d / 0.05) * 0.5 + exp(-d / 0.18) * 0.25);
  }
  // the roof post's footing
  if (uPostFoot.w > 0.5) {
    vec2 pd = max(abs(p.xz - uPostFoot.xy) - uPostFoot.z, 0.0);
    float d = length(pd);
    ao *= 1.0 - 0.55 * exp(-d / 0.06) - 0.25 * exp(-d / 0.4);
  }
  // where the floor runs into the wall
  ao *= mix(0.55, 1.0, smoothstep(0.0, 1.2, p.z - ${WALL_Z.toFixed(1)}));

  vec3 room;
  vec3 forge;
  vec3 hot;
  hfIrr3(p, n, room, forge, hot);
  // the forge's light leaves through its mouth: a warm wedge across the plates, fading at its sides
  vec2 fq = p.xz - uLPos[0].xz;
  float wedge = smoothstep(0.5, 0.86, dot(fq, vec2(0.8, 0.6)) / max(length(fq), 1e-3));
  forge *= mix(0.25, 1.45, wedge);
  // the room's light is shadowed at a foot; a letter's own light is not (it is the light)
  vec3 col = alb * ((room + forge) * ao + hot) * (1.0 - seam * 0.45) + footGlow * alb * 6.0;

  // reflection: projective lookup, broken up by the plate tilt. Rough iron spreads a reflection more the
  // higher above the floor the reflected point is, and streaks it toward the viewer: a dithered gather from the
  // blurred layer with that radius (the sharp layer only right at the contact line)
  vec2 ruv = vR.xy / vR.w + n.xz * vec2(0.08, 0.16);
  vec4 s0 = texture2D(uRefl, ruv);
  // height from the blurred layer: the fade must be as soft as the reflection it fades
  float hgt = texture2D(uReflBlur, ruv).a * 4.0;
  // rough iron never gives a sharp image: a floor of blur set by the roughness and how far off the plate looks,
  // growing with the reflected point's height above the floor
  float far = clamp(distance(cameraPosition, p) * 0.04, 0.0, 1.0);
  float rr = (0.009 + 0.008 * far) * (0.6 + rough) + 0.022 * clamp(hgt, 0.0, 1.5) * (0.5 + rough);
  // dither rotated every frame (interleaved gradient noise): no fixed pattern swimming as the camera drifts
  vec2 fc = gl_FragCoord.xy + 5.588238 * floor(fract(uHaze.w * 0.5) * 120.0);
  float ang = 6.2831853 * fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 6; k++) {
    float fk = (float(k) + 0.5) / 6.0;
    float a = ang + float(k) * 2.3999632;
    acc += texture2D(uReflBlur, ruv + vec2(cos(a), sin(a) * 2.6) * rr * sqrt(fk)).rgb;
  }
  vec3 rc = mix(s0.rgb, acc / 6.0, 0.6 + 0.4 * smoothstep(0.0, 0.1, hgt));
  vec3 v = normalize(cameraPosition - p);
  float nv = clamp(dot(n, v), 0.0, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  float refl = F * (1.0 - 0.8 * rough) * exp(-hgt * 2.2) * mix(0.55, 1.0, ao) * (1.0 - seam);
  col += rc * refl;
  // a broad sheen of the lamp and the forge on the iron (rough Blinn-Phong, energy-normalised)
  float pw = 2.0 / max(rough * rough * rough * rough, 0.002) - 2.0;
  for (int i = 0; i < 2; i++) {
    vec3 q = uLPos[i].xyz - p;
    float qq = dot(q, q);
    vec3 l = q * inversesqrt(qq);
    vec3 hv = normalize(l + v + vec3(0.0, 1e-4, 0.0));
    float nl = max(dot(n, l), 0.0);
    col += uLCol[i] * nl / (qq + uLPos[i].w) * pow(max(dot(n, hv), 0.0), pw) * (pw + 8.0) / 25.13 * F * ao * (i == 0 ? mix(0.25, 1.45, wedge) : 1.0);
  }

  col = hfAtmos(col, p);
  if (uDbg > 0.5) col = uDbg > 2.5 ? hfAtmos(alb * ((room + forge) * ao + hot), p) : uDbg > 1.5 ? s0.rgb : vec3(s0.a, hgt * 0.25, 0.0);
  gl_FragColor = vec4(hfSafe(col), 1.0);
}
`

/* ------------------------------------------------------------------ */
/* Mid-ground: a square oak roof post at the edge of frame, drawn as a  */
/* camera-facing card whose two visible faces are shaded for the real  */
/* viewing angle; out of focus like everything off the focal plane      */
/* ------------------------------------------------------------------ */
const POST_FRAG = /* glsl */ `
${WORLD_PARS}
uniform float uTheta; // angle of the camera round the post (+: camera to its right)
uniform float uW;     // post width (world units)
varying vec3 vW;
varying vec3 vN;
varying vec2 vL;
void main() {
  float bl = max(hfCoc(vW), length(fwidth(vL)) * 0.7);
  float c = cos(abs(uTheta));
  float sn = sin(abs(uTheta));
  float hw = 0.5 * uW * (c + sn);
  float sgn = uTheta >= 0.0 ? 1.0 : -1.0;
  // card x runs across the silhouette, from the far arris (-hw) over the camera-facing face, then the side face
  float x = vL.x * sgn;
  float edge = hw - abs(vL.x);
  float a = smoothstep(-bl, bl, edge);
  if (a < 0.004) discard;
  float split = -hw + uW * c;
  float side = smoothstep(split - bl - 0.006, split + bl + 0.006, x);
  vec3 nf = vec3(0.0, 0.0, 1.0);
  vec3 ns = vec3(sgn, 0.0, 0.0);
  vec3 n = normalize(mix(nf, ns, side));
  // weathered oak: coarse grain along the post (it still reads out of focus), checks, soot thicker up high
  float fine = 1.0 / (1.0 + bl * 12.0);
  float u = side > 0.5 ? (x - split) : (x + hw);
  float grain = hfNoise(vec3(u * 22.0, vL.y * 0.9, 3.0)) * 0.6 + hfNoise(vec3(u * 70.0, vL.y * 3.0, 7.0)) * 0.4;
  float check = smoothstep(0.035, 0.0, abs(fract(u * 2.6 + hfNoise(vec3(0.0, vL.y * 0.7, 1.0)) * 0.5) - 0.5) - 0.46) * fine;
  vec3 alb = vec3(0.13, 0.09, 0.06) * (0.62 + 0.76 * mix(0.5, grain, fine)) * (1.0 - 0.55 * check);
  alb *= 1.0 - 0.35 * smoothstep(2.0, 7.0, vL.y);
  // the foot: grime splashed up, and the occlusion where it stands on the plates
  alb *= mix(0.35, 1.0, smoothstep(0.0, 0.55, vL.y));
  vec3 room;
  vec3 forge;
  vec3 hot;
  hfIrr3(vW, n, room, forge, hot);
  vec3 col = alb * (room + forge + hot);
  // the worn arrises catch light: the far one from the forge behind it, the near one from the lamp and the word
  vec3 r2;
  vec3 f2;
  vec3 h2;
  hfIrr3(vW, vec3(-sgn * 0.8, 0.0, 0.6), r2, f2, h2);
  float farA = (x + hw) / (0.016 + bl);
  col += alb * (f2 * 2.6 + r2 * 0.6) * exp(-farA * farA) * a;
  float aq = (x - split) / (0.012 + bl);
  col += alb * (room + forge + hot) * 1.2 * exp(-aq * aq);
  col = hfAtmos(col, vW);
  gl_FragColor = vec4(hfSafe(col), a);
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
    uHaze: { value: new THREE.Vector4(0.012, 0.0018, 0.85, 0) },
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
  const footC = []
  for (let i = 0; i < FOOT_N; i++) {
    foot.push(new THREE.Vector4())
    footC.push(new THREE.Vector3())
  }
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
      uFootC: { value: footC },
      uFootHalf: { value: 0.2 },
      uPostFoot: { value: new THREE.Vector4() },
      uDbg: { value: 0 },
    },
  })
}

export function createPostMaterial(world, width) {
  const m = new THREE.ShaderMaterial({
    vertexShader: SURF_VERT,
    fragmentShader: POST_FRAG,
    uniforms: { ...world, uTheta: { value: 0.5 }, uW: { value: width } },
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
