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
  vec3 c4 = vec3(1.0, 0.24, 0.03);
  vec3 c5 = vec3(1.0, 0.6, 0.07);
  vec3 c6 = vec3(1.0, 0.92, 0.72);
  // no visible glow below ~430 C (black heat)
  vec3 c = mix(c0, c1, clamp((t - 0.04) / 0.04, 0.0, 1.0));
  c = mix(c, c2, clamp((t - 0.08) / 0.07, 0.0, 1.0));
  c = mix(c, c3, clamp((t - 0.15) / 0.20, 0.0, 1.0));
  c = mix(c, c4, clamp((t - 0.35) / 0.20, 0.0, 1.0));
  c = mix(c, c5, clamp((t - 0.55) / 0.20, 0.0, 1.0));
  c = mix(c, c6, clamp((t - 0.75) / 0.25, 0.0, 1.0));
  return c;
}
// emission gain: the reds and orange stay below ~1.3 in their brightest channel (so the tone curve keeps them
// saturated instead of washing them to peach); only yellow and white heat go well over 1
float hfHeatGain(float t) {
  float a = smoothstep(0.08, 0.55, t);
  float b = smoothstep(0.55, 1.0, t);
  return 0.3 + 0.95 * a + 1.75 * b * sqrt(b);
}
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
export const DENTS = 8
export const SDF_MAX = 0.2 // world units of inside distance mapped to 1.0 in a glyph's distance texture

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
// last line of the fragment. Main pass: alpha is 1 + how much of the pixel is incandescent glow, so the bloom can
// pick out hot steel at a far lower level than a cold highlight. Floor reflection pass: alpha is the height above
// the floor (the floor blurs its reflection by it)
export const STEEL_FRAG_OUT = /* glsl */ `
// never emit NaN/Inf: the bloom's mip chain would smear one bad pixel over the whole frame
if (any(isnan(gl_FragColor.rgb)) || any(isinf(gl_FragColor.rgb))) gl_FragColor.rgb = vec3(0.0);
gl_FragColor.a = uMirror > 0.5 ? clamp((vHfWy - uFloorY) * 0.25, 0.0, 1.0) : 1.0 + clamp(hfGlowA * 2.4, 0.0, 1.0);
`

export const STEEL_FRAG_PARS = /* glsl */ `
uniform float uTemp;   // heat of the stock (0 cold .. 1 white)
uniform float uScale;  // mill scale coverage (1 while it glows, flakes off as it cools)
uniform float uTint;   // straw temper film along the arrises, left as the scale goes
uniform float uRim;    // exit: hot glint along the arrises
uniform float uHalfD;  // half the straight depth of the walls
uniform vec2 uRest;
uniform float uSeed;
uniform float uBump;
uniform vec4 uSplats[${SPLATS}]; // segment start xy, radius, heat
uniform vec4 uSplatB[${SPLATS}]; // segment end xy, temper film, radius it formed at
uniform float uSplatOn;
uniform vec4 uDents[${DENTS}]; // xy, radius, depth (rest coordinates)
uniform float uDentOn;
uniform vec4 uGlint;
uniform vec3 uForgeDir; // world direction toward the forge mouth
uniform vec3 uForgeEnv; // the forge's flicker on top of its average in the environment
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
  vec3 ddx = dFdx(surfPos);
  vec3 ddy = dFdy(surfPos);
  if (dot(ddx, ddx) < 1e-16 || dot(ddy, ddy) < 1e-16) return surfNorm;
  vec3 sx = normalize(ddx);
  vec3 sy = normalize(ddy);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  vec3 r = abs(det) * surfNorm - grad;
  return dot(r, r) > 1e-14 ? normalize(r) : surfNorm;
}
`

