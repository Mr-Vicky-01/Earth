import { useEffect, useRef, useState } from 'react'
import { gsap, ScrollTrigger, useGSAP, reducedMotion } from '../lib/gsap'
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
// rating thresholds on the meter (m/s)
const ZONES = [0, 1.5, 3, 5]

/**
 * The sled in side profile, nose to the right: runners with upturned tips, a heat deck,
 * three plates stacked edge-on on a centre post, and a tow ring where the rope ties on.
 */
function SledArt() {
  const plate = (x, y, w, h) => (
    <g key={y}>
      <rect x={x} y={y} width={w} height={h} fill="#3b3b50" />
      <rect x={x} y={y} width={w} height="2.4" fill="#c8cbd6" />
      <rect x={x} y={y} width="3" height={h} fill="#c8cbd6" />
      <rect x={x + w - 3} y={y} width="3" height={h} fill="#c8cbd6" />
      <rect x="56.5" y={y + 2.4} width="9" height={h - 2.4} fill="#0a0a10" opacity=".55" />
    </g>
  )
  return (
    <svg viewBox="0 0 140 80" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {/* far runner, for depth */}
      <path d="M12 63.5H104Q118 63.5 122 49" fill="none" stroke="#5a5d6c" strokeWidth="4" />
      {/* struts */}
      <path d="M21 54h6v13h-6zM58 54h6v13h-6zM95 54h6v13h-6z" fill="#8b8e9c" />
      {/* near runner with an upturned nose */}
      <path d="M3 70H109Q126 70 130 49" fill="none" stroke="#c8cbd6" strokeWidth="6" strokeLinecap="square" />
      {/* deck */}
      <path d="M6 43H112L121 52V56H6Z" fill="#ff4b1f" />
      <path d="M6 52H121V56H6Z" fill="#0a0a10" opacity=".28" />
      {/* tow strap + ring */}
      <path d="M115 47.5L130 41" stroke="#0a0a10" strokeWidth="4" />
      <circle cx="133.5" cy="40" r="4.6" fill="none" stroke="#c8cbd6" strokeWidth="3" />
      {/* post */}
      <rect x="57.5" y="5" width="7" height="39" fill="#efeee9" />
      {plate(22, 32, 78, 11)}
      {plate(29, 22, 64, 9)}
      {plate(37, 13.5, 48, 7.5)}
      <rect x="54" y="8.5" width="14" height="4" fill="#ff4b1f" />
      <rect x="56" y="2" width="10" height="4" fill="#efeee9" />
    </svg>
  )
}

/**
 * Pull — interactive sled-pull test. Grab the handle (or use the keyboard) and yank the sled down a
 * 30 m turf lane; the camera chases the sled, peak speed is clocked in m/s like every rep on the floor.
 */
