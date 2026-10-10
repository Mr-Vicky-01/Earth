import { useRef, useState } from 'react'
import { gsap, useGSAP, reducedMotion } from '../lib/gsap'
import { useSectionEdge } from '../lib/useSectionEdge'
import { scrollToTarget } from '../lib/scroll'
import { SlamText } from '../ui/SlamText'
import { SpeedButton } from '../ui/SpeedButton'
import { Odometer } from '../ui/Odometer'
import { Reveal } from '../ui/Reveal'
import { Check } from '../ui/Icons'
import { ScrambleText } from '../ui/Scramble'
import './pricing.css'

const PLANS = [
  {
    key: 'warm',
    name: 'Warm-up',
    blurb: 'For getting started and showing up.',
    monthly: 49,
    annual: 39,
    cta: 'Start with Warm-up',
    variant: 'line',
    features: ['Open floor 6:00–22:00', 'Two coached sessions a week', 'Velocity tracking on every bar', 'Programming in the app'],
  },
  {
    key: 'main',
    name: 'Working set',
    blurb: 'The full floor. Most members pick this one.',
    monthly: 89,
    annual: 71,
    cta: 'Choose Working set',
    variant: 'heat',
    tag: 'Most picked',
    features: [
      'Unlimited coached sessions',
      'Velocity tracking and a monthly speed report',
      'Recovery Deck access',
      'Two guest passes a month',
      'Priority booking',
    ],
  },
  {
    key: 'max',
    name: 'Max effort',
    blurb: 'For people with a meet on the calendar.',
    monthly: 149,
    annual: 119,
    cta: 'Go Max effort',
    variant: 'ink',
    features: ['Everything in Working set', 'Four 1:1 coaching sessions a month', 'Nutrition programming', 'Competition prep and handling', '24/7 keycard'],
  },
]

export function Pricing() {
  const ref = useRef(null)
  const [annual, setAnnual] = useState(false)
  useSectionEdge(ref)

  useGSAP(
    () => {
      if (reducedMotion()) return
      const cards = gsap.utils.toArray('.price-card')
      gsap.set(cards, { xPercent: 120, skewX: -14, opacity: 0 })
      gsap.to(cards, {
        xPercent: 0,
        skewX: 0,
        opacity: 1,
        duration: 0.9,
        stagger: 0.09,
        ease: 'expo.out',
        clearProps: 'transform,opacity',
        scrollTrigger: { trigger: '.price-grid', start: 'top 85%', once: true },
      })
      cards.forEach((card) => {
        gsap.from(card.querySelectorAll('.price-feat li'), {
          x: 40,
          opacity: 0,
          duration: 0.6,
          stagger: 0.05,
          delay: 0.35,
          ease: 'expo.out',
          scrollTrigger: { trigger: '.price-grid', start: 'top 85%', once: true },
        })
      })
    },
    { scope: ref },
  )

  return (
    <section id="pricing" ref={ref} className="sec s-ink cut pad">
      <div className="wrap">
        <div className="mb-[clamp(3rem,6vw,5rem)] flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-6">
            <Reveal>
              <span className="tag">Membership</span>
            </Reveal>
            <SlamText className="d t-xl" lines={['Pick your', { text: 'pace.', className: 'outline' }]} />
          </div>
          <Reveal from="right" className="flex flex-col items-start gap-4 lg:items-end">
            <div className={`price-toggle ${annual ? 'is-annual' : ''}`} role="group" aria-label="Billing period">
              <span className="price-thumb" aria-hidden="true" />
              <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>
                Monthly
              </button>
              <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>
                Annual
              </button>
            </div>
            <span className="mono mute">Annual saves 20% · no contract on either</span>
          </Reveal>
        </div>

        <div className="price-grid">
          {PLANS.map((p) => (
            <article key={p.key} className={`price-card is-${p.key}`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="d text-[2.4rem] leading-[0.9]">{p.name}</h3>
                  <p className="mute mt-2 text-[0.95rem]">{p.blurb}</p>
                </div>
                {p.tag && (
                  <span className="tag is-solid shrink-0" style={{ '--accent': 'var(--color-heat)' }}>
                    {p.tag}
                  </span>
                )}
              </div>

              <div>
                <div className="flex items-end gap-3">
                  <span className="price-amount d tnum">
                    <Odometer value={annual ? p.annual : p.monthly} prefix="$" duration={1} />
                  </span>
                  <span className="mono mute mb-2">/ month</span>
                </div>
                <p className="mono mute mt-3 min-h-[1.2em]">
                  {annual ? <ScrambleText key="a" text={`Billed $${(p.annual * 12).toLocaleString('en-US')} once a year`} trigger="view" duration={420} /> : <ScrambleText key="m" text="Billed monthly · cancel any time" trigger="view" duration={420} />}
                </p>
              </div>

              <ul className="price-feat">
                {p.features.map((f) => (
                  <li key={f}>
                    <Check />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-2">
                <SpeedButton
                  href="#join"
                  variant={p.variant}
                  className="w-full"
                  onClick={(e) => {
                    e.preventDefault()
                    scrollToTarget('#join')
                  }}
                >
                  {p.cta}
                </SpeedButton>
              </div>
            </article>
          ))}
        </div>

        <p className="mono mute mt-8">No contract. Cancel in the app. Annual plans are billed once and renew yearly.</p>
      </div>
    </section>
  )
}
