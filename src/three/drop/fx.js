import * as THREE from 'three'
import { prng } from './textures'

/**
 * Shader pieces for THE DROP:
 *  - barFx: shaft whip (vertex bend) and speed smear (trailing half of each part stretched) injected into the
 *    standard materials, so the steel and rubber keep their full PBR lighting.
 *  - the light cone (fake volumetric), chalk motes, dust bursts, motion ghosts of the plates, the lens flare.
 * All animation lives in uniforms; nothing is rebuilt per frame.
 */

const NOISE = /* glsl */ `
float dropHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float dropNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dropHash(i + vec3(0, 0, 0)), dropHash(i + vec3(1, 0, 0)), f.x),
                 mix(dropHash(i + vec3(0, 1, 0)), dropHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(dropHash(i + vec3(0, 0, 1)), dropHash(i + vec3(1, 0, 1)), f.x),
                 mix(dropHash(i + vec3(0, 1, 1)), dropHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`

/** Shared uniforms for every bar part. */
export function createBarUniforms() {
  return {
    uBend: { value: 0 },
    uSmear: { value: 0 },
    uSmearDir: { value: new THREE.Vector3(0, 1, 0) },
  }
}

/**
 * Inject bend and/or smear into a built-in material. `bendHalf`: half-length of the bending span (shaft only).
 */
