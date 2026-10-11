import * as THREE from 'three'
import { GPUComputationRenderer } from 'three/examples/jsm/misc/GPUComputationRenderer.js'

/**
 * Chalk dust simulation on the GPU.
 * Two compute variables: tPos (xyz position, w = agitation 0..1.4) and tPrev (last frame's position).
 * Velocity is rebuilt from the two (position Verlet), so one heavy pass per frame moves every grain.
 * Units are cap heights of the headline; the letter plane is z = 0.
 */

/** Shared GLSL: hashes, the block's shape, the burst's lumps, the wind path of the scroll exit, shedding. */
export const COMMON_GLSL = /* glsl */ `
float hz(float s, float k) { return fract(sin(s * k) * 43758.5453); }

vec3 sphereDir(float a, float b) {
  float z = a * 2.0 - 1.0;
  float t = b * 6.2832;
  float r = sqrt(max(0.0, 1.0 - z * z));
  return vec3(r * cos(t), r * sin(t), z);
}

// outward normal of a point on the rounded chalk block (half extents uBlockH, edge radius uBlockRad)
vec3 rboxNormal(vec3 q, vec3 hExt, float rad) {
  vec3 d = abs(q) - (hExt - rad);
  return normalize(sign(q) * max(d, 0.0) + 1e-5);
}

// a grain's own scatter inside its lump of the burst (the render pass shades each lump's lit side with it)
vec3 lumpScatter(float seed) {
  return sphereDir(hz(seed, 17.31), hz(seed, 7.919));
}

// release 0..1 of a grain in the scroll-exit gust: the gust front sweeps the block from left to right
float windRelease(vec3 base, float seed, float wind, vec2 box) {
  float front = clamp((base.x - box.x) / box.y, 0.0, 1.0);
  return clamp((wind * 1.75 - front * 0.6 - seed * 0.4) / 0.42, 0.0, 1.0);
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
// a few grains of the block are crumbs: heavier, they bounce and skid instead of hanging in the air
float isCrumb(float seed) { return step(hz(seed, 91.3), 0.0025); }
`

