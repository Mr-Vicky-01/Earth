import * as THREE from 'three'
import data from './archivo-black-italic.json'

/**
 * Archivo Black Italic outlines (font units, y up, 1000 units per em, cap height ≈ 688) for building the
 * brand's display type in 3D (extrude) or 2D (canvas Path2D) with no font loading or network request.
 *
 * instances: 'italic-w100-900' (normal width) and 'italic-w125-900' (extra wide).
 * Characters: A–Z, 0–9 and . , ' ’ / - &
 */
export const UNITS_PER_EM = data.unitsPerEm
export const CAP_HEIGHT = 688

const cache = new Map()

/** Lays out a single line. Returns { items: [{ char, x, glyph }], width } in font units. Spaces = 0.26 em. */
export function layoutText(text, { instance = 'italic-w100-900', tracking = 0 } = {}) {
  const inst = data.instances[instance]
  const items = []
  let x = 0
  const chars = Array.from(String(text).toUpperCase())
  chars.forEach((ch, i) => {
    if (ch === ' ') {
      x += 260 + tracking
      return
    }
    const glyph = inst.glyphs[ch]
    if (!glyph) return
    items.push({ char: ch, x, glyph })
    const next = chars[i + 1]
    x += glyph.advance + tracking + (next ? inst.kerning[ch + next] || 0 : 0)
  })
  return { items, width: x - tracking }
}

/** THREE.Shape[] for one glyph (holes resolved), in font units with y up. Cached per glyph. */
export function glyphShapes(glyph) {
  if (cache.has(glyph)) return cache.get(glyph)
  const sp = new THREE.ShapePath()
  for (const c of glyph.cmds) {
    if (c[0] === 'M') sp.moveTo(c[1], c[2])
    else if (c[0] === 'L') sp.lineTo(c[1], c[2])
    else if (c[0] === 'Q') sp.quadraticCurveTo(c[1], c[2], c[3], c[4])
    else if (c[0] === 'C') sp.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6])
  }
  const shapes = sp.toShapes()
  cache.set(glyph, shapes)
  return shapes
}

/**
 * Extruded, bevelled geometry for one glyph, scaled so the cap height = `height` world units and
 * centred on its own bounding box (so it can spin/punch around its middle). Returns { geometry, width, offsetX }.
 * offsetX is where the glyph's centre sits relative to its layout origin, in world units.
 */
export function glyphGeometry(glyph, { height = 1, depth = 0.35, bevel = 0.04, curveSegments = 10, bevelSegments = 4 } = {}) {
  const s = height / CAP_HEIGHT
  const geo = new THREE.ExtrudeGeometry(glyphShapes(glyph), {
    depth: depth / s,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel / s,
    bevelSize: (bevel * 0.8) / s,
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
  return { geometry: geo, width: bb.max.x - bb.min.x, offsetX: cx, offsetY: cy }
}

/** Path2D for one glyph at `size` px cap height, origin at the glyph's baseline-left, canvas y down. */
export function glyphPath2D(glyph, size) {
  const s = size / CAP_HEIGHT
  const p = new Path2D()
  for (const c of glyph.cmds) {
    if (c[0] === 'M') p.moveTo(c[1] * s, -c[2] * s)
    else if (c[0] === 'L') p.lineTo(c[1] * s, -c[2] * s)
    else if (c[0] === 'Q') p.quadraticCurveTo(c[1] * s, -c[2] * s, c[3] * s, -c[4] * s)
    else if (c[0] === 'C') p.bezierCurveTo(c[1] * s, -c[2] * s, c[3] * s, -c[4] * s, c[5] * s, -c[6] * s)
    else p.closePath()
  }
  return p
}

/** Draws a whole line onto a 2D context: baseline at (x, y), cap height `size` px. Returns the drawn width in px. */
export function drawText(ctx, text, x, y, size, opts = {}) {
  const { items, width } = layoutText(text, opts)
  const s = size / CAP_HEIGHT
  ctx.save()
  ctx.translate(x, y)
  for (const it of items) {
    ctx.save()
    ctx.translate(it.x * s, 0)
    ctx.fill(glyphPath2D(it.glyph, size))
    ctx.restore()
  }
  ctx.restore()
  return width * s
}
