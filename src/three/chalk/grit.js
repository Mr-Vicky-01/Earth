import * as THREE from 'three'
import { rng } from './targets.js'

/**
 * Debris of the slam. Chalk does not spark: it chips and breaks.
 *  - chips:  small white chips and grit sprayed out low from the corner that hits, mostly back and to the side
 *            (they come to rest under and behind the letters, never out on the copy)
 *  - chunks: a few bigger pieces broken off the top of the block. They carry on the way the block was going,
 *            tumble, and most of them break again where they land (two survive and slide to rest)
 *  - crumbs: what a chunk breaks into when it lands
 *  - puffs:  the little cloud of powder knocked out where a chunk lands
 * Every piece is a ballistic path evaluated in closed form in the vertex shader (gravity at scene scale, a low
 * restitution bounce with a friction impulse, then a slide that friction brings to rest), so it costs no
 * simulation and lands the same way at any frame rate. Pieces smear with a 1/120 s shutter while fast.
 */

const KIND_CHIP = 0
const KIND_CHUNK = 1
const KIND_CRUMB = 2
const KIND_PUFF = 3

const GRIT_VERT = /* glsl */ `
uniform float uTime;
uniform vec4 uEv;         // impact point xyz, w = time of the impact (scene seconds)
uniform float uFloorY;
uniform float uG;         // gravity (caps / s^2)
uniform vec2 uThrow;      // horizontal direction the block was travelling (xz)
uniform float uZMax;      // pieces must not come to rest nearer the camera than this (they would sit on the copy)
uniform vec2 uRes;        // drawing buffer px
uniform float uPxK;       // drawing-buffer px per cap at unit view depth
uniform vec3 uKeyPos;
uniform float uKeyI;
uniform float uLight;
attribute vec4 aSeed;
attribute vec4 aSeed2;
attribute vec4 aPar;      // a crumb's or puff's parent chunk (its seeds)
attribute vec4 aPar2;
attribute float aKind;
varying vec2 vL;          // px along / across the streak, from its centre
varying vec2 vHalf;       // half length, half width (px)
varying float vShade;
varying float vSide;      // shade of a chunk's side facet
varying float vFacet;     // facet angle (chunks)
varying float vA;
varying float vSeed;
varying float vKind;

const float E_REST = 0.3;   // chalk on rubber: a dead bounce
const float MU = 0.55;      // sliding friction

float firstContact(vec3 o, vec3 v) {
  float y0 = max(o.y - uFloorY, 0.0);
  return (v.y + sqrt(v.y * v.y + 2.0 * uG * y0)) / uG;
}

// position and velocity of a piece t seconds after it set off; w of the result = seconds spent in the air
vec4 chipAt(float t, vec3 o, vec3 v, out vec3 vel) {
  vec3 p = o;
  float tl = t;
  float air = 0.0;
  for (int b = 0; b < 4; b++) {
    float y0 = max(p.y - uFloorY, 0.0);
    float th = (v.y + sqrt(v.y * v.y + 2.0 * uG * y0)) / uG;
    if (tl < th) {
      p += v * tl;
      p.y -= 0.5 * uG * tl * tl;
      vel = vec3(v.x, v.y - uG * tl, v.z);
      return vec4(p, air + tl);
    }
    p += v * th;
    p.y = uFloorY;
    air += th;
    tl -= th;
    float vyi = v.y - uG * th;
    v.y = -vyi * E_REST;
    v.xz *= 0.6;
    if (v.y < 0.9 || b == 3) break;
  }
  // slide to rest
  float vh = length(v.xz);
  float dec = MU * uG;
  float ts = vh / dec;
  float tt = min(tl, ts);
  vec2 dir = vh > 1e-4 ? v.xz / vh : vec2(0.0);
  p.xz += dir * (vh * tt - 0.5 * dec * tt * tt);
  p.y = uFloorY;
  vel = vec3(dir.x, 0.0, dir.y) * max(vh - dec * tt, 0.0);
  return vec4(p, air);
}

vec2 rot2(vec2 d, float a) { return vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a)); }
// keep a piece from travelling toward the camera past uZMax (its slide is about v^2 / (2 mu g) plus its flight)
vec3 limitForward(vec3 o, vec3 v) {
  float room = max(uZMax - o.z, 0.0);
  v.z = min(v.z, sqrt(2.0 * MU * uG * room) * 0.7);
  return v;
}

// a chunk off the top of the block: it carries on the way the block was going, a little up and out
void chunkInit(vec4 s, vec4 s2, out vec3 o, out vec3 v) {
  o = uEv.xyz + vec3((s2.x - 0.5) * 0.5, 0.22 + 0.28 * s2.y, (s2.z - 0.5) * 0.3);
  vec2 dir = rot2(uThrow, (s.x - 0.5) * 2.0);
  float sp = mix(2.0, 4.6, s.z);
  v = limitForward(o, vec3(dir.x * sp, mix(1.3, 3.4, s.y), dir.y * sp));
}

void main() {
  float age = uTime - uEv.w;
  vSeed = aSeed2.w;
  vKind = aKind;
  vSide = 0.0;
  vFacet = 0.0;
  if (age < 0.0 || uEv.w < -50.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vA = 0.0;
    return;
  }
  vec3 o;
  vec3 v0;
  float t = age;
  float size;
  float alive = 1.0;
  if (aKind < 0.5) {
    // a chip: a fan thrown out low from the corner, carrying on the way the block was going and back, away from
    // the camera (pieces that come forward would come to rest on the copy)
    float az = aSeed.x * 3.1416;
    vec2 dxz = vec2(cos(az), -sin(az) * 0.55 + 0.1) + uThrow * 0.45;
    dxz = normalize(dxz + 1e-4);
    float el = mix(0.2, 1.05, pow(aSeed.y, 1.25));
    float sp = mix(2.6, 11.0, pow(aSeed.z, 1.6));
    o = uEv.xyz + vec3((aSeed2.x - 0.5) * 0.5, 0.04 + 0.1 * aSeed2.y, (aSeed2.z - 0.5) * 0.3);
    v0 = limitForward(o, vec3(cos(el) * dxz.x, sin(el), cos(el) * dxz.y) * sp);
    size = mix(0.016, 0.06, pow(aSeed.w, 2.5));
  } else if (aKind < 1.5) {
    chunkInit(aSeed, aSeed2, o, v0);
    size = mix(0.09, 0.16, aSeed.w);
    // most chunks break where they first land (crumbs and a puff take over at that instant); two survive
    if (aSeed2.w > 0.4) alive = step(age, firstContact(o, v0));
  } else {
    // a crumb or puff starts where and when its parent chunk landed
    vec3 po;
    vec3 pv;
    chunkInit(aPar, aPar2, po, pv);
    float tc = firstContact(po, pv);
    t = age - tc;
    o = po + pv * tc;
    o.y = uFloorY + 0.01;
    vec3 vIn = vec3(pv.x, pv.y - uG * tc, pv.z);
    if (aPar2.w <= 0.4 || t < 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vA = 0.0;
      return;
    }
    if (aKind < 2.5) {
      vec2 dir = rot2(normalize(vIn.xz + 1e-4), (aSeed.x - 0.5) * 3.4);
      float sp = length(vIn.xz) * 0.45 + mix(0.8, 3.2, aSeed.z);
      v0 = limitForward(o, vec3(dir.x * sp, -vIn.y * mix(0.15, 0.4, aSeed.y), dir.y * sp));
      size = mix(0.014, 0.04, pow(aSeed.w, 1.5));
    } else {
      v0 = vec3(vIn.x * 0.12, 0.25, vIn.z * 0.12);
      size = 0.0;
    }
  }
  vec3 vel;
  vec4 pa;
  if (aKind > 2.5) {
    // the puff of powder a breaking chunk knocks out: it swells, rises a little and thins away
    float r = 0.07 + 0.36 * (1.0 - exp(-t * 6.0));
    pa = vec4(o + v0 * min(t, 1.2) + vec3(0.0, r * 0.6, 0.0), 0.0);
    vel = vec3(0.0);
    size = r * 2.0;
  } else {
    pa = chipAt(t, o, v0, vel);
    // and wherever its flight takes it, it never comes to rest nearer the camera than the top of the copy (a soft
    // limit: a piece running at it slows into it rather than stopping on a line)
    // (each piece has its own limit, so the ones that reach it never line up)
    float lim = uZMax - 0.15 - 0.9 * aSeed2.y * aSeed.z;
    float over = pa.z - lim;
    if (over > 0.0) pa.z = lim + 0.25 * (1.0 - exp(-over / 0.25));
  }
  vec3 p = pa.xyz;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mv;
  float depth = max(-mv.z, 0.1);
  // screen velocity: project a point a little along the velocity
  vec4 clip2 = projectionMatrix * (modelViewMatrix * vec4(p - vel * (1.0 / 120.0), 1.0));
  vec2 s1 = clip.xy / clip.w * uRes * 0.5;
  vec2 s2 = clip2.xy / clip2.w * uRes * 0.5;
  vec2 ax = s1 - s2;
  float L = length(ax);
  vec2 d = L > 1e-3 ? ax / L : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  float w = max(size * uPxK / depth * 0.5, 0.75);
  // the quad covers the shutter streak plus the piece itself
  vec2 hl = vec2(L * 0.5 + w + 1.0, w + 1.0);
  vec2 c = (s1 + s2) * 0.5;
  vec2 q = position.xy * hl;
  vec2 sp2 = c + d * q.x + n * q.y;
  gl_Position = vec4(sp2 / (uRes * 0.5) * clip.w, clip.z, clip.w);
  vL = q;
  vHalf = vec2(L * 0.5, w);

  // a tumbling facet: spins in the air, settles where it lands
  float spin = mix(14.0, 46.0, aSeed2.y) * (aSeed2.x < 0.5 ? -1.0 : 1.0) * (aKind > 0.5 && aKind < 1.5 ? 0.45 : 1.0);
  float ang = spin * pa.w + aSeed2.z * 6.28;
  float facet = 0.5 + 0.5 * cos(ang);
  vec3 Lk = uKeyPos - p;
  float kd = uKeyI / dot(Lk, Lk);
  vShade = (0.12 + (0.25 + 0.6 * facet) * kd) * mix(0.35, 1.0, uLight);
  vSide = (0.1 + (0.12 + 0.3 * (1.0 - facet)) * kd) * mix(0.35, 1.0, uLight);
  vFacet = ang * 0.5;
  // the first frames of a piece are already moving (it breaks off the block), so it can't pop: it streaks in
  vA = smoothstep(0.0, 0.012, t) * alive;
  if (aKind > 2.5) {
    vShade = (0.1 + 0.75 * kd) * mix(0.35, 1.0, uLight);
    vA = 0.22 * smoothstep(0.0, 0.03, t) * exp(-t * 3.0);
  }
}
`

