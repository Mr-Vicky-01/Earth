import * as THREE from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CAP_HEIGHT, glyphPath2D, glyphShapes, layoutText } from '../glyphs'
import {
  SPLATS,
  STEEL_FRAG_ANISO,
  STEEL_FRAG_EMIT,
  STEEL_FRAG_NORMAL,
  STEEL_FRAG_OUT,
  STEEL_FRAG_PARS,
  STEEL_FRAG_ROUGH,
  STEEL_FRAG_TEMP,
  STEEL_VERT_MAIN,
  STEEL_VERT_PARS,
} from './shaders'

export const WORD = 'FORGE'
export const DEPTH = 0.3 // × cap height, the straight part of the walls (the bevels add 2 × BEVEL_T)
export const BEVEL_T = 0.07 // bevel depth on each face
export const BEVEL_S = 0.062 // bevel width: a rounded chamfer wide enough to carry a bright rim
export const TRACKING = 58 // font units of extra air so the turned letters never touch
export const TURN = 0.2 // rad: the word stands turned to a gentle 3/4 view
// each letter is set a hair off the others, so no two faces catch the light the same way
export const YAW_JITTER = [-0.034, 0.026, -0.012, 0.038, -0.028]

const SDF_RES = 72 // distance-field texels per world unit (cap height = 1)
const SDF_PAD = 4
export const SDF_MAX = 0.2 // world units of inside distance mapped to 1.0

/**
 * Front and back caps are flat: their long fan triangles must not inherit the bevel's tilted vertex normals
 * (that shades as a star of streaks across the face). Bevels and curved walls keep their creased smoothing.
 */
function flattenCaps(geo) {
  const pos = geo.attributes.position.array
  const nrm = geo.attributes.normal.array
  for (let f = 0; f < pos.length; f += 9) {
    const ax = pos[f + 3] - pos[f]
    const ay = pos[f + 4] - pos[f + 1]
    const az = pos[f + 5] - pos[f + 2]
    const bx = pos[f + 6] - pos[f]
    const by = pos[f + 7] - pos[f + 1]
    const bz = pos[f + 8] - pos[f + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz)
    if (len === 0 || Math.abs(nz) < len * 0.99999) continue
    const s = Math.sign(nz)
    for (let v = 0; v < 9; v += 3) {
      nrm[f + v] = 0
      nrm[f + v + 1] = 0
      nrm[f + v + 2] = s
    }
  }
  geo.attributes.normal.needsUpdate = true
}

/**
 * Extruded glyph with a wide rounded bevel that is cut INTO the outline (negative bevel offset), so the
 * letter keeps the typeface's proportions and counters while every edge gets a quarter-round chamfer.
 */
function letterGeometry(glyph, { curveSegments, bevelSegments }) {
  const s = 1 / CAP_HEIGHT
  const geo = new THREE.ExtrudeGeometry(glyphShapes(glyph), {
    depth: DEPTH / s,
    bevelEnabled: true,
    bevelThickness: BEVEL_T / s,
    bevelSize: BEVEL_S / s,
    bevelOffset: (-BEVEL_S * 0.62) / s,
    bevelSegments,
    curveSegments,
  })
  geo.scale(s, s, s)
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const cx = (bb.min.x + bb.max.x) / 2
  const cy = (bb.min.y + bb.max.y) / 2
  const cz = (bb.min.z + bb.max.z) / 2
  geo.translate(-cx, -cy, -cz)
  geo.computeVertexNormals()
  return { geometry: geo, width: bb.max.x - bb.min.x, cx, cy }
}

/** Font-unit bounding box of a glyph's outline (and of its first counter, if any). */
function glyphBounds(glyph) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  let hole = null
  for (const shape of glyphShapes(glyph)) {
    for (const p of shape.getPoints(8)) {
      box.x0 = Math.min(box.x0, p.x)
      box.x1 = Math.max(box.x1, p.x)
      box.y0 = Math.min(box.y0, p.y)
      box.y1 = Math.max(box.y1, p.y)
    }
    if (!hole && shape.holes.length) {
      hole = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      for (const p of shape.holes[0].getPoints(12)) {
        hole.x0 = Math.min(hole.x0, p.x)
        hole.x1 = Math.max(hole.x1, p.x)
        hole.y0 = Math.min(hole.y0, p.y)
        hole.y1 = Math.max(hole.y1, p.y)
      }
    }
  }
  return { box, hole }
}

/**
 * Where the glyph actually stands on the floor: x spans (object space, centred) of the outline points within a
 * few millimetres of its lowest point. An italic F stands on its stem only; R on stem and leg; E on its bar.
 */
