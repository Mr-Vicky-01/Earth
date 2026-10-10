import { memo, useRef, useState } from 'react'
import { gsap, useGSAP, ScrollTrigger, reducedMotion, finePointer } from '../lib/gsap'
import { scroll, scrollToTarget } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'
import { useSectionEdge } from '../lib/useSectionEdge'
import { SlamText } from '../ui/SlamText'
import { SpeedButton } from '../ui/SpeedButton'
import { Odometer } from '../ui/Odometer'
import { Reveal } from '../ui/Reveal'
import { useScramble } from '../ui/Scramble'
import { createFlapEngine, BLANK, POOL_DIGIT, POOL_TEXT, DRUM_DIGIT } from './brd-flap'
import './board.css'

const ROWS = [
  { time: '06:00', session: 'VELOCITY LAB', coach: 'M. OKONKWO', target: '0.75–1.00 M/S', spots: 4 },
  { time: '07:15', session: 'ENGINE ROOM', coach: 'D. REYES', target: 'HR ZONE 4', spots: 0 },
  { time: '09:30', session: 'RECOVERY DECK', coach: 'I. SOLBERG', target: 'HRV +5 MS', spots: 9 },
  { time: '12:15', session: 'SPRINT + PLYO', coach: 'A. MENSAH', target: '1.30+ M/S', spots: 6 },
  { time: '17:30', session: 'VELOCITY LAB', coach: 'M. OKONKWO', target: '0.50–0.75 M/S', spots: 2 },
  { time: '18:45', session: 'FIGHT FLOOR', coach: 'K. NAKAMURA', target: '3 × 3 MIN', spots: 7 },
  { time: '20:00', session: 'ENGINE ROOM', coach: 'D. REYES', target: '6 × 500 M', spots: 11 },
]

// fixed cell count per column so every column lines up like real hardware
// (TIME's colon is a printed half-width separator, not a flap: w is the width in cells)
const COLS = [
  { key: 'time', label: 'Time', n: 5, w: 4.5 },
  { key: 'session', label: 'Session', n: 13 },
  { key: 'coach', label: 'Coach', n: 11 },
  { key: 'target', label: 'Target', n: 13 },
  { key: 'spots', label: 'Spots', n: 4 },
]
const SEP = { col: 'time', k: 2 }

const SESSION_LEN = 60 // minutes a class runs
const DAY_FROM = 5 * 60 + 30 // the day rail runs 05:30 → 21:30
const DAY_TO = 21 * 60 + 30
const toMin = (t) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
const fit = (s, n) => Array.from(String(s).padEnd(n, ' ').slice(0, n))
// SPOTS reads like a departures board: counts right-aligned, words (FULL / DONE / LIVE) fill the field
const spotsWord = (v, s) => (s === 'past' ? 'DONE' : s === 'now' ? 'LIVE' : v <= 0 ? 'FULL' : String(v))
const isNum = (w) => /^\d+$/.test(w)
const spotsChars = (v, s) => {
  const w = spotsWord(v, s)
  return Array.from(isNum(w) ? w.padStart(4, BLANK) : w.padEnd(4, BLANK).slice(0, 4))
}
const spotsSr = (v, s) => (s === 'past' ? 'Finished' : s === 'now' ? 'On now' : v <= 0 ? 'Full' : `${v} open`)
const minsOf = (d) => d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
const nice = (s) => s.toLowerCase().replace(/(^|\s)([a-z])/g, (_, a, b) => a + b.toUpperCase())
const two = (n) => String(n).padStart(2, '0')
const hms = (ms) => {
  let s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  return `${two(h)}:${two(m)}:${two(s - m * 60)}`
}
const clockText = (d) => two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds())
const dayPos = (mins) => Math.min(1, Math.max(0, (mins - DAY_FROM) / (DAY_TO - DAY_FROM)))