const GRIT_FRAG = /* glsl */ `
varying vec2 vL;
varying vec2 vHalf;
varying float vShade;
varying float vSide;
varying float vFacet;
varying float vA;
varying float vSeed;
varying float vKind;
void main() {
  float along = max(abs(vL.x) - vHalf.x, 0.0);
  vec2 e = vec2(along, vL.y);
  float r = length(e);
  if (vKind > 2.5) {
    // a soft ball of powder, lit from the upper left
    // a gaussian that reaches zero at the quad's edge (no square cut-off)
    float g = max(exp(-r * r / (vHalf.y * vHalf.y) * 3.0) - 0.0498, 0.0) / 0.9502;
    float lit = 0.75 + 0.25 * clamp(dot(normalize(vL + 1e-3), vec2(-0.6, 0.8)), -1.0, 1.0);
    float a = g * vA;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vec3(0.86, 0.87, 0.9) * vShade * lit, a);
    #include <colorspace_fragment>
    return;
  }
  // a capsule along the streak; at rest an irregular piece (radius wobbles with angle)
  // (e.x >= 0, so the offset keeps atan defined on the axis: a NaN here would spread through the bloom)
  float th = atan(e.y, e.x + 1e-4);
  float lobes = vKind > 0.5 && vKind < 1.5 ? 0.22 : 0.16;
  float rr = vHalf.y * (0.78 + lobes * sin(th * 3.0 + vSeed * 20.0) + 0.08 * sin(th * 5.0 + vSeed * 7.0));
  float a = 1.0 - smoothstep(rr - 0.6, rr + 0.6, r);
  // a long streak is the same piece spread over the exposure: thinner where it is spread
  float spread = vHalf.y / (vHalf.x + vHalf.y);
  a *= vA * mix(spread, 1.0, 0.35);
  if (a < 0.004) discard;
  vec3 c = vec3(0.86, 0.87, 0.9) * vShade;
  // a chunk shows two faces: the one turned to the light and a darker broken side
  if (vKind > 0.5 && vKind < 1.5) {
    vec2 fd = vec2(cos(vFacet + vSeed * 6.0), sin(vFacet + vSeed * 6.0));
    float side = smoothstep(-0.12, 0.12, dot(vL, fd) / max(vHalf.y, 1.0) - 0.15);
    c = mix(c, vec3(0.8, 0.81, 0.84) * vSide, side);
  }
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}
`

