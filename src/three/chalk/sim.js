import * as THREE from 'three'
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js'

/**
 * Chalk dust simulation on the GPU.
 * Two compute variables: tPos (xyz position, w = agitation 0..1.4) and tPrev (last frame's position).
 * Velocity is rebuilt from the two (position Verlet), so one heavy pass per frame moves every grain.
 * Units are cap heights of the headline; the letter plane is z = 0.
 */

/** Shared GLSL: hashes, the block's shape and wear, the burst's lumps, the wind path of the scroll exit, shedding. */
export const COMMON_GLSL = /* glsl */ `
float hz(float s, float k) { return fract(sin(s * k) * 43758.5453); }

vec3 sphereDir(float a, float b) {
  float z = a * 2.0 - 1.0;
  float t = b * 6.2832;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(t), r * sin(t), z);
}

// 3D value noise (sin-free hash, so it is stable on every GPU)
float h3d(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vn3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3d(i), h3d(i + vec3(1.0, 0.0, 0.0)), f.x), mix(h3d(i + vec3(0.0, 1.0, 0.0)), h3d(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(h3d(i + vec3(0.0, 0.0, 1.0)), h3d(i + vec3(1.0, 0.0, 1.0)), f.x), mix(h3d(i + vec3(0.0, 1.0, 1.0)), h3d(i + vec3(1.0)), f.x), f.y), f.z);
}

// outward normal of a point on the rounded chalk block (half extents hExt, edge radius rad)
vec3 rboxNormal(vec3 q, vec3 hExt, float rad) {
  vec3 d = abs(q) - (hExt - rad);
  return normalize(sign(q) * max(d, 0.0) + 1e-5);
}
// how far the block's surface is bitten in here: a used chalk block has worn, chipped, crumbly edges and corners
// (never the even bevel of a moulded bar) and a few shallow pits on its faces
float chipDepth(vec3 b, vec3 hExt, float rad) {
  vec3 d = abs(b) - (hExt - rad);
  float mx = max(d.x, max(d.y, d.z));
  float mn = min(d.x, min(d.y, d.z));
  // the middle component is close to 0 along an edge and very negative in the middle of a face
  float edge = smoothstep(-0.07, 0.0, d.x + d.y + d.z - mx - mn);
  float n = vn3(b * 7.0 + 3.1) * 0.7 + vn3(b * 17.0 + 7.7) * 0.3;
  return edge * max(n - 0.46, 0.0) * 0.22 + (1.0 - edge) * max(vn3(b * 26.0 + 1.3) - 0.8, 0.0) * 0.05;
}
vec3 blockPoint(vec3 b, vec3 hExt, float rad) {
  return b - rboxNormal(b, hExt, rad) * chipDepth(b, hExt, rad);
}
// seconds after the impact at which a block grain lets go. The block lands on a corner and crushes into the floor
// from it: a grain goes when it reaches the floor or when the crush front (from that corner) reaches it, whichever
// is first. impR/impC/impV: the block's pose and velocity at the impact, impP the contact point.
float crushTime(vec3 bl, mat3 impR, vec3 impC, vec3 impV, vec3 impP, float floorY, float crackV) {
  vec3 w = impC + impR * bl;
  float tf = (w.y - floorY - 0.015) / max(-impV.y, 1.0);
  float tc = length(w - impP) / crackV;
  return clamp(min(tf, tc), 0.0, 0.08);
}

// a grain's own scatter inside its lump of the burst (the render pass shades each lump's lit side with it)
vec3 lumpScatter(float seed) {
  return sphereDir(hz(seed, 17.31), hz(seed, 7.919));
}

// the scroll-exit gust sweeps the block from left to right. u: unclamped release, 0..1 inside the ramp
const float WIND_K = 2.2;
float windRamp(vec3 base, float seed, float wind, vec2 box) {
  float front = clamp((base.x - box.x) / box.y, 0.0, 1.0);
  return (wind * WIND_K - front * 0.6 - seed * 0.4) / 0.42;
}
float windRelease(vec3 base, float seed, float wind, vec2 box) {
  return clamp(windRamp(base, seed, wind, box), 0.0, 1.0);
}
// where the gust carries a released grain: a lift, then a long sweep off to the upper right
vec3 windOffset(float seed, float r) {
  float e = r * r;
  float h = fract(seed * 91.7);
  float g = fract(seed * 37.1);
  return vec3(e * (11.0 + 7.0 * h) + r * 0.5,
              e * (2.6 + 4.2 * g) + sin(r * 3.1416) * (0.25 + 0.7 * h),
              -e * (1.0 + 2.5 * g));
}
// shedding: a few edge grains drift off downward, fade, and re-form on their letter
// returns x = in the drift window (0/1), y = phase seconds, z = on
vec3 shedPhase(float seed, float edge, float time) {
  float on = step(hz(seed, 12.9898), 0.02) * step(0.3, edge);
  float period = 6.0 + 8.0 * hz(seed, 78.233);
  float ph = mod(time + hz(seed, 3.7) * period, period);
  return vec3(on * step(ph, 2.8), ph, on);
}
// the burst cloud is a cauliflower of LUMPS lumps arched over the headline, from the floor on the left, up over
// the top, to the floor on the right (a few grains fill the dense low core). Each grain joins the lump over its
// own letter, so the cloud later condenses where it stands. xyz = lump centre relative to the burst origin, w = radius.
const float LUMPS = 9.0;
vec4 lumpOf(vec3 base, float seed, vec2 box, vec2 shape) {
  float sweep = clamp((base.x - box.x) / box.y, 0.0, 1.0);
  float lf = clamp(sweep + (hz(seed, 61.7) - 0.5) * 0.3, 0.0, 0.999);
  float k = floor(lf * LUMPS) + 3.0;
  float j = clamp((k - 3.0 + 0.5 + (hz(k, 12.99) - 0.5) * 1.1) / LUMPS, 0.0, 1.0);
  float ang = mix(3.1, 0.04, j);
  float s = mix(0.62, 1.0, hz(k, 41.7));
  vec3 c = vec3(cos(ang) * shape.x, sin(ang) * shape.y, (hz(k, 78.23) - 0.5) * 1.1) * s;
  float rho = mix(0.72, 1.1, hz(k, 23.1));
  if (hz(seed, 5.31) < 0.1) {
    c = vec3((sweep - 0.5) * 1.6, 0.45, 0.0);
    rho = 0.8;
  }
  return vec4(c, rho);
}
// where a grain sits inside its lump (unit ball, denser toward the middle)
vec3 lumpPos(float seed) { return lumpScatter(seed) * pow(hz(seed, 29.17), 0.55); }
// a grain's place in the burst cloud tau seconds after the impact. Its lump first surges out low along the floor
// from the contact point (drag 'surge': the powder blown out from under the block), then rolls up into the crown a
// beat later and more slowly; afterwards lumps keep swelling, rising and drifting with the block's momentum.
// impP: contact point, o: burst origin (lumps are placed around it), throwDir: the block's horizontal heading.
vec3 cloudSpot(vec3 base, float seed, float tau, vec3 impP, vec3 o, float floorY, float surge, vec2 box, vec2 shape, vec2 throwDir) {
  vec4 lp = lumpOf(base, seed, box, shape);
  vec3 q = lumpPos(seed);
  float sh = 1.0 - exp(-surge * tau);
  float sv = 1.0 - exp(-3.6 * max(tau - 0.035, 0.0));
  float grow = 0.5 + 0.5 * (1.0 - exp(-4.5 * tau)) + 0.3 * tau;
  vec3 c = o + lp.xyz + q * lp.w * grow;
  // as it billows the cloud also gathers itself toward the headline: no hang between the burst and the letters
  c = mix(c, base, 0.38 * smoothstep(0.1, 0.75, tau));
  vec3 spot;
  spot.xz = impP.xz + (c.xz - impP.xz) * sh + throwDir * 0.35 * tau;
  float top = max(c.y - floorY, 0.05);
  // the surge is a low rolling layer, not a sheet on the floor: a few cm of turbulent powder, deepest at its front
  float hs = hz(seed, 11.3);
  float thick = (0.06 + 0.5 * hs * hs) * sh * (0.55 + 0.45 * sh) * (1.0 - 0.7 * sv);
  spot.y = floorY + 0.05 + thick + top * sv + 0.22 * tau * sv;
  // a little shear: the top of the cloud carries on the way the block was going
  spot.x += 0.3 * tau * (spot.y - floorY) * throwDir.x;
  return spot;
}
`

