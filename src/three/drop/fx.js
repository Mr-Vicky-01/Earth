import * as THREE from 'three'
import { prng } from './textures'

/**
 * Shader pieces for THE DROP:
 *  - barFx: shaft whip (vertex bend) injected into the standard materials, so the steel keeps its full PBR.
 *  - chalk motes drifting in the beam, the chalk cloud a slam squeezes out from under the plates (a fast low
 *    sheet, then rolling eddies: soft lit volumes that billow, expand, slow with drag and settle), the lamp halo.
 * All animation lives in uniforms; nothing is rebuilt per frame.
 */

/** Shared uniforms for every bar part. */
export function createBarUniforms() {
  return { uBend: { value: 0 } }
}

/** Inject the shaft bend into a built-in material. `bendHalf`: half-length of the bending span. */
export function barFx(material, uniforms, { bend = false, bendHalf = 0.655 } = {}) {
  if (!bend) return material
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uBend;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{ float bx = clamp(transformed.x / ${bendHalf.toFixed(4)}, -1.0, 1.0); transformed.y -= uBend * cos(bx * 1.5707963); }`,
      )
  }
  material.customProgramCacheKey = () => 'drop-bend'
  return material
}

/* ------------------------------------------------------------------ */
/* The beam: the barn-door slot of the pendant lamp, analytic (matches */
/* the cookie), for the particles that should only show inside it.     */
/* ------------------------------------------------------------------ */
const BEAM = /* glsl */ `
uniform vec3 uLampPos;
uniform vec3 uLampX;
uniform vec3 uLampY;
uniform vec3 uLampAxis;
uniform vec2 uSlot; // half-tangents of the slot (along x, along z)
float inBeam(vec3 p) {
  vec3 d = p - uLampPos;
  float cz = dot(d, uLampAxis);
  if (cz <= 0.05) return 0.0;
  vec2 q = abs(vec2(dot(d, uLampX), dot(d, uLampY)) / cz / uSlot);
  float r = pow(pow(q.x, 3.2) + pow(q.y, 3.2), 1.0 / 3.2);
  return 1.0 - smoothstep(0.62, 1.0, r);
}
`
export const beamUniforms = () => ({
  uLampPos: { value: new THREE.Vector3(0, 4.4, 0) },
  uLampX: { value: new THREE.Vector3(1, 0, 0) },
  uLampY: { value: new THREE.Vector3(0, 0, -1) },
  uLampAxis: { value: new THREE.Vector3(0, -1, 0) },
  uSlot: { value: new THREE.Vector2(0.33, 0.16) },
})

/* Screen rectangle (NDC) where the HTML copy sits: particles fade there so they never sit on the text. */
const COPY = /* glsl */ `
uniform vec4 uCopy;
float overCopy(vec4 clip) {
  vec2 n = clip.xy / clip.w;
  vec2 e = vec2(0.06);
  vec2 a = smoothstep(uCopy.xy - e, uCopy.xy + e, n) * (1.0 - smoothstep(uCopy.zw - e, uCopy.zw + e, n));
  return a.x * a.y;
}
`

/* ------------------------------------------------------------------ */
/* Chalk motes: fine dust hanging in the beam. Each speck drifts on    */
/* slow incommensurate sines and is only lit inside the slot, brighter */
/* near the lamp (inverse square). Wraps are faded, never popped.      */
/* ------------------------------------------------------------------ */
export function motesGeometry(count, seed = 3) {
  const r = prng(seed)
  const pos = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (r() - 0.5) * 3.2
    pos[i * 3 + 1] = r() * 3.6
    pos[i * 3 + 2] = (r() - 0.5) * 1.8 - 0.15
    for (let k = 0; k < 4; k++) seeds[i * 4 + k] = r()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.8, 0), 4)
  return g
}

export function motesMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...beamUniforms(),
      uTime: { value: 0 },
      uLight: { value: 0 },
      uPx: { value: 1 },
      uColor: { value: new THREE.Color('#fff6ea') },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uLight;
      uniform float uPx;
      varying float vLit;
      ${BEAM}
      void main() {
        vec3 p = position;
        float t = uTime;
        // slow fall or rise (chalk settles, warm air lifts some), wrapped over 3.6 m with faded ends
        float vy = mix(-0.018, 0.012, step(0.6, aSeed.x)) * (0.5 + aSeed.w);
        float y = mod(position.y + t * vy, 3.6);
        float wrapFade = smoothstep(0.0, 0.35, y) * (1.0 - smoothstep(3.25, 3.6, y));
        p.y = y + 0.05;
        p.x += sin(t * (0.07 + aSeed.y * 0.06) + aSeed.z * 6.283) * 0.18 + sin(t * (0.23 + aSeed.w * 0.1) + aSeed.x * 20.0) * 0.03;
        p.z += cos(t * (0.06 + aSeed.z * 0.05) + aSeed.y * 6.283) * 0.14 + cos(t * (0.19 + aSeed.y * 0.1) + aSeed.w * 20.0) * 0.025;
        vec4 w = modelMatrix * vec4(p, 1.0);
        float d = length(w.xyz - uLampPos);
        // flakes catch the light as they turn: a slow, partial glint, never a strobe
        float glint = 0.75 + 0.25 * sin(t * (0.6 + aSeed.y * 0.9) + aSeed.x * 40.0);
        vLit = inBeam(w.xyz) * wrapFade * glint * uLight * (0.35 + aSeed.y * 0.65) * clamp(6.0 / (d * d), 0.0, 2.0);
        vec4 mv = viewMatrix * w;
        gl_PointSize = clamp(0.0075 * (0.5 + aSeed.z * aSeed.z * 1.6) * uPx / max(-mv.z, 0.2), 1.0, 5.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vLit;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float a = exp(-dot(q, q) * 14.0);
        gl_FragColor = vec4(uColor * a * vLit * 1.3, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Chalk cloud. A slam squeezes the air out from under the plates and  */
/* throws the chalk on the platform out with it: first a fast, low,    */
/* faint sheet racing along the floor (≤ 5 cm high, gone in a few      */
/* tenths of a second), then slower rolling eddies that rise, spread   */
/* to ~1 m, thin out and settle. Many small, faint, ragged puffs (sizes */
/* vary ~3×, edges broken by noise) instead of a few bright blobs; lit */
/* by the lamp only inside its beam (forward-scattering, brighter on   */
/* top), by the wall wash and the room. Premultiplied alpha. Fully      */
/* analytic in uT (s since impact). One instanced draw per cloud.      */
/* ------------------------------------------------------------------ */
export function puffGeometry(count, seed) {
  const r = prng(seed)
  const base = new THREE.PlaneGeometry(1, 1)
  const g = new THREE.InstancedBufferGeometry()
  g.index = base.index
  g.setAttribute('position', base.getAttribute('position'))
  g.setAttribute('uv', base.getAttribute('uv'))
  const a = new Float32Array(count * 4)
  const b = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) {
      a[i * 4 + k] = r()
      b[i * 4 + k] = r()
    }
    // alternate sides so both plate stacks puff; 58 % sheet, 42 % eddies
    a[i * 4] = (i % 2) * 0.5 + r() * 0.5
    a[i * 4 + 1] = (i * 0.618034) % 1
  }
  g.setAttribute('aA', new THREE.InstancedBufferAttribute(a, 4))
  g.setAttribute('aB', new THREE.InstancedBufferAttribute(b, 4))
  g.instanceCount = count
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, 0), 4)
  return g
}

export function puffMaterial(noise) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...beamUniforms(),
      uCopy: { value: new THREE.Vector4(9, 9, 9, 9) },
      uNoise: { value: noise },
      uT: { value: -1 },
      uE: { value: 0 },
      uZ: { value: 0 },
      uLamp: { value: new THREE.Color(0, 0, 0) }, // lamp radiance on chalk inside the beam
      uKey: { value: new THREE.Color(0, 0, 0) }, // wall wash from camera-left
      uKeyDir: { value: new THREE.Vector3(-0.6, 0.1, 0.8).normalize() },
      uAmb: { value: new THREE.Color(0, 0, 0) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aA;
      attribute vec4 aB;
      uniform float uT;
      uniform float uE;
      uniform float uZ;
      uniform vec3 uKeyDir;
      varying vec2 vQ;
      varying float vA;
      varying float vBeam;
      varying float vPhase;
      varying float vKey;
      varying vec3 vUpV;
      varying float vY;
      varying float vR;
      varying vec2 vN;
      ${BEAM}
      ${COPY}
      void main() {
        float t = uT;
        bool sheet = aA.y < 0.58;
        float life = sheet ? 0.4 + aB.z * 0.5 : 1.5 + aB.w * 1.6;
        vA = 0.0;
        if (t < 0.0 || t > life || uE <= 0.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        float side = aA.x < 0.5 ? -1.0 : 1.0;
        // born along the contact under the plate stack
        vec3 o = vec3(side * (0.69 + fract(aA.x * 2.0) * 0.15), 0.01, uZ + (aA.z - 0.5) * 0.06);
        // squeezed out front and back along the floor, some out past the plate faces
        float ang = aA.w * 6.2831853;
        vec2 dir = normalize(vec2(cos(ang) * 0.75 + side * 0.3, sin(ang)));
        vec3 c;
        float r;
        float peak;
        if (sheet) {
          // the floor jet: fast, low, thin, slowed hard by drag
          float v0 = uE * (2.4 + aB.x * 2.8);
          float k = 9.0 + aB.y * 7.0;
          float d = v0 / k * (1.0 - exp(-k * t));
          c = o + vec3(dir.x * d, 0.006 + 0.034 * aB.z * (1.0 - exp(-7.0 * t)), dir.y * d);
          float r0 = 0.03 + 0.03 * aB.w;
          r = r0 + (0.04 + 0.07 * aB.y) * (1.0 - exp(-t / 0.22));
          peak = 0.055 + 0.04 * aB.x;
          vA = smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(life * 0.25, life, t)) * pow(r0 / r, 0.4);
        } else {
          // rolling eddies: slower, rise with the turbulence, roll over, spread and thin
          float v0 = uE * (0.9 + aB.x * 1.5);
          float k = 2.8 + aB.y * 2.4;
          float d = v0 / k * (1.0 - exp(-k * t));
          float rise = uE * (0.05 + 0.3 * aB.z * aB.z);
          float y = 0.015 + rise * (1.0 - exp(-t / 0.55)) - 0.01 * t;
          // the roll: each eddy turns over the way it travels, the turn slowing as it grows
          float rr = 0.035 * (1.0 - exp(-t / 0.35));
          float phs = (2.2 + 1.6 * aB.x) * (1.0 - exp(-t / 0.8));
          vec3 fwd = vec3(dir.x, 0.0, dir.y);
          c = o + fwd * (d + rr * sin(phs)) + vec3(0.0, y + rr * (1.0 - cos(phs)), 0.0);
          // slow drift once the jet has died
          float s = aB.y * 37.0;
          c += vec3(sin(t * 0.45 + s), 0.4 * sin(t * 0.33 + s * 1.7), cos(t * 0.39 + s * 0.6)) * 0.035 * (1.0 - exp(-0.7 * t));
          float r0 = 0.035 + 0.04 * aB.w;
          r = r0 + (0.07 + 0.12 * aA.z) * uE * (1.0 - exp(-t / 0.6)) + 0.012 * t;
          peak = 0.06 + 0.05 * aB.z;
          vA = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(life * 0.35, life, t)) * pow(r0 / r, 0.55);
        }
        // keep the body above the floor
        c.y = max(c.y, r * 0.35);
        vec4 mvC = viewMatrix * modelMatrix * vec4(c, 1.0);
        // billboard, slowly turning so the noise inside evolves
        float rot = aA.z * 6.2831853 + (aB.x - 0.5) * 1.4 * (1.0 - exp(-t / 0.9));
        vec2 corner = position.xy * 2.0;
        vec2 rc = vec2(cos(rot) * corner.x - sin(rot) * corner.y, sin(rot) * corner.x + cos(rot) * corner.y);
        // the floor sheet is flat and wide (it hugs the platform); eddies are round-ish
        vec2 squash = sheet ? vec2(1.9, 0.55) : vec2(1.15, 0.9);
        gl_Position = projectionMatrix * (mvC + vec4(corner * squash * r, 0.0, 0.0));
        vQ = corner;
        vN = rc * (1.1 + 0.5 * aB.w) + aB.xy * 7.0 + vec2(t * 0.08, -t * 0.05);
        vR = r;
        vY = c.y;
        vec3 wc = (modelMatrix * vec4(c, 1.0)).xyz;
        vBeam = inBeam(wc);
        // forward-scattering dust (Henyey-Greenstein g = 0.5, relative to isotropic): the lamp is overhead and the
        // camera looks across, so the beam lights it far less than it lights the floor
        vec3 toLamp = normalize(uLampPos - wc);
        vec3 toCam = normalize(cameraPosition - wc);
        float ct = dot(-toLamp, -toCam);
        vPhase = 0.75 / pow(1.25 - ct, 1.5);
        vKey = 0.75 / pow(1.25 - dot(-uKeyDir, -toCam), 1.5);
        vUpV = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        float copy = 1.0 - 0.85 * overCopy(projectionMatrix * mvC);
        vA *= copy * peak * (0.55 + 0.45 * uE);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uNoise;
      uniform vec3 uLamp;
      uniform vec3 uKey;
      uniform vec3 uAmb;
      varying vec2 vQ;
      varying float vA;
      varying float vBeam;
      varying float vPhase;
      varying float vKey;
      varying vec3 vUpV;
      varying float vY;
      varying float vR;
      varying vec2 vN;
      void main() {
        float r2 = dot(vQ, vQ);
        if (r2 >= 1.0 || vA <= 0.002) discard;
        // ragged, wispy body: domain-warped noise decides where the puff ends, so no round outline survives
        vec2 w = texture2D(uNoise, vN * 0.23 + 1.7).rg - 0.5;
        float n1 = texture2D(uNoise, vN * 0.31 + w * 0.5).b;
        float n2 = texture2D(uNoise, vN * 0.83 + w * 0.8 + 3.1).a;
        float n = n1 * 0.6 + n2 * 0.4;
        float dens = smoothstep(0.05, 0.6, (1.0 - r2) * (0.2 + 1.5 * n) - 0.28) * (1.0 - r2);
        if (dens <= 0.0) discard;
        // fades into the floor instead of cutting on it
        float up = dot(vec3(vQ, sqrt(1.0 - r2)), normalize(vUpV));
        dens *= smoothstep(-0.004, 0.025, vY + up * vR);
        // brighter on top (lit from above), darker underneath and in the thick of it
        float shade = mix(0.5, 1.0, 0.5 + 0.5 * up) * mix(0.75, 1.0, n1);
        vec3 c = uLamp * vBeam * vPhase * shade + uKey * vKey * mix(0.7, 1.0, n1) + uAmb;
        // never brighter than the painted headline under the same light
        c = min(c, vec3(0.75));
        float a = clamp(dens * vA, 0.0, 0.2);
        // thin dust mostly scatters light toward the eye and only partly hides what is behind it
        gl_FragColor = vec4(c * a, a * 0.6);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Lamp halo for the scroll exit: a small soft glow round the lens, as */
/* a normal spherical lens gives (no anamorphic streak); bloom does    */
/* the rest.                                                            */
/* ------------------------------------------------------------------ */
export function flareMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: 0 }, uColor: { value: new THREE.Color('#fff2e0') } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        // billboard: keep the quad facing the camera, centred on the object's origin
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        mv.xy += position.xy * scale;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uAmt;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        vec2 q = vUv - 0.5;
        float d2 = dot(q, q);
        float glow = exp(-d2 * 40.0) * 0.7 + exp(-d2 * 10.0) * 0.18;
        gl_FragColor = vec4(uColor * glow * uAmt, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Rubber detail for the bumper plates (and the kit's plates): moulded */
/* rubber is never one flat colour. A few % of colour mottling and a   */
/* per-plate tint, faint concentric flow lines from the mould on the   */
/* faces (a gentle bump that fades out before it can shimmer), rougher */
/* scuffs on the rim and the lip, and a pale chalk film worked into    */
/* the rim and the outer face. Procedural from the noise texture in    */
/* the plate's own (lathe) space, so it turns with the plate. Kit      */
/* plates use world-space mapping (merged geometry).                   */
/* ------------------------------------------------------------------ */
const PERTURB = /* glsl */ `
vec3 dropPerturb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir ) {
  vec3 sx = dFdx( surf_pos );
  vec3 sy = dFdy( surf_pos );
  vec3 r1 = cross( sy, surf_norm );
  vec3 r2 = cross( surf_norm, sx );
  float det = dot( sx, r1 ) * faceDir;
  vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
  return normalize( abs( det ) * surf_norm - grad );
}
`
export function rubberFx(material, { noise, radius = 0.225, lip = 0.03, kit = false, tint = 0 }) {
  const u = { uRNoise: { value: noise }, uRR: { value: radius }, uRLip: { value: lip } }
  material.userData.rubber = u
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRO;\nvarying vec3 vRN;\nvarying float vRT;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRO = ${kit ? '(modelMatrix * vec4(transformed, 1.0)).xyz' : 'transformed'};
vRN = ${kit ? 'normalize(mat3(modelMatrix) * objectNormal)' : 'objectNormal'};
vRT = fract(sin(dot(modelMatrix[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);`,
      )
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uRNoise;
uniform float uRR;
uniform float uRLip;
varying vec3 vRO;
varying vec3 vRN;
varying float vRT;
float dropRim;
float dropChalkF;
float dropScuffF;
float dropMott;
${PERTURB}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
${
  kit
    ? `vec2 dropP = abs(vRN.y) > 0.6 ? vRO.xz : (abs(vRN.x) > 0.6 ? vRO.zy : vRO.xy);
float dropRr = 1.0;
float dropFace = 1.0;`
    : `float dropRr = length(vRO.yz) / uRR;
float dropFace = abs(vRN.x) > 0.6 ? 1.0 : 0.0;
float dropAng = atan(vRO.z, vRO.y);
vec2 dropP = dropFace > 0.5 ? vRO.yz : vec2(dropAng * uRR, vRO.x * 2.0);`
}
vec4 dropNa = texture2D(uRNoise, dropP * 1.7 + vRT * 7.0);
vec4 dropNb = texture2D(uRNoise, dropP * 6.5 + 0.37);
dropMott = dropNa.r * 0.6 + dropNb.g * 0.4;
// the rim (tread + lip) takes the knocks; chalk works into the rim and the outer face
dropRim = ${kit ? '0.5' : '(1.0 - dropFace) + dropFace * smoothstep(1.0 - (uRLip + 0.02) / uRR, 1.0 - uRLip * 0.3 / uRR, dropRr)'};
dropScuffF = smoothstep(0.62, 0.8, dropNb.b * 0.7 + dropNa.a * 0.5) * (0.35 + 0.65 * dropRim);
dropChalkF = smoothstep(0.45, 0.9, dropNa.b) * (0.25 + 0.75 * dropRim) * ${kit ? '0.7' : '1.0'};
// a few chalky hand marks where the plates are gripped to load them (the outer face band)
dropChalkF = max(dropChalkF, ${kit ? '0.0' : 'smoothstep(0.7, 0.86, texture2D(uRNoise, dropP * 3.1 + 5.3).g) * smoothstep(0.55, 0.75, dropRr) * dropFace * 1.6'});
diffuseColor.rgb *= (0.9 + 0.18 * dropMott) * (1.0 + ${tint.toFixed(3)} * (vRT - 0.5));
// grime settles in the recess: round the hub and in the corner under the lip
${kit ? '' : 'float dropGrime = dropFace * (smoothstep(0.42, 0.3, dropRr) + smoothstep(1.0 - (uRLip + 0.012) / uRR, 1.0 - uRLip / uRR, dropRr) * (1.0 - smoothstep(1.0 - uRLip / uRR, 1.0 - (uRLip - 0.006) / uRR, dropRr))); diffuseColor.rgb *= 1.0 - 0.22 * dropGrime * (0.6 + 0.4 * dropNb.r);'}
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.62 + 0.035, dropScuffF * 0.55);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.62, 0.6), clamp(dropChalkF * 0.2, 0.0, 0.32));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (dropMott - 0.5) * 0.12 + dropScuffF * 0.16 + dropChalkF * 0.22, 0.2, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
${
  kit
    ? ''
    : `{
  // mould flow lines: faint concentric ripples on the faces (0.04 mm), faded out before they get near a pixel
  float lam = 0.0035;
  float ph = dropRr * uRR / lam + dropNa.g * 3.0;
  float hgt = 0.00004 * sin(ph * 6.2831853) * dropFace;
  float fw = fwidth(dropRr * uRR) / lam;
  hgt *= 1.0 - smoothstep(0.2, 0.45, fw);
  normal = dropPerturb(-vViewPosition, normal, vec2(dFdx(hgt), dFdy(hgt)), faceDirection);
}`
}`,
      )
  }
  material.customProgramCacheKey = () => (kit ? 'drop-rubber-kit' : 'drop-rubber')
  return material
}

/**
 * Knurling that never sparkles: the diamonds are ~4 mm, close to a pixel at the hero's framing, so as the
 * handheld drift moves the camera they would crawl. The normal map's strength fades with how many diamonds
 * fall in a pixel (screen-space derivative of the uv), and the lost relief goes into roughness.
 * diamonds: [around, along] per uv unit.
 */
export function knurlFx(material, diamonds = [18, 312]) {
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (s, r) => {
    prev?.call(material, s, r)
    const chunk = THREE.ShaderChunk.normal_fragment_maps.replace(
      'mapN.xy *= normalScale;',
      `vec2 dropKd = vec2(fwidth(vNormalMapUv.x) * ${diamonds[0].toFixed(1)}, fwidth(vNormalMapUv.y) * ${diamonds[1].toFixed(1)});
float dropKf = 1.0 - smoothstep(0.3, 0.75, max(dropKd.x, dropKd.y));
mapN.xy *= normalScale * dropKf;
roughnessFactor = min(1.0, roughnessFactor + (1.0 - dropKf) * 0.08);`,
    )
    s.fragmentShader = s.fragmentShader.replace('#include <normal_fragment_maps>', chunk)
  }
  const key = material.customProgramCacheKey?.()
  material.customProgramCacheKey = () => `${key || ''}-knurl`
  return material
}
