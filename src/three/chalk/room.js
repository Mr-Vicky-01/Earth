import * as THREE from 'three'

/**
 * The gym behind the dust headline: one analytic ray-cast pass, rendered at reduced resolution (it is out of
 * focus, so it loses nothing) into a half-float target that the main scene upsamples.
 *
 * Units are cap heights of the headline, like everything else in the chalk scene: 1 cap = 0.2 m, so the letters
 * are 20 cm tall, the camera sits about 26 cm off a rubber floor 2 m in front of them, and the back wall of the
 * gym is 5 m behind. Real lights: a pendant key light up front on the left (the one that rakes the dust) and two
 * downlights over the rig that throw scallops of light down the back wall, all with inverse-square falloff.
 * Haze hangs in the room, thicker near the floor, and catches the downlights' cones.
 * Depth of field: every edge and texture is filtered by its circle of confusion around the letter plane.
 */

/** caps per metre, and gravity at that scale */
export const M = 5
export const G = 9.81 * M

/** y values are heights above the floor (the floor sits just under the headline and moves with the layout) */
export const ROOM = {
  // the back wall: 5.2 m behind the letters in landscape; closer in portrait framing, where the camera sees more
  // floor and a far wall would put the wall-floor line right through the stacked headline
  wallZ: -26,
  wallZPortrait: -20,
  ceil: 22,
  // pendant key light over the floor in front of the letters, out of frame up and to the left: a deep shade throws
  // a soft cone, so it leaves a pool of light on the rubber under and around the letters and rakes the dust.
  // pos (y above the floor), aim, cone half angles (deg), neutral white
  key: { pos: [-6.5, 15.5, 5.5], aim: [0.4, 0, -0.6], color: [1.0, 0.99, 0.975], power: 300, radius: 1.4, inner: 9, outer: 52 },
  // two ceiling spots aimed at the back wall over the rig: soft pools of warm-neutral light on the paint, beams
  // through the haze. pos and aim are relative to the wall (z) and the floor (y), cone half angles (deg)
  spots: [
    { pos: [-9, 21, 14], aim: [-6.5, 6.4, 0], color: [1.0, 0.95, 0.885], power: 420, inner: 7, outer: 28 },
    { pos: [9, 21, 15], aim: [10.5, 6.0, 0], color: [1.0, 0.95, 0.885], power: 480, inner: 7, outer: 28 },
  ],
  // the room's bounce: a dim, neutral charcoal (a coloured tint here is exaggerated by the tone curve's toe)
  ambient: [0.0105, 0.0102, 0.0098],
}

/** The back wall's z for a frame of this aspect (landscape far, portrait nearer, eased between). */
export function wallZFor(aspect) {
  const t = Math.min(1, Math.max(0, (aspect - 0.6) / 0.6))
  return ROOM.wallZPortrait + (ROOM.wallZ - ROOM.wallZPortrait) * t
}

/**
 * Where spot i hangs and where it points (world units), for a floor at floorY. On narrow (portrait) frames the
 * two spots and their pools move in toward the middle, the way a set is lit for the frame it is shot in.
 */
export function spotPose(i, floorY, aspect, outPos, outDir) {
  const s = ROOM.spots[i]
  const k = Math.min(1, Math.max(0.42, aspect / 1.6))
  const wz = wallZFor(aspect)
  outPos.set(s.pos[0] * k, floorY + s.pos[1], wz + s.pos[2])
  outDir.set(s.aim[0] * k - s.pos[0] * k, s.aim[1] - s.pos[1], s.aim[2] - s.pos[2]).normalize()
}

/** The pendant key: position and direction (world units) for a floor at floorY. */
export function keyPose(floorY, outPos, outDir) {
  const k = ROOM.key
  outPos.set(k.pos[0], floorY + k.pos[1], k.pos[2])
  outDir.set(k.aim[0] - k.pos[0], k.aim[1] - k.pos[1], k.aim[2] - k.pos[2]).normalize()
}

