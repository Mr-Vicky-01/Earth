import { COMMON_GLSL } from './sim.js'

/**
 * Render shaders for the chalk scene. Colours are worked out in linear light; every fragment shader ends with
 * three's colour-space chunk so the output is right whether it goes to the screen or to the bloom composer.
 */

/* ------------------------------------------------------------------ */
/* Dust grains, and the soft pass drawn from a subset of them:         */
/* a powder body under the letters and the haze of the cloud           */
/* ------------------------------------------------------------------ */
export const GRAIN_VERT = /* glsl */ `
uniform sampler2D tPos;
uniform sampler2D tTarget;
uniform sampler2D tInfo;
uniform sampler2D tBlock;
uniform float uSize;      // grain px at the letter plane (device px)
uniform float uHazeSize;  // haze puff px at the letter plane
uniform float uDist;      // camera distance to the letter plane
uniform float uTime;
uniform float uAlpha;     // master alpha (entrance)
uniform float uShed;
uniform float uWind;
uniform vec2 uWindBox;
uniform float uHaze;      // 1 for the soft pass
uniform float uMaxSize;
uniform float uIntro;     // intro clock, same as the sim's
uniform float uImpact;
uniform mat3 uBlockR;
uniform vec3 uBlockH;
uniform float uBlockRad;
uniform vec3 uCloudC;     // centre and size of the burst cloud, for its lit and shadow sides
uniform float uCloudR;
uniform float uCloudOn;
attribute vec2 aRef;
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;

${COMMON_GLSL}

void main() {
  vec4 P = texture2D(tPos, aRef);
  vec4 T = texture2D(tTarget, aRef);
  vec4 I = texture2D(tInfo, aRef);
  vec4 B = texture2D(tBlock, aRef);
  float seed = T.w;
  float agit = clamp(P.w, 0.0, 1.0);
  vec4 mv = modelViewMatrix * vec4(P.xyz, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  float var1 = hz(seed, 41.3);
  float wall = step(I.b, 8.0);
  float crumb = isCrumb(seed);
  // the sim marks grains still riding the block with w = -1
  float onBlock = step(P.w, -0.5);
  float trail = step(B.w, uImpact - 1e-3) * (1.0 - onBlock) * step(uIntro, uImpact + 0.25);

  // ---------- light ----------
  // on the letter: the baked key-light shade (raking light on the shoulders, lit and shadowed walls)
  float onLetter = exp(-length(P.xyz - T.xyz) * 4.5);
  // in the air: each lump of the cloud has a lit upper-left side and a shadowed underside, and the cloud as a
  // whole is brighter on the flank toward the key light; loose dust elsewhere takes a soft key from the upper left
  vec3 Lc = normalize(vec3(-0.55, 0.72, 0.42));
  float lump = dot(lumpScatter(seed), Lc);
  vec3 rc = (P.xyz - uCloudC) / uCloudR;
  float flank = clamp(dot(rc, Lc) * 0.55 + 0.5, 0.0, 1.0);
  float under = smoothstep(-0.15, -0.95, rc.y);
  float cloud = 0.38 + 0.36 * lump + 0.3 * flank - 0.22 * under;
  float loose = 0.7 + 0.14 * clamp(-P.x * 0.12 + P.y * 0.2 + 0.4, 0.0, 1.0) + 0.1 * lump;
  float air = mix(loose, cloud, uCloudOn);
  float shade = mix(air, I.r, onLetter);

  // on the block: a matte brick under a key from the upper left, a cool fill from the right, a little rim
  vec3 n = uBlockR * rboxNormal(B.xyz, uBlockH, uBlockRad);
  float facing = dot(n, normalize(cameraPosition - P.xyz));
  float dif = max(dot(n, normalize(vec3(-0.5, 0.78, 0.42))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.85, -0.05, 0.55))), 0.0);
  float rim = pow(1.0 - clamp(facing, 0.0, 1.0), 3.0);
  // pressed powder is never perfectly even: soft cloudy patches over the fine grain
  float press = sin(B.x * 7.3 + B.y * 3.1 + 1.7) * sin(B.z * 6.1 - B.x * 2.3) + 0.5 * sin(B.y * 11.0 - B.z * 5.0);
  float brick = (0.12 + 0.95 * dif + 0.2 * fill + 0.1 * rim) * (0.93 + 0.12 * hz(seed, 13.7)) * (1.0 + 0.05 * press);
  shade = mix(shade, brick, onBlock);
  shade *= 1.0 + agit * 0.08 * sin(uTime * 11.0 + seed * 90.0) * (1.0 - onBlock);
  vColor = vec3(0.835, 0.845, 0.885) * shade;

  // ---------- size ----------
  // settled grains are crisp specks; airborne dust spreads into soft splats, so the cloud reads as a volume of
  // powder rather than a field of sharp dots; on the block they close up into a solid surface
  float airborne = (1.0 - onLetter) * (1.0 - onBlock) * (1.0 - crumb);
  float gsize = uSize * (0.62 + 0.76 * var1) * mix(1.0, 2.7, airborne) * mix(1.0, 1.45, onBlock) * (1.0 + crumb * 0.3 * (1.0 - onLetter));
  // the face of a letter closes up into a surface; the walls stay finer
  gsize *= mix(1.0, 1.22, onLetter * (1.0 - wall));
  // the soft pass: a powder body under the face of the letters (3x a grain), wide puffs in the air
  float body = (1.0 - wall) * (1.0 - smoothstep(0.35, 0.8, I.g));
  float hsize = mix(uHazeSize * (0.55 + 0.9 * var1), uSize * 4.4 * (0.8 + 0.4 * var1), onLetter);
  hsize = mix(hsize, uSize * 2.8, onBlock);
  float size = mix(gsize, hsize, uHaze);
  gl_PointSize = clamp(size * uDist / depth, 0.0, uMaxSize);

  // ---------- alpha ----------
  // settled grains are near opaque; airborne dust is thin, so the cloud is translucent and builds up softly
  float airA = mix(0.085, 0.13, trail);
  airA = mix(airA, 0.9, crumb);
  // (opacity falls off faster than the splat grows, so a grain coming loose never reads as a bright dot)
  float a = mix(airA, mix(0.95, 0.9, wall), onLetter * onLetter);
  // soft pass: body on the letters; haze only where the dust is stirred (never a lone blob in clear air)
  float hazeAir = (0.05 + 0.04 * trail) * smoothstep(0.05, 0.6, max(agit, trail));
  float ha = mix(hazeAir, 0.9 * body, onLetter);
  a = mix(a, ha, uHaze);
  a = mix(a, mix(1.0, 0.85, uHaze), onBlock);
  // the block hides the faces turned away from the camera (it is convex, so no depth buffer is needed)
  if (onBlock > 0.5 && facing < -0.02) a = 0.0;
  // a settled wall grain on a wall turned away from the camera sits behind the face: skip it, so it can never
  // show through the powder as a dark speck
  if (wall > 0.5 && onLetter > 0.5) {
    vec2 wn = vec2(cos(I.b), sin(I.b));
    if (dot(cameraPosition.xy - P.xy, wn) < 0.0) a *= 1.0 - onLetter;
  }

  // shed grains fade out and re-form, the gust thins the dust as it carries it
  vec3 sh = shedPhase(seed, I.g, uTime);
  float shedA = sh.z > 0.5 ? (sh.y < 2.8 ? 1.0 - smoothstep(1.7, 2.8, sh.y) : smoothstep(3.0, 3.6, sh.y)) : 1.0;
  a *= mix(1.0, shedA, uShed);
  float rw = windRelease(T.xyz, seed, uWind, uWindBox);
  a *= 1.0 - smoothstep(0.62, 1.0, rw);
  a *= 1.0 - uHaze * smoothstep(0.1, 0.5, rw);
  // never let a grain sit on the lens
  a *= smoothstep(0.6, 2.0, depth);
  vAlpha = a * uAlpha;
  vSoft = max(uHaze, airborne * 0.85);
  if (vAlpha < 0.002) gl_PointSize = 0.0;
}
`