export function Pull({ ready }) {
  const secRef = useRef(null)
  const headRef = useRef(null)
  const rigRef = useRef(null)
  const readoutRef = useRef(null)
  const speedRef = useRef(null)
  const peakRef = useRef(null)
  const distRef = useRef(null)
  const ratingRef = useRef(null)
  const meterFillRef = useRef(null)
  const meterPeakRef = useRef(null)
  const stampRef = useRef(null)
  const stampNoteRef = useRef(null)
  const trackWrapRef = useRef(null)
  const trackRef = useRef(null)
  const stageRef = useRef(null)
  const worldRef = useRef(null)
  const canvasRef = useRef(null)
  const smearRef = useRef(null)
  const trailRef = useRef(null)
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
  const mapRef = useRef(null)
  const mapFillRef = useRef(null)
  const mapSledRef = useRef(null)
  const mapWinRef = useRef(null)
  const againRef = useRef(null)
  const engineRef = useRef(null)

  useSectionEdge(secRef)
  const inView = useInView(trackRef, '10% 0px')
  const scramble = useScramble()
  const [best, setBest] = useState(readBest)
  const bestRef = useRef(best)
  const [done, setDone] = useState(false)
  const [msg, setMsg] = useState('')
  const [rateWord, setRateWord] = useState(IDLE_WORD)
  // App may render Pull without `ready` (it sits far below the fold): treat that as ready
  const isReady = ready !== false
  // mirrored so a re-created engine (HMR, scramble identity) starts in the right state
  const inViewRef = useRef(false)
  const readyRef = useRef(isReady)
  const arrivedRef = useRef(false)
  const newBestRef = useRef(false)

  useEffect(() => {
    const reduced = reducedMotion()
    const stamp = stampRef.current
    const hideStamp = () => {
      gsap.killTweensOf(stamp)
      gsap.to(stamp, { autoAlpha: 0, xPercent: 30, skewX: 20, duration: reduced ? 0 : 0.2, ease: 'power2.in' })
    }
    const slamStamp = (prev, peak) => {
      stampNoteRef.current.textContent = prev > 0 ? `+${(peak - prev).toFixed(2)} m/s` : 'First mark'
      gsap.killTweensOf(stamp)
      if (reduced) {
        gsap.set(stamp, { autoAlpha: 1, rotate: -6, xPercent: 0, scale: 1, skewX: 0 })
        return
      }
      gsap.fromTo(
        stamp,
        { autoAlpha: 0, scale: 2.8, xPercent: -60, skewX: -34, rotate: -20 },
        { autoAlpha: 1, scale: 1, xPercent: 0, skewX: 0, rotate: -6, duration: 0.55, ease: 'expo.out' },
      )
    }
    const setRating = (i) => {
      const el = ratingRef.current
      el.dataset.r = String(i)
      const word = i < 0 ? IDLE_WORD : RATINGS[i]
      scramble(el, word, i < 0 ? 340 : 380)
      setRateWord(word)
    }

    const q = (s) => rigRef.current.querySelectorAll(s)
    const engine = createPullEngine(
      {
        track: trackRef.current,
        stage: stageRef.current,
        world: worldRef.current,
        canvas: canvasRef.current,
        smear: smearRef.current,
        trail: trailRef.current,
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
        map: mapRef.current,
        mapFill: mapFillRef.current,
        mapSled: mapSledRef.current,
        mapWin: mapWinRef.current,
        edges: Array.from(q('.pull-edge')),
        faster: headRef.current?.querySelector('.d-line:nth-child(2)') || null,
      },
      {
        onFirst() {
          gsap.to(hintRef.current.firstChild, { autoAlpha: 0, x: 28, duration: reduced ? 0 : 0.25, ease: 'expo.out' })
        },
        onStart() {
          setDone(false)
          setMsg('')
        },
        onRating(i) {
          setRating(i)
        },
        onResult({ peak }) {
          const prev = bestRef.current
          newBestRef.current = peak > prev
          if (peak > prev) {
            bestRef.current = peak
            writeBest(peak)
            setBest(peak)
            slamStamp(prev, peak)
          }
          setDone(true)
        },
        onSettled({ peak, dist }) {
          setMsg(
            `Peak ${peak.toFixed(2)} metres per second, ${RATINGS[ratingIndex(peak)].toLowerCase()}. ` +
              `Distance ${dist.toFixed(1)} metres.${newBestRef.current ? ' New personal best.' : ''}`,
          )
        },
        onReset() {
          setDone(false)
          hideStamp()
          setRating(-1)
        },
      },
    )
    engineRef.current = engine
    engine.measure()
    engine.setInView(inViewRef.current)
    if (readyRef.current) engine.setReady()
    if (arrivedRef.current) engine.skipIntro()
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
    inViewRef.current = inView
    engineRef.current?.setInView(inView)
  }, [inView])

  useEffect(() => {
    readyRef.current = isReady
    if (isReady) engineRef.current?.setReady()
  }, [isReady])

  // arrival: the readout and the lane are yanked in, the turf marks snap down, the sled whips into its bay
  useGSAP(
    () => {
      if (!isReady) return
      const arrive = () => {
        arrivedRef.current = true
        engineRef.current?.intro()
      }
      if (reducedMotion()) {
        const st = ScrollTrigger.create({ trigger: rigRef.current, start: 'top 85%', once: true, onEnter: arrive })
        return () => st.kill()
      }
      const q = gsap.utils.selector(rigRef)
      const cells = q('.pull-cell')
      const track = trackWrapRef.current
      const marks = q('.pull-tick span, .pull-paint, .pull-start span, .pull-finish span')
      const lanes = q('.pull-lane, .pull-minor')
      const meter = q('.pull-meter-bar')
      const zones = q('.pull-zones span')
      const map = q('.pull-map')
      gsap.set(cells, { autoAlpha: 0, x: -64, skewX: -18 })
      gsap.set(track, { autoAlpha: 0, xPercent: -26, skewX: -20 })
      gsap.set(marks, { autoAlpha: 0, y: 16, skewX: -24 })
      gsap.set(lanes, { scaleX: 0, transformOrigin: '0% 50%' })
      gsap.set(meter, { clipPath: 'inset(-6px 100% -6px 0)' })
      gsap.set(zones, { autoAlpha: 0, x: -14 })
      gsap.set(map, { autoAlpha: 0, x: -40 })
      const play = () => {
        const tl = gsap.timeline({ defaults: { ease: 'expo.out' } })
        tl.to(cells, { autoAlpha: 1, x: 0, skewX: 0, duration: 0.7, stagger: 0.04 }, 0)
        tl.add(() => {
          if (!engineRef.current?.isIdle()) return
          scramble(speedRef.current, '0.00', 420)
          scramble(peakRef.current, '0.00', 360)
          scramble(distRef.current, '0.0', 360)
        }, 0.05)
        tl.to(meter, { clipPath: 'inset(-6px 0% -6px 0)', duration: 0.8 }, 0.12)
        tl.to(zones, { autoAlpha: 1, x: 0, duration: 0.5, stagger: 0.035 }, 0.2)
        tl.to(track, { autoAlpha: 1, xPercent: 0, skewX: 0, duration: 0.72 }, 0.06)
        tl.to(lanes, { scaleX: 1, duration: 0.6, stagger: 0.03 }, 0.2)
        tl.to(marks, { autoAlpha: 1, y: 0, skewX: 0, duration: 0.5, stagger: 0.02 }, 0.26)
        tl.to(map, { autoAlpha: 1, x: 0, duration: 0.6 }, 0.32)
        tl.add(arrive, 0.1)
      }
      ScrollTrigger.create({ trigger: rigRef.current, start: 'top 82%', once: true, onEnter: play })
    },
    { scope: rigRef, dependencies: [isReady] },
  )

  // "Pull again" is yanked in from the left as soon as the result is called
  useGSAP(
    () => {
      const el = againRef.current
      const reduced = reducedMotion()
      if (done) {
        gsap.fromTo(
          el,
          { autoAlpha: 0, x: -70, skewX: -26 },
          { autoAlpha: 1, x: 0, skewX: 0, duration: reduced ? 0 : 0.55, ease: 'expo.out' },
        )
      } else {
        gsap.to(el, { autoAlpha: 0, x: 20, skewX: 12, duration: reduced ? 0 : 0.18, ease: 'power2.in' })
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

        <div ref={rigRef} className="pull-rig">
          <div ref={readoutRef} className="pull-readout">
            <div className="pull-cell pull-speed">
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
                    <span key={z} className={z === 5 ? 'is-elite' : ''} style={{ '--at': `${(z / MAX_V) * 100}%` }}>
                      {z === 5 ? '5.0 Elite' : z.toFixed(1)}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <dl className="pull-stats">
              <div className="pull-cell pull-stat">
                <dt className="mono">Peak</dt>
                <dd>
                  <span ref={peakRef} className="d tnum pull-num">
                    0.00
                  </span>
                  <span className="mono pull-unit">m/s</span>
                </dd>
              </div>
              <div className="pull-cell pull-stat">
                <dt className="mono">Distance</dt>
                <dd>
                  <span ref={distRef} className="d tnum pull-num">
                    0.0
                  </span>
                  <span className="mono pull-unit">m</span>
                </dd>
              </div>
              <div className="pull-cell pull-stat pull-best">
                <dt className="mono">Your best</dt>
                <dd>
                  <Odometer value={best} decimals={2} className="d pull-num" />
                  <span className="mono pull-unit">m/s</span>
                </dd>
              </div>
              <div className="pull-cell pull-stat pull-rate">
                <dt className="mono">Rating</dt>
                <dd>
                  <span ref={ratingRef} className="d pull-rating" data-r="-1" aria-hidden="true">
                    {IDLE_WORD}
                  </span>
                  <span className="sr-only">{rateWord}</span>
                </dd>
              </div>
            </dl>
          </div>

          <div ref={trackWrapRef} className="pull-track-wrap">
            <div ref={trackRef} className="pull-track">
              <div ref={stageRef} className="pull-stage">
                <div ref={worldRef} className="pull-world" aria-hidden="true">
                  <div className="pull-bay" />
                  <div className="pull-mow" />
                  <div className="pull-runoff" />
                  <div className="pull-lane is-a" />
                  <div className="pull-lane is-b" />
                  <div className="pull-minor is-top" />
                  <div className="pull-minor is-bot" />
                  {[10, 20, 30].map((m) => (
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
                  <div className="pull-finish">
                    <span className="mono">Finish</span>
                  </div>
                  <div ref={trailRef} className="pull-trail" />
                  <div ref={flagRef} className="pull-flag">
                    <span className="pull-flag-in mono tnum">
                      Peak <b ref={flagTextRef}>0.00</b>
                    </span>
                  </div>
                </div>
                <div ref={smearRef} className="pull-smear" aria-hidden="true" />
                <canvas ref={canvasRef} className="pull-fx" aria-hidden="true" />
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
              <div className="pull-edge is-top" aria-hidden="true" />
              <div className="pull-edge is-bot" aria-hidden="true" />
              <div ref={stampRef} className="pull-stamp" aria-hidden="true">
                <span className="d">New best</span>
                <span ref={stampNoteRef} className="mono tnum">
                  First mark
                </span>
              </div>
            </div>
          </div>

          <div className="pull-map" aria-hidden="true">
            <div ref={mapRef} className="pull-map-bar">
              <div ref={mapWinRef} className="pull-map-win" />
              <div ref={mapFillRef} className="pull-map-fill" />
              <div ref={mapSledRef} className="pull-map-sled" />
            </div>
            <div className="pull-map-labels mono tnum">
              <span>0 m</span>
              <span>10</span>
              <span>20</span>
              <span>30 m</span>
            </div>
          </div>

          <div className="pull-controls">
            <p id="pull-help" className="pull-help mono">
              Drag the handle right, fast, and let go.{' '}
              <span className="pull-help-keys">Keyboard: hold → or Space to pull, Enter for one hard yank.</span>
            </p>
            <div ref={againRef} className="pull-again" inert={!done}>
              <SpeedButton variant="paper" size="sm" icon={false} onClick={onAgain}>
                Pull again
              </SpeedButton>
            </div>
          </div>
        </div>
        <p className="sr-only" aria-live="polite">
          {msg}
        </p>
      </div>
    </section>
  )
}