export const ROOM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const ROOM_FRAG = /* glsl */ `
precision highp float;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform vec2 uRes;        // target px
uniform float uTanHalf;   // tan(vertical fov / 2)
uniform float uFloorY;
uniform float uWallZ;
uniform float uFocus;     // view depth in focus (the letter plane)
uniform float uCocK;      // blur radius (target px) of a point at infinity
uniform float uTime;
uniform float uLight;     // 0..1: the lights coming up
uniform int uSteps;       // march steps through the spots' beams (the quality governor lowers it)
uniform vec3 uKeyPos;
uniform vec3 uKeyDir;
uniform vec2 uKeyCone;    // cos outer, cos inner
uniform vec3 uKeyCol;
uniform float uKeyR;
uniform vec3 uSpotPos[2];
uniform vec3 uSpotDir[2];
uniform vec3 uSpotCol[2];
uniform vec2 uSpotCone[2]; // cos outer, cos inner
uniform vec3 uAmb;
uniform sampler2D uMask;  // the headline silhouette (for its shadow and contact occlusion on the floor)
uniform vec4 uMaskBox;    // x0, y0 (caps), w, h
uniform float uMaskRes;   // mask px per cap
uniform float uMaskOn;    // how solid the letters are (0 while they are a cloud)
uniform vec2 uLetterY;    // bottom and top of the headline (caps)
uniform vec4 uBlock;      // falling block (shadow proxy): centre, radius (0 = none)
uniform vec4 uCloud;      // burst cloud (shadow proxy): centre, radius
uniform float uCloudA;    // its opacity
uniform vec4 uSplat;      // powder left on the floor by the slam: x, z, amount, radius
varying vec2 vUv;

const float CEIL = ${ROOM.ceil.toFixed(1)};

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
// band-limited fbm: octaves finer than the blur footprint (caps) fade out instead of aliasing
float fbmB(vec2 p, float foot) {
  float a = 0.5;
  float s = 0.0;
  float n = 0.0;
  float f = 1.0;
  for (int i = 0; i < 4; i++) {
    float keep = exp(-pow(foot * f * 1.6, 2.0));
    s += a * keep * (vnoise(p * f) - 0.5);
    n += a;
    f *= 2.03;
    a *= 0.5;
  }
  return s / n;
}
// detail of frequency f (cycles per cap) survives a blur footprint 'foot' (caps) by this much
float keepF(float f, float foot) { return exp(-pow(foot * f * 1.6, 2.0)); }
// tanh with its argument kept in range (some GL implementations compute inf / inf = NaN for large ones)
float tanhC(float x) { return tanh(clamp(x, -9.0, 9.0)); }
// a box of half width w seen through a blur of radius b (all px): a gaussian-ish filtered box
float band(float d, float w, float b) {
  b = max(b, 0.6);
  return clamp(0.5 * (tanhC(1.15 * (w - d) / b) + tanhC(1.15 * (w + d) / b)), 0.0, 1.0);
}
// a filled shape's edge: d is the signed distance (px), negative inside
float edge(float d, float b) {
  return 0.5 - 0.5 * tanhC(1.15 * d / max(b, 0.6));
}

float viewDepth(float t, vec3 rd) { return max(t * dot(rd, uCamFwd), 0.05); }
float pxPerUnit(float t, vec3 rd) { return uRes.y / (2.0 * uTanHalf * viewDepth(t, rd)); }
float coc(float t, vec3 rd) {
  float z = viewDepth(t, rd);
  return uCocK * abs(z - uFocus) / z + 0.7;
}

/* ---------------- lighting ---------------- */
vec3 spotE(int i, vec3 P, vec3 N) {
  vec3 L = uSpotPos[i] - P;
  float d2 = dot(L, L);
  L *= inversesqrt(d2);
  float ca = dot(-L, uSpotDir[i]);
  // the beam, plus the faint spill a real spot leaks around it
  float cone = smoothstep(uSpotCone[i].x, uSpotCone[i].y, ca) + 0.05 * smoothstep(0.3, uSpotCone[i].x, ca);
  return uSpotCol[i] * max(dot(N, L), 0.0) * cone / d2;
}
vec3 spotSpec(int i, vec3 P, vec3 N, vec3 V, float shin) {
  vec3 L = uSpotPos[i] - P;
  float d2 = dot(L, L);
  L *= inversesqrt(d2);
  float cone = smoothstep(uSpotCone[i].x, uSpotCone[i].y, dot(-L, uSpotDir[i]));
  vec3 H = normalize(L + V);
  return uSpotCol[i] * pow(max(dot(N, H), 0.0), shin) * cone / d2 * max(dot(N, L), 0.0);
}
float keyCone(vec3 L) {
  float ca = dot(-L, uKeyDir);
  return smoothstep(uKeyCone.x, uKeyCone.y, ca) + 0.04 * smoothstep(-0.2, uKeyCone.x, ca);
}
vec3 keyE(vec3 P, vec3 N) {
  vec3 L = uKeyPos - P;
  float d2 = dot(L, L);
  L *= inversesqrt(d2);
  return uKeyCol * max(dot(N, L), 0.0) * keyCone(L) / d2;
}
vec3 keySpec(vec3 P, vec3 N, vec3 V, float shin) {
  vec3 L = uKeyPos - P;
  float d2 = dot(L, L);
  L *= inversesqrt(d2);
  vec3 H = normalize(L + V);
  return uKeyCol * keyCone(L) * pow(max(dot(N, H), 0.0), shin) / d2 * max(dot(N, L), 0.0);
}
// the lit back wall seen from P (its pools act as a big soft light behind the rig): irradiance toward +z
vec3 wallGlow(vec3 P) {
  vec3 wp = vec3(P.x, uFloorY + 6.5, uWallZ);
  return (spotE(0, wp, vec3(0.0, 0.0, 1.0)) + spotE(1, wp, vec3(0.0, 0.0, 1.0)));
}
// diffuse light on a surface (key shadowing passed in), ambient included
vec3 lightD(vec3 P, vec3 N, float keyVis, float ao) {
  vec3 e = uAmb * (0.55 + 0.45 * max(N.y, 0.0) + 0.25 * max(N.z, 0.0)) * ao;
  e += (keyE(P, N) * keyVis + spotE(0, P, N) + spotE(1, P, N)) * uLight;
  // bounce off the lit wall onto anything facing it
  e += wallGlow(P) * 0.06 * max(-N.z, 0.0) * uLight;
  return e;
}
vec3 lightS(vec3 P, vec3 N, vec3 V, float shin, float keyVis) {
  return (keySpec(P, N, V, shin) * keyVis + spotSpec(0, P, N, V, shin) + spotSpec(1, P, N, V, shin)) * uLight;
}

/* ---------------- shadows on the floor ---------------- */
float maskAt(vec2 xy, float blurCaps) {
  vec2 uv = (xy - uMaskBox.xy) / uMaskBox.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  float lod = log2(max(blurCaps * uMaskRes, 1.0));
  return textureLod(uMask, uv, lod).r;
}
float sphereOcc(vec3 P, vec3 L, float lightDist, vec4 S, float lightR) {
  vec3 c = S.xyz - P;
  float tc = dot(c, L);
  if (tc <= 0.0 || S.w <= 0.0) return 0.0;
  float h = length(c - L * tc);
  float pen = tc * lightR / max(lightDist - tc, 0.5) + 0.05;
  return 1.0 - smoothstep(S.w - pen, S.w + pen, h);
}
float floorKeyVis(vec3 P) {
  vec3 L = uKeyPos - P;
  float ld = length(L);
  L /= ld;
  float vis = 1.0;
  // the letters (a sheet of dust around z = -0.1): their shadow falls behind them, away from the pendant
  if (L.z > 1e-3 && P.z < -0.1) {
    float tz = (-0.1 - P.z) / L.z;
    vec3 Q = P + L * tz;
    float pen = tz * uKeyR / max(ld - tz, 1.0) + 0.02;
    vis *= 1.0 - 0.85 * uMaskOn * maskAt(Q.xy, pen);
  }
  vis *= 1.0 - 0.6 * sphereOcc(P, L, ld, uBlock, uKeyR);
  vis *= 1.0 - 0.2 * uCloudA * sphereOcc(P, L, ld, uCloud, uKeyR * 4.0);
  return vis;
}
float floorAO(vec3 P) {
  float ao = 1.0;
  // contact: the bottoms of the letters hang just above the floor
  float gap = uLetterY.x - uFloorY;
  float dz = abs(P.z + 0.1);
  float under = maskAt(vec2(P.x, uLetterY.x + 0.12), 0.08 + dz * 0.7);
  ao *= 1.0 - 0.72 * uMaskOn * under * exp(-dz / (0.35 + gap));
  // the block as it comes down, the cloud over the floor
  if (uBlock.w > 0.0) {
    vec3 c = uBlock.xyz - P;
    ao *= 1.0 - clamp(uBlock.w * uBlock.w * 0.9 / dot(c, c), 0.0, 0.85);
  }
  vec3 cc = uCloud.xyz - P;
  ao *= 1.0 - 0.12 * uCloudA * clamp(uCloud.w * uCloud.w * 0.2 / dot(cc, cc), 0.0, 1.0);
  return ao;
}

/* ---------------- compositing helpers ---------------- */
// layer an object over what is behind it: cov is its coverage, t its distance along the ray
void over(inout vec3 col, inout float tFront, vec3 c, float cov, float t, float tBase) {
  if (t > tBase + 0.3 || cov <= 0.002) return;
  col = mix(col, c, cov);
  if (cov > 0.5) tFront = min(tFront, t);
}

// a vertical square tube (x0, z0) from y = 0 to y1 above the floor, half width w: coverage, the side the ray meets
// it on (-1..1 across the face) and where
float tube(vec3 ro, vec3 rd, float x0, float z0, float w, float y1, out float sx, out float y, out float tc) {
  vec2 rel = vec2(x0, z0) - ro.xz;
  vec2 dxz = rd.xz;
  float dd = dot(dxz, dxz);
  tc = dot(rel, dxz) / dd;
  sx = 0.0;
  y = 0.0;
  if (tc <= 0.0) return 0.0;
  vec2 cl = ro.xz + dxz * tc - vec2(x0, z0);
  y = ro.y + rd.y * tc - uFloorY;
  float pp = pxPerUnit(tc, rd);
  float b2 = coc(tc, rd);
  sx = clamp(dot(cl, vec2(dxz.y, -dxz.x)) / sqrt(dd) / w, -1.0, 1.0);
  return band(length(cl) * pp, w * pp, b2) * smoothstep(-0.05, 0.05, y) * (1.0 - smoothstep(y1 - 0.05, y1 + 0.05, y));
}
// a horizontal bar along x at height yb (above the floor) and depth zb, from x0 to x1, radius r: coverage
float barX(vec3 ro, vec3 rd, float yb, float zb, float x0, float x1, float r, out float tc, out vec3 pw) {
  vec2 rel = vec2(uFloorY + yb, zb) - ro.yz;
  vec2 dyz = rd.yz;
  float dd = dot(dyz, dyz);
  tc = dot(rel, dyz) / dd;
  pw = vec3(0.0);
  if (tc <= 0.0) return 0.0;
  float x = ro.x + rd.x * tc;
  float d = length(ro.yz + dyz * tc - vec2(uFloorY + yb, zb));
  float pp = pxPerUnit(tc, rd);
  float b2 = coc(tc, rd);
  pw = vec3(x, uFloorY + yb, zb);
  return band(d * pp, r * pp, b2) * smoothstep(x0 - 0.05, x0 + 0.05, x) * (1.0 - smoothstep(x1 - 0.05, x1 + 0.05, x));
}
// a horizontal arm along z at (x, yb above the floor) from z0 to z1, square half size r: coverage
float armZ(vec3 ro, vec3 rd, float xa, float yb, float z0, float z1, float r, out float tc, out vec3 pw) {
  vec2 rel = vec2(xa, uFloorY + yb) - ro.xy;
  vec2 dxy = rd.xy;
  float dd = dot(dxy, dxy);
  tc = dot(rel, dxy) / dd;
  pw = vec3(0.0);
  if (tc <= 0.0) return 0.0;
  float z = ro.z + rd.z * tc;
  float d = length(ro.xy + dxy * tc - vec2(xa, uFloorY + yb));
  float pp = pxPerUnit(tc, rd);
  float b2 = coc(tc, rd);
  pw = vec3(xa, uFloorY + yb, z);
  return band(d * pp, r * pp, b2) * smoothstep(z0 - 0.05, z0 + 0.05, z) * (1.0 - smoothstep(z1 - 0.05, z1 + 0.05, z));
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vp = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(normalize(vp.xyz / vp.w), 0.0)).xyz);
  vec3 ro = uCamPos;
  vec3 V = -rd;
  float WALL_Z = uWallZ;

  /* ---------- the room's shell: floor, back wall, ceiling ---------- */
  float tHit = 1e4;
  int mat = 0;
  vec3 N = vec3(0.0, 0.0, 1.0);
  if (rd.y < -1e-4) {
    float t = (uFloorY - ro.y) / rd.y;
    if (t > 0.0) { tHit = t; mat = 1; N = vec3(0.0, 1.0, 0.0); }
  }
  if (rd.z < -1e-4) {
    float t = (WALL_Z - ro.z) / rd.z;
    if (t > 0.0 && t < tHit) { tHit = t; mat = 2; N = vec3(0.0, 0.0, 1.0); }
  }
  if (rd.y > 1e-4) {
    float t = (uFloorY + CEIL - ro.y) / rd.y;
    if (t > 0.0 && t < tHit) { tHit = t; mat = 3; N = vec3(0.0, -1.0, 0.0); }
  }
  vec3 P = ro + rd * tHit;
  float ppu = pxPerUnit(tHit, rd);
  float bl = coc(tHit, rd);
  float foot = bl / ppu; // blur footprint in caps
  vec3 col = vec3(0.0);
  float hy = P.y - uFloorY;

  if (mat == 2) {
    // painted concrete block, running bond, 40 x 20 cm; the joints are slightly recessed, so under the downlights
    // each one carries a thin shadow line under the block above it
    vec2 w = vec2(P.x, hy);
    float row = floor(w.y);
    vec2 f = fract(vec2(w.x * 0.5 + 0.5 * mod(row, 2.0), w.y)) - 0.5;
    float jd = min((0.5 - abs(f.x)) * 2.0, 0.5 - abs(f.y));
    float joint = band(jd * ppu, 0.04 * ppu, bl);
    float lip = band((0.5 - f.y - 0.06) * ppu, 0.035 * ppu, bl) * 0.6;
    float mott = fbmB(w * 1.7, foot) * 0.22 + fbmB(w * 0.23 + 7.1, foot) * 0.35;
    // scuffed and darker low on the wall where plates and boots hit it, chalk handprints up the rig
    float scuff = smoothstep(2.4, 0.2, hy) * (0.55 + 0.45 * fbmB(w * vec2(0.6, 2.0), foot));
    float chalk = smoothstep(0.62, 0.8, vnoise(w * vec2(0.55, 0.4) + 3.0)) * smoothstep(3.5, 5.5, hy) * smoothstep(9.5, 7.0, hy);
    chalk *= exp(-pow(foot * 1.2, 2.0)) * 0.6 + 0.4;
    float alb = 0.145 * (1.0 + mott) * (1.0 - 0.45 * joint - 0.25 * lip) * (1.0 - 0.35 * scuff);
    vec3 albC = vec3(0.97, 0.97, 0.98) * alb + vec3(0.2) * chalk * 0.35;
    float corner = 1.0 - 0.45 * exp(-hy / 0.9);
    col = albC * lightD(P, N, 1.0, (1.0 - 0.25 * joint) * corner) * mix(1.0, corner, 0.6);
  } else if (mat == 1) {
    // rubber tiles, 1 m square: black EPDM with lighter flecks, worn paths, chalk trodden in. Detail is filtered by
    // the lens blur: what is too fine to resolve averages out to its mean instead of shimmering
    vec2 fl = P.xz;
    // seen at a grazing angle the floor is squeezed: detail is filtered by the long axis of the pixel's footprint
    float footF = foot / max(abs(rd.y), 0.06);
    vec2 tl = fl + vec2(2.1, 1.3);
    vec2 tf = fract(tl / 5.0) - 0.5;
    vec2 tid = floor(tl / 5.0);
    float sd = (0.5 - max(abs(tf.x), abs(tf.y))) * 5.0;
    float seam = band(sd * ppu * abs(rd.y) * 3.0, 0.03 * ppu * abs(rd.y) * 3.0, bl) * 0.7;
    float tileV = h21(tid) - 0.5;
    float wear = fbmB(fl * 0.35 + 2.0, footF);
    float grit = fbmB(fl * 4.0, footF);
    float fleck = mix(0.12, smoothstep(0.55, 0.8, vnoise(fl * 26.0)), keepF(26.0, footF));
    float dust = smoothstep(0.5, 0.85, vnoise(fl * 0.3 + 11.0)) * (0.4 + 0.6 * smoothstep(-6.0, -14.0, P.z));
    float alb = (0.036 * (1.0 + 0.14 * tileV + 0.45 * wear + 0.3 * grit) + 0.11 * fleck) * (1.0 - 0.5 * seam) + 0.035 * dust;
    // powder the slam left on the floor: a dense core and ragged streaks thrown out from where it hit
    vec2 sp = (P.xz - uSplat.xy) / uSplat.w;
    float sr = length(sp * vec2(0.85, 1.7));
    float sa = atan(sp.y, sp.x + 1e-4);
    // (the streak pattern is a closed loop in angle, so it has no seam behind the point of impact)
    vec2 ca = vec2(cos(sa), sin(sa));
    float streak = smoothstep(0.5, 0.8, vnoise(ca * 2.6 + vec2(3.0, sr * 0.5)) * 0.65 + vnoise(ca * 6.0 + 1.7 + sr * 0.3) * 0.35);
    float reach = 1.0 - smoothstep(0.15, 0.75 + 0.55 * streak, sr + 0.35 * (vnoise(P.xz * 3.5) - 0.5));
    float splat = uSplat.z * clamp(reach * (0.3 + 0.7 * max(streak * 0.7, 1.0 - smoothstep(0.05, 0.35, sr))), 0.0, 1.0);
    splat *= 0.75 + 0.25 * mix(0.5, vnoise(P.xz * 11.0), keepF(11.0, footF));
    alb = mix(alb, 0.2, splat * 0.55);
    float kv = floorKeyVis(P);
    float fz = max(P.z - WALL_Z, 0.0);
    float ao = floorAO(P) * (1.0 - 0.45 * exp(-fz / 0.9));
    col = vec3(alb) * lightD(P, N, kv, ao) * ao;
    // the pools on the wall bounce warm light onto the floor in front of it
    col += vec3(alb) * wallGlow(P) * 0.25 * exp(-fz / 4.5) * ao * uLight;
    // satin sheen of rubber: broad, faint highlights of the lights
    float fres = 0.035 + 0.5 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col += lightS(P, N, V, 12.0, kv) * fres * (1.0 - 0.7 * splat) * (0.8 + 0.4 * wear) * (1.0 - 0.6 * seam);
  } else if (mat == 3) {
    col = vec3(0.03) * lightD(P, N, 1.0, 1.0);
  }

  float tFront = tHit;

  /* ---------- plates stacked against the wall (left), in the edge of the left pool ---------- */
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float R = 2.25 - 0.08 * fi;
    vec3 c = vec3(-13.2 + 0.45 * fi, uFloorY + R, WALL_Z + 0.75 + 0.42 * fi);
    vec3 n = normalize(vec3(0.12, 0.16, 1.0));
    float tp = dot(c - ro, n) / dot(rd, n);
    if (tp > 0.0) {
      vec3 q = ro + rd * tp - c;
      float r = length(q);
      float b2 = coc(tp, rd);
      float pp = pxPerUnit(tp, rd);
      float cov = edge((r - R) * pp, b2);
      // black rubber face with a raised lip and a ring of white lettering, steel hub
      float hub = 1.0 - smoothstep(0.24, 0.3, r);
      float lip = smoothstep(R - 0.3, R - 0.05, r);
      float txt = band(abs(r - R * 0.8) * pp, 0.12 * pp, b2) * mix(0.55, step(0.45, vnoise(vec2(atan(q.y, q.x + 1e-4) * 9.0, fi * 3.0))), keepF(4.0, b2 / pp));
      vec3 nn = normalize(n + normalize(q + 1e-4) * lip * 0.9);
      vec3 pw = ro + rd * tp;
      vec3 c0 = vec3(0.05 + 0.3 * txt) * lightD(pw, nn, 1.0, 0.8) + lightS(pw, nn, V, 18.0, 1.0) * (0.08 + 0.25 * lip);
      vec3 c1 = vec3(0.45) * lightD(pw, n, 1.0, 1.0) + lightS(pw, n, V, 40.0, 1.0) * 0.5;
      over(col, tFront, mix(c0, c1, hub), cov, tp, tHit);
    }
  }

  /* ---------- kettlebells on the floor by the wall (right), under the right pool ---------- */
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float r = 0.56 - 0.07 * fi;
    vec3 c = vec3(13.4 + 1.4 * fi + 0.2 * fi * fi, uFloorY + r * 0.98, WALL_Z + 1.4 + 0.6 * fi);
    vec3 oc = c - ro;
    float tc = dot(oc, rd);
    if (tc > 0.0) {
      float d = length(oc - rd * tc);
      float pp = pxPerUnit(tc, rd);
      float b2 = coc(tc, rd);
      float cov = edge((d - r) * pp, b2);
      // handle: a loop over the bell, in the plane facing the camera
      vec3 hq = ro + rd * (dot(c - ro, vec3(0.0, 0.0, 1.0)) / rd.z) - (c + vec3(0.0, r * 0.85, 0.0));
      float hr = length(hq.xy * vec2(1.0, 0.9));
      float hcov = band(abs(hr - r * 0.62) * pp, 0.09 * pp, b2) * step(-0.05, hq.y);
      vec3 sp = ro + rd * (tc - sqrt(max(r * r - d * d, 0.0)));
      vec3 nn = normalize(sp - c);
      vec3 kc = vec3(0.06) * lightD(sp, nn, 1.0, 0.9) + lightS(sp, nn, V, 30.0, 1.0) * 0.2;
      over(col, tFront, kc, max(cov, hcov), tc, tHit);
    }
  }

  /* ---------- the rig: two racks (uprights, spotter arms, J-cups, base), a loaded bar ---------- */
  float zBack = WALL_Z + 3.4;
  float zFront = WALL_Z + 9.4;
  for (int k = 0; k < 2; k++) {
    float zr = k == 0 ? zBack : zFront;
    for (int i = 0; i < 4; i++) {
      // two racks, 1.16 m between uprights (the loaded bar's collars sit just outside them)
      float x0 = i < 2 ? -8.9 + 5.8 * float(i) : 7.1 + 5.8 * float(i - 2);
      float sx;
      float y;
      float tc;
      float cov = tube(ro, rd, x0, zr, 0.19, 12.0, sx, y, tc);
      if (cov <= 0.002) continue;
      float pp = pxPerUnit(tc, rd);
      float b2 = coc(tc, rd);
      // a square steel tube with a matte black powder coat: the faces toward the lights pick up a sheen, and its
      // edges pick up a rim from the lit wall behind it
      vec3 pw = vec3(x0, uFloorY + y, zr);
      vec3 nn = normalize(vec3(sign(sx) * smoothstep(0.55, 0.95, abs(sx)), 0.0, 1.0));
      // pin holes up the front face (Westside spacing)
      float holes = (1.0 - smoothstep(0.03, 0.06, abs(fract(y / 0.5) - 0.5) * 0.5)) * step(abs(sx), 0.45) * exp(-pow(b2 / pp * 8.0, 2.0));
      vec3 pc = vec3(0.035) * lightD(pw, nn, 1.0, 0.85) + lightS(pw, nn, V, 26.0, 1.0) * 0.2;
      pc += wallGlow(pw) * 0.05 * smoothstep(0.55, 1.0, abs(sx)) * uLight;
      pc *= 1.0 - 0.6 * holes;
      over(col, tFront, pc, cov, tc, tHit);
    }
  }
  for (int i = 0; i < 4; i++) {
    float x0 = i < 2 ? -8.9 + 5.8 * float(i) : 7.1 + 5.8 * float(i - 2);
    float tc;
    vec3 pw;
    // spotter arms off the front uprights at 85 cm, reaching toward the platform: their tops catch the downlights
    float cov = armZ(ro, rd, x0, 4.25, zFront, zFront + 2.8, 0.13, tc, pw);
    if (cov > 0.002) {
      vec3 nn = normalize(vec3(0.0, 1.0, 0.35));
      vec3 ac = vec3(0.05) * lightD(pw, nn, 1.0, 0.9) + lightS(pw, nn, V, 30.0, 1.0) * 0.35;
      over(col, tFront, ac, cov, tc, tHit);
    }
    // the base: a low steel frame along the floor from the back to the front upright
    cov = armZ(ro, rd, x0, 0.22, zBack, zFront + 0.6, 0.2, tc, pw);
    if (cov > 0.002) {
      vec3 nn = normalize(vec3(0.0, 1.0, 0.6));
      vec3 ac = vec3(0.03) * lightD(pw, nn, 1.0, 0.7) + lightS(pw, nn, V, 26.0, 1.0) * 0.15;
      over(col, tFront, ac, cov, tc, tHit);
    }
    // J-cups at 1.1 m, a little in front of the upright (UHMW lined steel)
    vec3 jc = vec3(x0, uFloorY + 5.45, zFront + 0.3);
    vec3 oc = jc - ro;
    float tj = dot(oc, rd);
    if (tj > 0.0) {
      vec3 q = ro + rd * tj - jc;
      float pp = pxPerUnit(tj, rd);
      float b2 = coc(tj, rd);
      float dj = max(abs(q.x) - 0.2, abs(q.y) - 0.24);
      float jcov = edge(dj * pp, b2);
      vec3 nn = normalize(vec3(0.0, 0.6, 1.0));
      vec3 jcol = vec3(0.07) * lightD(jc, nn, 1.0, 1.0) + lightS(jc, nn, V, 30.0, 1.0) * 0.4;
      over(col, tFront, jcol, jcov, tj, tHit);
    }
  }
  {
    // crossmembers tying each rack's front uprights together low and high (the high one runs out of frame)
    float tc;
    vec3 pw;
    for (int r = 0; r < 2; r++) {
      float xa = r == 0 ? -8.9 : 7.1;
      for (int h = 0; h < 2; h++) {
        float yb = h == 0 ? 0.45 : 11.6;
        float cov = barX(ro, rd, yb, zFront, xa, xa + 5.8, 0.19, tc, pw);
        if (cov > 0.002) {
          vec3 nn = normalize(vec3(0.0, h == 0 ? 1.0 : -0.3, 1.0));
          vec3 ac = vec3(0.035) * lightD(pw, nn, 1.0, 0.85) + lightS(pw, nn, V, 26.0, 1.0) * 0.2;
          over(col, tFront, ac, cov, tc, tHit);
        }
      }
    }
  }
  {
    // a loaded bar racked in the right bay, on the J-cups
    float yb = uFloorY + 5.75;
    float zb = zFront + 0.3;
    vec2 rel = vec2(yb, zb) - ro.yz;
    vec2 dyz = rd.yz;
    float dd = dot(dyz, dyz);
    float tc = dot(rel, dyz) / dd;
    if (tc > 0.0) {
      float x = ro.x + rd.x * tc - 10.0;
      float d = length(ro.yz + dyz * tc - vec2(yb, zb));
      float pp = pxPerUnit(tc, rd);
      float b2 = coc(tc, rd);
      float ax = abs(x);
      float rad = ax < 3.25 ? 0.07 : 0.13;
      float cov = band(d * pp, rad * pp, b2) * (1.0 - smoothstep(5.45, 5.55, ax));
      vec3 pw = vec3(10.0 + x, yb, zb);
      vec3 nn = normalize(vec3(0.0, (ro.y + rd.y * tc - yb) / rad, 1.0));
      // satin steel shaft and sleeves
      vec3 sc = vec3(0.32) * lightD(pw, nn, 1.0, 1.0) + lightS(pw, nn, V, 60.0, 1.0) * 0.9;
      over(col, tFront, sc, cov, tc, tHit);
    }
    // two bumper plates a side: black rubber, white lettering round the face, a raised lip, a bright steel hub
    for (int s = 0; s < 4; s++) {
      float side = s < 2 ? -1.0 : 1.0;
      float xp = 10.0 + side * (3.47 + 0.36 * float(s - (s < 2 ? 0 : 2)));
      float t1 = (xp - 0.16 - ro.x) / rd.x;
      float t2 = (xp + 0.16 - ro.x) / rd.x;
      float ta = max(min(t1, t2), 0.0);
      float tb = max(t1, t2);
      if (tb <= 0.0) continue;
      // the closest the ray comes to the plate's axis while inside its thickness
      vec2 o = ro.yz - vec2(yb, zb);
      float tm = clamp(-dot(o, rd.yz) / dot(rd.yz, rd.yz), ta, tb);
      vec2 q = o + rd.yz * tm;
      float r = length(q);
      float pp = pxPerUnit(tm, rd);
      float b2 = coc(tm, rd);
      float cov = edge((r - 1.125) * pp, b2);
      vec3 pw = vec3(xp, yb + q.x, zb + q.y);
      bool face = tm <= ta + 1e-3 || tm >= tb - 1e-3;
      float lipW = smoothstep(0.88, 1.08, r);
      vec3 nn = face ? normalize(vec3(-sign(rd.x), 0.0, 0.0) + vec3(0.0, q / max(r, 1e-3)) * lipW * 0.8) : normalize(vec3(0.0, q));
      float hub = 1.0 - smoothstep(0.2, 0.26, r);
      float txt = face ? band(abs(r - 0.82) * pp, 0.1 * pp, b2) * mix(0.55, step(0.45, vnoise(vec2(atan(q.y, q.x + 1e-4) * 8.0, float(s) * 2.0))), keepF(4.0, b2 / pp)) : 0.0;
      vec3 pc = vec3(0.055 + 0.32 * txt) * lightD(pw, nn, 1.0, 0.9) + lightS(pw, nn, V, 16.0, 1.0) * (0.1 + 0.3 * lipW);
      pc += wallGlow(pw) * 0.04 * lipW * uLight;
      vec3 hc = vec3(0.4) * lightD(pw, nn, 1.0, 1.0) + lightS(pw, nn, V, 50.0, 1.0) * 0.8;
      over(col, tFront, mix(pc, hc, hub * float(face)), cov, tm, tHit);
    }
  }

  /* ---------- gymnastic rings on straps, hung low in front of the rig (left) ---------- */
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec3 c = vec3(-3.4 + 2.3 * fi, uFloorY + 4.7 - 0.12 * fi, min(WALL_Z + 15.0, -11.0) - 0.4 * fi);
    float yaw = 0.5 + 0.7 * fi;
    vec3 n = vec3(sin(yaw), 0.0, cos(yaw));
    float tp = dot(c - ro, n) / dot(rd, n);
    float pp = pxPerUnit(max(tp, 0.1), rd);
    float b2 = coc(max(tp, 0.1), rd);
    if (tp > 0.0) {
      vec3 q = ro + rd * tp - c;
      float r = length(q);
      float cov = band(abs(r - 0.52) * pp, 0.07 * pp, b2);
      // round section: the normal turns smoothly from the outside of the ring over its face to the inside
      float acr = clamp((r - 0.52) / 0.07, -1.0, 1.0);
      vec3 nn = normalize(n * sqrt(1.0 - acr * acr) + q / max(r, 1e-3) * acr);
      vec3 pw = c + q;
      // birch wood: warm, a little satin
      vec3 rc = vec3(0.3, 0.24, 0.17) * lightD(pw, nn, 1.0, 1.0) + lightS(pw, nn, V, 10.0, 1.0) * 0.03;
      over(col, tFront, rc, cov, tp, tHit);
    }
    // the strap: from the top of the ring straight up out of the frame
    vec2 rel = vec2(c.x, c.z) - ro.xz;
    float dd = dot(rd.xz, rd.xz);
    float tc = dot(rel, rd.xz) / dd;
    if (tc > 0.0) {
      float d = length(ro.xz + rd.xz * tc - c.xz);
      float y = ro.y + rd.y * tc - c.y;
      float pps = pxPerUnit(tc, rd);
      float bs = coc(tc, rd);
      float cov = band(d * pps, 0.095 * pps, bs) * smoothstep(0.5, 0.62, y);
      vec3 pw = vec3(c.x, c.y + y, c.z);
      vec3 sc = vec3(0.07) * lightD(pw, normalize(vec3(-0.3, 0.0, 1.0)), 1.0, 1.0);
      over(col, tFront, sc, cov, tc, tHit);
    }
  }

  /* ---------- the air: chalky haze that thickens toward the floor and with distance ---------- */
  float tEnd = min(tFront, 120.0);
  // optical depth: a thin room haze plus a layer lying on the floor (analytic height-fog integral)
  float sig0 = 0.0065;
  float sig1 = 0.03;
  float hf = 2.2;
  float od = sig0 * tEnd;
  float y0 = ro.y - uFloorY;
  if (abs(rd.y) > 1e-4) od += sig1 * hf * (exp(-y0 / hf) - exp(-(y0 + rd.y * tEnd) / hf)) / rd.y;
  else od += sig1 * exp(-y0 / hf) * tEnd;
  float T = exp(-od);
  // the haze is lit by the room's bounce, and near the back wall by the light coming off its pools: the floor
  // haze glows softly where it meets the wall instead of the floor ending in a hard line
  vec3 Pend = ro + rd * tEnd;
  float nearWall = exp(-max(Pend.z - WALL_Z, 0.0) / 7.0);
  vec3 hazeC = uAmb * 2.0 + wallGlow(Pend) * 0.045 * nearWall * uLight;
  col = col * T + hazeC * (1.0 - T);

  // in-scatter of the pendant along the ray (closed form for a point light in uniform haze, weighted by its cone
  // where the ray passes closest): a soft shaft of light falls through the chalky air onto the letters
  vec3 kp = uKeyPos - ro;
  float t0 = dot(kp, rd);
  float hh = max(length(kp - rd * t0), 0.3);
  float air = (atan((tEnd - t0) / hh) - atan(-t0 / hh)) / hh;
  vec3 xc = ro + rd * clamp(t0, 0.0, tEnd);
  float coneAt = keyCone(normalize(uKeyPos - xc));
  col += uKeyCol * air * 0.00014 * (0.04 + 0.96 * coneAt) * uLight;

  // the downlights' cones through the haze: marched where they hang (near the back wall)
  if (rd.z < -1e-3) {
    float ta = max((WALL_Z + 16.0 - ro.z) / rd.z, 0.0);
    float tb = min((WALL_Z - ro.z) / rd.z, tEnd);
    if (tb > ta) {
      float fs = float(uSteps);
      float dt = (tb - ta) / fs;
      float jit = h21(gl_FragCoord.xy);
      vec3 sc = vec3(0.0);
      for (int i = 0; i < 16; i++) {
        if (i >= uSteps) break;
        float t = ta + (float(i) + jit) * dt;
        vec3 x = ro + rd * t;
        float hx = x.y - uFloorY;
        float rho = 0.6 + 1.6 * exp(-hx / 3.0);
        // slow drifting density
        rho *= 0.6 + 0.8 * vnoise(x.xy * 0.22 + vec2(uTime * 0.05, -uTime * 0.02) + x.z * 0.13);
        for (int s = 0; s < 2; s++) {
          vec3 L = uSpotPos[s] - x;
          float d2 = dot(L, L);
          float cone = smoothstep(uSpotCone[s].x, uSpotCone[s].y, dot(-L, uSpotDir[s]) * inversesqrt(d2));
          sc += uSpotCol[s] * cone / d2 * rho;
        }
      }
      col += sc * dt * 0.0022 * T * uLight;
    }
  }

  // a NaN or inf here would spread through the bloom's mip chain as black blocks
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  gl_FragColor = vec4(clamp(col, 0.0, 64.0), 1.0);
}
`

