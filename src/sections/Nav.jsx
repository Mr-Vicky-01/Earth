import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gsap, useGSAP, ScrollTrigger, reducedMotion } from '../lib/gsap'
import { scroll, scrollToTarget, getLenis } from '../lib/scroll'
import { useTicker } from '../lib/useTicker'
import { RollText } from '../ui/RollText'
import { SpeedButton } from '../ui/SpeedButton'
import { Chars } from '../ui/Chars'
import './chrome.css'

export const LINKS = [
  ['Method', '#method'],
  ['Programs', '#programs'],
  ['Schedule', '#schedule'],
  ['Coaches', '#coaches'],
  ['Pricing', '#pricing'],
]

export function Nav({ ready }) {
  const nav = useRef(null)
  const links = useRef(null)
  const indicator = useRef(null)
  const menu = useRef(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState('')
  const opened = useRef(false)
  const hidden = useRef(false)

  // entrance
  useGSAP(
    () => {
      if (!ready) {
        gsap.set('.chr-nav-in', { yPercent: -160, opacity: 0 })
        return
      }
      gsap.to('.chr-nav-in', { yPercent: 0, opacity: 1, duration: 0.8, stagger: 0.07, ease: 'expo.out', delay: 0.15 })
    },
    { scope: nav, dependencies: [ready] },
  )

  // hide when scrolling down fast, show when scrolling up
  useTicker(() => {
    if (open) return
    const down = scroll.velocity > 6 && scroll.y > 400
    const up = scroll.velocity < -2 || scroll.y < 200
    if (down && !hidden.current) {
      hidden.current = true
      nav.current?.classList.add('is-hidden')
    } else if (up && hidden.current) {
      hidden.current = false
      nav.current?.classList.remove('is-hidden')
    }
  }, ready)

  // active section tracking
  useEffect(() => {
    if (!ready) return
    const triggers = LINKS.map(([, href]) => {
      const el = document.querySelector(href)
      if (!el) return null
      return ScrollTrigger.create({
        trigger: el,
        start: 'top 45%',
        end: 'bottom 45%',
        onToggle: (self) => self.isActive && setActive(href),
        onLeaveBack: () => href === LINKS[0][1] && setActive(''),
      })
    }).filter(Boolean)
    return () => triggers.forEach((t) => t.kill())
  }, [ready])

  // slide the heat indicator under the active link
  useLayoutEffect(() => {
    const ind = indicator.current
    const box = links.current
    if (!ind || !box) return
    const a = box.querySelector(`a[href="${active}"]`)
    if (!a) {
      ind.style.opacity = '0'
      return
    }
    ind.style.opacity = '1'
    ind.style.left = `${a.offsetLeft + 12}px`
    ind.style.width = `${a.offsetWidth - 24}px`
  }, [active])

  // full-screen menu
  useGSAP(
    () => {
      if (!opened.current) return
      const items = menu.current.querySelectorAll('.chr-menu-item')
      const chars = menu.current.querySelectorAll('.chr-menu-link .ch')
      if (open) {
        getLenis()?.stop()
        document.documentElement.classList.add('is-locked')
        gsap
          .timeline()
          .set(menu.current, { visibility: 'visible' })
          .fromTo(menu.current, { xPercent: 100, skewX: -10 }, { xPercent: 0, skewX: 0, duration: 0.6, ease: 'expo.out' })
          .fromTo(chars, { xPercent: 160, opacity: 0, skewX: 25 }, { xPercent: 0, opacity: 1, skewX: 0, duration: 0.6, stagger: 0.012, ease: 'expo.out' }, 0.12)
          .fromTo(items, { x: 60, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, stagger: 0.04 }, 0.2)
      } else {
        getLenis()?.start()
        document.documentElement.classList.remove('is-locked')
        gsap
          .timeline()
          .to(menu.current, { xPercent: 100, skewX: 10, duration: 0.45, ease: 'power4.in' })
          .set(menu.current, { visibility: 'hidden' })
      }
    },
    { scope: nav, dependencies: [open] },
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const go = (e, href) => {
    e.preventDefault()
    if (open) {
      setOpen(false)
      setTimeout(() => scrollToTarget(href), 380)
    } else {
      scrollToTarget(href)
    }
  }

  return (
    <div ref={nav}>
      <header className={`chr-nav ${open ? 'is-open' : ''}`}>
        <div className="wrap chr-nav-row">
          <a href="#top" className="chr-nav-in chr-logo chr-plate d roll-host" onClick={(e) => go(e, '#top')} aria-label="FORGE, back to top">
            <RollText>FORGE</RollText>
            <span className="chr-logo-bar" aria-hidden="true" />
          </a>

          <nav ref={links} className="chr-nav-in chr-links chr-plate relative hidden lg:flex" aria-label="Primary">
            {LINKS.map(([label, href]) => (
              <a key={href} href={href} className={`chr-link roll-host ${active === href ? 'is-active' : ''}`} onClick={(e) => go(e, href)}>
                <RollText>{label}</RollText>
              </a>
            ))}
            <span ref={indicator} className="chr-indicator" aria-hidden="true" />
          </nav>

          <div className="chr-nav-in flex items-center gap-3">
            <SpeedButton href="#join" size="sm" className="hidden sm:inline-flex" onClick={(e) => go(e, '#join')}>
              Free week
            </SpeedButton>
            <button
              type="button"
              className="chr-menu-btn chr-plate roll-host lg:hidden"
              aria-expanded={open}
              aria-controls="site-menu"
              onClick={() => {
                opened.current = true
                setOpen((o) => !o)
              }}
            >
              <RollText>{open ? 'Close' : 'Menu'}</RollText>
              <span className="chr-burger" aria-hidden="true">
                <i />
                <i />
              </span>
            </button>
          </div>
        </div>
      </header>

      <div id="site-menu" ref={menu} className="chr-menu lg:hidden" aria-hidden={!open} inert={!open}>
        <nav className="flex flex-col gap-2" aria-label="Menu">
          {LINKS.map(([label, href]) => (
            <a key={href} href={href} className="chr-menu-link d" onClick={(e) => go(e, href)}>
              <span>
                <Chars text={label} />
              </span>
            </a>
          ))}
        </nav>
        <div className="chr-menu-item flex flex-wrap items-end justify-between gap-6 border-t border-white/25 pt-6">
          <div className="mono" style={{ color: 'rgb(239 238 233 / .78)' }}>
            88 Foundry Street, District 9
            <br />
            Floor open 24/7
          </div>
          <SpeedButton href="#join" variant="heat" onClick={(e) => go(e, '#join')}>
            Claim a free week
          </SpeedButton>
        </div>
      </div>
    </div>
  )
}
