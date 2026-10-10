import { useRef } from 'react'
import { scroll, PX_TO_M } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { reducedMotion } from '../lib/gsap'
import './chrome.css'

const SEGMENTS = 12
// thin vertical lanes near both edges: [left/right position, width px, dash length, period, speed factor]
const LANES = [
  ['left', '0.9%', 2, 120, 210, 1],
  ['left', '2.2%', 1, 70, 160, 1.45],
  ['left', '3.4%', 1, 160, 300, 0.8],
  ['right', '0.9%', 2, 110, 230, 1.1],
  ['right', '2.3%', 1, 80, 150, 1.6],
  ['right', '3.5%', 1, 140, 280, 0.75],
]

/**
 * Fixed scroll-speed readout (your scroll, in metres per second, using the CSS reference pixel) with a
 * segmented meter and session peak, plus a heat progress bar across the top of the page.
 */
export function Hud({ ready }) {
  const hud = useRef(null)
  const speed = useRef(null)
  const peak = useRef(null)
  const meter = useRef(null)
  const bar = useRef(null)
  const streaks = useRef(null)
  const state = useRef({ last: 0, peak: 0, shown: '', seg: -1, off: 0, op: 0 })
  const still = reducedMotion()

  useTicker((t, dt) => {
    const s = state.current
    if (bar.current) bar.current.style.transform = `scaleX(${scroll.progress.toFixed(4)})`
    if (streaks.current && !still) {
      // streaks rush opposite to scroll direction; only show above a speed threshold
      const target = Math.max(0, (scroll.abs - 0.25) / 0.75)
      s.op += (target - s.op) * 0.2
      s.off -= scroll.smooth * 2.2 * (Math.min(dt, 50) / 16.667)
      const op = s.op < 0.01 ? 0 : s.op * 0.85
      streaks.current.style.opacity = op.toFixed(3)
      if (op > 0) {
        const lanes = streaks.current.children
        for (let i = 0; i < lanes.length; i++) lanes[i].style.backgroundPosition = `0 ${(s.off * LANES[i][5]).toFixed(1)}px`
      }
    }
    if (t - s.last < 0.05) return
    s.last = t
    const ms = Math.abs(scroll.smooth) * 60 * PX_TO_M
    if (ms > s.peak) {
      s.peak = ms
      if (peak.current) peak.current.textContent = ms.toFixed(2)
    }
    const txt = ms.toFixed(2)
    if (txt !== s.shown && speed.current) {
      s.shown = txt
      speed.current.textContent = txt
      hud.current?.classList.toggle('is-fast', ms > 0.6)
    }
    const lit = Math.round(Math.min(1, ms / 1.6) * SEGMENTS)
    if (lit !== s.seg && meter.current) {
      s.seg = lit
      Array.from(meter.current.children).forEach((seg, i) => {
        seg.className = i < lit ? (i >= SEGMENTS - 4 ? 'hot' : 'on') : ''
      })
    }
  })

  return (
    <>
      <div ref={bar} className="chr-progress" aria-hidden="true" />
      <div ref={streaks} className="chr-streaks" aria-hidden="true">
        {LANES.map(([side, at, w, len, period], i) => (
          <i key={i} style={{ [side]: at, '--sw': `${w}px`, '--len': `${len}px`, '--period': `${period}px` }} />
        ))}
      </div>
      <div ref={hud} className={`chr-hud chr-plate ${ready ? 'is-in' : ''}`} aria-hidden="true">
        <span>Scroll</span>
        <span>
          <b ref={speed}>0.00</b> m/s
        </span>
        <span ref={meter} className="chr-meter">
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <i key={i} style={{ height: `${35 + (i / (SEGMENTS - 1)) * 65}%` }} />
          ))}
        </span>
        <span className="hidden sm:inline">
          Peak <b ref={peak}>0.00</b>
        </span>
      </div>
    </>
  )
}
