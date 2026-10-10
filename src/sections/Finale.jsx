import { useEffect, useRef, useState } from 'react'
import { gsap, useGSAP, finePointer, reducedMotion } from '../lib/gsap'
import { scroll, scrollToTarget } from '../lib/scroll'
import { useSectionEdge } from '../lib/useSectionEdge'
import { useInView } from '../lib/useInView'
import { SlamText } from '../ui/SlamText'
import { SpeedButton } from '../ui/SpeedButton'
import { Reveal } from '../ui/Reveal'
import { RollText } from '../ui/RollText'
import { LINKS } from './Nav'
import './finale.css'

const EMAIL = 'hello@forge.gym'

/** Radial warp lines on a 2D canvas. The vanishing point eases toward the cursor; speed follows scroll + boost. */
function useWarp(canvasRef, active, boostRef, glowRef) {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !active) return
    const ctx = canvas.getContext('2d')
    const still = reducedMotion()
    const N = window.innerWidth < 700 ? 200 : 420
    let w = 0
    let h = 0
    let dpr = 1
    const stars = Array.from({ length: N }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), s: 0.4 + Math.random() * 0.8, hot: Math.random() < 0.14 }))
    const vp = { x: 0.62, y: 0.5, tx: 0.62, ty: 0.5 }
    let speed = 0.35
    let raf = 0
    let last = performance.now()

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    const move = (e) => {
      const r = canvas.getBoundingClientRect()
      vp.tx = gsap.utils.clamp(0.15, 0.85, (e.clientX - r.left) / r.width)
      vp.ty = gsap.utils.clamp(0.15, 0.85, (e.clientY - r.top) / r.height)
    }
    if (finePointer()) window.addEventListener('pointermove', move, { passive: true })

    const draw = (now) => {
      const dt = Math.min(50, now - last) / 1000
      last = now
      vp.x += (vp.tx - vp.x) * 0.06
      vp.y += (vp.ty - vp.y) * 0.06
      const target = 0.32 + scroll.abs * 1.8 + boostRef.current * 2.6
      speed += (target - speed) * 0.08
      if (glowRef.current) {
        glowRef.current.style.setProperty('--gx', `${(vp.x * 100).toFixed(1)}%`)
        glowRef.current.style.setProperty('--gy', `${(vp.y * 100).toFixed(1)}%`)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const cx = vp.x * w
      const cy = vp.y * h
      const maxR = Math.hypot(w, h) * 0.75
      ctx.lineCap = 'round'
      for (const st of stars) {
        if (!still) st.r += dt * speed * st.s * (0.25 + st.r * 1.6)
        if (st.r > 1) {
          st.r = 0.02 + Math.random() * 0.05
          st.a = Math.random() * Math.PI * 2
        }
        const r0 = st.r * maxR
        const len = Math.min(maxR * 0.55, 10 + speed * 95 * st.r * st.s)
        const cos = Math.cos(st.a)
        const sin = Math.sin(st.a)
        ctx.strokeStyle = st.hot ? `rgba(255,75,31,${0.45 + st.r * 0.55})` : `rgba(239,238,233,${0.14 + st.r * 0.7})`
        ctx.lineWidth = (st.hot ? 2.4 : 1.5) * (0.4 + st.r)
        ctx.beginPath()
        ctx.moveTo(cx + cos * r0, cy + sin * r0)
        ctx.lineTo(cx + cos * (r0 + len), cy + sin * (r0 + len))
        ctx.stroke()
      }
      if (!still) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('pointermove', move)
    }
  }, [canvasRef, active, boostRef, glowRef])
}

/** FORGE wordmark: each letter widens and heats up as the cursor approaches (variable font width). */
function useProximityWord(wordRef, active) {
  useEffect(() => {
    const el = wordRef.current
    if (!el || !active) return
    const letters = Array.from(el.children)
    const fine = finePointer()
    const still = reducedMotion()
    let px = -9999
    let py = -9999
    let raf = 0
    let centers = []
    const vals = letters.map(() => 70)
    const measure = () => {
      centers = letters.map((l) => {
        const r = l.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })
    }
    const move = (e) => {
      px = e.clientX
      py = e.clientY
    }
    let frame = 0
    const loop = (t) => {
      if (frame++ % 20 === 0) measure()
      letters.forEach((l, i) => {
        let target = 66
        if (fine) {
          const d = Math.hypot(px - centers[i].x, (py - centers[i].y) * 1.6)
          target = 62 + 63 * Math.max(0, 1 - d / 520)
        } else {
          target = 70 + 40 * (0.5 + 0.5 * Math.sin(t / 600 - i * 0.7))
        }
        vals[i] += (target - vals[i]) * 0.12
        l.style.setProperty('--w', vals[i].toFixed(1))
        l.classList.toggle('is-hot', vals[i] > 108)
      })
      raf = requestAnimationFrame(loop)
    }
    window.addEventListener('pointermove', move, { passive: true })
    if (!still) raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', move)
    }
  }, [wordRef, active])
}

