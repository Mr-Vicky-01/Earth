/* GLSL shared by the forged steel, its floor reflection, the sparks, the floor glow and the backdrop. */

export const SPLATS = 32

/** Smith's colour chart as linear RGB (same stops as heat.js RAMP) and the emission gain. */
export const BLACKBODY = /* glsl */ `
vec3 hfBlackbody(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.0);
  vec3 c1 = vec3(0.10, 0.004, 0.0);
  vec3 c2 = vec3(0.40, 0.02, 0.004);
  vec3 c3 = vec3(0.95, 0.07, 0.012);
  vec3 c4 = vec3(1.0, 0.20, 0.03);
  vec3 c5 = vec3(1.0, 0.50, 0.10);
  vec3 c6 = vec3(1.0, 0.86, 0.62);
  vec3 c = mix(c0, c1, clamp(t / 0.06, 0.0, 1.0));
  c = mix(c, c2, clamp((t - 0.06) / 0.09, 0.0, 1.0));
  c = mix(c, c3, clamp((t - 0.15) / 0.20, 0.0, 1.0));
  c = mix(c, c4, clamp((t - 0.35) / 0.20, 0.0, 1.0));
  c = mix(c, c5, clamp((t - 0.55) / 0.20, 0.0, 1.0));
  c = mix(c, c6, clamp((t - 0.75) / 0.25, 0.0, 1.0));
  return c;
}
float hfHeatGain(float t) { return 0.25 + 3.3 * pow(max(t, 0.0), 2.3); }
`

export const NOISE = /* glsl */ `
float hfHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float hfNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hfHash(i), hfHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hfHash(i + vec3(0.0, 1.0, 0.0)), hfHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hfHash(i + vec3(0.0, 0.0, 1.0)), hfHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hfHash(i + vec3(0.0, 1.0, 1.0)), hfHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
float hfFbm(vec3 p) {
  return 0.5 * hfNoise(p) + 0.3 * hfNoise(p * 2.03 + 7.1) + 0.2 * hfNoise(p * 4.07 + 3.7);
}
vec2 hfHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// distance to the nearest cell centre: round hammer dimples
float hfCell(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + hfHash2(n + g) * 0.85 - f;
      md = min(md, dot(r, r));
    }
  }
  return sqrt(md);
}
`

/* ------------------------------------------------------------------ */
/* Steel: MeshPhysicalMaterial + temperature field (onBeforeCompile)   */
/* ------------------------------------------------------------------ */
export const STEEL_VERT_PARS = /* glsl */ `
varying vec3 vHfObj;
varying vec3 vHfN;
varying float vHfWy;
`
export const STEEL_VERT_MAIN = /* glsl */ `
vHfObj = position;
vHfN = normal;
vHfWy = (modelMatrix * vec4(transformed, 1.0)).y;
`
// last line of the fragment: in the floor's reflection pass, alpha carries the height above the floor
export const STEEL_FRAG_OUT = /* glsl */ `
if (uMirror > 0.5) gl_FragColor.a = clamp((vHfWy - uFloorY) * 0.25, 0.0, 1.0);
`

export const STEEL_FRAG_PARS = /* glsl */ `
uniform float uTemp;
uniform float uTemper;
uniform float uRim;
uniform vec2 uRest;
uniform float uSeed;
uniform float uBump;
uniform vec4 uSplats[${SPLATS}];
uniform vec4 uSplatT[${SPLATS / 4}];
uniform float uSplatOn;
uniform vec3 uTorch;
uniform vec4 uGlint;
uniform sampler2D uSdf;
uniform vec4 uSdfXf;
uniform float uMirror;
uniform float uFloorY;
varying vec3 vHfObj;
varying vec3 vHfN;
varying float vHfWy;
${BLACKBODY}
${NOISE}
vec3 hfPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = normalize(dFdx(surfPos));
  vec3 sy = normalize(dFdy(surfPos));
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
// thin-film temper colours on the reflectance: straw, bronze, a dark neutral, then steel blue (never purple)
vec3 hfTemperTint(float t) {
  vec3 c = vec3(1.0);
  c = mix(c, vec3(1.0, 0.88, 0.63), smoothstep(0.04, 0.22, t));
  c = mix(c, vec3(0.8, 0.58, 0.36), smoothstep(0.22, 0.42, t));
  c = mix(c, vec3(0.44, 0.42, 0.43), smoothstep(0.42, 0.58, t));
  c = mix(c, vec3(0.34, 0.41, 0.6), smoothstep(0.58, 0.8, t));
  return c;
}
`

