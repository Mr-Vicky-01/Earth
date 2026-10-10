import { Fragment, useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, ScrollTrigger, reducedMotion } from '../lib/gsap'
import { useSectionEdge } from '../lib/useSectionEdge'
import { useTicker } from '../lib/useTicker'
import { useInView } from '../lib/useInView'
import { SlamText } from '../ui/SlamText'
import { VelocityMarquee } from '../ui/VelocityMarquee'
import { Odometer } from '../ui/Odometer'
import { Reveal } from '../ui/Reveal'
import { useScramble } from '../ui/Scramble'
import './kinetic.css'

const MAX = 1.6 // m/s, right edge of the axis
const TICKS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5]
const ZONES = [
  { name: 'Absolute strength', from: 0.15, to: 0.5, pct: '≈ 85–100% 1RM', work: 'Heavy singles to triples. Raw max strength.' },
  { name: 'Accelerative strength', from: 0.5, to: 0.75, pct: '≈ 65–85% 1RM', work: 'Working sets of three to five. The core of most blocks.' },
  { name: 'Strength-speed', from: 0.75, to: 1.0, pct: '≈ 45–65% 1RM', work: 'Moderate loads moved hard. Cleans, speed squats, dynamic bench.' },
  { name: 'Speed-strength', from: 1.0, to: 1.3, pct: '≈ 30–45% 1RM', work: 'Light loads, maximum intent. Jump squats, push press.' },
  { name: 'Starting strength', from: 1.3, to: 1.6, pct: '< 30% 1RM', work: 'Bodyweight or very light. Jumps, throws, sprint starts.' },
]
const pos = (v) => `${(v / MAX) * 100}%`
const rangeOf = (z) => (z.to === 1.6 ? '1.30+ m/s' : `${z.from.toFixed(2)}–${z.to.toFixed(2)} m/s`)

const WORDS = ['Lift fast', 'Pull harder', 'Sprint', 'Recover', 'Repeat']
const WORDS_2 = ['Every rep measured', 'Stop before it slows', 'Faster every week']

