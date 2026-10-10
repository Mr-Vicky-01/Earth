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
import { createFlapEngine, BLANK, POOL_DIGIT } from './brd-flap'
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
const COLS = [
  { key: 'time', label: 'Time', n: 5 },
  { key: 'session', label: 'Session', n: 13 },
  { key: 'coach', label: 'Coach', n: 11 },
  { key: 'target', label: 'Target', n: 13 },
  { key: 'spots', label: 'Spots', n: 4 },
]

const SESSION_LEN = 60 // minutes a class runs
const DAY_FROM = 5 * 60 + 30 // the day rail runs 05:30 → 21:30
const DAY_TO = 21 * 60 + 30
const toMin = (t) => {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
const fit = (s, n) => Array.from(String(s).padEnd(n, ' ').slice(0, n))
const spotsText = (v) => (v <= 0 ? 'FULL' : String(v))
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

/** where the day stands: which row is next, which is running, which are done */
function dayState(d) {
  const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
  let next = ROWS.findIndex((r) => toMin(r.time) > mins)
  const tomorrow = next === -1
  if (tomorrow) next = 0
  const st = ROWS.map((r, i) => {
    const m = toMin(r.time)
    if (i === next) return tomorrow ? 'tomorrow' : 'next'
    if (tomorrow) return ''
    if (m <= mins && mins < m + SESSION_LEN) return 'now'
    if (m + SESSION_LEN <= mins) return 'past'
    return ''
  })
  return { next, tomorrow, st }
}
// rows you can still book: everything from the next class on (the whole list once the day is over)
const bookable = (i, day) => day.tomorrow || i >= day.next
const openSpots = (spots, day) => spots.reduce((sum, v, i) => sum + (bookable(i, day) ? v : 0), 0)

function Cell({ k }) {
  return (
    <span className={k ? 'brd-c brd-c--k' : 'brd-c'}>
      <span className="brd-g">{BLANK}</span>
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
          <span className="sr-only">{c.key === 'spots' ? spotsText(r.spots) : r[c.key]}</span>
          <span className="brd-cells" aria-hidden="true">
            {Array.from({ length: c.n }, (_, k) => (
              <Cell key={k} />
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
      const nextEl = root.querySelector('.brd-next')
      const lastEl = root.querySelector('.brd-last')
      const railFill = root.querySelector('.brd-rail-fill')
      const railHead = root.querySelector('.brd-rail-head')
      const railNow = root.querySelector('.brd-rail-now')
      const railTicks = Array.from(root.querySelectorAll('.brd-rail-tick'))
      const rows = Array.from(root.querySelectorAll('.brd-row[data-i]')).map((el, i) => ({
        el,
        i,
        data: ROWS[i],
        flash: el.querySelector('.brd-flash'),
        sr: el.querySelector('.brd-col--spots .sr-only'),
        cols: Object.fromEntries(COLS.map((c) => [c.key, Array.from(el.querySelectorAll(`.brd-col--${c.key} .brd-c`)).map(engine.bind)])),
        st: null,
        v: 0,
        q: 0,
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
        clockOn: false,
        shown: '',
        introDone: false,
        nextBooking: Infinity,
        sinceSeed: 0,
        last: null,
        lastSec: -1,
        rattle: 0,
        railOn: false,
        railPos: -1,
      }
      api.current = st

      const targetHidden = () => getComputedStyle(rows[0].el.querySelector('.brd-col--target')).display === 'none'
      const rowChars = (r, key, n) => fit(key === 'spots' ? spotsText(st.spots[r.i]) : r.data[key], n)

      /* ---------- markers: NEXT / ON NOW / TOMORROW / past ---------- */
      st.status = contextSafe((d, animate) => {
        const day = dayState(d)
        const changed = day.next !== st.day.next || day.tomorrow !== st.day.tomorrow
        st.day = day
        rows.forEach((r) => {
          const s = day.st[r.i]
          if (r.st === s) return
          r.st = s
          r.el.dataset.st = s
          const tag = r.el.querySelector(`.brd-tag--${s === 'tomorrow' ? 'tmrw' : s}`)
          if (animate && tag && !reduced) {
            gsap.fromTo(tag, { xPercent: -140, skewX: -30, scaleX: 1.6, opacity: 0 }, { xPercent: 0, skewX: 0, scaleX: 1, opacity: 1, duration: 0.6, ease: 'expo.out', overwrite: true })
          }
        })
        if (changed) setOpen(openSpots(st.spots, day))
        // day rail: fill and playhead at the current minute (whole rail is a fresh day once it is over)
        const mins = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
        const pos = day.tomorrow ? 1 : dayPos(mins)
        if (st.railOn && pos !== st.railPos) {
          st.railPos = pos
          railFill.style.transform = `scaleX(${pos})`
          railHead.style.left = `${pos * 100}%`
        }
        railHead.classList.toggle('is-end', pos > 0.82)
        railNow.textContent = `Now ${two(d.getHours())}:${two(d.getMinutes())}`
        railTicks.forEach((t, i) => t.classList.toggle('is-past', !day.tomorrow && toMin(ROWS[i].time) <= mins))
        // countdown to the next class
        const r = ROWS[day.next]
        const m = toMin(r.time)
        const at = new Date(d)
        at.setHours(Math.floor(m / 60), m % 60, 0, 0)
        if (day.tomorrow) at.setDate(at.getDate() + 1)
        nextEl.textContent = `${nice(r.session)} ${day.tomorrow ? 'tomorrow ' : ''}${r.time} · in ${hms(at - d)}`
        lastEl.textContent = st.last
          ? st.last.sync
            ? 'Board synced with the app'
            : `Last booking · ${nice(st.last.row.session)} ${st.last.row.time} · ${Math.max(0, Math.round((Date.now() - st.last.at) / 1000))} s ago`
          : 'Watching for bookings'
      })

      /* ---------- spots: flap the value, flash the row ---------- */
      // one reusable flash per row: heat sweeps in behind the tiles, then drains away
      rows.forEach((r) => {
        r.tl = gsap
          .timeline({ paused: true, onComplete: () => r.el.classList.remove('is-hot') })
          .fromTo(r.flash, { scaleX: 0, opacity: 1 }, { scaleX: 1, duration: 0.32, ease: 'expo.out', immediateRender: false })
          .to(r.flash, { opacity: 0, duration: 0.9, ease: 'power2.in' }, 0.45)
      })

      const writeSpots = (r, flash, delay = 0) => {
        const v = st.spots[r.i]
        const chars = rowChars(r, 'spots', 4)
        r.cols.spots.forEach((c, k) =>
          engine.flap(c, chars[k], { flips: 4 + k * 2 + ((Math.random() * 3) | 0), dur: 42, lastDur: 110, delay: delay + k * 45 }),
        )
        r.el.classList.toggle('is-full', v === 0)
        r.sr.textContent = spotsText(v)
        if (!flash || reduced) return
        r.el.classList.add('is-hot')
        r.tl.restart()
      }

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
        setOpen(openSpots(st.spots, st.day))
      }

      st.book = () => {
        const cands = rows.filter((r) => bookable(r.i, st.day) && st.spots[r.i] > 0)
        const n = cands.length
        if (st.sinceSeed >= 8 || n === 0 || (n === 1 && st.spots[cands[0].i] <= 2)) return reseed()
        const r = cands[(Math.random() * n) | 0]
        st.spots[r.i] -= 1
        writeSpots(r, true)
        st.sinceSeed += 1
        st.last = { row: r.data, at: Date.now() }
        setOpen(openSpots(st.spots, st.day))
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
        const d = new Date()
        const pos = st.day.tomorrow ? 1 : dayPos(d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60)
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
            r.cols[col.key].forEach((c, k) => {
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
                onLand: landed,
              })
              g += 1
            })
          })
        })
      })

      st.status(new Date(), false)
      rows.forEach((r) => r.el.classList.toggle('is-full', st.spots[r.i] === 0))

      if (reduced) {
        rows.forEach((r) => COLS.forEach((col) => r.cols[col.key].forEach((c, k) => engine.snap(c, rowChars(r, col.key, col.n)[k]))))
        const s = clockText(new Date())
        clock.forEach((c, k) => engine.snap(c, s[k]))
        st.shown = s
        st.clockOn = true
        st.introDone = true
        st.railOn = true
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

      /* ---------- narrow screens: fade on the right edge while there is more board to see ---------- */
      const edge = () => {
        const more = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 4
        unit.toggleAttribute('data-more', more)
        // only a tab stop when there is something to scroll to
        if (scroller.scrollWidth > scroller.clientWidth + 4) scroller.setAttribute('tabindex', '0')
        else scroller.removeAttribute('tabindex')
      }
      edge()
      scroller.addEventListener('scroll', edge, { passive: true })
      window.addEventListener('resize', edge)
      offs.push(() => {
        scroller.removeEventListener('scroll', edge)
        window.removeEventListener('resize', edge)
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
        if (!engine.busy(c)) engine.flap(c, c.cur, { dur: 70 })
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
            <span className="sr-only">Local time</span>
            <Clock />
            <div className="brd-clockmeta mono tnum">
              <span className="mute">Local time</span>
              <span className="brd-sep" aria-hidden="true" />
              <span className="brd-next accent" aria-live="off" />
            </div>
          </div>
        </header>

        <div className="brd-unit">
          <div className="brd-bezel mono">
            <span className="brd-bezel-l">
              <span className="speed-glyph" aria-hidden="true" />
              Floor board · {today}
              <span className="brd-swipe mute" aria-hidden="true">
                · swipe →
              </span>
            </span>
            <span className="brd-bezel-r tnum">
              <span>
                <span className="mute">Spots open </span>
                <Odometer value={open} duration={0.9} className="brd-open" />
              </span>
              <span className="brd-last mute" />
            </span>
          </div>
          <div className="brd-rail" aria-hidden="true">
            <span className="brd-rail-fill" />
            {ROWS.map((r, i) => (
              <span key={i} className="brd-rail-tick" style={{ left: `${dayPos(toMin(r.time)) * 100}%` }} />
            ))}
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
                      style={{ '--k': c.n }}
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