// after <color_fragment>: temperature per fragment; hot steel turns to dark oxide before it glows
export const STEEL_FRAG_TEMP = /* glsl */ `
vec2 hfRest = vHfObj.xy + uRest;
float hfN1 = hfFbm(vHfObj * 2.3 + uSeed);
float hfT = uTemp;
float hfTp = 0.0;
for (int i = 0; i < ${SPLATS}; i++) {
  if (uSplatOn < 0.5) break;
  vec4 s = uSplats[i];
  vec4 tv = uSplatT[i / 4];
  int c = i - (i / 4) * 4;
  float tw = c == 0 ? tv.x : (c == 1 ? tv.y : (c == 2 ? tv.z : tv.w));
  if (s.w > 0.002 || tw > 0.004) {
    vec2 d = hfRest - s.xy;
    if (i == 0) {
      // the torch: stretched along its travel
      float a = dot(d, uTorch.xy);
      d -= uTorch.xy * a * (uTorch.z / (1.0 + uTorch.z));
    }
    float q = dot(d, d) / (s.z * s.z);
    // a hot disc with a ragged edge (the noise eats into it) and short tails, so a blow stays where it landed;
    // the temper film spreads a little wider in a ring around it
    hfT += s.w * exp(-q * (0.7 + 0.5 * hfN1) - 0.25 * q * q);
    hfTp += tw * exp(-q * 0.5 - 0.08 * q * q);
  }
}
// thin edges, arrises and walls lose heat first and the core holds it (inside-distance field): as the steel
// cools the glow shrinks into the thick of each stroke, and even at white heat the edges run a shade cooler,
// so the letterform stays defined
float hfD = texture2D(uSdf, vHfObj.xy * uSdfXf.xy + uSdfXf.zw).r;
float hfFace = smoothstep(0.7, 0.97, abs(vHfN.z));
float hfCore = hfD * hfFace;
float hfC = smoothstep(0.0, 0.8, hfCore);
// exit flare: the bevels and walls run hot in uneven patches, the faces stay steel
float hfRimT = uRim * (1.0 - smoothstep(0.0, 0.22, hfCore)) * (0.35 + 0.9 * hfN1 * hfN1);
float hfTn = hfT * (0.88 + 0.24 * hfN1);
float hfTe = hfTn * mix(0.84, 1.0, hfC) * pow(clamp(hfTn, 0.001, 1.0), 0.75 * (1.0 - hfC)) * (1.0 - 0.06 * vHfObj.y);
hfTe = clamp(hfTe + hfRimT, 0.0, 1.25);
// the oxide covers the whole hot bar, cool edges included: they go dark, never silver-pink
float hfHot = smoothstep(0.012, 0.06, max(hfTn, hfTe));
float hfTau = clamp(uTemper * (0.7 + 0.6 * hfN1) * mix(1.12, 0.9, hfCore) + hfTp, 0.0, 1.0);
// mill scale: dark, warm and a little glossy, so the chamfers still draw the letter while it glows
diffuseColor.rgb = mix(diffuseColor.rgb * hfTemperTint(hfTau), vec3(0.085, 0.066, 0.05), hfHot);
`

// after <roughnessmap_fragment>: brushed streaks along the stroke direction + forge-scale roughness when hot
export const STEEL_FRAG_ROUGH = /* glsl */ `
float hfBrush = hfNoise(vec3(vHfObj.x * 1.2, vHfObj.y * 46.0, vHfObj.z * 46.0));
roughnessFactor = clamp(roughnessFactor + (hfBrush - 0.5) * 0.09 + (hfN1 - 0.5) * 0.07 + hfHot * 0.28, 0.08, 1.0);
`

// after <normal_fragment_maps>: shallow hammer dimples
// after <lights_physical_fragment>: the brushing is on the faces; walls and chamfers stay isotropic
export const STEEL_FRAG_ANISO = /* glsl */ `
#ifdef USE_ANISOTROPY
material.anisotropy *= hfFace * (1.0 - hfHot);
material.alphaT = mix(pow2(material.roughness), 1.0, pow2(material.anisotropy));
#endif
`

export const STEEL_FRAG_NORMAL = /* glsl */ `
#ifdef HF_HAMMER
{
  vec2 hfUv = abs(vHfN.z) > 0.6 ? vHfObj.xy : vec2(vHfObj.x + vHfObj.y, vHfObj.z * 1.3);
  float hfC = hfCell(hfUv * 6.5 + uSeed);
  float hfH = hfC * hfC * uBump;
  normal = hfPerturb(-vViewPosition, normal, vec2(dFdx(hfH), dFdy(hfH)), faceDirection);
}
#endif
`

