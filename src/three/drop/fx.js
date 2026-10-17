import * as THREE from 'three'
import { prng } from './textures'

/**
 * Shader pieces for THE DROP:
 *  - barFx: shaft whip (vertex bend) injected into the standard materials, so the steel keeps its full PBR.
 *  - chalk motes drifting in the beam, the chalk cloud a slam squeezes out from under the plates (soft lit
 *    volumes that billow, expand, slow with drag and settle), shutter trails on the plates, the lens flare.
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
        gl_PointSize = clamp(0.006 * (0.6 + aSeed.z) * uPx / max(-mv.z, 0.2), 1.0, 4.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vLit;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float a = exp(-dot(q, q) * 14.0);
        gl_FragColor = vec4(uColor * a * vLit * 0.55, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Chalk cloud: a slam squeezes the air out from under the plates and  */
/* blows the chalk on the platform out along the floor. Soft billboard */
/* volumes (sphere-impostor normal + noise density), lit by the lamp   */
/* from above inside the beam (darker underneath), by the wall wash    */
/* and the room, alpha blended. Fully analytic in uT (s since impact): */
/* velocity decays with drag, puffs lift with the turbulence, expand,  */
/* thin out and settle. One instanced draw per cloud.                  */
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
    // alternate sides so both plate stacks puff
    a[i * 4] = (i % 2) * 0.5 + r() * 0.5
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
      varying vec2 vQ;
      varying float vA;
      varying float vBeam;
      varying vec3 vLampV;
      varying vec3 vKeyV;
      varying vec3 vUpV;
      varying float vY;
      varying float vR;
      varying vec2 vN;
      ${BEAM}
      ${COPY}
      uniform vec3 uKeyDir;
      void main() {
        float t = uT;
        float life = 2.6 + aB.w * 2.8;
        vA = 0.0;
        if (t < 0.0 || t > life || uE <= 0.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        float side = aA.x < 0.5 ? -1.0 : 1.0;
        // born along the contact under the plate stack
        vec3 o = vec3(side * (0.7 + fract(aA.x * 2.0) * 0.13), 0.025, uZ + (aA.z - 0.5) * 0.05);
        // squeezed out front and back along the floor, some out past the plate faces
        float ang = aA.w * 6.2831853;
        vec2 dir = normalize(vec2(cos(ang) * 0.6 + side * 0.35, sin(ang)));
        float v0 = uE * (0.9 + aB.x * 2.6);
        float k = 3.0 + aB.y * 2.6; // drag (1/s)
        float dist = v0 / k * (1.0 - exp(-k * t));
        // the turbulence lifts it, then it hangs and very slowly settles
        float rise = uE * (0.04 + aB.z * aB.z * 0.42);
        float y = 0.03 + rise * (1.0 - exp(-1.5 * t)) - 0.008 * t;
        // slow billowing drift that grows as the jet dies
        float s = aB.y * 37.0;
        vec3 drift = vec3(sin(t * 0.5 + s), 0.6 * sin(t * 0.37 + s * 1.7), cos(t * 0.43 + s * 0.6)) * 0.05 * (1.0 - exp(-0.8 * t));
        vec3 c = o + vec3(dir.x * dist, max(y, 0.02), dir.y * dist) + drift;
        // radius: a dense small jet that expands and thins
        float r0 = 0.03 + aB.w * 0.03;
        float r = r0 + uE * (0.08 + aA.y * 0.17) * (1.0 - exp(-t / 0.65)) + 0.018 * t;
        // keep the sphere above the floor
        c.y = max(c.y, r * 0.45);
        float thin = pow(r0 / r, 0.9);
        float fade = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(life * 0.45, life, t));
        vec4 mvC = viewMatrix * modelMatrix * vec4(c, 1.0);
        // billboard (slowly turning so the noise inside evolves)
        float rot = aA.z * 6.2831853 + (aB.x - 0.5) * 1.6 * (1.0 - exp(-t / 0.9));
        vec2 corner = position.xy * 2.0;
        vec2 rc = vec2(cos(rot) * corner.x - sin(rot) * corner.y, sin(rot) * corner.x + cos(rot) * corner.y);
        vec4 mv = mvC + vec4(corner * r, 0.0, 0.0);
        gl_Position = projectionMatrix * mv;
        vQ = corner;
        vN = rc * 0.5 + aB.xy * 7.0 + vec2(t * 0.05, -t * 0.03);
        vR = r;
        vY = c.y;
        vec3 wc = (modelMatrix * vec4(c, 1.0)).xyz;
        vBeam = inBeam(wc);
        vLampV = normalize((viewMatrix * vec4(uLampPos, 1.0)).xyz - mvC.xyz);
        vKeyV = normalize((viewMatrix * vec4(uKeyDir, 0.0)).xyz);
        vUpV = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        float copy = 1.0 - 0.85 * overCopy(projectionMatrix * mvC);
        vA = fade * thin * copy * (0.45 + 0.55 * uE) * (0.55 + aA.y * 0.45);
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
      varying vec3 vLampV;
      varying vec3 vKeyV;
      varying vec3 vUpV;
      varying float vY;
      varying float vR;
      varying vec2 vN;
      void main() {
        float r2 = dot(vQ, vQ);
        if (r2 >= 1.0 || vA <= 0.0) discard;
        vec3 n = vec3(vQ, sqrt(1.0 - r2));
        // billowing density: two octaves of noise, thinner toward the rim
        float d1 = texture2D(uNoise, vN * 0.35).b;
        float d2 = texture2D(uNoise, vN * 0.9 + 3.1).a;
        float dens = smoothstep(0.18, 0.85, d1 * 0.7 + d2 * 0.45) * pow(1.0 - r2, 0.9);
        // fades into the floor instead of cutting on it
        float surfY = vY + dot(vec3(vQ * vR, n.z * vR), vUpV);
        dens *= smoothstep(-0.005, 0.03, surfY);
        // lit from above inside the beam, translucent (wrap), darker underneath and on the far side
        float wl = clamp(dot(n, vLampV) * 0.6 + 0.4, 0.0, 1.0);
        float wk = clamp(dot(n, vKeyV) * 0.5 + 0.5, 0.0, 1.0);
        float self = mix(0.55, 1.0, d1);
        vec3 c = uLamp * vBeam * wl * self + uKey * wk * 0.6 + uAmb;
        float a = clamp(dens * vA, 0.0, 1.0);
        gl_FragColor = vec4(c, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Shutter trails: on fast lifts and drops a real camera's exposure    */
/* smears each plate along its motion by speed × shutter time. A few   */
/* faint echoes over that length add up to the same soft trail. One    */
/* instanced draw per plate size; matrices are written per frame.      */
/* ------------------------------------------------------------------ */
export function ghostMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uAmt: { value: 0 },
      uLight: { value: new THREE.Vector3(0.1, 1, 0.3).normalize() },
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      uniform float uAmt;
      varying float vA;
      varying float vShade;
      uniform vec3 uLight;
      void main() {
        mat4 m = modelMatrix * instanceMatrix;
        vec3 n = normalize(mat3(m) * normal);
        vShade = 0.35 + 0.65 * max(dot(n, uLight), 0.0);
        vA = aAlpha * uAmt;
        gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vA;
      varying float vShade;
      void main() {
        gl_FragColor = vec4(uColor * vShade, vA);
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Lens flare: anamorphic streak + glow on the lamp (scroll exit)       */
/* ------------------------------------------------------------------ */
export function flareMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: 0 }, uColor: { value: new THREE.Color('#fff2e0') }, uHeat: { value: new THREE.Color('#ff4b1f') } },
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
      uniform vec3 uHeat;
      varying vec2 vUv;
      void main() {
        vec2 q = vUv - 0.5;
        float streak = exp(-abs(q.y) * 90.0) * exp(-abs(q.x) * 2.6);
        float glow = exp(-dot(q, q) * 60.0);
        float ring = exp(-pow(length(q * vec2(1.0, 4.0)) - 0.16, 2.0) * 900.0) * 0.12;
        vec3 c = uColor * (streak * 1.4 + glow * 1.2) + uHeat * ring;
        gl_FragColor = vec4(c * uAmt, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}
