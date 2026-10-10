import { useCallback, useState } from 'react'
import { useSmoothScroll } from './lib/scroll'
import { Preloader } from './sections/Preloader'
import { Cursor } from './sections/Cursor'
import { Nav } from './sections/Nav'
import { Hud } from './sections/Hud'
import { Hero } from './sections/Hero'
import { Kinetic } from './sections/Kinetic'
import { Programs } from './sections/Programs'
import { Pull } from './sections/Pull'
import { Board } from './sections/Board'
import { Coaches } from './sections/Coaches'
import { Pricing } from './sections/Pricing'
import { Finale } from './sections/Finale'

export default function App() {
  const [ready, setReady] = useState(false)
  const onDone = useCallback(() => setReady(true), [])
  useSmoothScroll(ready)

  return (
    <>
      <Preloader onDone={onDone} />
      <Cursor />
      <Nav ready={ready} />
      <Hud ready={ready} />
      <main>
        <Hero ready={ready} />
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