export function Kinetic() {
  const ref = useRef(null)
  const chart = useRef(null)
  const marker = useRef(null)
  const markerRead = useRef(null)
  const detail = useRef(null)
  const [hover, setHover] = useState(null)
  const [auto, setAuto] = useState(1)
  const live = useRef({ v: 0.62, target: 0.62, next: 0, zone: 1 })
  const track = useRef({ left: 0, width: 0 })
  const scramble = useScramble()
  const inView = useInView(chart)
  useSectionEdge(ref)

  const active = hover ?? auto

  // cache the track geometry so the per-frame marker update never forces layout
  useEffect(() => {
    const el = chart.current?.querySelector('.kin-track')
    if (!el) return
    const measure = () => {
      track.current = { left: el.offsetLeft, width: el.offsetWidth }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(chart.current)
    return () => ro.disconnect()
  }, [])

  useGSAP(
    () => {
      if (reducedMotion()) return
      gsap.set('.kin-band', { scaleX: 0 })
      gsap.set('.kin-tick', { opacity: 0, y: 8 })
      ScrollTrigger.create({
        trigger: chart.current,
        start: 'top 80%',
        once: true,
        onEnter: () => {
          gsap.to('.kin-band', { scaleX: 1, duration: 0.9, stagger: 0.07, ease: 'expo.out' })
          gsap.to('.kin-tick', { opacity: 1, y: 0, duration: 0.5, stagger: 0.03, delay: 0.2 })
        },
      })
    },
    { scope: ref },
  )

  // a simulated rep stream: the marker jumps to each new rep velocity and the zone lights up
  useTicker(
    (t) => {
      const L = live.current
      if (hover !== null) {
        const z = ZONES[hover]
        L.target = (z.from + z.to) / 2
      } else if (t > L.next) {
        L.next = t + 1.25
        const zi = (L.zone + 1 + Math.floor(Math.random() * 2)) % ZONES.length
        const z = ZONES[zi]
        L.target = z.from + Math.random() * (z.to - z.from) * 0.9 + 0.02
        L.zone = zi
        setAuto(zi)
      }
      L.v += (L.target - L.v) * 0.14
      const { left, width } = track.current
      if (marker.current && width) marker.current.style.transform = `translateX(${(left + (L.v / MAX) * width).toFixed(1)}px)`
      const txt = `${L.v.toFixed(2)} m/s`
      if (markerRead.current && markerRead.current.textContent !== txt) markerRead.current.textContent = txt
    },
    inView && !reducedMotion(),
  )

  useEffect(() => {
    scramble(detail.current, ZONES[active].work, 520)
  }, [active, scramble])

  return (
    <section id="method" ref={ref} className="sec s-paper cut kin">
      <div className="kin-marquees" aria-hidden="true">
        <VelocityMarquee speed={60} boost={1800} skew={12}>
          {WORDS.map((w) => (
            <span key={w} className="kin-mq-item d">
              {w}
              <span className="speed-glyph" />
            </span>
          ))}
        </VelocityMarquee>
        <VelocityMarquee speed={45} boost={1400} skew={12} reverse className="kin-mq-alt">
          {WORDS_2.map((w) => (
            <span key={w} className="kin-mq-item d outline">
              {w}
              <span className="speed-glyph" style={{ '--accent': 'var(--color-heat)' }} />
            </span>
          ))}
        </VelocityMarquee>
      </div>

      <div className="wrap mt-[clamp(4rem,9vw,8rem)] grid gap-10 lg:grid-cols-12">
        <div className="lg:col-span-3">
          <Reveal>
            <span className="tag">The method</span>
          </Reveal>
        </div>
        <div className="flex flex-col gap-10 lg:col-span-9">
          <SlamText className="d t-lg" stretch gain={22} lines={['Strength is', 'speed you can', { text: 'repeat.', className: 'text-cobalt' }]} />
          <div className="grid gap-6 md:grid-cols-2">
            <Reveal as="p" className="body" delay={0.05}>
              Every bar on the FORGE floor carries a sensor that clocks how fast you move the weight. Fast reps mean the load is
              right. When your speed drops past a set limit, the set is over, even if you could grind out two more.
            </Reveal>
            <Reveal as="p" className="body" delay={0.12}>
              That keeps every rep crisp, cuts junk volume and lets you train hard more often. Your coach sees the numbers live
              and changes the load on the spot, so each session builds on the last.
            </Reveal>
          </div>
        </div>
      </div>

      <div className="wrap mt-[clamp(4rem,8vw,7rem)]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mono mute">Velocity zones · mean concentric velocity</p>
            <h3 className="d t-md mt-2">Where your reps land</h3>
          </div>
          <p className="mono mute">
            <span className="hidden md:inline">Hover</span>
            <span className="md:hidden">Tap</span> a zone · %1RM figures are typical, not fixed
          </p>
        </div>

        <div ref={chart} className="kin-chart relative" onMouseLeave={() => setHover(null)}>
          <div ref={marker} className="kin-marker" aria-hidden="true" style={{ left: 0 }}>
            <span ref={markerRead} className="kin-marker-read">
              0.62 m/s
            </span>
          </div>
          {ZONES.map((z, i) => (
            <div
              key={z.name}
              className={`kin-row ${active === i ? 'is-on' : ''}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => setHover((h) => (h === i ? null : i))}
              tabIndex={0}
              role="button"
              aria-pressed={active === i}
              aria-label={`${z.name}: ${z.from.toFixed(2)} to ${z.to === 1.6 ? 'above 1.30' : z.to.toFixed(2)} metres per second, ${z.pct}`}
            >
              <div className="kin-row-label">
                <span className="kin-row-name d">{z.name}</span>
                <span className="kin-row-range mono mute tnum">
                  {rangeOf(z)} · {z.pct}
                </span>
              </div>
              <div className="kin-track">
                <div className="kin-band" style={{ left: pos(z.from), width: `calc(${pos(z.to)} - ${pos(z.from)})` }}>
                  <span className="mono tnum">{z.to === 1.6 ? '1.30+ m/s' : `${z.from.toFixed(2)}–${z.to.toFixed(2)}`}</span>
                  <span className="mono kin-band-pct" style={{ color: 'rgb(239 238 233 / .7)' }}>
                    {z.pct}
                  </span>
                </div>
              </div>
            </div>
          ))}
          <div className="kin-row" style={{ borderBottom: 0 }} aria-hidden="true">
            <span className="mono mute hidden md:block">m/s</span>
            <div className="kin-axis">
              {TICKS.map((t) => (
                <span key={t} className="kin-tick" style={{ left: pos(t) }}>
                  {t.toFixed(2)}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6 grid items-start gap-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-5">
          <span className="tag is-solid" style={{ '--accent': 'var(--color-heat)' }}>
            {ZONES[active].name}
          </span>
          <p ref={detail} className="kin-detail lead" aria-live="polite">
            {ZONES[active].work}
          </p>
        </div>
      </div>

      <div className="wrap mt-[clamp(4rem,8vw,7rem)] grid gap-8 border-t border-[var(--line)] pt-10 sm:grid-cols-3">
        {[
          { el: <Odometer value={12400} />, label: 'Members training every week' },
          { el: <Odometer value={1.8} decimals={1} suffix="M" />, label: 'Reps measured this year' },
          { el: <Odometer value={11} prefix="+" suffix="%" />, label: 'Average bar speed gained in 12 weeks' },
        ].map((s, i) => (
          <Fragment key={s.label}>
            <Reveal delay={i * 0.08} className="flex flex-col gap-3">
              <span className="d t-lg">{s.el}</span>
              <span className="mono mute">{s.label}</span>
            </Reveal>
          </Fragment>
        ))}
      </div>
    </section>
  )
}
