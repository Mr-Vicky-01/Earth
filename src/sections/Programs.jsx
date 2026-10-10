import { useRef } from 'react'
import { gsap, ScrollTrigger, useGSAP, reducedMotion } from '../lib/gsap'
import { scroll, PX_TO_M, scrollToTarget, getLenis } from '../lib/scroll'
import { useSectionEdge } from '../lib/useSectionEdge'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'
import { SlamText } from '../ui/SlamText'
import { SpeedButton } from '../ui/SpeedButton'
import { Reveal } from '../ui/Reveal'
import { Chars } from '../ui/Chars'
import { VelocityViz, EngineViz, BreathViz, FightViz } from './prg-viz'
import './programs.css'

const PROGRAMS = [
  {
    key: 'vl',
    name: 'Velocity Lab',
    lines: ['Velocity', 'Lab'],
    surface: 's-cobalt',
    body: 'Barbell strength measured rep by rep. Squat, bench, deadlift, clean.',
    facts: ['60 min', 'Measures bar speed · m/s', 'All levels'],
    btn: 'paper',
    head: 'Bar path · back squat 140 kg',
    water: 'Lift',
    Viz: VelocityViz,
    sr: 'Live demo: a six-rep squat set. Mean bar speed drops from 0.92 to 0.72 metres per second; at 22% velocity loss the set ends.',
  },
  {
    key: 'en',
    name: 'Engine Room',
    lines: ['Engine', 'Room'],
    surface: 's-heat',
    body: 'Intervals on bikes, rowers and sleds, paced by heart rate and watts.',
    facts: ['45 min', 'Measures watts + bpm', 'Hard'],
    btn: 'ink',
    head: 'Bike sprints · 8 s on / 12 s easy',
    water: 'Burn',
    Viz: EngineViz,
    sr: 'Live demo: bike sprint intervals. Power surges from about 280 to 1,150 watts; heart rate climbs between 150 and 186 bpm.',
  },
  {
    key: 'rc',
    name: 'Recovery Deck',
    lines: ['Recovery', 'Deck'],
    surface: 's-paper',
    body: 'Contrast therapy, assisted mobility and breath work. The slow part that keeps you fast.',
    facts: ['40 min', 'Measures HRV · ms', 'Easy'],
    btn: 'cobalt',
    head: 'Paced breathing · 4 s in / 6 s out',
    water: 'Breathe',
    Viz: BreathViz,
    sr: 'Live demo: a breathing ring expands for a four second inhale and contracts for a six second exhale while heart rate variability rises from 48 to 62 milliseconds.',
  },
  {
    key: 'ff',
    name: 'Fight Floor',
    lines: ['Fight', 'Floor'],
    surface: 's-ink',
    body: 'Boxing and Muay Thai pad rounds, footwork and sparring.',
    facts: ['60 min', 'Measures strike speed · m/s', 'All levels'],
    btn: 'heat',
    head: 'Pad round · Muay Thai',
    water: 'Strike',
    Viz: FightViz,
    sr: 'Live demo: strikes land on a pad target with a strike counter, peak strike speed of up to 9.4 metres per second and a three minute round clock.',
  },
]
const LAST = PROGRAMS.length - 1

const DESK = '(min-width: 900px) and (prefers-reduced-motion: no-preference)'
const MOB = '(max-width: 899.98px) and (prefers-reduced-motion: no-preference)'

/**
 * Entrance for one panel: title chars yanked in stretched + skewed, copy bits pulled after them,
 * the instrument screen wiped open on the -12deg slant. `dir` 1 = arrives from the right.
 */