// after <color_fragment>: temperature per fragment, mill scale, temper film
export const STEEL_FRAG_TEMP = /* glsl */ `
vec2 hfRest = vHfObj.xy + uRest;
// fine isotropic variation (a few cm): scale is never perfectly even
float hfN1 = hfFbm(vHfObj * 11.0 + uSeed);
float hfTs = 0.0;
float hfQr = 1e3; // nearest temper film, in units of the radius it formed at
float hfTw = 0.0; // and its strength
for (int i = 0; i < ${SPLATS}; i++) {
  if (uSplatOn < 0.5) break;
  vec4 s = uSplats[i];
  vec4 b = uSplatB[i];
  if (s.w > 0.002 || b.z > 0.004) {
    // a capsule: the stretch of steel the torch swept this step (a point for a blow)
    vec2 pa = hfRest - s.xy;
    vec2 ba = b.xy - s.xy;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    vec2 d = pa - ba * h;
    float q = dot(d, d) / (s.z * s.z);
    // a hot core with a short falloff, its edge a little ragged. Capsules join as a union (max), not a sum:
    // consecutive ones share an end, and adding them would bead the track at every joint
    hfTs = max(hfTs, s.w * exp(-q * (1.45 + 0.35 * hfN1)));
    // the temper film formed at the first heat, so it keeps the original radius while the heat spreads; like
    // the heat it is one field over the whole track (nearest capsule), so it bands the track instead of
    // ringing every capsule
    if (b.z > 0.004) {
      float qr = dot(d, d) / (b.w * b.w);
      hfQr = min(hfQr, qr);
      hfTw = max(hfTw, b.z * step(qr, 6.0));
    }
  }
}
// thin bands where the steel only reached 250-300 C (bronze) and 200 C (straw)
float hfRb = (hfQr - 2.1) / 0.5;
float hfRs = (hfQr - 3.3) / 0.6;
vec2 hfTr = hfTw * vec2(exp(-hfRb * hfRb), exp(-hfRs * hfRs));
// distance from the nearest arris: in from the outline on the faces, along the depth on the walls
float hfD = texture2D(uSdf, vHfObj.xy * uSdfXf.xy + uSdfXf.zw).r * ${SDF_MAX.toFixed(3)};
float hfFace = smoothstep(0.55, 0.9, abs(vHfN.z));
float hfA = mix(uHalfD + 0.02 - abs(vHfObj.z), hfD - 0.02, hfFace);
// arrises run a little cooler in a narrow band; as the stock cools the band widens a touch, so the last of the
// glow sits in the thick of each stroke
float hfW = mix(0.035, 0.075, smoothstep(0.5, 0.12, uTemp));
float hfC = smoothstep(-0.01, hfW, hfA);
float hfTn = (uTemp + hfTs) * (0.96 + 0.08 * hfN1);
float hfTe = hfTn * mix(0.88, 1.0, hfC);
// exit: a thin hot glint along the arrises as a letter flies past the lens
hfTe = clamp(hfTe + uRim * (1.0 - smoothstep(-0.01, 0.012, hfA)) * (0.3 + 0.9 * hfN1 * hfN1), 0.0, 1.25);
// mill scale: a dark neutral oxide skin on hot steel; below dull red it flakes off in small patches and the
// satin steel shows through
float hfFl = hfFbm(vHfObj * 15.0 + uSeed * 1.7) + 0.08 * hfNoise(vHfObj * 70.0);
float hfCov = max(uScale, smoothstep(0.05, 0.22, hfTs));
// (the last patches are already thin: they fade as they go, so the clearing never reads as a hard speckle)
float hfSc = smoothstep(-0.035, 0.035, hfCov * 1.3 - 0.15 - hfFl) * (0.4 + 0.6 * smoothstep(0.0, 0.7, hfCov));
// temper: straw only (never through blue or purple), along the arrises and in rings round a blow
float hfStr = clamp(uTint * (1.0 - smoothstep(0.0, 0.05, hfA)) + hfTr.y, 0.0, 1.0);
vec3 hfTint = mix(vec3(1.0), vec3(1.0, 0.8, 0.52), hfStr) * mix(vec3(1.0), vec3(0.84, 0.58, 0.38), clamp(hfTr.x, 0.0, 1.0));
// (a warm graphite, faintly glossy: a dim sheen keeps the letterform readable while it is dark, and with the
// last dull-red glow it reads as dark brown-red, never mauve)
diffuseColor.rgb = mix(diffuseColor.rgb * hfTint, vec3(0.08, 0.07, 0.062) * (0.8 + 0.4 * hfN1), hfSc);
`

// after <roughnessmap_fragment>: brushed streaks on bare steel; scale is rougher (and only where it is)
export const STEEL_FRAG_ROUGH = /* glsl */ `
float hfBrush = hfNoise(vec3(vHfObj.x * 1.2, vHfObj.y * 46.0, vHfObj.z * 46.0));
roughnessFactor = clamp(roughnessFactor + ((hfBrush - 0.5) * 0.09 + (hfN1 - 0.5) * 0.05) * (1.0 - hfSc) + hfSc * 0.16, 0.08, 1.0);
`

// after <lights_physical_fragment>: the brushing is on the faces; walls, chamfers and scale stay isotropic
export const STEEL_FRAG_ANISO = /* glsl */ `
#ifdef USE_ANISOTROPY
material.anisotropy *= hfFace * (1.0 - hfSc);
material.alphaT = mix(pow2(material.roughness), 1.0, pow2(material.anisotropy));
#endif
`

// after <lights_fragment_end>: the forge's flicker in the reflections (the environment holds its average)
export const STEEL_FRAG_FORGE = /* glsl */ `
{
  vec3 hfRw = inverseTransformDirection(reflect(-normalize(vViewPosition), normal), viewMatrix);
  float hfF = smoothstep(0.76, 0.97, dot(hfRw, uForgeDir));
  reflectedLight.indirectSpecular = max(reflectedLight.indirectSpecular + uForgeEnv * hfF * material.specularColor, 0.0);
}
`