function glyphFeet(glyph, cx, cy) {
  const s = 1 / CAP_HEIGHT
  const pts = []
  let minY = Infinity
  for (const shape of glyphShapes(glyph)) {
    for (const p of shape.getPoints(24)) {
      const x = p.x * s - cx
      const y = p.y * s - cy
      pts.push([x, y])
      if (y < minY) minY = y
    }
  }
  const xs = pts.filter((p) => p[1] < minY + 0.03).map((p) => p[0]).sort((a, b) => a - b)
  const feet = []
  for (const x of xs) {
    const last = feet[feet.length - 1]
    if (last && x - last[1] < 0.1) last[1] = x
    else feet.push([x, x])
  }
  return feet.map(([a, b]) => [a - 0.03, b + 0.03])
}

/* 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher) */
function edt1d(f, n, d, v, z) {
  let k = 0
  v[0] = 0
  z[0] = -1e20
  z[1] = 1e20
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = 1e20
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/**
 * Inside-distance field of one glyph (0 at the outline, 1 at SDF_MAX deep) as a small R8 texture, plus the
 * transform from the letter's centred object space (world units) to texture uv. Drives the hot core / cool
 * edges of the temperature field and the edge-only flare of the exit.
 */
function glyphDistanceField(glyph, cx, cy) {
  const s = 1 / CAP_HEIGHT
  const { box } = glyphBounds(glyph)
  const k = SDF_RES * s // px per font unit
  const W = Math.ceil((box.x1 - box.x0) * k) + SDF_PAD * 2
  const H = Math.ceil((box.y1 - box.y0) * k) + SDF_PAD * 2
  const data = new Uint8Array(W * H)
  let ok = false
  try {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) {
      ctx.translate(SDF_PAD - box.x0 * k, SDF_PAD + box.y1 * k)
      ctx.fillStyle = '#fff'
      ctx.fill(glyphPath2D(glyph, SDF_RES))
      const img = ctx.getImageData(0, 0, W, H).data
      const INF = 1e12
      const n = Math.max(W, H)
      const grid = new Float64Array(W * H)
      for (let i = 0; i < W * H; i++) grid[i] = img[i * 4 + 3] > 127 ? INF : 0
      const f = new Float64Array(n)
      const d = new Float64Array(n)
      const v = new Int32Array(n)
      const z = new Float64Array(n + 1)
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) f[y] = grid[y * W + x]
        edt1d(f, H, d, v, z)
        for (let y = 0; y < H; y++) grid[y * W + x] = d[y]
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) f[x] = grid[y * W + x]
        edt1d(f, W, d, v, z)
        for (let x = 0; x < W; x++) {
          const dist = Math.sqrt(d[x]) / SDF_RES // world units
          data[y * W + x] = Math.min(255, Math.round((dist / SDF_MAX) * 255))
        }
      }
      ok = true
    }
  } catch {
    ok = false
  }
  if (!ok) data.fill(255) // no canvas: uniform heat, still correct
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = false
  tex.needsUpdate = true
  // object space (centred, world units) → uv; texture row 0 is the canvas top
  const xf = new THREE.Vector4(
    SDF_RES / W,
    -SDF_RES / H,
    ((cx - box.x0 * s) * SDF_RES + SDF_PAD) / W,
    ((box.y1 * s - cy) * SDF_RES + SDF_PAD) / H,
  )
  return { texture: tex, xf }
}

/**
 * Extruded, bevelled FORGE in the wide display cut. Cap height = 1 world unit, word centred on x,
 * baseline at y = -0.5. Normals are creased: curves and bevels shade smooth, real corners stay crisp.
 */
