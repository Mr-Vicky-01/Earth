import { useEffect, useRef } from 'react'
import { CAP_HEIGHT, drawText } from '../glyphs/index.js'
import { LAYOUTS } from './layout'
import { sampleHeadline } from './targets'

/**
 * Static chalk headline for browsers that can't run the dust simulation, drawn once onto a 2D canvas and placed
 * on the HTML layout box, over a painted version of the gym the scene renders: the real letterforms (from the
 * local glyph outlines) as a solid powder body with a short extruded flank in shadow, and the sim's own grains on
 * top for the chalky tooth and the dusty edges, lit the same way. Redrawn on resize.
 */
export function ChalkFallback({ motion, variant = 'wide' }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    const host = cv?.parentElement
    if (!cv || !host) return
    let samples = null
    let raf = 0
    // the gym behind it, painted once: a dim wall with two pools of light from the downlights, the rig's uprights
    // out of focus, the pendant's pool of light on the rubber floor around the letters, a soft band of haze where
    // the floor meets the wall, and the lens's vignette (the same room the WebGL scene renders)
    const paintRoom = (ctx, W, H, cx, cy, cap, layoutH) => {
      const base = cy + (layoutH / 2) * cap
      const junction = Math.min(H * 0.92, cy + cap * (W / H < 0.9 ? 0.75 : 0.42))
      const wall = ctx.createLinearGradient(0, 0, 0, junction)
      wall.addColorStop(0, '#0f0f10')
      wall.addColorStop(1, '#1d1d1e')
      ctx.fillStyle = wall
      ctx.fillRect(0, 0, W, junction)
      const floor = ctx.createLinearGradient(0, junction, 0, H)
      floor.addColorStop(0, '#151515')
      floor.addColorStop(1, '#070708')
      ctx.fillStyle = floor
      ctx.fillRect(0, junction, W, H - junction)
      const pool = (x, y, r, a) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r)
        g.addColorStop(0, `rgba(118, 114, 108, ${a})`)
        g.addColorStop(0.45, `rgba(92, 89, 85, ${a * 0.45})`)
        g.addColorStop(1, 'rgba(60, 58, 56, 0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, W, junction)
      }
      const k = Math.min(1, Math.max(0.42, W / H / 1.6))
      pool(W * (0.5 - 0.21 * k), junction * 0.42, Math.max(W, H) * 0.3, 0.4)
      pool(W * (0.5 + 0.36 * k), junction * 0.4, Math.max(W, H) * 0.32, 0.44)
      ctx.save()
      ctx.filter = `blur(${Math.max(3, Math.round(cap * 0.06))}px)`
      ctx.fillStyle = 'rgba(6, 6, 7, 0.55)'
      for (const x of [0.1, 0.37, 0.76, 0.96]) ctx.fillRect(W * x, 0, Math.max(6, W * 0.016), junction)
      ctx.restore()
      // the pendant's pool on the rubber, centred under the letters and squeezed by the low point of view
      ctx.save()
      ctx.translate(cx, base)
      ctx.scale(1, 0.32)
      const fp = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.62)
      fp.addColorStop(0, 'rgba(96, 96, 95, 0.45)')
      fp.addColorStop(0.5, 'rgba(70, 70, 70, 0.2)')
      fp.addColorStop(1, 'rgba(50, 50, 50, 0)')
      ctx.fillStyle = fp
      ctx.fillRect(-W, -H * 3, W * 2, H * 6)
      ctx.restore()
      // haze lying on the floor where it meets the wall
      const haze = ctx.createLinearGradient(0, junction - H * 0.05, 0, junction + H * 0.1)
      haze.addColorStop(0, 'rgba(78, 78, 80, 0)')
      haze.addColorStop(0.4, 'rgba(78, 78, 80, 0.18)')
      haze.addColorStop(1, 'rgba(78, 78, 80, 0)')
      ctx.fillStyle = haze
      ctx.fillRect(0, junction - H * 0.05, W, H * 0.15)
      // the letters' contact shadow on the floor
      const cs = ctx.createLinearGradient(0, base - cap * 0.02, 0, base + cap * 0.16)
      cs.addColorStop(0, 'rgba(0, 0, 0, 0.55)')
      cs.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = cs
      ctx.fillRect(cx - (W * 0.45), base - cap * 0.02, W * 0.9, cap * 0.18)
      const vig = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.3, W / 2, H * 0.45, Math.max(W, H) * 0.8)
      vig.addColorStop(0, 'rgba(0, 0, 0, 0)')
      vig.addColorStop(1, 'rgba(0, 0, 0, 0.55)')
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)
    }
    const draw = () => {
      raf = 0
      const W = host.clientWidth
      const H = host.clientHeight
      if (!W || !H) return
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
      const ctx = cv.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const layout = LAYOUTS[variant] || LAYOUTS.wide
      const box = motion?.box
      const bw = box && box.w > 10 ? box.w : Math.min(W * 0.86, 1240)
      const cap = bw / layout.W
      const cx = box && box.w > 10 ? box.x + box.w / 2 : W / 2
      const cy = box && box.w > 10 ? box.y + box.h / 2 : H * 0.45
      paintRoom(ctx, W, H, cx, cy, cap, layout.H)
      const left = cx - (layout.W * cap) / 2
      const top = cy - (layout.H * cap) / 2
      const lines = (dx, dy) => {
        for (const line of layout.lines) {
          const size = cap * line.scale
          const s = size / CAP_HEIGHT
          drawText(ctx, line.text, left + dx - line.ink.minx * s, top + dy + line.top * cap + layout.top * s, size, {
            instance: line.instance,
          })
        }
      }
      // the extruded flank, stepping back down and to the right, away from the key light, into shadow
      const depth = Math.max(3, cap * 0.05)
      const steps = Math.ceil(depth)
      for (let i = steps; i >= 1; i--) {
        const k = i / steps
        const v = Math.round(58 + 40 * (1 - k))
        ctx.fillStyle = `rgb(${v} ${v + 1} ${v + 4})`
        lines(k * depth * 0.55, k * depth)
      }
      // the powder body
      ctx.fillStyle = '#d4d6dd'
      lines(0, 0)
      // grains on top: tooth, the light on the shoulders, the dusty edge
      const n = W < 700 ? 40000 : 90000
      if (!samples || samples.n !== n || samples.variant !== variant)
        samples = { n, variant, ...sampleHeadline(n, W < 700 ? 100 : 140, 11, variant) }
      const { target, info, nWall } = samples
      const g = Math.max(0.7, Math.min(1.6, cap * 0.009))
      const buckets = 10
      ctx.globalAlpha = 0.7
      for (let b = 0; b < buckets; b++) {
        // display-referred: lift the shade so the powder reads white
        const sh = Math.pow(0.3 + (b + 0.5) * (1 / buckets), 0.6)
        const c = (v) => Math.round(Math.min(255, v * sh))
        ctx.fillStyle = `rgb(${c(246)} ${c(247)} ${c(250)})`
        ctx.beginPath()
        for (let i = nWall; i < n; i++) {
          const k = i * 4
          const bi = Math.min(buckets - 1, Math.max(0, Math.floor((info[k] - 0.3) * buckets)))
          if (bi !== b) continue
          const x = cx + target[k] * cap
          const y = cy - target[k + 1] * cap
          ctx.moveTo(x + g, y)
          ctx.arc(x, y, g, 0, Math.PI * 2)
        }
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(host)
    if (motion) motion.onBox = schedule
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      if (motion && motion.onBox === schedule) motion.onBox = null
    }
  }, [motion, variant])
  return <canvas ref={ref} className="hc-fallback" aria-hidden="true" />
}

export default ChalkFallback