export function barFx(material, uniforms, { bend = false, smear = true, bendHalf = 0.655 } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uBend;
uniform float uSmear;
uniform vec3 uSmearDir;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
${bend ? `{ float bx = clamp(transformed.x / ${bendHalf.toFixed(4)}, -1.0, 1.0); transformed.y -= uBend * cos(bx * 1.5707963); }` : ''}`,
      )
      .replace(
        '#include <project_vertex>',
        smear
          ? `vec4 mvPosition = vec4( transformed, 1.0 );
{
  vec4 dropW = modelMatrix * mvPosition;
  vec3 dropRel = mat3( modelMatrix ) * transformed;
  float dropD = dot( dropRel, uSmearDir );
  dropW.xyz += uSmearDir * min( dropD, 0.0 ) * uSmear;
  mvPosition = viewMatrix * dropW;
}
gl_Position = projectionMatrix * mvPosition;`
          : '#include <project_vertex>',
      )
  }
  material.customProgramCacheKey = () => `drop-${bend ? 'b' : ''}${smear ? 's' : ''}`
  return material
}

/* ------------------------------------------------------------------ */
/* Light cone: additive shell, brightest where the view ray crosses the */
/* most volume, falls off down its length, drifting dust density.      */
/* ------------------------------------------------------------------ */
export function coneMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#f3f1ea') },
      uIntensity: { value: 0 },
      uTime: { value: 0 },
      uApexY: { value: 4 },
      uHeight: { value: 4 },
      uInside: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      uniform float uApexY;
      uniform float uHeight;
      uniform float uInside;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      ${NOISE}
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        float facing = abs(dot(normalize(vNormalW), V));
        float core = pow(facing, 2.4);
        float h = clamp((uApexY - vWorld.y) / uHeight, 0.0, 1.0);
        float along = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.78, 1.0, h)) * mix(1.15, 0.38, h);
        float n = dropNoise(vWorld * vec3(2.6, 0.8, 2.6) + vec3(0.0, uTime * 0.07, uTime * 0.03));
        float a = uIntensity * core * along * (0.66 + 0.55 * n) * mix(1.0, 0.5, uInside);
        gl_FragColor = vec4(uColor * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Cone membership shared by the particle shaders                      */
/* ------------------------------------------------------------------ */
const CONE = /* glsl */ `
uniform vec3 uApex;
uniform vec3 uAxis;
uniform float uCos;
float inCone(vec3 p) {
  vec3 d = p - uApex;
  float c = dot(normalize(d), uAxis);
  return smoothstep(uCos - 0.035, uCos + 0.04, c);
}
`
const coneUniforms = () => ({
  uApex: { value: new THREE.Vector3(0, 4, 0) },
  uAxis: { value: new THREE.Vector3(0, -1, 0) },
  uCos: { value: Math.cos(0.4) },
})

/* ------------------------------------------------------------------ */
/* Chalk motes: slow drifting specks, bright only inside the light     */
/* ------------------------------------------------------------------ */
export function motesGeometry(count, seed = 3) {
  const r = prng(seed)
  const pos = new Float32Array(count * 3)
  const seeds = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2
    const rad = Math.sqrt(r()) * 1.7
    pos[i * 3] = Math.cos(a) * rad
    pos[i * 3 + 1] = r() * 3.4
    pos[i * 3 + 2] = Math.sin(a) * rad
    for (let k = 0; k < 4; k++) seeds[i * 4 + k] = r()
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.7, 0), 4)
  return g
}

export function motesMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...coneUniforms(),
      uTime: { value: 0 },
      uLight: { value: 0 },
      uPx: { value: 1 },
      uSize: { value: 0.035 },
      uColor: { value: new THREE.Color('#fff6ea') },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uLight;
      uniform float uPx;
      uniform float uSize;
      varying float vLit;
      ${CONE}
      void main() {
        vec3 p = position;
        float t = uTime;
        float dir = aSeed.x > 0.55 ? 1.0 : -0.6;
        p.y = mod(position.y + t * (0.012 + aSeed.w * 0.03) * dir, 3.4) + 0.04;
        p.x += sin(t * (0.11 + aSeed.y * 0.1) + aSeed.z * 6.283) * 0.22 + sin(t * 0.7 + aSeed.w * 30.0) * 0.012;
        p.z += cos(t * (0.09 + aSeed.z * 0.1) + aSeed.y * 6.283) * 0.22 + cos(t * 0.6 + aSeed.x * 30.0) * 0.012;
        vec4 w = modelMatrix * vec4(p, 1.0);
        float lit = inCone(w.xyz);
        float tw = 0.65 + 0.35 * sin(t * (1.0 + aSeed.y * 2.0) + aSeed.x * 40.0);
        vLit = lit * tw * uLight * (0.25 + aSeed.y * 0.5);
        vec4 mv = viewMatrix * w;
        gl_PointSize = max(1.5, uSize * (0.4 + aSeed.z * 0.9) * uPx / max(-mv.z, 0.2));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vLit;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float a = exp(-dot(q, q) * 22.0);
        gl_FragColor = vec4(uColor * a * vLit, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Pool of light on the floor (matches the spot's barn-door cookie)    */
/* ------------------------------------------------------------------ */
const POOL = /* glsl */ `
uniform vec2 uPoolC;
uniform vec2 uPoolH;
float inPool(vec3 p) {
  vec2 d = abs((p.xz - uPoolC) / uPoolH);
  float r = pow(pow(d.x, 3.2) + pow(d.y, 3.2), 1.0 / 3.2);
  return 1.0 - smoothstep(0.62, 1.0, r);
}
`
const poolUniforms = () => ({
  uPoolC: { value: new THREE.Vector2(0, -0.2) },
  uPoolH: { value: new THREE.Vector2(1.45, 0.82) },
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
/* Dust burst: chalk squeezed out from under the plates on impact.     */
/* A floor-hugging ring of bright specks that shoots out and settles   */
/* fast, plus a little haze that hangs in the light.                   */
/* Fully analytic in uT (seconds since impact): no CPU work per frame. */
/* ------------------------------------------------------------------ */
export function dustGeometry(count, seed) {
  const r = prng(seed)
  const a = new Float32Array(count * 4)
  const b = new Float32Array(count * 4)
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) {
      a[i * 4 + k] = r()
      b[i * 4 + k] = r()
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aA', new THREE.BufferAttribute(a, 4))
  g.setAttribute('aB', new THREE.BufferAttribute(b, 4))
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 4)
  return g
}

export function dustMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...poolUniforms(),
      uCopy: { value: new THREE.Vector4(9, 9, 9, 9) },
      uT: { value: -1 },
      uE: { value: 0 },
      uZ: { value: 0 },
      uLight: { value: 1 },
      uPx: { value: 1 },
      uColor: { value: new THREE.Color('#f6f4ee') },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aA;
      attribute vec4 aB;
      uniform float uT;
      uniform float uE;
      uniform float uZ;
      uniform float uLight;
      uniform float uPx;
      varying float vA;
      varying float vSoft;
      ${POOL}
      ${COPY}
      void main() {
        float t = uT;
        // haze: the fine chalk that stays up, drifting and glittering in the light for a few seconds
        float haze = step(0.7, aB.w);
        float life = mix(0.45 + aB.w * 1.1, 2.4 + aB.x * 2.6, haze);
        if (t < 0.0 || t > life) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          vA = 0.0;
          vSoft = 0.0;
          return;
        }
        float side = aA.x < 0.5 ? -1.0 : 1.0;
        // born along the contact under the plate stack
        vec3 o = vec3(side * (0.69 + aA.y * 0.14), 0.004, uZ + (aA.z - 0.5) * 0.06);
        // a full ring round the contact, a little stronger out the plate faces (±x)
        float ang = aA.w * 6.2831853;
        vec2 dir = normalize(vec2(cos(ang) * 1.25, sin(ang)));
        float v0 = uE * mix(1.1 + pow(aB.x, 1.4) * 3.6, 0.3 + aB.x * 0.7, haze);
        float k = mix(7.5 + aB.y * 4.0, 2.4 + aB.y * 1.2, haze);
        float dist = v0 / k * (1.0 - exp(-k * t));
        // specks hop a few centimetres and drop back; the fine dust lifts and hangs
        float hop = uE * (0.02 + aB.z * aB.z * 0.22);
        float ys = hop * (1.0 - exp(-14.0 * t)) - 1.6 * t * t;
        float yh = uE * (0.05 + aB.z * 0.42) * (1.0 - exp(-1.3 * t)) - 0.012 * t;
        vec3 p = o + vec3(dir.x * dist, max(mix(ys, yh, haze), 0.0), dir.y * dist);
        // and wanders as it hangs
        float s = aB.y * 40.0;
        p += haze * vec3(sin(t * 0.9 + s), sin(t * 0.7 + s * 1.3) * 0.5, cos(t * 0.8 + s)) * 0.025 * t;
        p.y = max(p.y, 0.003);
        float fade = smoothstep(0.0, mix(0.02, 0.25, haze), t) * (1.0 - smoothstep(life * mix(0.35, 0.4, haze), life, t));
        vec4 w = modelMatrix * vec4(p, 1.0);
        float lit = inPool(w.xyz);
        vec4 mv = viewMatrix * w;
        gl_Position = projectionMatrix * mv;
        float copy = 1.0 - 0.9 * overCopy(gl_Position);
        // glitter: the hanging specks catch the light as they turn
        float tw = mix(1.0, 0.45 + 0.55 * abs(sin(t * (2.0 + aA.y * 5.0) + aB.y * 30.0)), haze);
        vA = fade * lit * copy * tw * uLight * mix(0.5 + aA.w * 0.5, 0.16 + aB.z * 0.22, haze) * (0.5 + 0.5 * uE);
        vSoft = 0.0;
        float size = mix(0.0035 + aA.y * 0.005, 0.0028 + aA.y * 0.0035, haze);
        gl_PointSize = max(1.0, size * uPx / max(-mv.z, 0.2));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vA;
      varying float vSoft;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float a = exp(-dot(q, q) * mix(26.0, 7.0, vSoft)) * (1.0 - smoothstep(0.42, 0.5, length(q)));
        gl_FragColor = vec4(uColor * a * vA, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  })
}

/* ------------------------------------------------------------------ */
/* Motion ghosts: translucent echoes of each plate trailing behind it   */
/* on fast lifts and drops (a stylised long exposure). One instanced   */
/* draw per plate size; matrices are written by the scene per frame.   */
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
        vShade = 0.45 + 0.55 * max(dot(n, uLight), 0.0);
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
        float glow = exp(-dot(q * vec2(1.0, 1.0), q) * 60.0);
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