const POS_SHADER = /* glsl */ `
uniform sampler2D tTarget;
uniform sampler2D tInfo;
uniform sampler2D tBlock;
uniform float uDt;
uniform float uDtPrev;
uniform float uTime;
uniform float uIntro;     // intro clock (s): grains ride the block until their release time
uniform float uImpact;    // when the block hits
uniform float uSlam;      // 1 on the step the block hits
uniform mat3 uBlockR;
uniform vec3 uBlockC;
uniform vec3 uBlockV;
uniform vec3 uBlockH;
uniform float uBlockRad;
uniform float uK;         // spring stiffness toward the letters
uniform float uZeta;      // damping ratio of that spring
uniform float uYank;      // seconds since the yank began (staggers each grain's start)
uniform float uDrag;      // air drag
uniform float uDragHold;  // extra drag on grains whose yank hasn't started yet
uniform float uTurb;      // base turbulence
uniform float uBillow;    // large swirls in the burst cloud
uniform float uAgitDecay;
uniform float uAgitSoft;  // how much agitation loosens the spring
uniform float uAgitTurb;  // how much agitation stirs the turbulence
uniform float uPuffSpeed;
uniform vec2 uPuffShape;  // horizontal / vertical reach of the burst
uniform vec3 uBurstO;     // where the burst cloud is centred (on the floor, under the block)
uniform float uFloor;     // the floor the block lands on (y), only during the burst
uniform float uGravity;   // on crumbs
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

// the block breaks into a cauliflower of lumps. Every grain joins one of LUMPS lumps fanned out from the floor on
// the left, up over the top, to the floor on the right (a few fill the dense low core). Each grain takes a lump
// over its own letter, so the cloud later condenses where it stands. A lump is a ball: its grains share the
// lump's velocity plus their own scatter inside it (the render pass lights each lump's upper-left side with it).
const float LUMPS = 16.0;
vec3 burstVel(vec3 p, vec3 base, float seed) {
  float sweep = clamp((base.x - uWindBox.x) / uWindBox.y, 0.0, 1.0);
  float lf = clamp(sweep + (hz(seed, 61.7) - 0.5) * 0.3, 0.0, 0.999);
  float k = floor(lf * LUMPS) + 3.0;
  float j = clamp((k - 3.0 + 0.5 + (hz(k, 12.99) - 0.5) * 1.1) / LUMPS, 0.0, 1.0);
  float ang = mix(3.1, 0.04, j);
  float s = mix(0.3, 1.0, hz(k, 41.7));
  vec3 c = vec3(cos(ang) * uPuffShape.x, sin(ang) * uPuffShape.y, (hz(k, 78.23) - 0.5) * 0.9) * s;
  float rho = mix(0.3, 0.62, hz(k, 23.1));
  if (hz(seed, 5.31) < 0.13) {
    // the dense low core where it hit
    c = vec3((sweep - 0.5) * 0.9, 0.22, 0.0);
    rho = 0.5;
  }
  // aimed: with drag uPuffSpeed the grain comes to rest at its place in its lump, wherever it sat on the block
  vec3 v = (uBurstO + c + lumpScatter(seed) * rho * pow(hz(seed, 29.17), 0.4) - p) * uPuffSpeed;
  // crumbs skid out low and fast, then fall
  float cr = isCrumb(seed);
  v = mix(v, vec3(cos(ang) * 0.8, 0.05 + 0.15 * hz(seed, 3.3), (hz(seed, 8.1) - 0.5) * 0.5) * uPuffShape.x * uPuffSpeed * (0.3 + 0.4 * hz(seed, 8.7)), cr);
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  vec4 T = texture2D(tTarget, uv);
  vec4 B = texture2D(tBlock, uv);
  float seed = T.w;
  // only the faces trailing the throw shed powder: a grain on a leading face rides the block to the impact
  float relT = B.w;
  if (relT < uImpact - 1e-3) {
    vec3 wn0 = uBlockR * rboxNormal(B.xyz, uBlockH, uBlockRad);
    if (dot(wn0, uBlockV) > -0.25 * length(uBlockV) && uIntro < uImpact) relT = uImpact;
  }
  if (uIntro < relT) {
    // riding the block; the faces trailing the motion smear back a little: the throw is fast
    vec3 wn = uBlockR * rboxNormal(B.xyz, uBlockH, uBlockRad);
    float sp = length(uBlockV);
    vec3 vd = uBlockV / max(sp, 1e-4);
    float h = hz(seed, 3.31);
    float lag = max(0.0, -dot(wn, vd)) * step(0.62, h) * (h - 0.62) * 0.05;
    // w = -1 marks a grain still riding the block (the render pass reads it too)
    gl_FragColor = vec4(uBlockC + uBlockR * B.xyz - uBlockV * lag, -1.0);
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
  float crumb = isCrumb(seed);

  vec3 vel = (p - pp) / max(uDtPrev, 1e-4);

  // the step a grain leaves the block
  if (agit < -0.5) {
    agit = 0.0;
    if (uIntro < uImpact - 1e-4) {
      // shed during the throw: left behind with a little of the block's speed, curling off in wisps
      vel = vel * 0.45 + lumpScatter(seed) * 0.9;
      agit = 1.0;
    } else {
      vel = burstVel(p, T.xyz, seed);
      agit = 1.0;
    }
  }

  // the slam's blast catches the powder the throw left in the air and rolls it into the cloud
  if (uSlam > 0.5 && B.w < uImpact - 1e-3) {
    vel = burstVel(p, T.xyz, seed) * 0.85;
    agit = 1.0;
  }

  // the letter this grain belongs to, breathing slightly, carried off by the exit gust
  vec3 base = T.xyz;
  vec3 tgt = base * (1.0 + uBreath * 0.0045 * sin(uTime * 1.25));
  tgt.z += uBreath * 0.03 * sin(uTime * 0.9 + base.x * 0.8 + base.y * 0.5);
  float rw = windRelease(base, seed, uWind, uWindBox);
  tgt += windOffset(seed, rw);

  vec3 shed = shedPhase(seed, I.g, uTime) * uShed;
  float drifting = shed.x;

  // hold to blow: a ragged, lifting stream (its front wobbles with angle and time, never a clean ring)
  vec3 db = p - uPtr;
  float ab = atan(db.y, db.x);
  float rag = 1.0 + 0.32 * sin(ab * 3.0 + uTime * 2.3) + 0.2 * sin(ab * 5.0 - uTime * 3.7 + 1.3) + 0.12 * sin(ab * 9.0 + uTime * 5.1);
  float rb = uPtrR * 1.05 * rag;
  float d2b = dot(db.xy, db.xy) + db.z * db.z * 0.5;
  float fb = exp(-d2b / (rb * rb)) * uBlow;

  // spring toward the target (each grain a little different, staggered start for the yank)
  // the yank sweeps the block left to right: the headline is pulled in from the side, letter by letter
  float sweep = clamp((base.x - uWindBox.x) / uWindBox.y, 0.0, 1.0);
  float gate = smoothstep(0.0, 0.07, uYank - sweep * 0.26 - h3 * 0.06);
  float k = uK * (0.72 + 0.56 * h2) * gate * (1.0 - uAgitSoft * clamp(agit, 0.0, 1.0)) * (1.0 - drifting) * (1.0 - 0.95 * fb);
  vec3 acc = (tgt - p) * k - vel * (2.0 * uZeta * sqrt(k) + uDrag * (1.0 - 0.4 * crumb) + uDragHold * (1.0 - gate));

  // turbulence: calm when settled, wild when disturbed or blown away
  float amp = uTurb + agit * uAgitTurb + uGust * 1.4 + rw * 3.5 + drifting * 0.18 + fb * 7.0;
  acc += flow(p * 0.85 + vec3(0.0, 0.0, seed * 0.3), uTime) * amp;
  // big slow swirls roll the burst cloud over itself
  acc += flow(p * 0.62 + vec3(4.1, 1.7, 0.0), uTime * 1.6) * uBillow * (1.0 - crumb);

  // shedding grains drift down and a little sideways
  acc += drifting * vec3(0.06 * (h1 - 0.5), -0.13, 0.0);
  // the gust itself, with scroll-speed gusts on top
  acc += vec3(1.0, 0.45, 0.0) * (rw * 6.0 + uGust * 2.0 * (0.4 + rw));
  // crumbs fall
  acc.y -= uGravity * crumb;

  // pointer: a capsule over the last ~70 ms of its path pushes grains aside, drags them along and lifts them
  vec3 pa = uPtr;
  vec3 pb = uPtr - uPtrVel * 0.07;
  vec3 ab3 = pb - pa;
  float tc = clamp(dot(p - pa, ab3) / max(dot(ab3, ab3), 1e-5), 0.0, 1.0);
  vec3 d = p - (pa + ab3 * tc);
  d.z *= 0.7;
  float d2 = dot(d, d);
  vec3 nd = d * inversesqrt(d2 + 1e-4);
  float fp = exp(-d2 / (uPtrR * uPtrR)) * uPtrStr;
  float spd = length(uPtrVel);
  acc += fp * (nd * 10.0 + uPtrVel * 3.4 * (1.0 - 0.45 * tc) + vec3(0.0, 0.32 * spd, 0.0));
  acc += fb * (normalize(db + 1e-4) * 11.0 + vec3(0.0, 6.5, 0.0));

  agit = agit * exp(-uAgitDecay * dt) + (fp * 8.0 + fb * 3.5) * dt;

  // soft walls: dust is cushioned (over the last 0.45 cap) before it reaches the nav band, the tag row or the copy
  vec3 lo = vec3(uBounds.x, uBounds.z, -1e3) + 0.45;
  vec3 hi = vec3(uBounds.y, uBounds.w, 1e3) - 0.45;
  vec3 over = p - clamp(p, lo, hi);
  float ov = length(over);
  acc -= (over * (40.0 + 260.0 * ov) + vel * 9.0 * smoothstep(0.0, 0.2, ov)) * uBoundsOn;

  vel += acc * dt;

  // a user clap: radial impulse with some scatter
  if (uBurst.w > 0.0) {
    vec3 bd = p - uBurst.xyz;
    float bl = length(bd);
    vec2 bn = bd.xy / (bl + 1e-3);
    // a ragged blast front: the reach wobbles with the angle (fixed per clap position), never a clean ring
    float ang = atan(bn.y, bn.x);
    float k1 = fract(uBurst.x * 3.17 + uBurst.y * 1.31);
    float wob = 1.0 + 0.32 * sin(ang * 3.0 + k1 * 6.28) + 0.18 * sin(ang * 7.0 - k1 * 11.0);
    float r = uBurstR * wob;
    float bf = exp(-bl * bl / (r * r));
    vec3 rnd = normalize(vec3(h1, h2, h3) * 2.0 - 1.0 + 1e-3);
    vec3 dir = normalize(bd / (bl + 1e-3) + rnd * 0.7 + vec3(0.0, 0.3, 0.0));
    dir.z *= 0.6;
    vel += dir * uBurst.w * bf * (0.2 + 0.8 * h2 * h2) * wob;
    agit = max(agit, bf * 1.2);
  }

  float vl = length(vel);
  if (vl > uMaxV) vel *= uMaxV / vl;
  vec3 p0 = p;
  p += vel * dt;

  // the floor of the slam: dust slides along it, crumbs bounce. The next step reads velocity as
  // (new - old) / dt, so the reflected, rubbed-off velocity is written into the new position itself.
  if (p.y < uFloor) {
    float bounce = mix(0.05, 0.42, crumb);
    p.y = max(p0.y, uFloor) + abs(vel.y) * bounce * dt;
    p.xz = p0.xz + vel.xz * 0.9 * dt;
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
    uK: { value: 0 },
    uZeta: { value: 0.8 },
    uYank: { value: 100 },
    uDrag: { value: 1 },
    uDragHold: { value: 0 },
    uTurb: { value: 0 },
    uBillow: { value: 0 },
    uAgitDecay: { value: 1.6 },
    uAgitSoft: { value: 0.75 },
    uAgitTurb: { value: 4 },
    uPuffSpeed: { value: 20 },
    uPuffShape: { value: new THREE.Vector2(1, 1) },
    uBurstO: { value: new THREE.Vector3() },
    uFloor: { value: -1e3 },
    uGravity: { value: 0 },
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
