import { useRef } from 'react'
import { gsap, useGSAP } from '../lib/gsap'
import { Reveal } from './ui/Reveal'
import { Counter } from './ui/Counter'

const TEXT =
  'We don’t sell memberships. We build *athletes*. Every square metre of Forge is engineered for one thing: progressive overload — of your body, your mind and your *limits*.'

export function Manifesto() {
  const root = useRef(null)

  useGSAP(
    () => {
      gsap.to('.manifesto-text .w', {
        opacity: 1,
        stagger: 0.04,
        ease: 'none',
        scrollTrigger: { trigger: '.manifesto-text', start: 'top 78%', end: 'bottom 42%', scrub: true },
      })
    },
    { scope: root },
  )

  const words = TEXT.split(' ').map((w, i) => {
    const acid = w.startsWith('*')
    const clean = w.replace(/\*/g, '')
    return (
      <span key={i} className={`w ${acid ? 'is-acid' : ''}`}>
        {clean}
      </span>
    )
  })

  return (
    <section id="about" ref={root} className="section">
      <div className="wrap grid gap-10 md:grid-cols-12">
        <div className="md:col-span-3">
          <Reveal>
            <span className="label eyebrow">01 — The philosophy</span>
          </Reveal>
        </div>
        <div className="md:col-span-9">
          <p className="manifesto-text display">{words}</p>

          <div className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-3 md:mt-24">
            {[
              { to: 12400, suffix: '+', label: 'Members training weekly' },
              { to: 98, suffix: '%', label: 'Twelve-month retention' },
              { to: 4.9, decimals: 1, label: 'Average member rating' },
            ].map((s, i) => (
              <Reveal key={s.label} delay={i * 0.1} className="border-t border-white/10 pt-6">
                <Counter {...s} className="stat-num block" />
                <span className="label mt-3 block">{s.label}</span>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
