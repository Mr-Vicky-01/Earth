import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { ScrollTrigger } from './lib/gsap'
import { getLenis, useSmoothScroll } from './lib/scroll'
import { Preloader } from './sections/Preloader'
import { Cursor } from './sections/Cursor'
import { Nav } from './sections/Nav'
import { Hud } from './sections/Hud'
import { HeroPicker } from './sections/HeroPicker'
import { Hero as CurrentHero } from './sections/Hero'
import { Kinetic } from './sections/Kinetic'
import { Programs } from './sections/Programs'
import { Pull } from './sections/Pull'
import { Board } from './sections/Board'
import { Coaches } from './sections/Coaches'
import { Pricing } from './sections/Pricing'
import { Finale } from './sections/Finale'

// Hero concepts under review. Only files that exist are offered.
const CONCEPTS = [
  ['forged', 'Forged', 'HeroForged'],
  ['drop', 'Drop', 'HeroDrop'],
  ['chalk', 'Chalk', 'HeroChalk'],
]
const modules = import.meta.glob('./sections/Hero{Forged,Drop,Chalk}.jsx')
const AVAILABLE = CONCEPTS.filter(([, , file]) => modules[`./sections/${file}.jsx`])
const HEROES = Object.fromEntries(
  AVAILABLE.map(([key, , file]) => [key, lazy(() => modules[`./sections/${file}.jsx`]().then((m) => ({ default: m[file] })))]),
)

const initialHero = () => {
  const fromHash = typeof location !== 'undefined' ? location.hash.slice(1) : ''
  if (HEROES[fromHash]) return fromHash
  // recommended concept opens by default
  if (HEROES.drop) return 'drop'
  return AVAILABLE[0]?.[0] ?? null
}

/** Holds the hero's space while its chunk loads, so nothing below jumps. */
const HeroShell = () => <section id="top" className="sec s-ink" style={{ height: '100svh', minHeight: 640 }} aria-hidden="true" />

export default function App() {
  const [ready, setReady] = useState(false)
  const [hero, setHero] = useState(initialHero)
  const onDone = useCallback(() => setReady(true), [])
  useSmoothScroll(ready)

  const Hero = hero ? HEROES[hero] : null
  const options = useMemo(() => AVAILABLE.map(([key, label]) => [key, label]), [])

  const pick = useCallback((key) => {
    if (!HEROES[key]) return
    const lenis = getLenis()
    if (lenis) lenis.scrollTo(0, { immediate: true, force: true })
    else window.scrollTo(0, 0)
    try {
      history.replaceState(null, '', `#${key}`)
    } catch {
      /* sandboxed */
    }
    setHero(key)
  }, [])

  // a new hero changes the page above every other section: re-measure all scroll triggers once it has laid out
  useEffect(() => {
    const id = setTimeout(() => ScrollTrigger.refresh(), 400)
    return () => clearTimeout(id)
  }, [hero])

  return (
    <>
      <Preloader onDone={onDone} />
      <Cursor />
      <Nav ready={ready} menuExtra={<HeroPicker variant="inline" options={options} value={hero} onChange={pick} ready={ready} />} />
      <Hud ready={ready} />
      <HeroPicker options={options} value={hero} onChange={pick} ready={ready} />
      <main>
        {/* until a concept exists, the current hero stays in place */}
        <Suspense fallback={<HeroShell />}>{Hero ? <Hero key={hero} ready={ready} /> : <CurrentHero ready={ready} />}</Suspense>
        <Kinetic />
        <Programs />
        <Pull />
        <Board />
        <Coaches />
        <Pricing />
      </main>
      <Finale />
    </>
  )
}
