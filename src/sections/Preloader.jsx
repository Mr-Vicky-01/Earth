import { useRef } from 'react'
import { gsap, useGSAP, reducedMotion } from '../lib/gsap'
import { Chars } from '../ui/Chars'
import './chrome.css'

/**
 * Loader as a rep: the wordmark slams in while a bar-speed readout accelerates 0.00 → 1.30 m/s,
 * then five colour bands shoot across the screen and pull away to reveal the hero. ≈2 s. Click to skip.
 */
export function Preloader({ onDone }) {
  const root = useRef(null)
  const read = useRef(null)
  const done = useRef(false)

  const finish = () => {
    if (done.current) return
    done.current = true
    onDone?.()
  }

  const { contextSafe } = useGSAP(
    () => {
      const el = root.current
      if (reducedMotion()) {
        read.current.textContent = '1.30'
        gsap.to(el, { autoAlpha: 0, duration: 0.4, delay: 0.5, onStart: finish, onComplete: () => gsap.set(el, { display: 'none' }) })
        return
      }
      const counter = { v: 0 }
      const tl = gsap.timeline()
      tl.from('.chr-pre-word .ch', {
        xPercent: -160,
        scaleX: 2,
        skewX: -30,
        opacity: 0,
        transformOrigin: '0% 60%',
        duration: 0.7,
        stagger: 0.045,
        ease: 'expo.out',
      })
        .from('.chr-pre-meta', { x: -40, opacity: 0, duration: 0.5, stagger: 0.05 }, 0.1)
        .to(
          counter,
          {
            v: 1.3,
            duration: 1.15,
            ease: 'power2.in',
            onUpdate: () => {
              read.current.textContent = counter.v.toFixed(2)
            },
          },
          0.05,
        )
        .to('.chr-pre-bar i', { scaleX: 1, duration: 1.15, ease: 'power2.in' }, 0.05)
        .to('.chr-pre-bands i', { scaleX: 1, duration: 0.42, stagger: 0.045, ease: 'power4.in' }, 1.05)
        .set('.chr-pre-inner', { autoAlpha: 0 })
        .set(el, { backgroundColor: 'transparent' })
        .call(finish)
        .to('.chr-pre-bands i', { scaleX: 0, transformOrigin: '100% 50%', duration: 0.6, stagger: 0.05, ease: 'power4.out' })
        .set(el, { display: 'none' })
      tl.timeScale(1)
      root.current._tl = tl
    },
    { scope: root },
  )

  const skip = contextSafe(() => {
    const tl = root.current?._tl
    if (tl && tl.progress() < 0.7) tl.timeScale(3.5)
  })

  return (
    <div ref={root} className="chr-pre" onClick={skip} role="presentation">
      <div className="chr-pre-inner">
        <div className="flex items-start justify-between gap-6">
          <span className="chr-pre-meta mono" style={{ color: 'var(--color-mute-ink)' }}>
            Calibrating bar sensors
          </span>
          <span className="chr-pre-meta mono" style={{ color: 'var(--color-mute-ink)' }}>
            Velocity lab · 2026
          </span>
        </div>
        <div className="flex flex-col gap-6">
          <div className="chr-pre-word d" style={{ '--w': 82 }} aria-label="Forge">
            <Chars text="FORGE" />
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <span className="chr-pre-meta mono" style={{ color: 'var(--color-mute-ink)' }}>
              Bar speed · mean concentric velocity
            </span>
            <span className="chr-pre-read d tnum" style={{ '--w': 70 }}>
              <span ref={read}>0.00</span>
              <span className="mono ml-3 align-top text-[0.8rem] not-italic" style={{ color: 'var(--color-paper)' }}>
                m/s
              </span>
            </span>
          </div>
          <div className="chr-pre-bar">
            <i />
          </div>
        </div>
      </div>
      <div className="chr-pre-bands" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  )
}