/**
 * The room pass: a full-screen triangle in its own scene, rendered into a reduced-resolution half-float target.
 * `update(camera, frame)` sets the camera and the per-frame inputs; `render(gl)` draws it.
 */
export function createRoom() {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  const cosd = (d) => Math.cos(THREE.MathUtils.degToRad(d))
  const mat = new THREE.ShaderMaterial({
    vertexShader: ROOM_VERT,
    fragmentShader: ROOM_FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTanHalf: { value: 0.27 },
      uFloorY: { value: -1.3 },
      uWallZ: { value: ROOM.wallZ },
      uSteps: { value: 14 },
      uFocus: { value: 9 },
      uCocK: { value: 8 },
      uTime: { value: 0 },
      uLight: { value: 0 },
      uKeyPos: { value: new THREE.Vector3() },
      uKeyDir: { value: new THREE.Vector3(0, -1, 0) },
      uKeyCone: { value: new THREE.Vector2(cosd(ROOM.key.outer), cosd(ROOM.key.inner)) },
      uKeyCol: { value: new THREE.Vector3(...ROOM.key.color).multiplyScalar(ROOM.key.power) },
      uKeyR: { value: ROOM.key.radius },
      uSpotPos: { value: ROOM.spots.map(() => new THREE.Vector3()) },
      uSpotDir: { value: ROOM.spots.map(() => new THREE.Vector3(0, -1, 0)) },
      uSpotCol: { value: ROOM.spots.map((s) => new THREE.Vector3(...s.color).multiplyScalar(s.power)) },
      uSpotCone: { value: ROOM.spots.map((s) => new THREE.Vector2(cosd(s.outer), cosd(s.inner))) },
      uAmb: { value: new THREE.Vector3(...ROOM.ambient) },
      uMask: { value: null },
      uMaskBox: { value: new THREE.Vector4(-4, -1, 8, 2) },
      uMaskRes: { value: 40 },
      uMaskOn: { value: 0 },
      uLetterY: { value: new THREE.Vector2(-1.2, 1.2) },
      uBlock: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCloud: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCloudA: { value: 0 },
      uSplat: { value: new THREE.Vector4(0, 0, 0, 1) },
    },
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(mesh)
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const rt = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  })
  const u = mat.uniforms
  const fwd = new THREE.Vector3()
  let quality = 0
  return {
    scene,
    cam,
    rt,
    uniforms: u,
    material: mat,
    /** size of the target for a drawing buffer of w x h (the room is out of focus: half resolution, capped) */
    setSize(w, h, scale) {
      const k = Math.min(scale, 1100 / Math.max(w, 1))
      const tw = Math.max(32, Math.round(w * k))
      const th = Math.max(32, Math.round(h * k))
      if (rt.width !== tw || rt.height !== th) rt.setSize(tw, th)
      u.uRes.value.set(tw, th)
    },
    update(camera, floorY, aspect = 1.6) {
      u.uInvProj.value.copy(camera.projectionMatrixInverse)
      u.uCamWorld.value.copy(camera.matrixWorld)
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld)
      camera.getWorldDirection(fwd)
      u.uCamFwd.value.copy(fwd)
      u.uTanHalf.value = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      u.uFloorY.value = floorY
      u.uWallZ.value = wallZFor(aspect)
      keyPose(floorY, u.uKeyPos.value, u.uKeyDir.value)
      for (let i = 0; i < ROOM.spots.length; i++) spotPose(i, floorY, aspect, u.uSpotPos.value[i], u.uSpotDir.value[i])
    },
    /** quality rung: 0 full, 1 lighter (smaller target, fewer march steps), 2 lightest */
    setQuality(level) {
      quality = level
      u.uSteps.value = level === 0 ? 14 : level === 1 ? 9 : 6
    },
    get scale() {
      return quality === 0 ? 0.5 : quality === 1 ? 0.4 : 0.32
    },
    render(gl) {
      const prev = gl.getRenderTarget()
      gl.setRenderTarget(rt)
      gl.render(scene, cam)
      gl.setRenderTarget(prev)
    },
    dispose() {
      geo.dispose()
      mat.dispose()
      rt.dispose()
    },
  }
}

/** The headline's silhouette as a mipmapped texture, for its shadow and contact occlusion on the floor. */
export function maskTexture(raster) {
  const tex = new THREE.CanvasTexture(raster.canvas)
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  const { w, h, res, cx, cy } = raster
  return { tex, box: new THREE.Vector4(-cx / res, -(h - cy) / res, w / res, h / res), res }
}

/** Composite: the room target upsampled over the frame (a 4-tap tent, smoother than plain bilinear). */
export const ROOM_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tRoom;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tRoom, vUv + uTexel * vec2(0.35, 0.15)).rgb
         + texture2D(tRoom, vUv + uTexel * vec2(-0.15, 0.35)).rgb
         + texture2D(tRoom, vUv + uTexel * vec2(-0.35, -0.15)).rgb
         + texture2D(tRoom, vUv + uTexel * vec2(0.15, -0.35)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}
`