const POS_SHADER = /* glsl */ `
uniform sampler2D tTarget;
uniform sampler2D tInfo;
uniform sampler2D tBlock;
uniform float uDt;
uniform float uDtPrev;
uniform float uTime;
uniform float uIntro;     // intro clock (s): grains ride the block until they let go
uniform float uImpact;    // when the block hits
uniform float uSlam;      // 1 on the step the block hits
uniform mat3 uBlockR;
uniform vec3 uBlockC;
uniform vec3 uBlockV;
uniform vec3 uBlockH;
uniform float uBlockRad;
uniform mat3 uImpR;       // the block's pose and velocity at the impact, and the corner that hits
uniform vec3 uImpC;
uniform vec3 uImpV;
uniform vec3 uImpP;
uniform float uCrackV;    // speed of the crush front through the block (caps/s)
uniform vec2 uThrowDir;   // the block's horizontal heading
uniform float uK;         // spring stiffness toward the letters
uniform float uZeta;      // damping ratio of that spring
uniform float uYank;      // seconds since the pull back into the letters began (staggers each grain's start)
uniform float uDrag;      // air drag
uniform float uTurb;      // base turbulence
uniform float uBillow;    // large swirls in the burst cloud
uniform float uEddy;      // small eddies in stirred dust
uniform float uAgitDecay;
uniform float uAgitSoft;  // how much agitation loosens the spring
uniform float uAgitTurb;  // how much agitation stirs the turbulence
uniform float uCloud;     // 1 while the opening's cloud holds the grains that are not yet pulled in
uniform float uSurge;     // drag of the surge along the floor (also sets how far out it runs)
uniform vec2 uPuffShape;  // horizontal / vertical reach of the burst
uniform vec3 uBurstO;     // where the burst cloud is centred (on the floor, under the block)
uniform float uFloor;     // the floor
uniform float uSettle;    // coarse grains settle, the finest dust lifts
uniform float uVCap;      // top speed of a grain flowing back to its letter
uniform float uSwirl;     // swirl along the way (scaled by how far the grain still has to go)
uniform vec4 uBounds;     // soft walls that keep dust off the copy: xmin, xmax, ymin, ymax
uniform float uBoundsOn;
uniform vec4 uBurst;      // xyz centre, w speed: a user clap (one frame)
uniform float uBurstR;
uniform vec3 uPtr;        // pointer on the letter plane
uniform vec3 uPtrVel;
uniform float uPtrStr;    // 0..1 from pointer speed
uniform float uPtrR;
uniform float uBlow;      // 0..1 hold-to-blow
uniform float uWind;      // 0..1 scroll exit
uniform float uWindPrev;  // its value on the previous step and the one before: the gust carries the dust along
uniform float uWindPrev2;
uniform float uGust;      // 0..1 scroll speed
uniform vec2 uWindBox;    // block left x, block width
uniform float uBreath;
uniform float uShed;
uniform float uMaxV;

${COMMON_GLSL}

// ABC flow: divergence-free swirl, cheap enough for every grain every frame
vec3 flow(vec3 q, float t) {
  vec3 a = vec3(sin(q.z * 1.7 + t * 0.9) + cos(q.y * 1.3 - t * 0.7),
                sin(q.x * 1.5 - t * 0.8) + cos(q.z * 1.9 + t * 0.6),
                sin(q.y * 1.6 + t * 0.7) + cos(q.x * 1.2 - t * 0.9));
  q = q * 2.7 + vec3(1.7, 9.2, 3.1);
  a += 0.55 * vec3(sin(q.z + t * 1.3) + cos(q.y - t * 1.1),
                   sin(q.x - t * 1.2) + cos(q.z + t),
                   sin(q.y + t * 1.15) + cos(q.x - t * 1.25));
  return a;
}

vec3 spotAt(vec3 base, float seed, float tau) {
  return cloudSpot(base, seed, tau, uImpP, uBurstO, uFloor, uSurge, uWindBox, uPuffShape, uThrowDir);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 T = texture2D(tTarget, uv);
  vec4 B = texture2D(tBlock, uv);
  float seed = T.w;
  float tau = uIntro - uImpact;
  vec3 bl = blockPoint(B.xyz, uBlockH, uBlockRad);
  // when this grain leaves the block: on the impact, as the crush reaches it. A few on the faces trailing the throw
  // are shed earlier (powder smoking off the block); a grain on a leading face rides the block to the floor.
  float relT = uImpact + crushTime(bl, uImpR, uImpC, uImpV, uImpP, uFloor, uCrackV);
  if (B.w < 0.999) {
    vec3 wn0 = uBlockR * rboxNormal(B.xyz, uBlockH, uBlockRad);
    bool leading = dot(wn0, uBlockV) > -0.25 * length(uBlockV);
    if (!(leading && uIntro < uImpact)) relT = B.w * uImpact;
  }
  if (uIntro < relT) {
    vec3 pos;
    if (uIntro < uImpact) {
      // riding the block; the faces trailing the motion smear back a little: the throw is fast
      vec3 wn = uBlockR * rboxNormal(B.xyz, uBlockH, uBlockRad);
      float sp = length(uBlockV);
      vec3 vd = uBlockV / max(sp, 1e-4);
      float h = hz(seed, 3.31);
      float lag = max(0.0, -dot(wn, vd)) * step(0.62, h) * (h - 0.62) * 0.05;
      pos = uBlockC + uBlockR * bl - uBlockV * lag;
    } else {
      // the part of the block the crush hasn't reached yet carries on into the floor
      pos = uImpC + uImpV * tau + uImpR * bl;
    }
    // w = -1 marks a grain still on the block (the render pass reads it too)
    gl_FragColor = vec4(pos, -1.0);
    return;
  }

  vec4 P = texture2D(tPos, uv);
  vec3 p = P.xyz;
  float agit = P.w;
  vec3 pp = texture2D(tPrev, uv).xyz;
  vec4 I = texture2D(tInfo, uv);
  float h1 = hz(seed, 17.31);
  float h2 = hz(seed, 7.919);
  float h3 = hz(seed, 29.17);
  float dt = uDt;
  vec3 base = T.xyz;

  // the gust carries every grain it has released along its path, exactly (in both directions, so scrolling back
  // brings the dust home with the page); everything else (springs, swirl, pointer) acts relative to that carry.
  // The last step's carry is taken out of the Verlet velocity so it is not applied twice.
  float rwP = windRelease(T.xyz, seed, uWindPrev, uWindBox);
  float rwPP = windRelease(T.xyz, seed, uWindPrev2, uWindBox);
  vec3 carryP = windOffset(seed, rwP) - windOffset(seed, rwPP);
  vec3 vel = (p - pp - carryP) / max(uDtPrev, 1e-4);

  // the step a grain leaves the block
  if (agit < -0.5) {
    agit = 1.0;
    if (uIntro < uImpact - 1e-4) {
      // shed during the throw: left behind with a little of the block's speed, curling off in wisps
      vel = vel * 0.45 + lumpScatter(seed) * 0.9;
    } else {
      // crushed out of the block: it surges out low along the floor toward its place in the cloud, keeping a little
      // of the block's momentum; the floor turns the rest of its fall aside
      vec3 s0 = spotAt(base, seed, tau);
      vec3 s1 = spotAt(base, seed, tau + 0.01);
      vel = (s1 - s0) * 100.0 * (0.8 + 0.4 * h1) + (s0 - p) * 5.0 + vec3(uImpV.x, min(uImpV.y, 0.0), uImpV.z) * 0.3;
      vel.y = max(vel.y, 0.0) + 0.3 + 1.4 * h3 * h3;
    }
  }

  // the slam's blast catches the powder the throw left in the air and rolls it into the cloud
  if (uSlam > 0.5 && B.w < 0.999) {
    vel = (spotAt(base, seed, 0.25) - p) * 3.0;
    agit = 1.0;
  }

  // the letter this grain belongs to, breathing slightly, carried off by the exit gust
  vec3 tgt = base * (1.0 + uBreath * 0.0045 * sin(uTime * 1.25));
  tgt.z += uBreath * 0.03 * sin(uTime * 0.9 + base.x * 0.8 + base.y * 0.5);
  float rw = windRelease(base, seed, uWind, uWindBox);
  tgt += windOffset(seed, rw);
  vec3 carry = windOffset(seed, rw) - windOffset(seed, rwP);

  vec3 shed = shedPhase(seed, I.g, uTime) * uShed;
  float drifting = shed.x;

  // hold to blow: a ragged, lifting stream (its front wobbles with angle and time, never a clean ring)
  vec3 db = p - uPtr;
  float ab = atan(db.y, db.x + 1e-5);
  float rag = 1.0 + 0.32 * sin(ab * 3.0 + uTime * 2.3) + 0.2 * sin(ab * 5.0 - uTime * 3.7 + 1.3) + 0.12 * sin(ab * 9.0 + uTime * 5.1);
  float rb = uPtrR * 1.05 * rag;
  float d2b = dot(db.xy, db.xy) + db.z * db.z * 0.5;
  float fb = exp(-d2b / (rb * rb)) * uBlow;

  // back toward the letter (each grain a little different). The pull opens gradually and at a different moment for
  // every grain (only loosely left to right), so the headline condenses out of the cloud rather than snapping in
  float sweep = clamp((base.x - uWindBox.x) / uWindBox.y, 0.0, 1.0);
  float gate = smoothstep(0.0, 0.45, uYank - sweep * 0.1 - h3 * 0.32);
  float soft = clamp(agit, 0.0, 1.0) * uAgitSoft;
  float k = uK * (0.72 + 0.56 * h2) * gate * (1.0 - soft) * (1.0 - drifting) * (1.0 - 0.95 * fb);
  // a damped spring written as "steer toward the velocity that closes the gap": the same thing up close, but a
  // grain far from its letter travels at a top speed instead of being whipped in like a magnet
  float c = 2.0 * uZeta * sqrt(k);
  vec3 gap = tgt - p;
  vec3 vDes = gap * (k / max(c, 1e-3));
  float vd = length(vDes);
  float cap = uVCap * (0.8 + 0.4 * h1);
  if (vd > cap) vDes *= cap / vd;
  vec3 acc = (vDes - vel) * c - vel * uDrag;
  // on the way it rides the air: swirls that die out as it arrives
  float far = min(length(gap), 2.5);
  acc += flow(p * 0.55 + vec3(seed * 0.7, 0.0, 2.3), uTime * 0.7) * uSwirl * far * gate;

  // the opening's cloud: grains not yet pulled in follow their place in the billowing cloud (a soft spring plus the
  // place's own velocity, so they trail it organically and the turbulence below roughs them up)
  float held = uCloud * (1.0 - gate);
  if (held > 0.0) {
    vec3 s0 = spotAt(base, seed, tau);
    vec3 vs = (spotAt(base, seed, tau + 0.01) - s0) * 100.0;
    acc += ((s0 - p) * 26.0 + (vs - vel) * 8.5) * held;
  }

  // turbulence: calm when settled, wild when disturbed or blown away
  float amp = uTurb + agit * uAgitTurb + uGust * 1.4 + rw * 3.5 + drifting * 0.18 + fb * 7.0;
  acc += flow(p * 0.85 + vec3(0.0, 0.0, seed * 0.3), uTime) * amp;
  // small eddies where the dust is stirred: a clap's ring or a pointer's wake breaks up into curls
  acc += flow(p * 2.3 + vec3(seed * 0.21, 4.0, 1.0), uTime * 1.7) * uEddy * clamp(agit, 0.0, 1.0);
  acc += flow(p * 4.1 + vec3(2.0, seed * 0.13, 7.0), uTime * 2.6) * uEddy * 0.6 * clamp(agit - 0.15, 0.0, 1.0);
  // big slow swirls roll the burst cloud over itself
  acc += flow(p * 0.62 + vec3(4.1, 1.7, 0.0), uTime * 1.6) * uBillow * (1.0 - 0.7 * gate);
  // stirred powder sorts itself: the coarse grains sink, the finest dust lifts on the warm air
  float coarse = step(h1, 0.35);
  float stir = max(held, clamp(agit, 0.0, 1.0));
  acc.y += uSettle * stir * (coarse > 0.5 ? -1.0 : 0.25);

  // shedding grains drift down and a little sideways
  acc += drifting * vec3(0.06 * (h1 - 0.5), -0.13, 0.0);
  // the gust itself, with scroll-speed gusts on top
  acc += vec3(1.0, 0.45, 0.0) * (rw * 6.0 + uGust * 2.0 * (0.4 + rw));

  // pointer: a capsule over the last ~70 ms of its path pushes grains aside, drags them along and lifts them. Each
  // grain takes the push differently (powder is not a sheet), and either side of the path the air curls back
  float spd = length(uPtrVel);
  vec3 pa = uPtr;
  vec3 pb = uPtr - uPtrVel * 0.07;
  vec3 ab3 = pb - pa;
  float tc = clamp(dot(p - pa, ab3) / max(dot(ab3, ab3), 1e-5), 0.0, 1.0);
  vec3 d = p - (pa + ab3 * tc);
  d.z *= 0.7;
  float d2 = dot(d, d);
  vec3 nd = d * inversesqrt(d2 + 1e-4);
  float fp = exp(-d2 / (uPtrR * uPtrR)) * uPtrStr;
  float take = 0.3 + 1.4 * h2 * sqrt(h2);
  vec2 vdir = uPtrVel.xy / max(spd, 1e-3);
  float side = sign(vdir.x * d.y - vdir.y * d.x + 1e-5);
  vec3 curl = vec3(-nd.y, nd.x, 0.0) * side;
  acc += fp * (nd * 9.0 * take + uPtrVel * 3.2 * take * (1.0 - 0.45 * tc) + curl * spd * 1.5 * tc + vec3(0.0, 0.45 * spd * (0.4 + h3), 0.0));
  acc += fb * (normalize(db + 1e-4) * 11.0 + vec3(0.0, 6.5, 0.0));

  agit = agit * exp(-uAgitDecay * (0.65 + 0.7 * h3) * dt) + (fp * 8.0 + fb * 3.5) * dt;

  // soft walls keep dust clear of the nav band, the tag row and the copy. They only damp dust moving OUT through
  // them (dust coming home from outside is never pushed), each grain's wall sits a little differently (no ruler
  // edge), and a grain the wind has released, or one far from home, is not held at all
  vec3 jit = (vec3(h1, h2, h3) - 0.5) * vec3(0.5, 0.36, 0.0);
  // (and never between a grain and its own target: the gust's path runs far outside them)
  vec3 lo = min(vec3(uBounds.x, uBounds.z, -1e3) + 0.45 + jit, tgt - 0.35);
  vec3 hi = max(vec3(uBounds.y, uBounds.w, 1e3) - 0.45 + jit, tgt + 0.35);
  vec3 over = p - clamp(p, lo, hi);
  float ov = length(over);
  if (ov > 1e-5) {
    vec3 on = over / ov;
    float wall = smoothstep(0.0, 0.3, ov) * uBoundsOn * (1.0 - rw) * (1.0 - smoothstep(1.2, 3.0, length(gap)));
    acc -= on * (max(dot(vel, on), 0.0) * 16.0 + ov * 10.0) * wall;
  }

  vel += acc * dt;

  // a user clap: radial impulse with some scatter
  if (uBurst.w > 0.0) {
    vec3 bd = p - uBurst.xyz;
    float bln = length(bd);
    vec2 bn = bd.xy / (bln + 1e-3);
    // a ragged blast front: the reach wobbles with the angle (fixed per clap position) and from grain to grain
    float ang = atan(bn.y, bn.x + 1e-5);
    float k1 = fract(uBurst.x * 3.17 + uBurst.y * 1.31);
    float wob = 1.0 + 0.32 * sin(ang * 3.0 + k1 * 6.28) + 0.18 * sin(ang * 7.0 - k1 * 11.0);
    float r = uBurstR * wob * (0.8 + 0.4 * h1);
    float bf = exp(-bln * bln / (r * r));
    vec3 rnd = normalize(vec3(h1, h2, h3) * 2.0 - 1.0 + 1e-3);
    vec3 dir = normalize(bd / (bln + 1e-3) + rnd * 0.7 + vec3(0.0, 0.35, 0.0));
    dir.z *= 0.6;
    vel += dir * uBurst.w * bf * (0.2 + 0.8 * h2 * h2) * wob;
    agit = max(agit, bf * 1.2);
  }

  float vl = length(vel);
  if (vl > uMaxV) vel *= uMaxV / vl;
  vec3 p0 = p;
  p += vel * dt + carry;

  // the floor: powder can't go through it and glides along it on a cushion of air. The next step reads velocity
  // as (new - old) / dt, so the floor's response is written into the new position itself.
  if (p.y < uFloor) {
    p.y = max(min(p0.y, uFloor + 0.02), uFloor) + 0.004 * h3;
    p.xz = p0.xz + vel.xz * dt * (1.0 - 1.5 * dt) + carry.xz;
  }

  // a shed grain is put back on its letter (the render pass has it faded out by then)
  if (shed.z * uShed > 0.5 && shed.y > 2.8 && shed.y < 3.0) p = tgt;

  gl_FragColor = vec4(p, min(agit, 1.4));
}
`

