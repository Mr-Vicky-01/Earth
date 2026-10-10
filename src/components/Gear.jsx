import { useRef } from 'react'
import { gsap, useGSAP } from '../lib/gsap'
import { useInView } from '../lib/useInView'
import { GearScene, PLATES, PLATE_WINDOWS } from './three/GearScene'

const STEPS = [
  {
    n: '01',
    title: 'Load',
    copy: 'Every plate is a promise. Our coaches program progressive overload down to the kilo, so you walk in heavier than you did last week.',
  },
  {
    n: '02',
    title: 'Brace',
    copy: 'Technique is the multiplier. Film review, tempo work and cueing that actually sticks — before the weight goes up.',
  },
  {
    n: '03',
    title: 'Lift',
    copy: 'Then you move it. On platforms built to take it, in a room that wants you to win.',
  },
]

const BAR_KG = 20

function readoutFor(progress) {
  let loaded = 0
  let kg = BAR_KG
  PLATES.forEach((p, i) => {
    const w = PLATE_WINDOWS[i]
    if (progress >= w.start + w.dur) {
      loaded += 2
      kg += p.kg * 2
    }
  })
  return { loaded, kg }
}

export function Gear() {
  const root = useRef(null)
  const progress = useRef(0)
  const readouts = useRef([])
  const inView = useInView(root, '0px')

  useGSAP(
    () => {
      const steps = gsap.utils.toArray('.gear-step')
      gsap.set(steps[0], { autoAlpha: 1 })

      const paint = (p) => {
        progress.current = p
        const { loaded, kg } = readoutFor(p)
        readouts.current.forEach((el) => {
          if (el) el.innerHTML = `Loaded <b>${loaded} / 6</b> plates &nbsp;·&nbsp; <b>${kg} kg</b>`
        })
      }
      paint(0)

      gsap
        .timeline({
          scrollTrigger: {
            trigger: root.current,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 0.6,
            onUpdate: (self) => paint(self.progress),
          },
        })
        .to({}, { duration: 0.28 })
        .to(steps[0], { autoAlpha: 0, y: -40, duration: 0.08 })
        .fromTo(steps[1], { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.08 })
        .to({}, { duration: 0.2 })
        .to(steps[1], { autoAlpha: 0, y: -40, duration: 0.08 })
        .fromTo(steps[2], { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.08 })
        .to({}, { duration: 0.2 })

      gsap.to('.gear-rail i', {
        scaleY: 1,
        ease: 'none',
        scrollTrigger: { trigger: root.current, start: 'top top', end: 'bottom bottom', scrub: true },
      })
    },
    { scope: root },
  )

  return (
    <section id="method" ref={root} className="gear relative">
      <div className="gear-stage">
        <div className="absolute inset-0">
          <GearScene progressRef={progress} active={inView} />
        </div>
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: 'linear-gradient(90deg, rgba(5,5,5,.92) 0%, rgba(5,5,5,.55) 38%, rgba(5,5,5,0) 62%)' }}
          aria-hidden="true"
        />

        <div className="wrap pointer-events-none relative flex h-full flex-col justify-between py-24 md:py-28">
          <div className="flex items-center justify-between gap-6">
            <span className="label eyebrow">03 — The method</span>
            <span ref={(el) => (readouts.current[0] = el)} className="readout hidden md:block" />
          </div>

          <div className="relative mt-10 min-h-[22rem] flex-1">
            <div className="gear-rail absolute bottom-0 left-0 top-0 hidden md:block">
              <i />
            </div>
            {STEPS.map((s) => (
              <div key={s.n} className="gear-step flex max-w-xl flex-col justify-center md:pl-10">
                <span className="label mb-4">Step {s.n} / 03</span>
                <h3 className="display">{s.title}</h3>
                <p className="mt-6 max-w-md text-ash md:text-lg md:leading-relaxed">{s.copy}</p>
              </div>
            ))}
          </div>

          <span ref={(el) => (readouts.current[1] = el)} className="readout md:hidden" />
        </div>
      </div>
    </section>
  )
}
