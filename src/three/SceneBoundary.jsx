import { Component } from 'react'

/** Keeps a WebGL failure (no WebGL, lost context, shader error) from taking the page down. */
export class SceneBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(err) {
    console.warn('3D scene unavailable, showing fallback.', err)
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? <SceneFallback />
    return this.props.children
  }
}

/** Static stand-in for a canvas: cobalt field with a soft heat glow and speed lines. */
export function SceneFallback({ tone = 'cobalt' }) {
  const base = tone === 'ink' ? '#0a0a10' : '#2236ff'
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        background: `repeating-linear-gradient(100deg, transparent 0 46px, rgb(239 238 233 / .07) 46px 48px), radial-gradient(50% 45% at 68% 42%, rgb(255 75 31 / .35), transparent 70%), ${base}`,
      }}
    />
  )
}
