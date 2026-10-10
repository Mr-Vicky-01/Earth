import { useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, reducedMotion } from '../lib/gsap'
import { useInView } from '../lib/useInView'
import { useSectionEdge } from '../lib/useSectionEdge'
import { SlamText } from '../ui/SlamText'
import { SpeedButton } from '../ui/SpeedButton'
import { Odometer } from '../ui/Odometer'
import { useScramble } from '../ui/Scramble'
import { ArrowRight } from '../ui/Icons'
import { createPullEngine } from './pull-engine'
import { MAX_V, RATINGS, ratingIndex } from './pull-physics'
import './pull.css'

const BEST_KEY = 'forge.pull.best'
const IDLE_WORD = 'Ready to pull'

function readBest() {
  try {
    const v = parseFloat(window.localStorage.getItem(BEST_KEY))
    return Number.isFinite(v) && v > 0 && v <= MAX_V ? Math.round(v * 100) / 100 : 0
  } catch {
    return 0
  }
}
function writeBest(v) {
  try {
    window.localStorage.setItem(BEST_KEY, v.toFixed(2))
  } catch {
    /* storage blocked: best lives for this visit only */
  }
}

const TICKS = [0, 5, 10, 15, 20, 25, 30]
const ZONES = [
  { at: 0, label: 'Warm-up' },
  { at: 1.5, label: 'Working' },
  { at: 3, label: 'Explosive' },
  { at: 5, label: 'Elite' },
]

/** Top-down sled: runners, a slanted heat deck, tow bar and two loaded plates. */
function SledArt() {
  const plate = (cx) => (
    <g key={cx}>
      <circle cx={cx} cy="40" r="19.5" fill="#0a0a10" stroke="#c8cbd6" strokeWidth="2.5" />
      <circle cx={cx} cy="40" r="13" fill="none" stroke="#3a3a4c" strokeWidth="1.5" />
      <circle cx={cx} cy="40" r="5.5" fill="#c8cbd6" />
      <circle cx={cx} cy="40" r="2.2" fill="#0a0a10" />
    </g>
  )
  return (
    <svg viewBox="0 0 124 80" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect x="0" y="3" width="118" height="7" fill="#c8cbd6" />
      <rect x="0" y="70" width="118" height="7" fill="#c8cbd6" />
      <path d="M6 11H99L111 23V57L99 69H6Z" fill="#ff4b1f" />
      <rect x="0" y="15" width="8" height="50" fill="#0a0a10" />
      <path d="M12 15h9l-4 50h-9z" fill="#0a0a10" opacity=".22" />
      <rect x="109" y="31" width="9" height="18" fill="#0a0a10" />
      <rect x="117" y="35.5" width="7" height="9" fill="#efeee9" />
      {plate(37)}
      {plate(79)}
    </svg>
  )
}

/**
 * Pull — interactive sled-pull test. Grab the handle (or use the keyboard) and yank the sled down a
 * 30 m turf track; peak speed is clocked in m/s like every rep on the floor.
 */
