import { Component } from 'react'

/** Keeps a WebGL failure (unsupported browser, lost context) from taking the whole page down. */
export class SceneBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(err) {
    console.warn('3D scene unavailable, showing fallback.', err)
  }

  render() {
    if (this.state.failed) return <SceneFallback />
    return this.props.children
  }
}

export function SceneFallback() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        background:
          'radial-gradient(55% 45% at 65% 40%, rgba(198,255,0,0.22), transparent 70%), radial-gradient(40% 40% at 20% 80%, rgba(198,255,0,0.08), transparent 70%), #050505',
      }}
    />
  )
}
