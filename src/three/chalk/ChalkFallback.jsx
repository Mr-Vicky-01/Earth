import { useEffect, useRef } from 'react'
import { CAP_HEIGHT, drawText } from '../glyphs/index.js'
import { LAYOUTS } from './layout'
import { sampleHeadline } from './targets'

/**
 * Static chalk headline for browsers that can't run the dust simulation, drawn once onto a 2D canvas and placed
 * on the HTML layout box: the real letterforms (from the local glyph outlines) as a solid powder body with a
 * short extruded flank in shadow, and the sim's own grains on top for the chalky tooth and the dusty edges, lit
 * the same way. Redrawn on resize.
 */
export function ChalkFallback({ motion, variant = 'wide' }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    const host = cv?.parentElement
    if (!cv || !host) return
    let samples = null
    let raf = 0
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
        ctx.fillStyle = `rgb(${v} ${v + 2} ${v + 10})`
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