export function buildWord({ lite = false } = {}) {
  const { items } = layoutText(WORD, { instance: 'italic-w125-900', tracking: TRACKING })
  const s = 1 / CAP_HEIGHT
  const letters = items.map((it, i) => {
    const { geometry, width, cx, cy } = letterGeometry(it.glyph, {
      curveSegments: lite ? 9 : 18,
      bevelSegments: lite ? 4 : 6,
    })
    const geo = toCreasedNormals(geometry, 0.8)
    geometry.dispose()
    flattenCaps(geo)
    geo.computeBoundingBox()
    geo.computeBoundingSphere()
    const bb = geo.boundingBox
    const sdf = glyphDistanceField(it.glyph, cx, cy)
    const { hole } = glyphBounds(it.glyph)
    return {
      index: i,
      char: it.char,
      geometry: geo,
      sdf,
      feet: glyphFeet(it.glyph, cx, cy),
      bottom: bb.min.y,
      // counter centre and size in the letter's object space (the exit flies the camera through the O)
      hole: hole
        ? { x: ((hole.x0 + hole.x1) / 2) * s - cx, y: ((hole.y0 + hole.y1) / 2) * s - cy, w: (hole.x1 - hole.x0) * s, h: (hole.y1 - hole.y0) * s }
        : null,
      x: it.x * s + cx,
      y: cy - 0.5,
      w: width,
      h: bb.max.y - bb.min.y,
      d: bb.max.z - bb.min.z,
    }
  })
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const L of letters) {
    minX = Math.min(minX, L.x - L.w / 2)
    maxX = Math.max(maxX, L.x + L.w / 2)
    minY = Math.min(minY, L.y - L.h / 2)
    maxY = Math.max(maxY, L.y + L.h / 2)
  }
  const cx = (minX + maxX) / 2
  for (const L of letters) L.x -= cx
  return {
    letters,
    width: maxX - minX,
    floorY: minY,
    top: maxY,
    depth: letters[0].d,
    dispose() {
      for (const L of letters) {
        L.geometry.dispose()
        L.sdf.texture.dispose()
      }
    },
  }
}

/** Uniforms shared by every letter (same objects, updated once per frame). */
export function createSharedUniforms() {
  const splats = []
  for (let i = 0; i < SPLATS; i++) splats.push(new THREE.Vector4(0, 0, 0.2, 0))
  const temper = []
  for (let i = 0; i < SPLATS / 4; i++) temper.push(new THREE.Vector4())
  return {
    uSplats: { value: splats },
    uSplatT: { value: temper },
    uSplatOn: { value: 0 }, // 0 when no splat is live: the per-fragment loop is skipped
    uTorch: { value: new THREE.Vector3(1, 0, 0) },
    uGlint: { value: new THREE.Vector4(-9, 0.07, 0, 0) },
    uBump: { value: 0.0032 },
    // 1 while the floor's reflection pass renders (alpha then carries height above the floor)
    uMirror: { value: 0 },
    uFloorY: { value: -0.5 },
  }
}

/**
 * Satin silver forged steel with a live temperature field. Per-letter heat + local heat splats drive a
 * blackbody emission ramp; the core holds heat longer than the edges (distance field); hot steel turns to
 * dark oxide before it glows; on the way back to cold it passes through temper colours. Cold, it is
 * brushed (anisotropic) satin steel with faint hammer dimples and a slow travelling glint.
 */
export function createSteelMaterial(shared, { rest, seed, lite, sdf }) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: '#d6d9e0',
    metalness: 1,
    roughness: 0.27,
    envMapIntensity: 1.25,
    anisotropy: 0.55,
    anisotropyRotation: Math.PI / 2,
  })
  const own = {
    uTemp: { value: 0 },
    uTemper: { value: 0 },
    uRim: { value: 0 },
    uRest: { value: new THREE.Vector2(rest[0], rest[1]) },
    uSeed: { value: seed },
    uSdf: { value: sdf.texture },
    uSdfXf: { value: sdf.xf },
  }
  mat.userData.uniforms = own
  if (!lite) mat.defines = { HF_HAMMER: '' }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, own)
    shader.uniforms.uSplats = shared.uSplats
    shader.uniforms.uSplatT = shared.uSplatT
    shader.uniforms.uSplatOn = shared.uSplatOn
    shader.uniforms.uTorch = shared.uTorch
    shader.uniforms.uGlint = shared.uGlint
    shader.uniforms.uBump = shared.uBump
    shader.uniforms.uMirror = shared.uMirror
    shader.uniforms.uFloorY = shared.uFloorY
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${STEEL_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${STEEL_VERT_MAIN}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${STEEL_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${STEEL_FRAG_TEMP}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${STEEL_FRAG_ROUGH}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${STEEL_FRAG_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${STEEL_FRAG_EMIT}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${STEEL_FRAG_ANISO}`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${STEEL_FRAG_OUT}`)
  }
  mat.customProgramCacheKey = () => (lite ? 'hf-steel3-lite' : 'hf-steel3')
  return mat
}

/** Heat (0..~1.2) at a point on the word plane, mirroring the shader (without the noise and edge shaping). */
export function heatAt(letterTemp, splats, x, y) {
  let t = letterTemp
  for (let i = 0; i < splats.length; i++) {
    const s = splats[i]
    if (s.w <= 0.002) continue
    const dx = x - s.x
    const dy = y - s.y
    const q = (dx * dx + dy * dy) / (s.z * s.z)
    t += s.w * Math.exp(-q * 0.95 - 0.25 * q * q)
  }
  return t
}