/**
 * Where the day stands. Each row is first placed against the clock (still to start / running / finished),
 * then labelled: 'next' (first class still to start), 'now' (running), 'past', 'tomorrow', or '' (later today).
 * Once nothing is left to start, tomorrow's first class is next up; while the last class still runs it keeps
 * ON NOW and the finished rows stay DONE. Only when nothing runs does the whole board turn over to tomorrow.
 */
function dayState(d) {
  const mins = minsOf(d)
  const phase = ROWS.map((r) => {
    const m = toMin(r.time)
    return mins < m ? 'up' : mins < m + SESSION_LEN ? 'now' : 'past'
  })
  const running = phase.includes('now')
  const first = phase.indexOf('up')
  const tomorrow = first === -1 // the next class to start is tomorrow's first one
  const over = tomorrow && !running // nothing left today at all: the board shows tomorrow
  const st = phase.map((p, i) => {
    if (over) return i === 0 ? 'tomorrow' : ''
    if (p === 'now') return 'now'
    if (tomorrow && i === 0) return 'tomorrow'
    if (p === 'past') return 'past'
    return i === first ? 'next' : ''
  })
  return { mins, next: tomorrow ? 0 : first, tomorrow, over, st }
}
// you can book anything that hasn't started: never a running or finished class
const canBook = (s) => s !== 'now' && s !== 'past'
const openSpots = (spots, day) => spots.reduce((sum, v, i) => sum + (canBook(day.st[i]) ? v : 0), 0)

function Cell({ k, sep }) {
  return (
    <span className={k ? 'brd-c brd-c--k' : sep ? 'brd-c brd-c--sep' : 'brd-c'}>
      <span className="brd-g">{sep ? ':' : BLANK}</span>
      <span className="brd-l">{BLANK}</span>
      <span className="brd-fu">{BLANK}</span>
      <span className="brd-fl">{BLANK}</span>
    </span>
  )
}

// rendered once; everything after mount is written straight to the DOM by the flap engine
const Rows = memo(function Rows() {
  return ROWS.map((r, i) => (
    <div key={i} className="brd-row" role="row" data-i={i}>
      <span className="brd-flash" aria-hidden="true" />
      <span className="brd-prog" aria-hidden="true" />
      <span className="brd-mk" role="cell">
        <span className="brd-tag brd-tag--next">Next</span>
        <span className="brd-tag brd-tag--now">
          <span className="live-dot" />
          On now
        </span>
        <span className="brd-tag brd-tag--tmrw">Tomorrow</span>
      </span>
      {COLS.map((c) => (
        <span key={c.key} role="cell" className={`brd-col brd-col--${c.key}`}>
          <span className="sr-only">{c.key === 'spots' ? spotsSr(r.spots, '') : r[c.key]}</span>
          <span className="brd-cells" aria-hidden="true">
            {Array.from({ length: c.n }, (_, k) => (
              <Cell key={k} sep={c.key === SEP.col && k === SEP.k} />
            ))}
          </span>
        </span>
      ))}
    </div>
  ))
})

const Clock = memo(function Clock() {
  const pair = (
    <span className="brd-pair">
      <Cell k />
      <Cell k />
    </span>
  )
  const colon = (
    <span className="brd-colon">
      <i />
      <i />
    </span>
  )
  return (
    <div className="brd-clock" aria-hidden="true">
      {pair}
      {colon}
      {pair}
      {colon}
      {pair}
    </div>
  )
})

