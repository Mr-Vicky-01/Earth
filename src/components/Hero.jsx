import { useRef } from 'react'
import { gsap, useGSAP, ScrollTrigger } from '../lib/gsap'
import { useInView } from '../lib/useInView'
import { scrollToTarget } from '../lib/useSmoothScroll'
import { HeroScene } from './three/HeroScene'
import { Magnetic } from './ui/Magnetic'
import { ArrowUpRight, Play } from './ui/Icons'

const STATS = [
  ['12K+', 'Active members'],
  ['40+', 'Elite coaches'],
  ['24/7', 'Floor access'],
]

export function Hero({ ready }) {
  const root = useRef(null)
  const scrollRef = useRef(0)
  const inView = useInView(root)

  useGSAP(
    () => {
      ScrollTrigger.create({
        trigger: root.current,
        start: 'top top',
        end: 'bottom top',
        scrub: true,
        onUpdate: (self) => (scrollRef.current = self.progress),
      })
      gsap.to('.hero-content', {
        yPercent: 18,
        opacity: 0,
        ease: 'none',
        scrollTrigger: { trigger: root.current, start: 'top top', end: '75% top', scrub: true },
      })
    },
    { scope: root },
  )

  useGSAP(
    () => {
      if (!ready) return
      const tl = gsap.timeline({ defaults: { ease: 'power4.out' } })
      tl.to('.hero-canvas', { opacity: 1, scale: 1, duration: 1.8, ease: 'power2.out' }, 0)
        .fromTo('.hero-line > span', { yPercent: 112 }, { yPercent: 0, duration: 1.3, stagger: 0.1 }, 0.15)
        .to('.hero-fade', { opacity: 1, y: 0, duration: 1.1, stagger: 0.08 }, 0.55)
    },
    { scope: root, dependencies: [ready] },
  )

  return (
    <section id="top" ref={root} className="hero relative h-[100svh] min-h-[660px] overflow-hidden">
      <div className="hero-canvas absolute inset-0">
        <HeroScene scrollRef={scrollRef} active={inView} />
      </div>
      <div className="hero-glow" aria-hidden="true" />

      <div className="hero-content wrap relative z-10 flex h-full flex-col justify-end pb-8 md:pb-12">
        <div className="hero-fade label mb-5 flex items-center gap-3">
          <span className="pulse-dot" />
          Strength &amp; conditioning — Est. 2026
        </div>

        <h1 className="display hero-title">
          <span className="line-mask hero-line">
            <span>Forge your</span>
          </span>
          <span className="line-mask hero-line">
            <span className="text-acid">strongest</span>
          </span>
          <span className="line-mask hero-line">
            <span className="outline">self.</span>
          </span>
        </h1>

        <div className="mt-8 flex flex-col gap-8 md:mt-10 md:flex-row md:items-end md:justify-between">
          <p className="hero-fade max-w-md text-[0.98rem] leading-relaxed text-ash md:text-lg">
            Elite coaching, immersive training floors and a community that refuses to coast. This is where limits go to die.
          </p>
          <div className="hero-fade flex flex-wrap gap-3">
            <Magnetic>
              <a
                href="#pricing"
                className="btn btn-acid"
                onClick={(e) => {
                  e.preventDefault()
                  scrollToTarget('#pricing')
                }}
              >
                Start training <ArrowUpRight />
              </a>
            </Magnetic>
            <Magnetic>
              <a
                href="#method"
                className="btn btn-ghost"
                onClick={(e) => {
                  e.preventDefault()
                  scrollToTarget('#method')
                }}
              >
                <Play /> See the method
              </a>
            </Magnetic>
          </div>
        </div>

        <div className="hero-fade mt-10 grid grid-cols-3 gap-4 border-t border-white/10 pt-6 md:mt-14">
          {STATS.map(([n, l]) => (
            <div key={l}>
              <div className="stat-num">{n}</div>
              <div className="label mt-2">{l}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="hero-fade scroll-cue label absolute bottom-8 right-6 z-10 hidden md:flex" aria-hidden="true">
        Scroll <i />
      </div>
    </section>
  )
}
