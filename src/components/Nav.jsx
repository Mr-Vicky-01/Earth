import { useEffect, useRef, useState } from 'react'
import { gsap, useGSAP } from '../lib/gsap'
import { getLenis, scrollToTarget } from '../lib/useSmoothScroll'
import { Magnetic } from './ui/Magnetic'
import { ArrowUpRight } from './ui/Icons'

export const LINKS = [
  ['Programs', '#programs'],
  ['Method', '#method'],
  ['Coaches', '#coaches'],
  ['Pricing', '#pricing'],
]

export function Nav({ ready }) {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const menu = useRef(null)
  const touched = useRef(false)

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 60)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])

  useGSAP(
    () => {
      if (!touched.current) return
      const items = menu.current.querySelectorAll('.menu-item')
      if (open) {
        getLenis()?.stop()
        gsap
          .timeline()
          .to(menu.current, { clipPath: 'inset(0 0 0% 0)', duration: 0.8, ease: 'power4.inOut' })
          .fromTo(items, { y: 70, opacity: 0 }, { y: 0, opacity: 1, stagger: 0.06, duration: 0.9, ease: 'power3.out' }, '-=0.35')
      } else {
        getLenis()?.start()
        gsap.to(menu.current, { clipPath: 'inset(0 0 100% 0)', duration: 0.6, ease: 'power4.inOut' })
      }
    },
    { dependencies: [open] },
  )

  const go = (e, href) => {
    e.preventDefault()
    if (open) {
      touched.current = true
      setOpen(false)
      setTimeout(() => scrollToTarget(href), 120)
    } else {
      scrollToTarget(href)
    }
  }

  const toggle = () => {
    touched.current = true
    setOpen((o) => !o)
  }

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-[70] pointer-events-none">
        <div className={`wrap nav ${ready ? 'nav--in' : ''} ${scrolled ? 'nav--scrolled' : ''}`}>
          <a href="#top" className="logo pointer-events-auto" onClick={(e) => go(e, '#top')} aria-label="Forge home">
            FORGE
            <i />
          </a>

          <nav className="nav-links glass hidden md:flex pointer-events-auto" aria-label="Primary">
            {LINKS.map(([label, href]) => (
              <a key={href} href={href} className="nav-link" onClick={(e) => go(e, href)}>
                {label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2 pointer-events-auto">
            <Magnetic className="hidden sm:inline-block">
              <a href="#pricing" className="btn btn-sm btn-acid" onClick={(e) => go(e, '#pricing')}>
                Join now <ArrowUpRight />
              </a>
            </Magnetic>
            <button
              type="button"
              className={`burger glass md:hidden ${open ? 'is-open' : ''}`}
              onClick={toggle}
              aria-expanded={open}
              aria-controls="mobile-menu"
              aria-label="Toggle menu"
            >
              <span />
              <span />
            </button>
          </div>
        </div>
      </header>

      <div id="mobile-menu" ref={menu} className="menu md:hidden" aria-hidden={!open}>
        <nav className="flex flex-col gap-1" aria-label="Mobile">
          {LINKS.map(([label, href], i) => (
            <a key={href} href={href} className="menu-item menu-link display" onClick={(e) => go(e, href)}>
              <span className="label mr-4 align-top">0{i + 1}</span>
              {label}
            </a>
          ))}
        </nav>
        <div className="menu-item mt-10 flex items-end justify-between gap-6">
          <div>
            <p className="label mb-2">Visit</p>
            <p className="text-sm text-bone/80">88 Foundry Street, District 9</p>
            <p className="text-sm text-bone/80">Open 24 / 7</p>
          </div>
          <a href="#pricing" className="btn btn-acid" onClick={(e) => go(e, '#pricing')}>
            Join now <ArrowUpRight />
          </a>
        </div>
      </div>
    </>
  )
}
