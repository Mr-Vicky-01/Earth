import { LINKS } from './Nav'
import { scrollToTarget } from '../lib/useSmoothScroll'
import { ArrowUpRight } from './ui/Icons'

const SOCIAL = ['Instagram', 'TikTok', 'YouTube', 'Strava']

export function Footer() {
  const go = (e, href) => {
    e.preventDefault()
    scrollToTarget(href)
  }
  return (
    <footer className="relative overflow-hidden border-t border-white/10">
      <div className="wrap grid gap-12 py-16 md:grid-cols-12 md:py-20">
        <div className="md:col-span-5">
          <a href="#top" className="logo" onClick={(e) => go(e, '#top')}>
            FORGE
            <i />
          </a>
          <p className="mt-6 max-w-sm text-ash">
            A strength &amp; conditioning gym for people who want to be coached, not just let in. Built on progressive overload, brutal
            honesty and very good coffee.
          </p>
          <a href="mailto:hello@forge.gym" className="btn btn-ghost btn-sm mt-8">
            hello@forge.gym <ArrowUpRight />
          </a>
        </div>

        <div className="md:col-span-2">
          <p className="label mb-5">Explore</p>
          <ul className="flex flex-col gap-3">
            {LINKS.map(([label, href]) => (
              <li key={href}>
                <a href={href} className="footer-link" onClick={(e) => go(e, href)}>
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className="md:col-span-2">
          <p className="label mb-5">Social</p>
          <ul className="flex flex-col gap-3">
            {SOCIAL.map((s) => (
              <li key={s}>
                <a href="#top" className="footer-link" onClick={(e) => e.preventDefault()}>
                  {s}
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className="md:col-span-3">
          <p className="label mb-5">Visit</p>
          <p className="text-bone/85">88 Foundry Street</p>
          <p className="text-bone/85">District 9, 10110</p>
          <p className="mt-4 label">Open 24 / 7 · Staffed 05:30 – 22:00</p>
          <p className="mt-4 text-bone/85">+1 (555) 010-3674</p>
        </div>
      </div>

      <div className="wrap">
        <div className="footer-giant display -mb-[0.12em] text-center" aria-hidden="true">
          Forge
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="wrap flex flex-col gap-3 py-5 text-xs text-ash sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 Forge Athletics. All rights reserved.</span>
          <div className="flex gap-6">
            <a href="#top" className="footer-link text-xs" onClick={(e) => e.preventDefault()}>
              Privacy
            </a>
            <a href="#top" className="footer-link text-xs" onClick={(e) => e.preventDefault()}>
              Terms
            </a>
            <a href="#top" className="footer-link text-xs" onClick={(e) => go(e, '#top')}>
              Back to top ↑
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}
