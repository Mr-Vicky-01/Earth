import { useRef } from 'react'
import { gsap, useGSAP } from '../lib/gsap'

export function Preloader({ onDone }) {
  const ref = useRef(null)
  const num = useRef(null)

  useGSAP(
    () => {
      const counter = { v: 0 }
      const tl = gsap.timeline({ defaults: { ease: 'power4.out' } })
      tl.fromTo('.pre-char', { yPercent: 112 }, { yPercent: 0, duration: 1.1, stagger: 0.07 }, 0.15)
        .to(
          counter,
          {
            v: 100,
            duration: 2,
            ease: 'power2.inOut',
            onUpdate: () => {
              num.current.textContent = String(Math.round(counter.v)).padStart(3, '0')
            },
          },
          0,
        )
        .to('.preloader-bar i', { scaleX: 1, duration: 2, ease: 'power2.inOut' }, 0)
        .to('.pre-char', { yPercent: -112, duration: 0.7, stagger: 0.04, ease: 'power3.in' }, '-=0.35')
        .to('.pre-meta', { opacity: 0, duration: 0.4 }, '<')
        .call(onDone, [], '-=0.1')
        .to(ref.current, { yPercent: -100, duration: 1, ease: 'power4.inOut' }, '-=0.2')
        .set(ref.current, { display: 'none' })
    },
    { scope: ref },
  )

  return (
    <div ref={ref} className="preloader" aria-hidden="true">
      <div className="pre-meta flex items-start justify-between">
        <span className="label">Loading experience</span>
        <span className="label">Forge © 2026</span>
      </div>
      <div className="flex items-end justify-between gap-6">
        <div className="preloader-word display">
          {'FORGE'.split('').map((c, i) => (
            <span key={i} className="line-mask">
              <span className="pre-char">{c}</span>
            </span>
          ))}
        </div>
        <span ref={num} className="preloader-count pre-meta">
          000
        </span>
      </div>
      <div className="preloader-bar">
        <i />
      </div>
    </div>
  )
}
