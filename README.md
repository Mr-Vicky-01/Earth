# FORGE — immersive 3D gym website

A dark, high-contrast gym landing page with real-time 3D, scroll-driven animation and a motion-first UI.

## Stack

- **React 19 + Vite** — app shell and build
- **Three.js via @react-three/fiber + drei** — procedural hex dumbbell, orbit rings, scroll-loaded barbell, procedural lighting (no external 3D assets)
- **@react-three/postprocessing** — bloom + vignette
- **GSAP + ScrollTrigger** — preloader, masked text reveals, pinned "Method" sequence, counters
- **Lenis** — smooth scrolling synced to GSAP's ticker
- **Tailwind CSS v4** — layout utilities on top of a hand-written design system

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
npm run preview  # serve the production build
```

## Structure

```
src/
  App.jsx                  page composition
  index.css                design tokens + component styles
  lib/                     gsap setup, smooth scroll, in-view hook
  components/
    three/                 HeroScene (dumbbell), GearScene (barbell), Studio (lights)
    ui/                    Reveal, Heading, Magnetic, Tilt, Counter, Icons
    *.jsx                  page sections
```

Fonts are loaded from Google Fonts (Bebas Neue, Manrope, JetBrains Mono). Everything else is self-contained.
