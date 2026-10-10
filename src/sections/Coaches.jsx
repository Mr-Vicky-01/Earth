import { useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, finePointer, reducedMotion } from '../lib/gsap'
import { useSectionEdge } from '../lib/useSectionEdge'
import { SlamText } from '../ui/SlamText'
import { Reveal } from '../ui/Reveal'
import { Plus } from '../ui/Icons'
import { Chars } from '../ui/Chars'
import './coaches.css'

const COACHES = [
  {
    name: 'Maya Okonkwo',
    role: 'Head of strength',
    floor: 'Velocity Lab',
    num: '182.5 kg',
    numLabel: 'Back squat',
    years: 12,
    quote: 'If the bar slows down, we stop. That one rule fixed more lifters than any program I ever wrote.',
    bg: 'var(--color-cobalt)',
  },
  {
    name: 'Dante Reyes',
    role: 'Conditioning lead',
    floor: 'Engine Room',
    num: '6:02',
    numLabel: '2,000 m row',
    years: 9,
    quote: 'Pace is a skill. We practise it like a lift, with numbers on the screen and no guessing.',
    bg: 'var(--color-heat)',
  },
  {
    name: 'Ingrid Solberg',
    role: 'Recovery and mobility',
    floor: 'Recovery Deck',
    num: '11 yrs',
    numLabel: 'Sports physio',
    years: 11,
    quote: 'Fast athletes recover on purpose. The slow work is what lets you come back tomorrow and move well.',
    bg: 'var(--color-ink-3)',
  },
  {
    name: 'Kai Nakamura',
    role: 'Striking coach',
    floor: 'Fight Floor',
    num: '3×',
    numLabel: 'National champion',
    years: 8,
    quote: 'Fast hands come from loose shoulders. Speed shows up once you stop forcing it.',
    bg: 'var(--color-cobalt-deep)',
  },
  {
    name: 'Ama Mensah',
    role: 'Sprint and plyometrics',
    floor: 'Velocity Lab',
    num: '10.94 s',
    numLabel: '100 m',
    years: 7,
    quote: 'Start fast, stay tall, finish faster. We film every start and fix one thing at a time.',
    bg: 'var(--color-heat)',
  },
]

const initials = (n) =>
  n
    .split(' ')
    .map((p) => p[0])
    .join('')

function Card({ c }) {
  const dark = c.bg.includes('heat') ? 'var(--color-ink)' : 'var(--color-paper)'
  return (
    <div className="coach-card" style={{ background: c.bg, color: dark }}>
      <div className="coach-card-lines" />
      <span className="coach-card-mark d outline" style={{ '--fg': dark }}>
        {initials(c.name)}
      </span>
      <div className="relative flex items-start justify-between gap-3">
        <span className="mono">{c.floor}</span>
        <span className="mono tnum">{c.years} yrs coaching</span>
      </div>
      <div className="relative flex flex-col gap-3">
        <span className="d text-[2.6rem] leading-[0.9]">{c.num}</span>
        <span className="mono">{c.numLabel}</span>
        <p className="text-[0.92rem] leading-snug">“{c.quote}”</p>
      </div>
    </div>
  )
}