function entrance(slot, dir) {
  const chars = slot.querySelectorAll('.prg-title .ch')
  const bits = slot.querySelectorAll('[data-yank]')
  const viz = slot.querySelector('.prg-viz')
  const tl = gsap.timeline({ paused: true })
  tl.fromTo(
    chars,
    { xPercent: 150 * dir, scaleX: 1.9, skewX: 28 * dir, opacity: 0, transformOrigin: dir > 0 ? '100% 60%' : '0% 60%' },
    { xPercent: 0, scaleX: 1, skewX: 0, opacity: 1, duration: 0.8, ease: 'expo.out', stagger: { each: 0.024, from: dir > 0 ? 'end' : 'start' } },
    0,
  )
  tl.fromTo(bits, { x: 90 * dir, skewX: 10 * dir, opacity: 0 }, { x: 0, skewX: 0, opacity: 1, duration: 0.7, ease: 'expo.out', stagger: 0.035 }, 0.08)
  if (viz) {
    const hidden = dir > 0 ? 'polygon(112% 0%, 112% 0%, 100% 100%, 100% 100%)' : 'polygon(0% 0%, 0% 0%, -12% 100%, -12% 100%)'
    tl.fromTo(viz, { clipPath: hidden }, { clipPath: 'polygon(0% 0%, 112% 0%, 100% 100%, -12% 100%)', duration: 0.75, ease: 'expo.out' }, 0.02)
  }
  return tl
}