// after <emissivemap_fragment>: blackbody glow (fine scale flakes only in the dull-red to cherry range),
// and the glint: a strip light travelling through the reflections, so it races along the bevels
export const STEEL_FRAG_EMIT = /* glsl */ `
float hfMid = smoothstep(0.07, 0.17, hfTe) * (1.0 - smoothstep(0.3, 0.46, hfTe));
float hfFlake = 0.0;
if (hfMid > 0.001) hfFlake = smoothstep(0.52, 0.74, hfFbm(vec3(vHfObj.x * 13.0, vHfObj.y * 50.0, vHfObj.z * 50.0) + uSeed * 3.0));
totalEmissiveRadiance += hfBlackbody(hfTe) * hfHeatGain(hfTe) * (1.0 - hfFlake * hfMid * 0.18);
if (uGlint.z > 0.001) {
  vec3 hfRw = inverseTransformDirection(reflect(-normalize(vViewPosition), normal), viewMatrix);
  float hfS = dot(hfRw.xy, vec2(0.866, 0.5));
  float hfG = exp(-pow((hfS - uGlint.x) / uGlint.y, 2.0)) * smoothstep(-0.2, 0.25, hfRw.z);
  totalEmissiveRadiance += diffuseColor.rgb * hfG * uGlint.z * (1.0 - hfHot) * (1.15 - roughnessFactor);
}
`

/* ------------------------------------------------------------------ */
/* Sparks + embers: one instanced quad per particle. A spark is a      */
/* streak whose length is its velocity times the shutter (motion blur), */
/* bright white-yellow while it burns and orange as it dies; embers are */
/* soft round glows                                                    */
/* ------------------------------------------------------------------ */
export const SPARK_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aInfo; // age 0..1, width (world), start heat, kind (0 spark, 1 ember)
uniform float uShutter;
uniform float uAspect;
uniform float uGain;
uniform float uSize;
varying vec3 vColor;
varying vec2 vQ;
varying float vKind;
${BLACKBODY}
void main() {
  float age = aInfo.x;
  float kind = aInfo.w;
  vKind = kind;
  float size = aInfo.y * uSize * (kind > 0.5 ? 1.0 : mix(1.0, 0.45, age));
  if (aInfo.y <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vQ = vec2(0.0);
    return;
  }
  vec4 h = projectionMatrix * modelViewMatrix * vec4(aPos, 1.0);
  vec4 t = projectionMatrix * modelViewMatrix * vec4(aPos - aVel * uShutter * (1.0 - kind), 1.0);
  if (t.w < 0.05 || h.w < 0.05) t = h;
  vec2 d = h.xy / h.w - t.xy / t.w;
  d.x *= uAspect;
  float len = length(d);
  vec2 dir = len > 1e-5 ? d / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float wh = size * projectionMatrix[1][1];
  vec4 p = mix(h, t, position.x);
  // perspective-correct width, tapering to the tail; round caps so slow particles read as dots
  vec2 off = nrm * position.y * wh * mix(1.0, 0.35, position.x) + dir * wh * (position.x < 0.5 ? 1.0 : -1.0);
  off.x /= uAspect;
  p.xy += off;
  gl_Position = p;
  vQ = position.xy;
  float heat = kind > 0.5 ? aInfo.z : aInfo.z * pow(1.0 - age, 0.9);
  // a spark burns white-yellow and dies orange, never red or pink; embers stay a soft orange
  float hue = kind > 0.5 ? aInfo.z : mix(0.62, 1.0, clamp(heat, 0.0, 1.0));
  float lum = kind > 0.5 ? (0.35 + 4.0 * heat * heat) : (0.15 + 7.0 * heat * heat * heat);
  float fade = kind > 0.5
    ? smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.55, 1.0, age))
    : smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.7, 1.0, age));
  // a streak spreads its light along its length: keep the energy, not the brightness
  float spread = kind > 0.5 ? 1.0 : clamp(wh * 2.0 / max(len * 0.5 + wh * 2.0, 1e-4), 0.35, 1.0);
  vColor = hfBlackbody(hue) * lum * fade * uGain * spread;
}
`
export const SPARK_FRAG = /* glsl */ `
varying vec3 vColor;
varying vec2 vQ;
varying float vKind;
void main() {
  float side = 1.0 - vQ.y * vQ.y;
  float along = vKind > 0.5 ? 1.0 : 0.25 + 0.75 * (1.0 - vQ.x);
  float soft = vKind > 0.5 ? side * side : side;
  gl_FragColor = vec4(vColor * soft * along, 1.0);
}
`
