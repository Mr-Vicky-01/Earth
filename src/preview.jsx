/**
 * Dev-only section preview: /preview.html?s=Hero[&pad=0][&cursor=1]
 * Renders one section between spacer blocks with smooth scroll + velocity tracking live,
 * so a section can be built and screenshotted on its own. Not part of the production build.
 */
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import 'lenis/dist/lenis.css'
import './index.css'
import { useSmoothScroll } from './lib/scroll'

const modules = import.meta.glob('./sections/*.jsx')
const params = new URLSearchParams(location.search)
const name = params.get('s') || 'Hero'
const pad = params.get('pad') !== '0'
const withCursor = params.get('cursor') === '1'

const Section = lazy(async () => {
  const mod = await modules[`./sections/${name}.jsx`]()
  return { default: mod[name] || mod.default }
})
const CursorLazy = lazy(async () => {
  const mod = await modules['./sections/Cursor.jsx']()
  return { default: mod.Cursor }
})

function Shell() {
  const [ready, setReady] = useState(false)
  useSmoothScroll(ready)
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 150)
    return () => clearTimeout(id)
  }, [])
  return (
    <Suspense fallback={null}>
      {withCursor && <CursorLazy />}
      {pad && (
        <div className="s-ink grid h-[70vh] place-items-center">
          <span className="mono mute">preview · {name} · scroll ↓</span>
        </div>
      )}
      <Section ready={ready} onDone={() => {}} />
      {pad && (
        <div className="s-ink grid h-[100vh] place-items-center">
          <span className="mono mute">end of {name}</span>
        </div>
      )}
    </Suspense>
  )
}

if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
)