export function Coaches() {
  const ref = useRef(null)
  const float = useRef(null)
  const strip = useRef(null)
  const [openIdx, setOpenIdx] = useState(-1)
  const [fine] = useState(() => finePointer())
  useSectionEdge(ref)

  // cursor-chasing card: position lerps toward the pointer, rotation and skew follow pointer velocity,
  // content strip slides to the hovered coach.
  useEffect(() => {
    if (!fine) return
    const f = float.current
    const list = ref.current.querySelector('.coach-list')
    const still = reducedMotion()
    let x = 0
    let y = 0
    let cx = 0
    let cy = 0
    let raf = 0
    let on = false
    let idx = -1
    const show = gsap.quickTo(f, 'opacity', { duration: 0.25, ease: 'power2.out' })
    const scale = gsap.quickTo(f, 'scale', { duration: 0.45, ease: 'expo.out' })
    gsap.set(f, { scale: 0.6, xPercent: -50, yPercent: -50 })

    const loop = () => {
      const dx = x - cx
      const dy = y - cy
      cx += dx * (still ? 1 : 0.16)
      cy += dy * (still ? 1 : 0.16)
      const rot = still ? 0 : gsap.utils.clamp(-14, 14, dx * 0.06)
      const sk = still ? 0 : gsap.utils.clamp(-10, 10, -dx * 0.03)
      gsap.set(f, { x: cx + 40, y: cy, rotation: rot, skewX: sk })
      raf = on || Math.abs(dx) + Math.abs(dy) > 0.5 ? requestAnimationFrame(loop) : 0
    }
    const move = (e) => {
      x = e.clientX
      y = e.clientY
      const row = e.target.closest?.('.coach-row')
      const i = row ? Number(row.dataset.i) : -1
      if (i >= 0 && i !== idx) {
        if (idx === -1) {
          cx = x
          cy = y
        }
        idx = i
        gsap.to(strip.current, { yPercent: (-100 / COACHES.length) * i, duration: still ? 0 : 0.55, ease: 'expo.out', overwrite: true })
      }
      if (!on && i >= 0) {
        on = true
        show(1)
        scale(1)
      }
      if (!raf) raf = requestAnimationFrame(loop)
    }
    const leave = () => {
      on = false
      idx = -1
      show(0)
      scale(0.6)
    }
    list.addEventListener('pointermove', move)
    list.addEventListener('pointerleave', leave)
    return () => {
      cancelAnimationFrame(raf)
      list.removeEventListener('pointermove', move)
      list.removeEventListener('pointerleave', leave)
    }
  }, [fine])

  useGSAP(
    () => {
      if (reducedMotion()) return
      gsap.utils.toArray('.coach-row').forEach((row, i) => {
        const chars = row.querySelectorAll('.coach-name-base .ch')
        gsap.set(chars, { x: 0, xPercent: i % 2 ? 160 : -160, scaleX: 1.8, skewX: i % 2 ? 28 : -28, opacity: 0, transformOrigin: i % 2 ? '100% 60%' : '0% 60%' })
        gsap.set(row.querySelectorAll('.coach-meta'), { x: i % 2 ? -40 : 40, opacity: 0 })
        gsap.to(chars, {
          x: 0,
          xPercent: 0,
          scaleX: 1,
          skewX: 0,
          opacity: 1,
          duration: 0.75,
          stagger: i % 2 ? { each: 0.02, from: 'end' } : 0.02,
          ease: 'expo.out',
          scrollTrigger: { trigger: row, start: 'top 92%', once: true },
        })
        gsap.to(row.querySelectorAll('.coach-meta'), {
          x: 0,
          opacity: 1,
          duration: 0.7,
          stagger: 0.05,
          delay: 0.15,
          scrollTrigger: { trigger: row, start: 'top 92%', once: true },
        })
      })
    },
    { scope: ref },
  )

  return (
    <section id="coaches" ref={ref} className="sec s-paper cut pad">
      <div className="wrap">
        <div className="mb-[clamp(3rem,6vw,5rem)] grid gap-8 lg:grid-cols-12 lg:items-end">
          <div className="flex flex-col gap-6 lg:col-span-8">
            <Reveal>
              <span className="tag">The pace setters</span>
            </Reveal>
            <SlamText className="d t-xl" lines={['Coached', { text: 'at speed.', className: 'outline' }]} />
          </div>
          <Reveal as="p" from="right" className="lead lg:col-span-4">
            Five coaches run the floor at every peak hour. Each one competes or has competed, and each one reads velocity data for
            a living.
          </Reveal>
        </div>

        <div className="coach-list">
          {COACHES.map((c, i) => (
            <div key={c.name}>
              <button
                type="button"
                className={`coach-row ${openIdx === i ? 'is-open' : ''}`}
                data-i={i}
                aria-expanded={openIdx === i}
                aria-controls={`coach-detail-${i}`}
                onClick={() => setOpenIdx((o) => (o === i ? -1 : i))}
              >
                <span className="coach-name d">
                  <span className="coach-name-base">
                    <Chars text={c.name} />
                  </span>
                  <span className="coach-name-fill" aria-hidden="true">
                    {c.name}
                  </span>
                </span>
                <span className="coach-role coach-meta">
                  <span className="mono">{c.role}</span>
                  <span className="mono mute">{c.floor}</span>
                </span>
                <span className="coach-num coach-meta">
                  <span className="d tnum">{c.num}</span>
                  <span className="mono mute">{c.numLabel}</span>
                </span>
                <span className="coach-plus coach-meta" aria-hidden="true">
                  <Plus />
                </span>
              </button>
              <div id={`coach-detail-${i}`} className={`coach-detail ${openIdx === i ? 'is-open' : ''}`}>
                <div>
                  <div className="grid gap-4 pb-6 pt-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:items-start">
                    <div className="flex items-baseline gap-3">
                      <span className="d t-md text-cobalt tnum">{c.num}</span>
                      <span className="mono mute">
                        {c.numLabel} · {c.years} yrs coaching
                      </span>
                    </div>
                    <p className="lead max-w-[48ch]">“{c.quote}”</p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {fine && (
        <div ref={float} className="coach-float" aria-hidden="true">
          <div className="absolute inset-0 overflow-hidden">
            <div ref={strip} className="coach-card-strip">
              {COACHES.map((c) => (
                <Card key={c.name} c={c} />
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