export function Programs() {
  const ref = useRef(null)
  const stage = useRef(null)
  const rail = useRef(null)
  const track = useRef(null)
  const fill = useRef(null)
  const pct = useRef(null)
  const speed = useRef(null)
  const nav = useRef(null)
  const live = useRef({ desk: false, tween: null, centers: [], vw: 1, sk: 0, w: 75, lastX: null, vx: 0, txtT: 0, idx: -1, prox: [] })
  const stageIn = useInView(stage, '0px')
  useSectionEdge(ref)

  useGSAP(
    () => {
      const L = live.current
      const root = ref.current
      const slots = gsap.utils.toArray('.prg-slot', root)
      const panels = slots.map((s) => s.querySelector('.prg-panel'))
      const mm = gsap.matchMedia()

      mm.add({ desk: DESK, mob: MOB }, (ctx) => {
        if (ctx.conditions.desk) {
          const st = stage.current
          const tr = track.current
          const dist = () => Math.max(0, tr.scrollWidth - st.clientWidth)
          const measure = () => {
            L.vw = st.clientWidth || window.innerWidth
            L.centers = slots.map((s) => s.offsetLeft + s.offsetWidth / 2)
          }
          const tween = gsap.to(tr, {
            x: () => -dist(),
            ease: 'none',
            scrollTrigger: {
              trigger: st,
              start: 'top top',
              end: () => `+=${dist()}`,
              pin: true,
              scrub: 0.6,
              invalidateOnRefresh: true,
              anticipatePin: 1,
              onRefresh: measure,
            },
            onUpdate() {
              const p = this.progress()
              if (fill.current) fill.current.style.transform = `scaleX(${p.toFixed(4)})`
            },
          })
          measure()
          L.tween = tween
          L.desk = true

          slots.forEach((slot, i) => {
            const tl = entrance(slot, 1)
            if (i === 0) {
              ScrollTrigger.create({
                trigger: st,
                start: 'top 70%',
                onEnter: () => tl.timeScale(1).play(),
                onLeaveBack: () => tl.timeScale(2.4).reverse(),
              })
            } else {
              ScrollTrigger.create({
                trigger: slot,
                containerAnimation: tween,
                start: 'left 86%',
                onEnter: () => tl.timeScale(1).play(),
                onLeaveBack: () => tl.timeScale(2.4).reverse(),
              })
            }
            // giant word drifts against the run
            gsap.fromTo(
              slot.querySelector('.prg-water'),
              { xPercent: 22 },
              { xPercent: -22, ease: 'none', scrollTrigger: { trigger: slot, containerAnimation: tween, start: 'left right', end: 'right left', scrub: true } },
            )
          })

          return () => {
            L.desk = false
            L.tween = null
            L.lastX = null
            L.prox = []
            L.idx = -1
            if (rail.current) rail.current.style.transform = ''
            panels.forEach((p) => {
              p.style.transform = ''
              const v = p.querySelector('.prg-veil')
              if (v) v.style.opacity = ''
            })
          }
        }

        if (ctx.conditions.mob) {
          slots.forEach((slot, i) => {
            const dir = i % 2 === 0 ? -1 : 1
            const panel = panels[i]
            const tl = entrance(slot, dir)
            gsap.set(panel, { xPercent: 104 * dir, skewX: 14 * dir, scaleX: 1.12, transformOrigin: '50% 50%' })
            ScrollTrigger.create({
              trigger: slot,
              start: 'top 86%',
              once: true,
              onEnter: () => {
                gsap.to(panel, { xPercent: 0, skewX: 0, scaleX: 1, duration: 0.85, ease: 'expo.out', clearProps: 'transform' })
                tl.play()
              },
            })
            gsap.fromTo(
              slot.querySelector('.prg-water'),
              { xPercent: 14 * dir },
              { xPercent: -14 * dir, ease: 'none', scrollTrigger: { trigger: slot, start: 'top bottom', end: 'bottom top', scrub: true } },
            )
          })
        }
      })
      return () => mm.revert()
    },
    { scope: ref },
  )

  // desktop run: velocity skew, title stretch, focus-pull on the centre panel, live readouts
  useTicker(
    (t, dtMs) => {
      const L = live.current
      if (!L.desk || !L.tween) return
      const dt = Math.max(dtMs || 16.7, 1)
      // frame-rate independent easing toward the scroll-speed skew
      L.sk += (-scroll.norm * 6 - L.sk) * (1 - Math.pow(0.86, dt / 16.667))
      const skv = Math.abs(L.sk) < 0.02 ? 0 : Math.round(L.sk * 100) / 100
      if (skv !== L.skShown && rail.current) {
        L.skShown = skv
        rail.current.style.transform = skv ? `skewX(${skv}deg)` : ''
      }
      const w = Math.round((75 + scroll.abs * 8) * 2) / 2
      if (w !== L.w && track.current) {
        L.w = w
        track.current.style.setProperty('--prg-w', w)
      }

      const x = Number(gsap.getProperty(track.current, 'x')) || 0
      const slots = track.current.children
      for (let i = 0; i < slots.length; i++) {
        const c = L.centers[i]
        if (c === undefined) continue
        const d = Math.min(1, Math.abs((c + x - L.vw / 2) / L.vw) * 1.25)
        const q = Math.round(d * 200) / 200
        if (q !== L.prox[i]) {
          L.prox[i] = q
          const panel = slots[i].firstChild
          panel.style.transform = q ? `scale(${(1 - q * 0.075).toFixed(4)})` : ''
          const veil = panel.lastChild
          if (veil) veil.style.opacity = (q * 0.18).toFixed(3)
        }
      }

      if (L.lastX !== null) L.vx += ((Math.abs(x - L.lastX) / dt) * 1000 - L.vx) * 0.18
      L.lastX = x
      if (t - L.txtT >= 0.05) {
        L.txtT = t
        const ms = (L.vx * PX_TO_M).toFixed(2)
        if (speed.current && speed.current.__v !== ms) {
          speed.current.__v = ms
          speed.current.textContent = ms
        }
        const p = L.tween.progress()
        const pc = `${Math.round(p * 100)}%`
        if (pct.current && pct.current.__v !== pc) {
          pct.current.__v = pc
          pct.current.textContent = pc
        }
        const idx = Math.round(p * LAST)
        if (idx !== L.idx && nav.current) {
          L.idx = idx
          Array.from(nav.current.children).forEach((b, i) => {
            b.classList.toggle('is-on', i === idx)
            b.setAttribute('aria-current', i === idx ? 'true' : 'false')
          })
        }
      }
    },
    stageIn && !reducedMotion(),
  )

  /** scroll the pinned run so panel `i` sits in the middle */
  const jump = (i, immediate = false) => {
    const st = live.current.tween?.scrollTrigger
    if (!st) return false
    const y = st.start + (st.end - st.start) * (i / LAST)
    const lenis = getLenis()
    if (lenis) lenis.scrollTo(y, { immediate, duration: 1.1, easing: (k) => 1 - Math.pow(1 - k, 5) })
    else window.scrollTo(0, y)
    return true
  }

  const onSlotFocus = (i) => {
    const L = live.current
    if (L.desk && L.idx !== i) jump(i, true)
  }

  const toSchedule = (e) => {
    e.preventDefault()
    scrollToTarget('#schedule')
  }

  return (
    <section id="programs" ref={ref} className="sec s-ink cut prg" aria-labelledby="prg-h">
      <div className="wrap prg-intro">
        <Reveal className="prg-intro-tag">
          <span className="tag">
            <span className="live-dot" /> Four floors
          </span>
        </Reveal>
        <SlamText id="prg-h" className="d t-xl prg-h2" stretch gain={18} lines={['Four floors.', { text: 'One pace.', className: 'outline' }]} />
        <div className="prg-intro-foot">
          <Reveal as="p" className="lead" delay={0.08}>
            Every program runs on the same idea: measure the output, keep the quality high, stop before it gets sloppy.
          </Reveal>
          <Reveal from="right" className="prg-legend" delay={0.12}>
            {PROGRAMS.map((p) => (
              <span key={p.key} className={`prg-legend-i prg-sw-${p.key} mono`}>
                <i />
                {p.name}
              </span>
            ))}
          </Reveal>
          <Reveal from="right" className="prg-hint mono" delay={0.12} aria-hidden="true">
            <span className="speed-glyph" />
            Keep scrolling · the floor runs sideways
          </Reveal>
        </div>
      </div>

      <div ref={stage} className="prg-stage">
        <div className="wrap prg-top">
          <div ref={nav} className="prg-nav" role="group" aria-label="Jump to a program">
            {PROGRAMS.map((p, i) => (
              <button key={p.key} type="button" className={`prg-nav-b prg-sw-${p.key} mono ${i === 0 ? 'is-on' : ''}`} onClick={() => jump(i)}>
                <i aria-hidden="true" />
                {p.name}
              </button>
            ))}
          </div>
          <p className="mono prg-top-speed" aria-hidden="true">
            <span className="speed-glyph" />
            Floor speed <b ref={speed} className="tnum">0.00</b> m/s
          </p>
        </div>

        <div ref={rail} className="prg-rail">
          <div ref={track} className="prg-track">
            {PROGRAMS.map((p, i) => (
              <div key={p.key} className="prg-slot" onFocus={() => onSlotFocus(i)}>
                <article className={`prg-panel prg-p-${p.key} ${p.surface}`} aria-labelledby={`prg-t-${p.key}`}>
                  <span className="prg-water d" aria-hidden="true">
                    {p.water}
                  </span>
                  <div className="prg-copy">
                    <h3 id={`prg-t-${p.key}`} className="d t-lg prg-title" aria-label={p.name}>
                      {p.lines.map((l) => (
                        <span key={l} className="d-line" aria-hidden="true">
                          <Chars text={l} />
                        </span>
                      ))}
                    </h3>
                    <div className="prg-copy-foot">
                      <p className="body" data-yank>
                        {p.body}
                      </p>
                      <ul className="prg-facts" aria-label={`${p.name} at a glance`}>
                        {p.facts.map((f) => (
                          <li key={f} className="tag" data-yank>
                            {f}
                          </li>
                        ))}
                      </ul>
                      <div data-yank className="prg-cta">
                        <SpeedButton href="#schedule" size="sm" variant={p.btn} onClick={toSchedule}>
                          See schedule
                        </SpeedButton>
                      </div>
                    </div>
                  </div>
                  <div className="prg-viz">
                    <div className="prg-viz-head mono">
                      <span>{p.head}</span>
                      <span className="prg-viz-live">
                        <span className="live-dot" /> Live
                      </span>
                    </div>
                    <p className="sr-only">{p.sr}</p>
                    <p.Viz />
                  </div>
                  <span className="prg-veil" aria-hidden="true" />
                </article>
              </div>
            ))}
          </div>
        </div>

        <div className="prg-foot" aria-hidden="true">
          <div className="wrap prg-foot-row">
            <span className="mono">
              Run <b ref={pct} className="tnum">0%</b>
            </span>
          </div>
          <div className="prg-progress">
            {PROGRAMS.map((p, i) => (
              <em key={p.key} style={{ left: `${(i / LAST) * 100}%` }} />
            ))}
            <i ref={fill} />
          </div>
        </div>
      </div>
    </section>
  )
}
