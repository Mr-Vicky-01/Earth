/**
 * Shared geometry of the dust headline, in cap-height units (no glyph data, so the section's main chunk can
 * import it without pulling the outlines in).
 *
 * Two compositions:
 *  - wide  (landscape): "MOVE IT" in the normal width over "FAST." in the extra-wide cut, scaled up so both lines
 *           share one ink width: a justified block where the second line is the stretched, faster one.
 *  - stack (portrait):  "MOVE" / "IT" / "FAST.", ragged right, so the type can be twice as big on a phone.
 * Ink bounds measured from the Archivo Black Italic outlines (font units, cap height 688).
 */
const CAP = 688
// every line uses the same vertical ink box (the tallest glyphs), so baselines sit on an even rhythm
const TOP = 700
const BOTTOM = -12
const INK = {
  'MOVE IT': { minx: 27, maxx: 4686 },
  MOVE: { minx: 27, maxx: 3307 },
  IT: { minx: 27, maxx: 1141 },
  'FAST.': { minx: 28, maxx: 3761 },
}
const W100 = 'italic-w100-900'
const W125 = 'italic-w125-900'
const LINE_GAP = 0.2

function compose(spec, justifyTo) {
  const width = justifyTo ?? Math.max(...spec.map((l) => ((l.ink.maxx - l.ink.minx) / CAP) * (l.scale || 1)))
  let y = 0
  const lines = spec.map((l, i) => {
    const inkW = (l.ink.maxx - l.ink.minx) / CAP
    const scale = l.justify ? width / inkW : l.scale || 1
    const h = ((TOP - BOTTOM) / CAP) * scale
    const line = { text: l.text, instance: l.instance, ink: l.ink, scale, top: y, height: h, width: inkW * scale }
    y += h + (i < spec.length - 1 ? LINE_GAP : 0)
    return line
  })
  return { lines, W: width, H: y, aspect: width / y, top: TOP, cap: CAP }
}

export const LAYOUTS = {
  wide: compose(
    [
      { text: 'MOVE IT', instance: W100, ink: INK['MOVE IT'], scale: 1 },
      { text: 'FAST.', instance: W125, ink: INK['FAST.'], justify: true },
    ],
    (INK['MOVE IT'].maxx - INK['MOVE IT'].minx) / CAP,
  ),
  stack: compose(
    [
      { text: 'MOVE', instance: W100, ink: INK.MOVE, scale: 1 },
      { text: 'IT', instance: W100, ink: INK.IT, scale: 1 },
      { text: 'FAST.', instance: W125, ink: INK['FAST.'], justify: true },
    ],
    (INK.MOVE.maxx - INK.MOVE.minx) / CAP,
  ),
}

/** Portrait boxes (phones, tablets held upright) stack the headline in three lines. */
export const variantFor = (w, h) => (w > 0 && h > 0 && w / h < 0.8 ? 'stack' : 'wide')

/* the chalk block of the opening slam, half extents and edge radius in cap heights */
export const BLOCK = { hx: 0.92, hy: 0.46, hz: 0.58, r: 0.12 }
