import { useEffect, useRef, useState } from 'react'
import { gsap } from '../lib/gsap'
import { Reveal } from './ui/Reveal'
import { Heading } from './ui/Heading'
import { Magnetic } from './ui/Magnetic'
import { ArrowUpRight, Check } from './ui/Icons'

const TIERS = [
  {
    name: 'Day One',
    blurb: 'For getting started and showing up.',
    monthly: 49,
    annual: 39,
    features: ['Open-gym access', '2 coached classes / week', 'App programming', 'Locker room & towels'],
  },
  {
    name: 'Forged',
    blurb: 'The full floor. The one most people pick.',
    monthly: 89,
    annual: 71,
    featured: true,
    features: [
      'Unlimited coached classes',
      'Monthly coach check-in',
      'Recovery suite access',
      '2 guest passes / month',
      'Priority booking',
    ],
  },
  {
    name: 'Elite',
    blurb: 'For people with a date on the calendar.',
    monthly: 149,
    annual: 119,
    features: ['Everything in Forged', '4 × 1:1 coaching / month', 'Nutrition programming', 'Competition prep', '24/7 keycard'],
  },
]

function Price({ value }) {
  const ref = useRef(null)
  const current = useRef(value)
  useEffect(() => {
    const obj = { v: current.current }
    gsap.to(obj, {
      v: value,
      duration: 0.7,
      ease: 'power3.out',
      onUpdate: () => {
        ref.current.textContent = Math.round(obj.v)
      },
    })
    current.current = value
  }, [value])
  return <span ref={ref}>{value}</span>
}

export function Pricing() {
  const [annual, setAnnual] = useState(false)

  return (
    <section id="pricing" className="section">
      <div className="wrap">
        <div className="mb-12 flex flex-col gap-8 md:mb-16 md:flex-row md:items-end md:justify-between">
          <div>
            <Reveal>
              <span className="label eyebrow">05 — Membership</span>
            </Reveal>
            <Heading
              className="mt-6 text-[clamp(3.8rem,9vw,9.5rem)]"
              lines={['No contracts.', <span className="outline">No excuses.</span>]}
            />
          </div>
          <Reveal className="flex flex-col items-start gap-4 md:items-end">
            <div className={`toggle glass ${annual ? 'annual' : ''}`} role="group" aria-label="Billing period">
              <span className="thumb" aria-hidden="true" />
              <button type="button" className={!annual ? 'is-on' : ''} onClick={() => setAnnual(false)} aria-pressed={!annual}>
                Monthly
              </button>
              <button type="button" className={annual ? 'is-on' : ''} onClick={() => setAnnual(true)} aria-pressed={annual}>
                Annual
              </button>
            </div>
            <span className="label">Save 20% on annual · cancel anytime</span>
          </Reveal>
        </div>

        <div className="grid gap-4 md:grid-cols-3 md:gap-5">
          {TIERS.map((t, i) => (
            <Reveal key={t.name} delay={i * 0.1} className="flex">
              <article className={`card price-card w-full ${t.featured ? 'featured' : ''}`} data-cursor="Join">
                <div className="relative flex items-start justify-between">
                  <div>
                    <h3 className="display text-4xl">{t.name}</h3>
                    <p className={`mt-2 text-sm ${t.featured ? 'text-ink/70' : 'text-ash'}`}>{t.blurb}</p>
                  </div>
                  {t.featured && <span className="chip border-ink/20 text-ink">Most popular</span>}
                </div>

                <div className="relative flex items-end gap-2">
                  <span className="price">
                    $<Price value={annual ? t.annual : t.monthly} />
                  </span>
                  <span className="label mb-2">/ month</span>
                </div>

                <ul className="relative flex flex-col gap-3">
                  {t.features.map((f) => (
                    <li key={f} className="flex items-center gap-3 text-sm">
                      <span className="check">
                        <Check />
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>

                <div className="relative mt-auto">
                  <Magnetic className="w-full">
                    <a
                      href="#top"
                      className={`btn w-full justify-center ${t.featured ? 'btn-dark' : 'btn-ghost'}`}
                      onClick={(e) => e.preventDefault()}
                    >
                      Choose {t.name} <ArrowUpRight />
                    </a>
                  </Magnetic>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