export const GRAIN_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  // grains: a soft round speck · soft pass: a wide gaussian puff
  float a = mix(1.0 - smoothstep(0.15, 1.0, r2), exp(-r2 * 3.2) * (1.0 - r2), vSoft);
  gl_FragColor = vec4(vColor, vAlpha * a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/* ------------------------------------------------------------------ */
/* Sparks: hot streaks thrown off the slam and every clap (heat colour) */
/* ------------------------------------------------------------------ */
export const SPARK_VERT = /* glsl */ `
uniform float uTime;
uniform vec4 uEv[4];      // xyz origin, w start time
uniform vec4 uEvP[4];     // x strength, y upward bias, z floor y
uniform vec2 uRes;        // drawing buffer px
uniform float uWidth;     // streak width, device px
attribute vec4 aSeed;
attribute float aSlot;
varying vec2 vUv;
varying vec3 vCol;
varying float vA;

${COMMON_GLSL}

vec3 sparkAt(float t, vec3 o, vec3 v0, float floorY) {
  float c = 3.4;
  float e = (1.0 - exp(-c * t)) / c;
  vec3 p = o + v0 * e;
  p.y -= 11.0 * (t - e) / c;
  p.y = max(p.y, floorY);
  return p;
}

void main() {
  int s = int(aSlot + 0.5);
  vec4 ev = uEv[0];
  vec4 ep = uEvP[0];
  if (s == 1) { ev = uEv[1]; ep = uEvP[1]; }
  else if (s == 2) { ev = uEv[2]; ep = uEvP[2]; }
  else if (s == 3) { ev = uEv[3]; ep = uEvP[3]; }
  float age = uTime - ev.w;
  float life = 0.28 + 0.38 * aSeed.y;
  if (age < 0.0 || age > life || ep.x <= 0.0 || aSeed.w > ep.w) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vA = 0.0;
    return;
  }
  vec3 dir = sphereDir(aSeed.x, aSeed.z);
  dir.y = mix(dir.y, abs(dir.y) * 0.75 + 0.3, ep.y);
  dir.z *= 0.45;
  dir = normalize(dir);
  float sp = ep.x * (4.0 + 11.0 * pow(aSeed.y, 1.4));
  vec3 head = sparkAt(age, ev.xyz, dir * sp, ep.z);
  vec3 tail = sparkAt(max(age - 0.028 - 0.03 * aSeed.y, 0.0), ev.xyz, dir * sp, ep.z);
  vec4 h = projectionMatrix * modelViewMatrix * vec4(head, 1.0);
  vec4 t = projectionMatrix * modelViewMatrix * vec4(tail, 1.0);
  vec2 hs = h.xy / h.w * uRes * 0.5;
  vec2 ts = t.xy / t.w * uRes * 0.5;
  vec2 ax = hs - ts;
  float L = length(ax);
  vec2 d = L > 1e-3 ? ax / L : vec2(1.0, 0.0);
  vec2 perp = vec2(-d.y, d.x);
  float k = age / life;
  float w = uWidth * (0.7 + 0.6 * aSeed.x) * (1.0 - 0.5 * k);
  // position.x: 0 tail … 1 head, position.y: -1 … 1 across
  vec2 sp2 = mix(ts - d * w, hs + d * w, position.x) + perp * position.y * w;
  vec4 clip = mix(t, h, position.x);
  gl_Position = vec4(sp2 / (uRes * 0.5) * clip.w, clip.z, clip.w);
  // white-hot at first, burning down to the heat orange, then out
  vCol = mix(vec3(1.0, 0.72, 0.42) * 6.0, vec3(1.0, 0.075, 0.016) * 4.0, smoothstep(0.0, 0.4, k));
  vA = (1.0 - k) * (1.0 - k);
  vUv = position.xy;
}
`

export const SPARK_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
void main() {
  float across = 1.0 - vUv.y * vUv.y;
  float along = 0.25 + 0.75 * vUv.x;
  gl_FragColor = vec4(vCol * vA * across * along, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/* ------------------------------------------------------------------ */
/* Motes: a few slow specks hanging in the air of the gym              */
/* ------------------------------------------------------------------ */
export const MOTE_VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uDist;
uniform vec3 uBox;        // half extents of the drift volume
uniform vec3 uCentre;
uniform float uWind;
uniform float uAlpha;
uniform vec2 uBeamO;      // beam origin / direction in world xy
uniform vec2 uBeamD;
attribute vec4 aSeed;     // xyz 0..1, w size/brightness
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec3 q = aSeed.xyz;
  float t = uTime;
  // slow drift with a lazy wobble, wrapped inside the box
  q.x += t * (0.004 + 0.006 * aSeed.w) + uWind * (0.6 + aSeed.y);
  q.y += t * (0.0025 * (aSeed.z - 0.4)) + uWind * 0.25;
  q = fract(q);
  vec3 p = uCentre + (q * 2.0 - 1.0) * uBox;
  p.x += sin(t * 0.31 + aSeed.y * 20.0) * 0.12;
  p.y += sin(t * 0.23 + aSeed.x * 17.0) * 0.1;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  gl_PointSize = clamp(uSize * (0.5 + aSeed.w * 1.1) * uDist / depth, 1.5, 16.0);
  // only the specks drifting through the key light's beam really catch it, and they glint as they turn
  vec2 rel = p.xy - uBeamO;
  float along = dot(rel, uBeamD);
  float across = abs(rel.x * uBeamD.y - rel.y * uBeamD.x);
  float beam = exp(-pow(across / (0.35 + along * 0.22), 2.0)) * smoothstep(0.0, 2.0, along) * exp(-along * 0.06);
  float glint = 0.55 + 0.45 * sin(t * (0.7 + aSeed.y * 1.3) + aSeed.x * 40.0);
  // fade at the edges of the wrap so nothing pops
  vec3 e = abs(q * 2.0 - 1.0);
  float edge = (1.0 - smoothstep(0.82, 1.0, e.x)) * (1.0 - smoothstep(0.82, 1.0, e.y));
  vAlpha = (0.002 + 0.085 * beam * glint) * (0.35 + 0.65 * aSeed.w) * edge * uAlpha * (1.0 - smoothstep(0.0, 0.5, uWind));
  vColor = vec3(0.8, 0.83, 0.92) * (0.75 + 0.4 * beam);
}
`

export const MOTE_FRAG = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  // out of focus: a faint disc with a brighter ring, like a speck caught by a lens, not a dead pixel
  float disc = (1.0 - smoothstep(0.75, 1.0, r2)) * (0.35 + 0.65 * smoothstep(0.3, 0.85, r2));
  gl_FragColor = vec4(vColor, vAlpha * disc);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/* ------------------------------------------------------------------ */
/* Background: ink, a cool cobalt-deep tint toward the edges, a soft    */
/* key light from the upper left, film grain, and the impact's flash   */
/* ------------------------------------------------------------------ */
export const BG_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const BG_FRAG = /* glsl */ `
uniform vec2 uRes;
uniform float uTime;
uniform float uFlash;
uniform vec2 uFlashUv;
uniform vec2 uFlashK;     // flash shape: a wide splash along the floor for the slam, round for a clap
uniform float uGrain;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);
  // display-referred design values (sRGB 0..1), converted to linear at the end
  vec3 ink = vec3(0.039, 0.039, 0.063);
  vec3 tint = vec3(0.045, 0.055, 0.15);
  float r = length(p * vec2(0.78, 1.0));
  vec3 col = mix(ink, tint, smoothstep(0.32, 1.05, r) * 0.9);
  // key light from the upper left: a soft wash and a faint cone through the dust
  vec2 o = vec2(-0.62 * aspect, 0.62);
  vec2 dir = normalize(vec2(0.82, -0.57));
  vec2 rel = p - o;
  float along = dot(rel, dir);
  float across = abs(rel.x * dir.y - rel.y * dir.x);
  float cone = exp(-pow(across / (0.08 + along * 0.3), 2.0)) * smoothstep(0.0, 0.35, along) * exp(-along * 1.1);
  float wash = exp(-dot(rel, rel) * 1.6);
  col += vec3(0.55, 0.6, 0.78) * (cone * 0.05 + wash * 0.05);
  // the flash
  vec2 fd = (vUv - uFlashUv) * vec2(aspect, 1.0) * uFlashK;
  float f2 = dot(fd, fd);
  col += vec3(0.78, 0.77, 0.82) * uFlash * exp(-f2 * 4.0) * 0.3;
  col += vec3(1.0, 0.3, 0.1) * uFlash * exp(-f2 * 26.0) * 0.22;
  // grain
  float g = hash(floor(gl_FragCoord.xy) + fract(uTime * 7.31) * 113.0) - 0.5;
  col += g * uGrain;
  gl_FragColor = vec4(toLinear(max(col, 0.0)), 1.0);
  #include <colorspace_fragment>
}
`
