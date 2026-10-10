/**
 * Split-flap engine for the Board section.
 *
 * Every cell is a <span class="brd-c"> with four children, each holding a single text node:
 *   [0] glyph        – the full character; the only thing rendered while the cell is idle
 *   [1] lower static – bottom half of the character being flipped FROM (until the flip lands)
 *   [2] upper leaf   – top half of FROM, folds down onto the hinge (scaleY 1 → 0)
 *   [3] lower leaf   – bottom half of TO, unfolds from the hinge (scaleY 0 → 1)
 * The three halves only exist (display) while the cell carries `.is-f`, so an idle board is one
 * plain glyph per cell: no clipping, no transforms.
 *
 * One engine instance owns all cells. `tick(dt)` is called from a single ticker; it only walks the
 * cells that are currently flapping and writes text nodes / transforms directly (no React).
 * Time is engine-local: it only advances while ticking, so pausing off-screen freezes every flap.
 */

export const BLANK = ' '
export const POOL_TEXT = 'ABCDEFGHIJKLMNOPRSTUVWXYZ0123456789+./'
export const POOL_DIGIT = '0123456789'
// a real digit module only turns forward: blank, 0-9, then round again
export const DRUM_DIGIT = BLANK + '0123456789'

const norm = (ch) => (ch === ' ' || !ch ? BLANK : ch)

export function createFlapEngine({ reduced = false } = {}) {
  const active = new Set()
  let time = 0

  function bind(el) {
    const [g, l, fu, fl] = el.children
    return {
      el,
      g: g.firstChild,
      l: l.firstChild,
      fuT: fu.firstChild,
      flT: fl.firstChild,
      fu,
      fl,
      cur: norm(g.firstChild.data),
      from: BLANK,
      seq: null,
      on: false,
      i: 0,
      t0: 0,
      start: 0,
      dur: 35,
      lastDur: 35,
      curDur: 35,
      ease: false,
      fuS: -1,
      flS: -1,
      onLand: null,
    }
  }

  const put = (node, ch) => {
    if (node.data !== ch) node.data = ch
  }

  function setLeaves(c, a, b) {
    if (a !== c.fuS) {
      c.fuS = a
      c.fu.style.transform = `scaleY(${a})`
    }
    if (b !== c.flS) {
      c.flS = b
      c.fl.style.transform = `scaleY(${b})`
    }
  }

  function show(c, on) {
    if (c.on === on) return
    c.on = on
    c.el.classList.toggle('is-f', on)
    if (!on) {
      c.fuS = -1
      c.flS = -1
    }
  }

  function snap(c, ch) {
    ch = norm(ch)
    active.delete(c)
    c.seq = null
    c.cur = ch
    put(c.g, ch)
    show(c, false)
  }

  // start showing the flip from c.from → c.seq[c.i]
  function begin(c) {
    const to = c.seq[c.i]
    show(c, true)
    put(c.g, to)
    put(c.flT, to)
    put(c.fuT, c.from)
    put(c.l, c.from)
    c.curDur = c.i === c.seq.length - 1 ? c.lastDur : c.dur
  }

  function land(c) {
    const to = c.seq[c.seq.length - 1]
    c.cur = to
    put(c.g, to)
    show(c, false)
    c.seq = null
    active.delete(c)
    const cb = c.onLand
    c.onLand = null
    cb?.(c)
  }

  /**
   * Flap `c` to `target`, passing through `flips` random characters first.
   * opts: flips, delay (ms), dur (ms per flip), lastDur (ms for the landing flip), pool, ease, onLand,
   *       drum – when both ends are on this drum, walk it forward one flap at a time instead (ignores flips)
   */
  function flap(c, target, opts = {}) {
    const { flips = 0, delay = 0, dur = 35, lastDur = dur, pool = POOL_TEXT, ease = false, onLand = null, drum = null } = opts
    target = norm(target)
    if (reduced) {
      snap(c, target)
      onLand?.(c)
      return
    }
    // if mid-flip, land the visible state first so the new run starts from what is on screen
    if (c.seq) {
      const shown = c.seq[c.i] ?? c.cur
      c.cur = shown
      put(c.g, shown)
      show(c, false)
    }
    const seq = []
    let prev = c.cur
    const a = drum ? drum.indexOf(prev) : -1
    if (a >= 0 && target !== prev && drum.includes(target)) {
      for (let k = (a + 1) % drum.length; drum[k] !== target; k = (k + 1) % drum.length) seq.push(drum[k])
    } else for (let k = 0; k < flips; k++) {
      let ch = pool[(Math.random() * pool.length) | 0]
      if (ch === prev) ch = pool[(pool.indexOf(ch) + 1) % pool.length]
      seq.push(ch)
      prev = ch
    }
    seq.push(target)
    c.seq = seq
    c.i = 0
    c.from = c.cur
    c.dur = dur
    c.lastDur = lastDur
    c.ease = ease
    c.start = time + delay
    c.t0 = -1
    c.onLand = onLand
    active.add(c)
  }

  /** change where a running flap lands (or start a plain flip when idle) */
  function retarget(c, target, opts) {
    target = norm(target)
    if (!c.seq || reduced) return flap(c, target, opts)
    const last = c.seq.length - 1
    c.seq[last] = target
    if (c.i === last && c.t0 >= 0) begin(c)
  }

  /** advance by dt ms; returns true while anything is flapping */
  function tick(dt) {
    time += Math.min(Math.max(dt, 0), 120)
    if (!active.size) return false
    for (const c of active) {
      if (time < c.start) continue
      if (c.t0 < 0) {
        c.t0 = c.start
        begin(c)
      }
      // catch up whole flips without writing the skipped intermediate states
      let moved = false
      let done = false
      while (time - c.t0 >= c.curDur) {
        c.t0 += c.curDur
        c.from = c.seq[c.i]
        c.i++
        if (c.i >= c.seq.length) {
          done = true
          break
        }
        c.curDur = c.i === c.seq.length - 1 ? c.lastDur : c.dur
        moved = true
      }
      if (done) {
        land(c)
        continue
      }
      if (moved) begin(c)
      let p = (time - c.t0) / c.curDur
      if (p < 0.5) {
        let q = p * 2
        if (c.ease) q = q * q // the leaf falls: accelerates into the hinge
        setLeaves(c, Math.round((1 - q) * 20) / 20, 0)
      } else {
        let q = (p - 0.5) * 2
        if (c.ease) q = 1 - (1 - q) * (1 - q) * (1 - q)
        setLeaves(c, 0, Math.round(q * 20) / 20)
      }
    }
    return active.size > 0
  }

  return {
    bind,
    flap,
    retarget,
    snap,
    tick,
    busy: (c) => active.has(c),
    get size() {
      return active.size
    },
    get time() {
      return time
    },
  }
}