const PREV_SHADER = /* glsl */ `
void main() {
  gl_FragColor = texture2D(tPos, gl_FragCoord.xy / resolution.xy);
}
`

function dataTexture(data, size) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType)
  t.minFilter = THREE.NearestFilter
  t.magFilter = THREE.NearestFilter
  t.needsUpdate = true
  return t
}

/** Can this browser run the sim? (WebGL2 + renderable 32-bit float textures + vertex texture fetch) */
export function canSimulate() {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    if (!gl) return false
    const ok = !!gl.getExtension('EXT_color_buffer_float') && gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) >= 4
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return ok
  } catch {
    return false
  }
}

/**
 * Builds the compute pipeline. `start` is the initial position buffer (the letters for reduced motion; otherwise
 * the block overrides it until the slam).
 */
export function createSim(renderer, size, { target, info, block, start }) {
  const gpu = new GPUComputationRenderer(size, size, renderer)
  gpu.setDataType(THREE.FloatType)
  const pos0 = gpu.createTexture()
  pos0.image.data.set(start)
  const prev0 = gpu.createTexture()
  prev0.image.data.set(start)
  const posVar = gpu.addVariable('tPos', POS_SHADER, pos0)
  const prevVar = gpu.addVariable('tPrev', PREV_SHADER, prev0)
  gpu.setVariableDependencies(posVar, [posVar, prevVar])
  gpu.setVariableDependencies(prevVar, [posVar])

  const tTarget = dataTexture(target, size)
  const tInfo = dataTexture(info, size)
  const tBlock = dataTexture(block, size)
  const u = {
    tTarget: { value: tTarget },
    tInfo: { value: tInfo },
    tBlock: { value: tBlock },
    uDt: { value: 1 / 60 },
    uDtPrev: { value: 1 / 60 },
    uTime: { value: 0 },
    uIntro: { value: 1e3 },
    uImpact: { value: 0.3 },
    uSlam: { value: 0 },
    uBlockR: { value: new THREE.Matrix3() },
    uBlockC: { value: new THREE.Vector3(0, 100, 0) },
    uBlockV: { value: new THREE.Vector3() },
    uBlockH: { value: new THREE.Vector3(1, 0.5, 0.6) },
    uBlockRad: { value: 0.12 },
    uImpR: { value: new THREE.Matrix3() },
    uImpC: { value: new THREE.Vector3(0, 100, 0) },
    uImpV: { value: new THREE.Vector3(0, -20, 0) },
    uImpP: { value: new THREE.Vector3(0, 100, 0) },
    uCrackV: { value: 22 },
    uThrowDir: { value: new THREE.Vector2(1, 0) },
    uK: { value: 0 },
    uZeta: { value: 0.8 },
    uYank: { value: 100 },
    uDrag: { value: 1 },
    uTurb: { value: 0 },
    uBillow: { value: 0 },
    uEddy: { value: 0 },
    uAgitDecay: { value: 1.6 },
    uAgitSoft: { value: 0.75 },
    uAgitTurb: { value: 4 },
    uCloud: { value: 0 },
    uSurge: { value: 8 },
    uPuffShape: { value: new THREE.Vector2(1, 1) },
    uBurstO: { value: new THREE.Vector3() },
    uFloor: { value: -1e3 },
    uSettle: { value: 0 },
    uVCap: { value: 12 },
    uSwirl: { value: 0 },
    uBounds: { value: new THREE.Vector4(-1e3, 1e3, -1e3, 1e3) },
    uBoundsOn: { value: 0 },
    uBurst: { value: new THREE.Vector4(0, 0, 0, 0) },
    uBurstR: { value: 1.5 },
    uPtr: { value: new THREE.Vector3(0, 0, 100) },
    uPtrVel: { value: new THREE.Vector3() },
    uPtrStr: { value: 0 },
    uPtrR: { value: 0.6 },
    uBlow: { value: 0 },
    uWind: { value: 0 },
    uWindPrev: { value: 0 },
    uWindPrev2: { value: 0 },
    uGust: { value: 0 },
    uWindBox: { value: new THREE.Vector2(-3.4, 6.8) },
    uBreath: { value: 0 },
    uShed: { value: 0 },
    uMaxV: { value: 40 },
  }
  Object.assign(posVar.material.uniforms, u)
  const err = gpu.init()
  if (err) {
    gpu.dispose()
    tTarget.dispose()
    tInfo.dispose()
    tBlock.dispose()
    throw new Error(`chalk sim: ${err}`)
  }

  return {
    uniforms: posVar.material.uniforms,
    materials: [posVar.material, prevVar.material],
    get posTarget() {
      return gpu.getCurrentRenderTarget(posVar)
    },
    tTarget,
    tInfo,
    tBlock,
    compute() {
      gpu.compute()
    },
    get pos() {
      return gpu.getCurrentRenderTarget(posVar).texture
    },
    get prev() {
      return gpu.getCurrentRenderTarget(prevVar).texture
    },
    dispose() {
      gpu.dispose()
      tTarget.dispose()
      tInfo.dispose()
      tBlock.dispose()
    },
  }
}
