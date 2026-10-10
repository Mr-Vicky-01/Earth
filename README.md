# FORGE Velocity Gym

A fully animated, speed-themed gym website. FORGE is a velocity-based strength gym: every bar measures how fast
you move the weight, and the site is built around that idea. Things get yanked into place, headlines stretch with
your scroll speed, and you can grab and fling most of what you see.

## What's on the page

- **Preloader**: the wordmark slams in while a bar-speed readout accelerates to 1.30 m/s, then colour bands wipe
  the screen away.
- **Hero**: a chrome kettlebell in a warp-speed tunnel (three.js). Drag to spin it; the harder you fling it, the
  faster the light streaks run.
- **Method**: scroll-reactive marquees and an interactive velocity-zones chart drawn to scale (m/s).
- **Programs**: a pinned horizontal run of four colour-blocked floors, each with a live motion graphic.
- **Sled pull**: an interactive test. Grab the handle, yank it, and get your peak speed in m/s.
- **Live board**: a split-flap class board with a ticking clock and spots that update.
- **Coaches**: a list where a card chases your cursor and tilts with its speed.
- **Pricing**: rolling-digit prices with a monthly or annual toggle.
- **Finale**: a warp-speed call to action and a footer wordmark that widens toward your cursor.
- **Everywhere**: a velocity-stretched cursor, a scroll-speed meter in m/s, and a nav that hides on fast scroll.

## Stack

React 19, Vite 8, three.js via @react-three/fiber, drei and postprocessing, GSAP with ScrollTrigger, Lenis smooth
scroll, Tailwind CSS v4. Fonts: Archivo (variable width, used for the stretch effects), Geist and Geist Mono from
Google Fonts. Everything else is generated in code; there are no image or model files.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
npm run preview  # serve the production build
```

While developing, `/preview.html?s=<Section>` renders a single section (for example `?s=Pricing`) with smooth
scroll running, which is handy for working on one part at a time. It is not included in the production build.

## Structure

```
src/
  App.jsx              page order
  index.css            design tokens, type, buttons and shared motion styles
  lib/                 GSAP setup, smooth scroll and live scroll velocity, tickers, section edges
  ui/                  SlamText, SpeedButton, RollText, Odometer, VelocityMarquee, Scramble, Reveal, Magnetic
  three/               hero 3D scene, kettlebell geometry, WebGL fallback
  sections/            one file per section, each with its own CSS
```

The site respects `prefers-reduced-motion`, pauses animations that are off-screen, and falls back to a static
background if WebGL is unavailable.
