import { COMMON_GLSL } from './sim.js'

/**
 * Render shaders for the chalk dust. Colours are linear light; the composer tone-maps the frame at the end
 * (Khronos Neutral), so the shaders only finish with three's colour-space chunk.
 */

/* ------------------------------------------------------------------ */
/* Dust grains, and the soft pass drawn from a subset of them:         */
/* a powder body under the letters and the billowing volume of the     */
/* burst cloud                                                         */
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
uniform float uLight;     // the room's lights coming up
uniform float uShed;
uniform float uWind;
uniform vec2 uWindBox;
uniform float uHaze;      // 1 for the soft pass
uniform float uMaxSize;
uniform float uAirMax;    // airborne splats and haze puffs are capped (device px): overdraw stays in budget
uniform float uIntro;     // intro clock, same as the sim's
uniform float uImpact;
uniform mat3 uBlockR;
uniform vec3 uBlockH;
uniform float uBlockRad;
uniform vec3 uBlockV;     // the falling block's velocity and spin (world), for its motion blur
uniform vec3 uBlockW;
uniform float uShutter;   // exposure (s)
uniform mat3 uImpR;       // the block at the impact (when each grain lets go)
uniform vec3 uImpC;
uniform vec3 uImpV;
uniform vec3 uImpP;
uniform float uCrackV;
uniform float uFloorY;
uniform vec3 uKeyPos;     // the key light (world)
uniform vec3 uCloudC;     // the burst cloud as a whole (centre, radii), for its shading
uniform vec3 uCloudRad;
uniform float uCloudOn;
uniform float uGrow;      // 1 → ~2: airborne powder spreads as the cloud billows out
uniform vec2 uPuffShape;
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
  // the sim marks grains still on the block with w = -1
  float onBlock = step(P.w, -0.5);
  vec3 pos = P.xyz;
  vec3 bl = B.xyz;
  float chip = 0.0;
  if (onBlock > 0.5 || uIntro < uImpact + 0.3) {
    chip = chipDepth(B.xyz, uBlockH, uBlockRad);
    bl = B.xyz - rboxNormal(B.xyz, uBlockH, uBlockRad) * chip;
  }
  // motion blur on the falling block: each grain is spread over the 1/120 s exposure along its own motion (the
  // throw plus the spin), the same shutter the chips are drawn with, so the block smears instead of strobing
  if (onBlock > 0.5 && uIntro < uImpact) {
    vec3 vg = uBlockV + cross(uBlockW, uBlockR * bl);
    pos -= vg * uShutter * (hz(seed, 91.7) - 0.5);
  }
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  float var1 = hz(seed, 41.3);
  float wall = step(I.b, 8.0);
  // each grain leaves the block as the crush reaches it: it keeps the block's look for an instant and dissolves into
  // the cloud's as it spreads (its opacity goes first: the same powder over more space thins out at once)
  float relT = uImpact + crushTime(bl, uImpR, uImpC, uImpV, uImpP, uFloorY, uCrackV);
  float age = uIntro - relT;
  float trail = step(B.w, 0.999) * (1.0 - onBlock) * step(uIntro, uImpact + 0.25);
  float burstGrain = (1.0 - onBlock) * step(0.999, B.w) * step(uImpact, uIntro);
  float blockLook = max(onBlock, burstGrain * (1.0 - smoothstep(0.0, 0.16, age)));
  float blockOpaque = max(onBlock, burstGrain * (1.0 - smoothstep(0.0, 0.06, age)));

  // ---------- light ----------
  // on the letter: the baked key-light shade (raking light on the shoulders, lit and shadowed walls)
  float onLetter = exp(-length(P.xyz - T.xyz) * 4.5);
  vec3 Lk = normalize(uKeyPos - P.xyz);
  // in the cloud: each grain is shaded as if it sat on the front surface of its lump at its place on screen (an
  // impostor normal), and the cloud as a whole likewise. Grains are blended in no particular depth order, so
  // shading by a grain's own buried position would just average out to a flat blob; shading by where it shows
  // keeps every lump a lit ball of powder with a soft shadow side, and the cloud brighter toward the key.
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camF = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec3 q = lumpPos(seed);
  vec2 qs = vec2(dot(q, camR), dot(q, camU));
  float qr2 = min(dot(qs, qs), 1.0);
  vec3 nL = qs.x * camR + qs.y * camU + sqrt(1.0 - qr2) * camF;
  // powder scatters light round its terminator: a wrapped, softened lambert
  float lumpLit = clamp(dot(nL, Lk) * 0.75 + 0.36, 0.0, 1.0);
  vec3 rcw = (P.xyz - uCloudC) / uCloudRad;
  vec2 cs = vec2(dot(rcw, camR), dot(rcw, camU));
  float cr2 = min(dot(cs, cs), 1.0);
  vec3 nC = cs.x * camR + cs.y * camU + sqrt(1.0 - cr2) * camF;
  float cloudLit = clamp(dot(nC, Lk) * 0.7 + 0.38, 0.0, 1.0);
  // the cloud's own shadow: how much cloud lies between this grain and the key (a ray out through its ellipsoid),
  // and less of the room's light low down where the floor and the dense skirt of powder hide it
  vec3 dl = normalize(Lk / uCloudRad);
  float bq = dot(rcw, dl);
  float disc = bq * bq - (dot(rcw, rcw) - 1.0);
  float tOut = disc > 0.0 ? max(-bq + sqrt(disc), 0.0) : 0.0;
  float selfSh = mix(1.0, exp(-0.6 * tOut), uCloudOn);
  float low = 0.72 + 0.28 * smoothstep(0.0, 1.3, P.y - uFloorY);
  float keyAir = mix(0.82, 0.98 * lumpLit * mix(1.0, cloudLit, 0.6) * selfSh * mix(1.0, low, 0.6), uCloudOn);
  // loose dust anywhere else: a soft key from the upper left
  keyAir *= 0.9 + 0.12 * clamp(-P.x * 0.12 + P.y * 0.2 + 0.4, 0.0, 1.0);
  // ambient from the room: less under the cloud, where the floor hides the sky of the gym
  float ambAir = mix(0.15, 0.13 * (0.55 + 0.45 * (nC.y * 0.5 + 0.5)) * (0.7 + 0.3 * lumpLit) * low, uCloudOn);

  // on the block: pressed powder under the pendant key, the room's bounce, and the lit floor below it
  vec3 n = uBlockR * rboxNormal(B.xyz, uBlockH, uBlockRad);
  // chipped and crumbled spots face every which way: the broken faces catch the light differently
  vec3 jn = vec3(vn3(B.xyz * 11.0 + 1.0), vn3(B.xyz * 11.0 + 5.0), vn3(B.xyz * 11.0 + 9.0)) - 0.5;
  n = normalize(n + uBlockR * jn * 1.8 * smoothstep(0.015, 0.06, chip));
  float facingCam = dot(n, normalize(cameraPosition - P.xyz));
  // powder scatters a little light past its terminator, so the shading rolls off softly (never a hard CG edge)
  float ndl = dot(n, Lk);
  float dif = pow(clamp((ndl + 0.22) / 1.22, 0.0, 1.0), 1.35);
  float rim = pow(1.0 - clamp(facingCam, 0.0, 1.0), 3.0);
  // its colour: pressed-powder clouding across the block, a fine tooth, greyer smudges where it has been
  // handled, a few hairline cracks, and the broken spots a shade darker (fresh, rougher powder in shadow)
  float mott = vn3(B.xyz * 3.3 + 1.7) - 0.5;
  float tooth = vn3(B.xyz * 15.0 + 4.0) - 0.5;
  float smudge = smoothstep(0.6, 0.85, vn3(B.xyz * 1.7 + 7.3));
  float crack = (1.0 - smoothstep(0.02, 0.06, abs(vn3(B.xyz * 3.1 + 11.0) - 0.5))) * step(0.52, vn3(B.xyz * 1.1 + 3.3));
  float alb = (0.92 + 0.16 * mott + 0.06 * tooth) * (1.0 - 0.14 * smudge) * (1.0 - 0.42 * crack) * (1.0 - 1.2 * chip);
  float brick = (0.97 * dif + 0.08 * rim) * alb;
  float hFloor = P.y - uFloorY;
  float brickAmb = (0.1 + 0.07 * (n.y * 0.5 + 0.5) + 0.12 * max(-n.y, 0.0) * exp(-hFloor / 1.6)) * alb;

  // key (slightly warm daylight) and ambient (the neutral bounce of the room)
  float keyT = mix(mix(keyAir, I.r, onLetter), brick, blockLook);
  float ambT = mix(mix(ambAir, 0.0, onLetter), brickAmb, blockLook);
  keyT *= 1.0 + agit * 0.08 * sin(uTime * 11.0 + seed * 90.0) * (1.0 - blockLook);
  vec3 chalk = vec3(0.84, 0.845, 0.87);
  vColor = chalk * (vec3(1.0, 0.99, 0.97) * keyT * mix(0.25, 1.0, uLight) + vec3(0.86, 0.87, 0.9) * ambT);

  // ---------- size ----------
  // settled grains are crisp specks; airborne dust spreads into soft splats (wider as the cloud billows out), so
  // the cloud reads as a volume of powder rather than a field of sharp dots; on the block they close up into a
  // solid surface
  float airborne = (1.0 - onLetter) * (1.0 - blockLook);
  float grow = mix(1.0, uGrow, airborne * uCloudOn);
  float gsize = uSize * (0.62 + 0.76 * var1) * mix(1.0, 2.7, airborne) * mix(1.0, 1.45, blockLook) * grow;
  // the face of a letter closes up into a surface; the walls stay finer
  gsize *= mix(1.0, 1.3, onLetter * (1.0 - wall));
  // the block's silhouette is a little fuzzy: loose powder on its edges
  float fringe = blockLook * (1.0 - smoothstep(0.0, 0.3, abs(facingCam)));
  gsize *= 1.0 + 0.35 * fringe;
  // the soft pass: a powder body under the face of the letters, wide puffs in the air
  float body = (1.0 - wall) * (1.0 - smoothstep(0.2, 0.5, I.g));
  float hsize = mix(uHazeSize * (0.55 + 0.9 * var1) * grow, uSize * 4.2 * (0.8 + 0.4 * var1), onLetter);
  hsize = mix(hsize, uSize * 2.8, blockLook);
  float size = mix(gsize, hsize, uHaze);
  float px = size * uDist / depth;
  // airborne powder is capped in size (overdraw): soft grain splats at half uAirMax, the haze puffs at uAirMax
  px = min(px, mix(uMaxSize, mix(uAirMax * mix(0.5, 0.62, uCloudOn), uAirMax * mix(1.0, 1.25, uCloudOn), uHaze), airborne));
  gl_PointSize = clamp(px, 0.0, uMaxSize);

  // ---------- alpha ----------
  // settled grains are near opaque; airborne dust is thin, and thins further as it spreads (the same powder
  // over a bigger area), so the cloud stays translucent and soft instead of building up into a white blob
  float thin = 1.0 / pow(grow, 1.6);
  // the edges of each lump are thinner than its core: wispy, not a hard ball
  thin *= 1.0 - 0.55 * qr2 * uCloudOn * airborne;
  float airA = mix(0.05, 0.08, trail) * thin;
  // (opacity falls off faster than the splat grows, so a grain coming loose never reads as a bright dot)
  float a = mix(airA, mix(0.97, 0.9, wall), onLetter * onLetter);
  // soft pass: body on the letters; haze only where the dust is stirred (never a lone blob in clear air), and in the
  // opening's cloud more of the powder's volume is carried by these soft puffs than by sharp grains
  float hazeAir = (0.06 + 0.04 * trail + 0.075 * uCloudOn) * smoothstep(0.05, 0.6, max(max(agit, trail), uCloudOn)) * thin;
  float ha = mix(hazeAir, 0.95 * body, onLetter);
  a = mix(a, ha, uHaze);
  a = mix(a, mix(1.0, 0.85, uHaze), blockOpaque);
  a *= 1.0 - 0.4 * fringe;
  // the block hides the faces turned away from the camera (it is convex, so no depth buffer is needed); as it
  // bursts the far side fades into view with the rest of the powder
  a *= mix(1.0, step(-0.02, facingCam), blockLook);
  // a settled wall grain on a wall turned away from the camera sits behind the face: skip it, so it can never
  // show through the powder as a dark speck
  if (wall > 0.5 && onLetter > 0.5) {
    vec2 wn = vec2(cos(I.b), sin(I.b));
    if (dot(cameraPosition.xy - P.xy, wn) < 0.0) a *= 1.0 - onLetter;
  }

  // shed grains fade out and re-form
  vec3 sh = shedPhase(seed, I.g, uTime);
  float shedA = sh.z > 0.5 ? (sh.y < 2.8 ? 1.0 - smoothstep(1.7, 2.8, sh.y) : smoothstep(3.0, 3.6, sh.y)) : 1.0;
  a *= mix(1.0, shedA, uShed);
  // carried on the wind the powder thins as it actually spreads out (by how far it has been carried, not by the
  // gust's schedule), so the letters lift and stream away before they thin
  float carried = length(P.xyz - T.xyz) * smoothstep(0.0, 0.08, uWind);
  a *= (1.0 - 0.55 * smoothstep(0.6, 5.0, carried)) * (1.0 - smoothstep(8.0, 15.0, carried));
  a *= 1.0 - uHaze * smoothstep(0.3, 2.5, carried);
  // never let a grain sit on the lens
  a *= smoothstep(0.6, 2.0, depth);
  // in the cloud only part of the airborne grains is drawn (the rest fade out with the cloud's own ramp and
  // come back as they settle on their letter): the same look for less than half the overdraw
  float keep = step(0.7, hz(seed, 3.7));
  a *= mix(1.0, keep / 0.3 * 0.5, airborne * uCloudOn * (1.0 - uHaze));
  // dust far from its letter outside the burst (blown off by a clap) is spread thin over its path
  a *= mix(1.0, 0.5, smoothstep(1.5, 6.0, length(P.xyz - T.xyz)) * (1.0 - uCloudOn) * (1.0 - smoothstep(0.0, 0.08, uWind)));
  vAlpha = a * uAlpha;
  // (the powder body under a letter's face is drawn as broad opaque discs, so it closes up without holes; in
  // the air the soft pass is wide gaussian puffs)
  vSoft = max(uHaze * (1.0 - 0.85 * onLetter), airborne * 0.9);
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
  #include <colorspace_fragment>
}
`

/* ------------------------------------------------------------------ */
/* Motes: specks of chalk hanging in the gym's air. Lit by the real    */
/* lights (only the ones drifting through a beam really show), and     */
/* out of focus away from the letters (lens bokeh)                     */
/* ------------------------------------------------------------------ */
export const MOTE_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uBoxMin;     // near the letters: specks in focus, glinting in the key light
uniform vec3 uBoxMax;
uniform vec3 uFarMin;     // back by the wall, drifting through the spots' beams: soft discs
uniform vec3 uFarMax;
uniform float uPxK;       // drawing-buffer px per cap at unit view depth
uniform float uFocus;
uniform float uCocK;      // drawing-buffer px of blur at infinity
uniform float uWind;
uniform float uAlpha;
uniform vec3 uKeyPos;
uniform vec3 uKeyDir;
uniform vec2 uKeyCone;
uniform float uKeyI;
uniform vec3 uSpotPos[2];
uniform vec3 uSpotDir[2];
uniform vec2 uSpotCone[2];
uniform float uSpotI[2];
attribute vec4 aSeed;     // xyz 0..1, w size/brightness
varying float vAlpha;
varying float vRing;
void main() {
  vec3 q = aSeed.xyz;
  float t = uTime;
  // still air: a slow drift (a few cm a second) with a lazy wobble, wrapped inside the box
  q.x += t * (0.0015 + 0.003 * aSeed.w) + uWind * (0.5 + aSeed.y);
  q.y += t * 0.0012 * (aSeed.z - 0.45) + uWind * 0.2;
  q = fract(q);
  float near = step(aSeed.w, 0.5);
  vec3 p = mix(mix(uFarMin, uBoxMin, near), mix(uFarMax, uBoxMax, near), q);
  p.x += sin(t * 0.29 + aSeed.y * 20.0) * 0.14;
  p.y += sin(t * 0.21 + aSeed.x * 17.0) * 0.11;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  // irradiance from the key and the two downlights (inverse square, cones)
  vec3 L = uKeyPos - p;
  float e = uKeyI * (smoothstep(uKeyCone.x, uKeyCone.y, dot(-normalize(L), uKeyDir)) + 0.04) / dot(L, L);
  for (int i = 0; i < 2; i++) {
    vec3 Ls = uSpotPos[i] - p;
    float d2 = dot(Ls, Ls);
    e += uSpotI[i] * smoothstep(uSpotCone[i].x, uSpotCone[i].y, dot(-Ls, uSpotDir[i]) * inversesqrt(d2)) / d2;
  }
  // flakes turn as they drift: they glint
  float glint = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(t * (0.6 + aSeed.y * 1.4) + aSeed.x * 40.0), 3.0);
  float spx = (0.018 + 0.022 * aSeed.w) * uPxK / depth;
  float cpx = uCocK * abs(depth - uFocus) / depth * 2.0;
  float size = max(spx, cpx);
  gl_PointSize = clamp(size, 1.5, 56.0);
  // the same light spread over the blur disc
  float spread = clamp((spx * spx) / (size * size), 0.0, 1.0);
  vec3 e3 = abs(q * 2.0 - 1.0);
  float edge = (1.0 - smoothstep(0.85, 1.0, e3.x)) * (1.0 - smoothstep(0.85, 1.0, e3.y)) * (1.0 - smoothstep(0.85, 1.0, e3.z));
  // a defocused speck spreads its light over the disc; the brightest in a beam still read as soft discs
  vAlpha = clamp(e * 0.42 * glint * (0.5 + 0.5 * aSeed.y), 0.0, 1.0) * (0.12 + 0.88 * spread);
  vAlpha = min(vAlpha, 0.42) * edge * uAlpha * (1.0 - smoothstep(0.0, 0.5, uWind)) * smoothstep(1.0, 3.0, depth);
  vRing = 1.0 - spread;
}
`

export const MOTE_FRAG = /* glsl */ `
varying float vAlpha;
varying float vRing;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  // in focus a soft speck; out of focus a disc with a slightly brighter rim, like a lens renders it
  float speck = 1.0 - smoothstep(0.0, 1.0, r2);
  float disc = (1.0 - smoothstep(0.8, 1.0, r2)) * (0.6 + 0.4 * smoothstep(0.4, 0.95, r2));
  float a = mix(speck, disc, vRing);
  gl_FragColor = vec4(vec3(0.85, 0.87, 0.92), vAlpha * a);
  #include <colorspace_fragment>
}
`

/* ------------------------------------------------------------------ */
/* The room's upsample into the frame                                  */
/* ------------------------------------------------------------------ */
export const BG_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`
