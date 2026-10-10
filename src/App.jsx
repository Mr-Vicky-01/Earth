import { useCallback, useState } from 'react'
import { useSmoothScroll } from './lib/useSmoothScroll'
import { Preloader } from './components/Preloader'
import { Cursor } from './components/Cursor'
import { Nav } from './components/Nav'
import { Hero } from './components/Hero'
import { Marquee } from './components/Marquee'
import { Manifesto } from './components/Manifesto'
import { Programs } from './components/Programs'
import { Gear } from './components/Gear'
import { Coaches } from './components/Coaches'
import { Pricing } from './components/Pricing'
import { Testimonials } from './components/Testimonials'
import { CTA } from './components/CTA'
import { Footer } from './components/Footer'

export default function App() {
  const [ready, setReady] = useState(false)
  const onDone = useCallback(() => setReady(true), [])
  useSmoothScroll(ready)

  return (
    <>
      <Preloader onDone={onDone} />
      <Cursor />
      <div className="grain" aria-hidden="true" />
      <Nav ready={ready} />
      <main>
        <Hero ready={ready} />
        <Marquee />
        <Manifesto />
        <Programs />
        <Gear />
        <Coaches />
        <Pricing />
        <Testimonials />
        <CTA />
      </main>
      <Footer />
    </>
  )
}