export function Pull({ ready }) {
  const secRef = useRef(null)
  const headRef = useRef(null)
  const readoutRef = useRef(null)
  const speedRef = useRef(null)
  const peakRef = useRef(null)
  const distRef = useRef(null)
  const ratingRef = useRef(null)
  const meterFillRef = useRef(null)
  const meterPeakRef = useRef(null)
  const stampRef = useRef(null)
  const stampNoteRef = useRef(null)
  const trackRef = useRef(null)
  const stageRef = useRef(null)
  const canvasRef = useRef(null)
  const smearRef = useRef(null)
  const trailRef = useRef(null)
  const progRef = useRef(null)
  const flagRef = useRef(null)
  const flagTextRef = useRef(null)
  const ropeSvgRef = useRef(null)
  const ropeRef = useRef(null)
  const braidRef = useRef(null)
  const sledRef = useRef(null)
  const chipRef = useRef(null)
  const chipTextRef = useRef(null)
  const handleRef = useRef(null)
  const gripRef = useRef(null)
  const hintRef = useRef(null)
  const againRef = useRef(null)
  const statusRef = useRef(null)
  const engineRef = useRef(null)

  useSectionEdge(secRef)
  const inView = useInView(trackRef, '10% 0px')
  const scramble = useScramble()
  const [best, setBest] = useState(readBest)
  const bestRef = useRef(best)
  const [done, setDone] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    const reduced = reducedMotion()
    const stamp = stampRef.current
    const hideStamp = () => {
      gsap.killTweensOf(stamp)
      gsap.to(stamp, { autoAlpha: 0, xPercent: 20, duration: reduced ? 0 : 0.22, ease: 'power2.in' })
    }
    const slamStamp = (prev, peak) => {
      stampNoteRef.current.textContent = prev > 0 ? `+${(peak - prev).toFixed(2)} m/s` : 'First mark'
      gsap.killTweensOf(stamp)
      if (reduced) {
        gsap.set(stamp, { autoAlpha: 1, rotate: -5, xPercent: 0, scale: 1, skewX: 0 })
        return
      }
      gsap.fromTo(
        stamp,
        { autoAlpha: 0, scale: 2.6, xPercent: -40, skewX: -30, rotate: -18 },
        { autoAlpha: 1, scale: 1, xPercent: 0, skewX: 0, rotate: -5, duration: 0.6, ease: 'expo.out', delay: 0.05 },
      )
    }

    const engine = createPullEngine(
      {
        track: trackRef.current,
        stage: stageRef.current,
        canvas: canvasRef.current,
        smear: smearRef.current,
        trail: trailRef.current,
        prog: progRef.current,
        flag: flagRef.current,
        flagText: flagTextRef.current,
        ropeSvg: ropeSvgRef.current,
        rope: ropeRef.current,
        braid: braidRef.current,
        sled: sledRef.current,
        chip: chipRef.current,
        chipText: chipTextRef.current,
        handle: handleRef.current,
        grip: gripRef.current,
        hint: hintRef.current,
        readout: readoutRef.current,
        speed: speedRef.current,
        peak: peakRef.current,
        dist: distRef.current,
        meterFill: meterFillRef.current,
        meterIn: meterFillRef.current.firstChild,
        meterPeak: meterPeakRef.current,
        faster: headRef.current?.querySelector('.d-line:nth-child(2)') || null,
      },
      {
        onFirst() {
          gsap.to(hintRef.current.firstChild, { autoAlpha: 0, x: 28, duration: reduced ? 0 : 0.3, ease: 'expo.out' })
        },
        onStart() {
          statusRef.current.dataset.state = 'live'
          setDone(false)
          setMsg('')
        },
        onRating(i) {
          const el = ratingRef.current
          el.dataset.r = String(i)
          scramble(el, RATINGS[i], 420)
        },
        onStop({ peak, dist }) {
          const prev = bestRef.current
          const isBest = peak > prev
          if (isBest) {
            bestRef.current = peak
            writeBest(peak)
            setBest(peak)
            slamStamp(prev, peak)
          }
          statusRef.current.dataset.state = 'done'
          setDone(true)
          setMsg(
            `Peak ${peak.toFixed(2)} metres per second, ${RATINGS[ratingIndex(peak)].toLowerCase()}. ` +
              `Distance ${dist.toFixed(1)} metres.${isBest ? ' New personal best.' : ''}`,
          )
        },
        onReset() {
          statusRef.current.dataset.state = 'idle'
          setDone(false)
          hideStamp()
          const el = ratingRef.current
          el.dataset.r = '-1'
          scramble(el, IDLE_WORD, 380)
        },
      },
    )
    engineRef.current = engine
    engine.measure()
    const ro = new ResizeObserver(() => engine.measure())
    ro.observe(trackRef.current)
    return () => {
      ro.disconnect()
      engine.destroy()
      engineRef.current = null
      gsap.killTweensOf(stamp)
    }
  }, [scramble])

  useEffect(() => {
    engineRef.current?.setInView(inView)
  }, [inView])

  useEffect(() => {
    if (ready) engineRef.current?.setReady()
  }, [ready])

  // "Pull again" is yanked in from the left once the sled stops
  useGSAP(
    () => {
      const el = againRef.current
      const reduced = reducedMotion()
      if (done) {
        gsap.fromTo(
          el,
          { autoAlpha: 0, x: -70, skewX: -26 },
          { autoAlpha: 1, x: 0, skewX: 0, duration: reduced ? 0 : 0.6, delay: reduced ? 0 : 0.12, ease: 'expo.out' },
        )
      } else {
        gsap.to(el, { autoAlpha: 0, x: 20, skewX: 12, duration: reduced ? 0 : 0.2, ease: 'power2.in' })
      }
    },
    { dependencies: [done], scope: againRef },
  )

  const onAgain = () => {
    engineRef.current?.reset()
    handleRef.current?.focus({ preventScroll: true })
  }

  return (
    <section id="pull" ref={secRef} className="sec s-cobalt cut pad pull" aria-labelledby="pull-title">
      <div className="wrap">
        <div className="pull-head">
          <div ref={headRef}>
            <span className="tag">
              <span className="speed-glyph" aria-hidden="true" />
              Floor test · Sled pull
            </span>
            <SlamText
              id="pull-title"
              className="d t-xl pull-title"
              lines={['Pull it.', { text: 'Faster.', className: 'outline' }]}
              stretch
              gain={26}
            />
          </div>
          <div className="pull-intro">
            <p className="lead pull-lead">
              Grab the handle and yank it to the right. We clock the sled the way we clock every rep on the floor: peak
              speed, in metres per second.
            </p>
            <ul className="pull-specs mono">
              <li>
                <span className="mute">Lane</span> 30 m turf
              </li>
              <li>
                <span className="mute">Sled</span> 60 kg loaded
              </li>
              <li>
                <span className="mute">Clocked</span> m/s, 2 dp
              </li>
            </ul>
          </div>
        </div>

        <div ref={readoutRef} className="pull-readout">
          <div className="pull-speed">
            <p className="pull-lab mono">
              <span className="pull-dot" aria-hidden="true" />
              Speed
              <span className="pull-lab-live" aria-hidden="true">
                Clocking
              </span>
            </p>
            <p className="pull-speed-row">
              <span ref={speedRef} className="d tnum pull-speed-num">
                0.00
              </span>
              <span className="mono pull-unit">m/s</span>
            </p>
            <div className="pull-meter" aria-hidden="true">
              <div className="pull-meter-bar">
                <div className="pull-meter-base" />
                <div className="pull-meter-clip">
                  <div ref={meterFillRef} className="pull-meter-fill">
                    <div className="pull-meter-in">
                      <div className="pull-meter-paint" />
                    </div>
                  </div>
                </div>
                <div className="pull-meter-lane">
                  <div ref={meterPeakRef} className="pull-meter-peak" />
                </div>
              </div>
              <div className="pull-zones mono">
                {ZONES.map((z) => (
                  <span key={z.label} style={{ '--at': `${(z.at / MAX_V) * 100}%` }}>
                    {z.label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <dl className="pull-stats">
            <div className="pull-stat">
              <dt className="mono">Peak</dt>
              <dd>
                <span ref={peakRef} className="d tnum pull-num">
                  0.00
                </span>
                <span className="mono pull-unit">m/s</span>
              </dd>
            </div>
            <div className="pull-stat">
              <dt className="mono">Distance</dt>
              <dd>
                <span ref={distRef} className="d tnum pull-num">
                  0.0
                </span>
                <span className="mono pull-unit">m</span>
              </dd>
            </div>
            <div className="pull-stat pull-best">
              <dt className="mono">Your best</dt>
              <dd>
                <Odometer value={best} decimals={2} className="d pull-num" />
                <span className="mono pull-unit">m/s</span>
                <span ref={stampRef} className="pull-stamp" aria-hidden="true">
                  <span className="d">New best</span>
                  <span ref={stampNoteRef} className="mono tnum">
                    First mark
                  </span>
                </span>
              </dd>
            </div>
            <div className="pull-stat pull-rate">
              <dt className="mono">Rating</dt>
              <dd>
                <span ref={ratingRef} className="d pull-rating" data-r="-1">
                  {IDLE_WORD}
                </span>
              </dd>
            </div>
          </dl>
        </div>

        <div className="pull-track-wrap">
          <div ref={trackRef} className="pull-track">
            <div ref={stageRef} className="pull-stage">
              <p ref={statusRef} className="pull-status mono" data-state="idle" aria-hidden="true">
                <span className="pull-status-dot" />
                <span className="pull-status-t is-idle">Sensor armed</span>
                <span className="pull-status-t is-live">Clocking</span>
                <span className="pull-status-t is-done">Logged</span>
              </p>
              <div className="pull-turf" aria-hidden="true">
                <div className="pull-bay" />
                <div className="pull-runoff" />
                <div className="pull-lane is-a" />
                <div className="pull-lane is-b" />
                {[10, 20].map((m) => (
                  <span key={m} className="d pull-paint" style={{ '--m': m }}>
                    {m}
                  </span>
                ))}
                {TICKS.map((m) => (
                  <div
                    key={m}
                    className={`pull-tick ${m % 10 ? 'is-five' : 'is-ten'} ${m === 30 ? 'is-end' : ''}`}
                    style={{ '--m': m }}
                  >
                    <span className="mono tnum">{m} m</span>
                  </div>
                ))}
                <div className="pull-start">
                  <span className="mono">Start</span>
                </div>
                <div className="pull-finish" />
                <div ref={trailRef} className="pull-trail" />
                <div ref={progRef} className="pull-prog" />
              </div>
              <div ref={smearRef} className="pull-smear" aria-hidden="true" />
              <canvas ref={canvasRef} className="pull-fx" aria-hidden="true" />
              <div ref={flagRef} className="pull-flag" aria-hidden="true">
                <span className="pull-flag-in mono tnum">
                  Peak <b ref={flagTextRef}>0.00</b>
                </span>
              </div>
              <svg ref={ropeSvgRef} className="pull-rope" aria-hidden="true" focusable="false">
                <path ref={ropeRef} className="pull-rope-base" d="M0 0" />
                <path ref={braidRef} className="pull-rope-braid" d="M0 0" />
              </svg>
              <div ref={sledRef} className="pull-sled" aria-hidden="true">
                <SledArt />
              </div>
              <div ref={chipRef} className="pull-chip" aria-hidden="true">
                <span className="pull-chip-in mono tnum">
                  <span ref={chipTextRef}>0.00</span> m/s
                </span>
              </div>
              <button
                ref={handleRef}
                type="button"
                className="pull-handle"
                aria-label="Pull the sled"
                aria-describedby="pull-help"
                data-cursor="Pull"
              >
                <span ref={gripRef} className="pull-grip" aria-hidden="true">
                  <span className="pull-grip-loop" />
                  <span className="pull-grip-plate">
                    <span className="d pull-grip-txt">Pull</span>
                    <span className="speed-glyph" />
                  </span>
                </span>
              </button>
              <div ref={hintRef} className="pull-hint" aria-hidden="true">
                <span className="pull-hint-in mono">
                  <ArrowRight />
                  Yank
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="pull-controls">
          <p id="pull-help" className="pull-help mono">
            Drag the handle right, fast.{' '}
            <span className="pull-help-keys">Keyboard: hold → or Space to pull, Enter for one hard yank.</span>
          </p>
          <div ref={againRef} className="pull-again" inert={!done}>
            <SpeedButton variant="paper" size="sm" onClick={onAgain}>
              Pull again
            </SpeedButton>
          </div>
        </div>
        <p className="sr-only" aria-live="polite">
          {msg}
        </p>
      </div>
    </section>
  )
}