export function Board() {
  const ref = useRef(null)
  const api = useRef(null)
  const inView = useInView(ref)
  const scramble = useScramble()
  const [open, setOpen] = useState(() => openSpots(ROWS.map((r) => r.spots), dayState(new Date())))
  const [today] = useState(() => {
    const d = new Date()
    const part = (o) => d.toLocaleDateString('en-GB', o)
    return `${part({ weekday: 'short' })} ${d.getDate()} ${part({ month: 'short' })}`
  })
  useSectionEdge(ref)

  useGSAP(
    (_ctx, contextSafe) => {
      const root = ref.current
      const reduced = reducedMotion()
      const engine = createFlapEngine({ reduced })
      const unit = root.querySelector('.brd-unit')
      const scroller = root.querySelector('.brd-scroll')
      const table = root.querySelector('.brd-table')
      const nextEl = root.querySelector('.brd-next')
      const lastEl = root.querySelector('.brd-last')
      const srTime = root.querySelector('.brd-srtime')
      const railFill = root.querySelector('.brd-rail-fill')
      const railHead = root.querySelector('.brd-rail-head')
      const railNow = root.querySelector('.brd-rail-now')
      const railNext = root.querySelector('.brd-rail-next')
      const railTicks = Array.from(root.querySelectorAll('.brd-rail-tick'))
      const bindCol = (el, key) =>
        Array.from(el.querySelectorAll(`.brd-col--${key} .brd-c`)).map((cel) => {
          const c = engine.bind(cel)
          c.fixed = cel.classList.contains('brd-c--sep')
          return c
        })
      const rows = Array.from(root.querySelectorAll('.brd-row[data-i]')).map((el, i) => ({
        el,
        i,
        data: ROWS[i],
        flash: el.querySelector('.brd-flash'),
        prog: el.querySelector('.brd-prog'),
        sr: el.querySelector('.brd-col--spots .sr-only'),
        cols: Object.fromEntries(COLS.map((c) => [c.key, bindCol(el, c.key)])),
        st: null,
        p: -1,
        v: 0,
        q: 0,
        wc: false,
        hoverAt: -1e9,
      }))
      const clock = Array.from(root.querySelectorAll('.brd-clock .brd-c')).map(engine.bind)
      const st = {
        engine,
        rows,
        clock,
        reduced,
        spots: ROWS.map((r) => r.spots),
        day: dayState(new Date()),
        open: -1,
        filled: false, // every cell has been sent its value (intro started, or snapped)
        clockOn: false,
        shown: '',
        introDone: false,
        nextBooking: Infinity,
        sinceSeed: 0,
        last: null,
        lastText: '',
        lastSec: -1,
        lastMin: -1,
        rattle: 0,
        railOn: false,
        railPos: -1,
      }
      api.current = st

      const targetHidden = () => getComputedStyle(rows[0].el.querySelector('.brd-col--target')).display === 'none'
      const rowChars = (r, key, n) => (key === 'spots' ? spotsChars(st.spots[r.i], r.st) : fit(r.data[key], n))
      const syncOpen = () => {
        const v = openSpots(st.spots, st.day)
        if (v !== st.open) {
          st.open = v
          setOpen(v)
        }
      }

      /* ---------- bezel readout: written the moment something happens, and every second for the "ago" ---------- */
      const writeLast = () => {
        const l = st.last
        let t = 'Watching for bookings'
        if (l?.sync) t = 'Board synced with the app'
        else if (l) {
          const s = Math.max(0, Math.round((Date.now() - l.at) / 1000))
          t = `Booked · ${nice(l.row.session)} ${l.row.time} · ${s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`} ago`
        }
        if (t !== st.lastText) {
          st.lastText = t
          lastEl.textContent = t
        }
      }

      /* ---------- spots: flap only the modules that change; digits turn forward round the drum ---------- */
      // one reusable flash per row: heat sweeps in behind the tiles, then drains away
      rows.forEach((r) => {
        r.tl = gsap
          .timeline({ paused: true, onComplete: () => r.el.classList.remove('is-hot') })
          .fromTo(r.flash, { scaleX: 0, opacity: 1 }, { scaleX: 1, duration: 0.32, ease: 'expo.out', immediateRender: false })
          .to(r.flash, { opacity: 0, duration: 0.9, ease: 'power2.in' }, 0.45)
      })

      const markSpots = (r) => {
        const v = st.spots[r.i]
        r.el.classList.toggle('is-full', v === 0 && canBook(r.st))
        r.sr.textContent = spotsSr(v, r.st)
      }
      const writeSpots = (r, flash, delay = 0) => {
        const chars = spotsChars(st.spots[r.i], r.st)
        const digits = chars.every((ch) => DRUM_DIGIT.includes(ch))
        let j = 0
        r.cols.spots.forEach((c, k) => {
          const ch = chars[k]
          if (engine.busy(c)) return engine.retarget(c, ch)
          if (c.cur === ch) return
          const word = { flips: 5 + j * 2 + ((Math.random() * 3) | 0), pool: POOL_TEXT }
          engine.flap(c, ch, { ...(digits ? { drum: DRUM_DIGIT, ...word, pool: POOL_DIGIT } : word), dur: 40, lastDur: 110, delay: delay + j * 45 })
          j += 1
        })
        markSpots(r)
        if (!flash || reduced) return
        r.el.classList.add('is-hot')
        r.tl.restart()
      }

      /* ---------- markers: NEXT / ON NOW / TOMORROW / past, DONE + LIVE roll-overs, the day rail ---------- */
      st.status = contextSafe((d, animate) => {
        const day = dayState(d)
        st.day = day
        let delay = 0
        rows.forEach((r) => {
          const s = day.st[r.i]
          if (r.st === s) return
          r.st = s
          r.el.dataset.st = s
          const tag = r.el.querySelector(`.brd-tag--${s === 'tomorrow' ? 'tmrw' : s}`)
          if (animate && tag && !reduced) {
            gsap.fromTo(tag, { xPercent: -140, skewX: -30, scaleX: 1.6, opacity: 0 }, { xPercent: 0, skewX: 0, scaleX: 1, opacity: 1, duration: 0.6, ease: 'expo.out', overwrite: true })
          }
          // a class that starts flaps its SPOTS to LIVE, one that ends to DONE; the board turning over to
          // tomorrow flaps every row back to its count
          if (st.filled) {
            writeSpots(r, false, delay)
            delay += 90
          } else markSpots(r)
        })
        syncOpen()
        // ON NOW: a heat line under the row fills with the minutes gone
        rows.forEach((r) => {
          if (r.st !== 'now') return
          const p = Math.round(Math.min(1, Math.max(0, (day.mins - toMin(r.data.time)) / SESSION_LEN)) * 400) / 400
          if (p !== r.p) {
            r.p = p
            r.prog.style.transform = `scaleX(${p})`
          }
        })
        // day rail: playhead and lit ticks always follow the real clock
        const pos = dayPos(day.mins)
        if (st.railOn && pos !== st.railPos) {
          st.railPos = pos
          railFill.style.transform = `scaleX(${pos})`
          railHead.style.left = `${pos * 100}%`
        }
        railHead.classList.toggle('is-end', pos > 0.8)
        const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
        railNow.textContent = `Now ${hm}`
        railTicks.forEach((t, i) => {
          t.classList.toggle('is-past', toMin(ROWS[i].time) <= day.mins)
          t.classList.toggle('is-next', i === day.next)
        })
        const nx = ROWS[day.next]
        const np = dayPos(toMin(nx.time))
        railNext.textContent = `${day.tomorrow ? 'Tmrw' : 'Next'} ${nx.time}`
        railNext.style.left = `${np * 100}%`
        railNext.dataset.side = np < 0.12 ? 'l' : np > 0.88 ? 'r' : 'c'
        if (d.getMinutes() !== st.lastMin) {
          st.lastMin = d.getMinutes()
          srTime.textContent = ` ${hm}`
        }
        // countdown to the next class
        const m = toMin(nx.time)
        const at = new Date(d)
        at.setHours(Math.floor(m / 60), m % 60, 0, 0)
        if (day.tomorrow) at.setDate(at.getDate() + 1)
        nextEl.textContent = `${nice(nx.session)} ${day.tomorrow ? 'tomorrow ' : ''}${nx.time} · in ${hms(at - d)}`
        writeLast()
      })

      const reseed = () => {
        let d = 0
        rows.forEach((r) => {
          if (st.spots[r.i] === ROWS[r.i].spots) return
          st.spots[r.i] = ROWS[r.i].spots
          writeSpots(r, false, d)
          d += 120
        })
        st.sinceSeed = 0
        st.last = { sync: true }
        syncOpen()
        writeLast()
      }

      st.book = () => {
        const cands = rows.filter((r) => canBook(r.st) && st.spots[r.i] > 0)
        const n = cands.length
        if (st.sinceSeed >= 8 || n === 0 || (n === 1 && st.spots[cands[0].i] <= 2)) return reseed()
        const r = cands[(Math.random() * n) | 0]
        st.spots[r.i] -= 1
        writeSpots(r, true)
        st.sinceSeed += 1
        st.last = { row: r.data, at: Date.now() }
        syncOpen()
        writeLast()
      }

      /* ---------- clock ---------- */
      st.tickClock = (d) => {
        if (!st.clockOn) return
        const s = clockText(d)
        for (let k = 0; k < 6; k++) {
          if (s[k] === st.shown[k]) continue
          const c = clock[k]
          if (engine.busy(c)) engine.retarget(c, s[k])
          else engine.flap(c, s[k], { dur: 240, ease: true })
        }
        st.shown = s
      }
      const clockIntro = () => {
        const s = clockText(new Date())
        st.shown = s
        st.clockOn = true
        clock.forEach((c, k) =>
          engine.flap(c, s[k], { flips: 7 + k * 2, dur: 38, lastDur: 160, delay: 80 + k * 55, pool: POOL_DIGIT, ease: false }),
        )
      }

      /* ---------- board intro: pulled in from the left, then every cell flaps into place ---------- */
      const intro = contextSafe(() => {
        const skipTarget = targetHidden()
        const heads = Array.from(root.querySelectorAll('.brd-hd'))
        heads.forEach((h, i) => gsap.delayedCall(0.12 + i * 0.06, () => scramble(h, h.dataset.label, 420)))
        gsap.fromTo(
          unit,
          { xPercent: -10, skewX: 9, scaleX: 1.08, opacity: 0, transformOrigin: '0% 50%' },
          { xPercent: 0, skewX: 0, scaleX: 1, opacity: 1, duration: 0.8, ease: 'expo.out', clearProps: 'transform,opacity' },
        )
        gsap.fromTo(
          rows.map((r) => r.el),
          { x: -160, skewX: 18, opacity: 0 },
          { x: 0, skewX: 0, opacity: 1, duration: 0.7, stagger: 0.035, delay: 0.06, ease: 'expo.out', clearProps: 'transform,opacity' },
        )
        const pos = dayPos(minsOf(new Date()))
        st.railPos = pos
        gsap.fromTo(railFill, { scaleX: 0 }, { scaleX: pos, duration: 1.1, delay: 0.15, ease: 'expo.out', onComplete: () => (st.railOn = true) })
        gsap.fromTo(railHead, { left: '0%' }, { left: `${pos * 100}%`, duration: 1.1, delay: 0.15, ease: 'expo.out' })
        const tags = root.querySelectorAll('.brd-tag')
        gsap.fromTo(
          tags,
          { xPercent: -140, skewX: -30, scaleX: 1.6, opacity: 0 },
          { xPercent: 0, skewX: 0, scaleX: 1, opacity: 1, duration: 0.6, delay: 1.25, ease: 'expo.out', clearProps: 'transform,opacity' },
        )
        let pending = 0
        const landed = () => {
          pending -= 1
          if (pending === 0) {
            st.introDone = true
            st.nextBooking = engine.time + 3200
          }
        }
        rows.forEach((r) => {
          let g = 0
          COLS.forEach((col) => {
            const chars = rowChars(r, col.key, col.n)
            // times and counts sit on digit-only drums; names and targets on the full alphabet
            const pool = col.key === 'time' || (col.key === 'spots' && chars.every((ch) => DRUM_DIGIT.includes(ch))) ? POOL_DIGIT : POOL_TEXT
            r.cols[col.key].forEach((c, k) => {
              if (c.fixed) return
              if (col.key === 'target' && skipTarget) {
                engine.snap(c, chars[k])
                return
              }
              pending += 1
              engine.flap(c, chars[k], {
                flips: 6 + ((Math.random() * 9) | 0),
                dur: 35,
                lastDur: 70,
                delay: 140 + r.i * 80 + g * 10,
                pool,
                onLand: landed,
              })
              g += 1
            })
          })
        })
        st.filled = true
      })

      st.status(new Date(), false)

      if (reduced) {
        rows.forEach((r) => COLS.forEach((col) => r.cols[col.key].forEach((c, k) => engine.snap(c, rowChars(r, col.key, col.n)[k]))))
        const s = clockText(new Date())
        clock.forEach((c, k) => engine.snap(c, s[k]))
        st.shown = s
        st.clockOn = true
        st.filled = true
        st.introDone = true
        st.railOn = true
        st.railPos = -1
        st.nextBooking = 6000
        st.status(new Date(), false)
      } else {
        gsap.set(unit, { opacity: 0 })
        ScrollTrigger.create({ trigger: unit, start: 'top 85%', once: true, onEnter: intro })
        ScrollTrigger.create({ trigger: root.querySelector('.brd-clock'), start: 'top 92%', once: true, onEnter: clockIntro })
      }

      /* ---------- hover: the row re-flaps its session name and slides out ---------- */
      const offs = []
      if (finePointer() && !reduced) {
        rows.forEach((r) => {
          const enter = () => {
            if (!st.introDone || engine.time - r.hoverAt < 900) return
            r.hoverAt = engine.time
            const chars = rowChars(r, 'session', 13)
            r.cols.session.forEach((c, k) => {
              if (chars[k] === BLANK || chars[k] === ' ') return
              engine.flap(c, chars[k], { flips: 3 + ((Math.random() * 3) | 0), dur: 34, lastDur: 70, delay: k * 18 })
            })
          }
          r.el.addEventListener('pointerenter', enter)
          offs.push(() => r.el.removeEventListener('pointerenter', enter))
        })
      }

      /* ---------- narrow screens: swipe hint + right-edge fade only when the board really overflows ---------- */
      const edge = () => {
        const over = scroller.scrollWidth > scroller.clientWidth + 4
        const more = over && scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 4
        unit.toggleAttribute('data-overflow', over)
        unit.toggleAttribute('data-more', more)
        // only a tab stop when there is something to scroll to
        if (over) scroller.setAttribute('tabindex', '0')
        else scroller.removeAttribute('tabindex')
      }
      edge()
      const ro = new ResizeObserver(edge)
      ro.observe(scroller)
      ro.observe(table)
      scroller.addEventListener('scroll', edge, { passive: true })
      offs.push(() => {
        ro.disconnect()
        scroller.removeEventListener('scroll', edge)
      })

      return () => {
        offs.forEach((f) => f())
        api.current = null
      }
    },
    { scope: ref },
  )

  // one loop for everything: flaps, the 1 Hz clock, live bookings, scroll shear
  useTicker((_t, dt) => {
    const st = api.current
    if (!st) return
    const { engine, rows, reduced } = st
    engine.tick(dt)

    const now = Date.now()
    const sec = Math.floor(now / 1000)
    if (sec !== st.lastSec) {
      st.lastSec = sec
      const d = new Date(now)
      st.tickClock(d)
      st.status(d, true)
    }

    if (st.introDone && engine.time >= st.nextBooking) {
      st.nextBooking = engine.time + 5000 + Math.random() * 2000
      st.book()
    }

    if (reduced) return
    // rows drag behind fast scrolling, lower rows lag more, then snap back
    const target = scroll.norm * 13
    for (const r of rows) {
      r.v += (target - r.v) * (0.24 - r.i * 0.024)
      const q = Math.round(r.v * 2) / 2
      if (q !== r.q) {
        r.q = q
        r.el.style.translate = q ? `${q}px 0` : ''
        // own layer only while it moves, so the shear never repaints the tiles
        if (!q !== !r.wc) {
          r.wc = !!q
          r.el.classList.toggle('is-shear', r.wc)
        }
      }
    }
    // fast scrolling rattles loose flaps
    if (st.introDone && scroll.abs > 0.18) {
      st.rattle += scroll.abs * dt * 0.035
      while (st.rattle >= 1) {
        st.rattle -= 1
        const r = rows[(Math.random() * rows.length) | 0]
        const col = r.cols[COLS[(Math.random() * COLS.length) | 0].key]
        const c = col[(Math.random() * col.length) | 0]
        if (!c.fixed && !engine.busy(c)) engine.flap(c, c.cur, { dur: 70 })
      }
    } else st.rattle = 0
  }, inView)

  return (
    <section id="schedule" ref={ref} className="sec s-ink cut cut-rev pad brd">
      <div className="wrap">
        <header className="brd-head">
          <Reveal>
            <span className="tag">
              <span className="live-dot" />
              Live floor
            </span>
          </Reveal>
          <SlamText className="d t-xl brd-title" lines={['On the floor', { text: 'today.', className: 'outline' }]} skew />
          <div className="brd-clockbox">
            <Clock />
            <div className="brd-clockmeta mono tnum">
              <span className="mute">
                Local time
                <span className="sr-only brd-srtime" />
              </span>
              <span className="brd-sep" aria-hidden="true" />
              <span className="brd-next accent" aria-live="off" />
            </div>
          </div>
        </header>

        <div className="brd-unit">
          <div className="brd-bezel mono tnum">
            <span className="brd-bezel-l">
              <span className="speed-glyph" aria-hidden="true" />
              Floor board · {today}
            </span>
            <span className="brd-swipe mute" aria-hidden="true">
              Swipe →
            </span>
            <span className="brd-openbox">
              <span className="mute">Spots open </span>
              <Odometer value={open} duration={0.9} className="brd-open" />
            </span>
            <span className="brd-last mute">Watching for bookings</span>
          </div>
          <div className="brd-rail" aria-hidden="true">
            <span className="brd-rail-fill" />
            {ROWS.map((r, i) => (
              <span key={i} className="brd-rail-tick" style={{ left: `${dayPos(toMin(r.time)) * 100}%` }} />
            ))}
            <span className="brd-rail-lbl brd-rail-lbl--from mono tnum">05:30</span>
            <span className="brd-rail-lbl brd-rail-lbl--to mono tnum">21:30</span>
            <span className="brd-rail-next mono tnum" />
            <span className="brd-rail-head">
              <span className="brd-rail-now mono tnum" />
            </span>
          </div>
          <div className="brd-scrollbox">
            <div className="brd-scroll" role="region" aria-label="Today's classes">
              <div className="brd-table" role="table" aria-label="Classes on the floor today">
                <div className="brd-row brd-hrow" role="row">
                  <span className="brd-mk" role="columnheader">
                    <span className="sr-only">Status</span>
                  </span>
                  {COLS.map((c) => (
                    <span
                      key={c.key}
                      role="columnheader"
                      className={`brd-hd brd-col--${c.key}`}
                      data-label={c.label}
                      style={{ '--k': c.w ?? c.n, '--kg': c.n - 1 }}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
                <Rows />
              </div>
            </div>
            <span className="brd-fade" aria-hidden="true" />
          </div>
          <div className="brd-key mono" aria-hidden="true">
            <span>
              <i className="brd-key-sw brd-key-sw--next" />
              Next
            </span>
            <span>
              <i className="brd-key-sw brd-key-sw--now" />
              On now
            </span>
            <span>
              <i className="brd-key-sw brd-key-sw--past" />
              Done
            </span>
          </div>
        </div>

        <Reveal from="right" className="brd-foot">
          <p className="mono mute">Book in the app · spots update live</p>
          <SpeedButton
            href="#pricing"
            variant="heat"
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              scrollToTarget('#pricing')
            }}
          >
            Book a session
          </SpeedButton>
        </Reveal>
      </div>
    </section>
  )
}