export function Finale() {
  const cta = useRef(null)
  const canvas = useRef(null)
  const glow = useRef(null)
  const word = useRef(null)
  const foot = useRef(null)
  const boost = useRef(0)
  const [copied, setCopied] = useState(false)
  const ctaIn = useInView(cta)
  const footIn = useInView(foot)
  useSectionEdge(cta)
  useWarp(canvas, ctaIn, boost, glow)
  useProximityWord(word, footIn)

  useGSAP(
    () => {
      if (reducedMotion()) return
      gsap.from('.fin-word span', {
        yPercent: 100,
        skewX: -20,
        opacity: 0,
        duration: 0.9,
        stagger: 0.06,
        ease: 'expo.out',
        scrollTrigger: { trigger: '.fin-word', start: 'top 95%', once: true },
      })
    },
    { scope: foot },
  )

  const hyper = (on) => () => gsap.to(boost, { current: on ? 1 : 0, duration: on ? 0.5 : 0.9, ease: on ? 'power2.out' : 'power2.inOut' })

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(EMAIL)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      const r = document.createRange()
      const node = document.getElementById('fin-email')
      if (node) {
        r.selectNodeContents(node)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(r)
      }
    }
  }

  const go = (href) => (e) => {
    e.preventDefault()
    scrollToTarget(href)
  }

  return (
    <>
      <section id="join" ref={cta} className="sec s-cobalt cut fin-cta pad">
        <canvas ref={canvas} className="fin-canvas" aria-hidden="true" />
        <div ref={glow} className="fin-glow" aria-hidden="true" />
        <div className="wrap flex flex-col gap-8">
          <Reveal>
            <span className="tag">
              <span className="live-dot" /> Free first week
            </span>
          </Reveal>
          <SlamText as="h2" className="d t-xl" stretch gain={30} lines={["First week's", { text: 'on us.', className: 'outline' }]} />
          <Reveal as="p" className="lead" delay={0.1}>
            Seven days, every floor, every class. We measure your first session and build your plan from the numbers. No card needed.
          </Reveal>
          <Reveal delay={0.18} className="flex flex-wrap gap-3" onMouseEnter={hyper(true)} onMouseLeave={hyper(false)}>
            <SpeedButton href="#pricing" variant="heat" onClick={go('#pricing')} onFocus={hyper(true)} onBlur={hyper(false)}>
              Claim your free week
            </SpeedButton>
            <SpeedButton href="#pull" variant="line" onClick={go('#pull')}>
              Try the sled pull
            </SpeedButton>
          </Reveal>
        </div>
      </section>

      <footer ref={foot} className="sec s-ink fin-foot">
        <div className="wrap grid gap-12 md:grid-cols-12">
          <div className="flex flex-col gap-5 md:col-span-5">
            <span className="mono mute">Talk to a coach</span>
            <button type="button" className={`fin-copy roll-host ${copied ? 'is-done' : ''}`} onClick={copy} aria-label={`Copy email address ${EMAIL}`}>
              <span id="fin-email">{EMAIL}</span>
              <span className="mono">{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <span className="mono mute tnum">+1 (555) 010-3674</span>
          </div>
          <div className="fin-col md:col-span-2">
            <h3 className="mono mute">Explore</h3>
            <ul className="flex flex-col gap-1">
              {LINKS.map(([label, href]) => (
                <li key={href}>
                  <a href={href} className="fin-link roll-host" onClick={go(href)}>
                    <RollText>{label}</RollText>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="fin-col md:col-span-2">
            <h3 className="mono mute">Floors</h3>
            <ul className="flex flex-col gap-1 text-[1rem]">
              <li>Velocity Lab</li>
              <li>Engine Room</li>
              <li>Recovery Deck</li>
              <li>Fight Floor</li>
            </ul>
          </div>
          <div className="fin-col md:col-span-3">
            <h3 className="mono mute">Visit</h3>
            <p>88 Foundry Street</p>
            <p>District 9, 10110</p>
            <p className="mono mute mt-4">Floor open 24/7</p>
            <p className="mono mute">Coaches 05:30–22:00</p>
          </div>
        </div>

        <div className="wrap">
          <div ref={word} className="fin-word d" aria-hidden="true">
            {'FORGE'.split('').map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          </div>
        </div>

        <div className="fin-bottom mt-6">
          <div className="wrap flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
            <span className="mono mute">© 2026 FORGE Velocity Gym</span>
            <span className="mono mute">Instagram · TikTok · YouTube · Strava — @forgevelocity</span>
            <button type="button" className="mono roll-host text-left" onClick={go('#top')}>
              <RollText>Back to top ↑</RollText>
            </button>
          </div>
        </div>
      </footer>
    </>
  )
}