/** `chips` small chips, `chunks` chunks (each breaking into `crumbs` crumbs and a puff). */
export function createGrit(chips, chunks = 5, crumbs = 6) {
  const count = chips + chunks + chunks * crumbs + chunks
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3))
  g.setIndex([0, 1, 2, 2, 1, 3])
  const r = rng(17)
  const a = new Float32Array(count * 4)
  const b = new Float32Array(count * 4)
  const pa = new Float32Array(count * 4)
  const pb = new Float32Array(count * 4)
  const kind = new Float32Array(count)
  for (let i = 0; i < count * 4; i++) {
    a[i] = r()
    b[i] = r()
  }
  let k = 0
  for (let i = 0; i < chips; i++) kind[k++] = KIND_CHIP
  const chunk0 = k
  for (let i = 0; i < chunks; i++) {
    kind[k] = KIND_CHUNK
    // spread the chunks round the throw direction, and make exactly the first two the survivors
    a[k * 4] = (i + 0.5) / chunks + (r() - 0.5) * 0.12
    b[k * 4 + 3] = i < 2 ? 0.2 * r() : 0.5 + 0.5 * r()
    k++
  }
  const parentOf = (i) => {
    const pk = chunk0 + i
    return [a.subarray(pk * 4, pk * 4 + 4), b.subarray(pk * 4, pk * 4 + 4)]
  }
  for (let i = 0; i < chunks; i++) {
    const [s, s2] = parentOf(i)
    for (let j = 0; j < crumbs + 1; j++) {
      kind[k] = j < crumbs ? KIND_CRUMB : KIND_PUFF
      pa.set(s, k * 4)
      pb.set(s2, k * 4)
      k++
    }
  }
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(a, 4))
  g.setAttribute('aSeed2', new THREE.InstancedBufferAttribute(b, 4))
  g.setAttribute('aPar', new THREE.InstancedBufferAttribute(pa, 4))
  g.setAttribute('aPar2', new THREE.InstancedBufferAttribute(pb, 4))
  g.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1))
  g.instanceCount = count
  const mat = new THREE.ShaderMaterial({
    vertexShader: GRIT_VERT,
    fragmentShader: GRIT_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uEv: { value: new THREE.Vector4(0, 0, 0, -100) },
      uFloorY: { value: -1.3 },
      uG: { value: 49 },
      uThrow: { value: new THREE.Vector2(1, 0) },
      uZMax: { value: 0.3 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uPxK: { value: 1000 },
      uKeyPos: { value: new THREE.Vector3() },
      uKeyI: { value: 300 },
      uLight: { value: 1 },
    },
  })
  return { geometry: g, material: mat, uniforms: mat.uniforms }
}