// after <normal_fragment_maps>: shallow hammer dimples, and the dents left by blows (front faces)
export const STEEL_FRAG_NORMAL = /* glsl */ `
{
  float hfH = 0.0;
#ifdef HF_HAMMER
  vec2 hfUv = abs(vHfN.z) > 0.6 ? vHfObj.xy : vec2(vHfObj.x + vHfObj.y, vHfObj.z * 1.3);
  float hfCl = hfCell(hfUv * 6.5 + uSeed);
  hfH += hfCl * hfCl * uBump;
#endif
  if (uDentOn > 0.5 && vHfN.z > 0.6) {
    for (int i = 0; i < ${DENTS}; i++) {
      vec4 dn = uDents[i];
      if (dn.w <= 0.0) continue;
      vec2 dd = hfRest - dn.xy;
      hfH -= dn.w * exp(-dot(dd, dd) / (dn.z * dn.z));
    }
  }
  normal = hfPerturb(-vViewPosition, normal, vec2(dFdx(hfH), dFdy(hfH)), faceDirection);
}
`

// after <emissivemap_fragment>: blackbody glow (thick scale flakes hold a touch less heat at the surface in the
// reds), and the glint: a strip light travelling through the reflections, so it races along the bevels
export const STEEL_FRAG_EMIT = /* glsl */ `
float hfMid = smoothstep(0.06, 0.15, hfTe) * (1.0 - smoothstep(0.35, 0.55, hfTe));
vec3 hfE = hfBlackbody(hfTe) * hfHeatGain(hfTe) * (1.0 - 0.16 * hfMid * smoothstep(0.45, 0.7, hfFl));
// the scale's texture shows in the glow at any heat: its flakes a touch darker, a finer mottle all over
float hfMot = hfFbm(vHfObj * 23.0 + uSeed * 0.7);
hfE *= (1.0 - 0.18 * smoothstep(0.5, 0.78, hfFl)) * (0.9 + 0.2 * hfMot) * step(0.004, hfTe);
totalEmissiveRadiance += hfE;
float hfGlowA = dot(hfE, vec3(0.2126, 0.7152, 0.0722));
if (uGlint.z > 0.001) {
  vec3 hfRw = inverseTransformDirection(reflect(-normalize(vViewPosition), normal), viewMatrix);
  float hfS = dot(hfRw.xy, vec2(0.866, 0.5));
  float hfG = exp(-pow((hfS - uGlint.x) / uGlint.y, 2.0)) * smoothstep(-0.2, 0.25, hfRw.z);
  totalEmissiveRadiance += diffuseColor.rgb * hfG * uGlint.z * (1.0 - hfSc) * (1.15 - roughnessFactor);
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
varying vec2 vHL; // head hue, brightness
varying vec2 vQ;
varying float vKind;
void main() {
  float age = aInfo.x;
  float kind = aInfo.w;
  vKind = kind;
  float size = aInfo.y * uSize * (kind > 0.5 ? 1.0 : mix(1.0, 0.45, age));
  if (aInfo.y <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vHL = vec2(0.0);
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
  // a spark's head burns yellow-white and dies orange; its tail is always cooler (see the fragment)
  float hue = kind > 0.5 ? aInfo.z : mix(0.6, 0.88, clamp(heat, 0.0, 1.0));
  float lum = kind > 0.5 ? (0.35 + 4.0 * heat * heat) : (0.25 + 6.5 * heat * heat * heat);
  float fade = kind > 0.5
    ? smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.55, 1.0, age))
    : smoothstep(0.0, 0.05, age) * (1.0 - smoothstep(0.7, 1.0, age));
  // a streak spreads its light along its length: keep the energy, not the brightness (the head keeps most)
  float spread = kind > 0.5 ? 1.0 : clamp(wh * 3.0 / max(len * 0.5 + wh * 3.0, 1e-4), 0.5, 1.0);
  vHL = vec2(hue, lum * fade * uGain * spread);
}
`
export const SPARK_FRAG = /* glsl */ `
varying vec2 vHL;
varying vec2 vQ;
varying float vKind;
${BLACKBODY}
void main() {
  float side = 1.0 - vQ.y * vQ.y;
  vec3 c;
  if (vKind > 0.5) {
    c = hfBlackbody(vHL.x) * vHL.y * side * side;
  } else {
    // hot head, cooler fading tail
    float x = vQ.x;
    float along = mix(1.0, 0.1, pow(x, 0.6));
    c = hfBlackbody(vHL.x - 0.3 * x) * vHL.y * side * along * (1.0 + 0.8 * (1.0 - smoothstep(0.0, 0.12, x)));
  }
  gl_FragColor = vec4((any(isnan(c)) || any(isinf(c))) ? vec3(0.0) : c, 1.0);
}
`
