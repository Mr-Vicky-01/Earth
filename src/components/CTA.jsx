import { Heading } from './ui/Heading'
import { Reveal } from './ui/Reveal'
import { Magnetic } from './ui/Magnetic'
import { ArrowUpRight } from './ui/Icons'
import { scrollToTarget } from '../lib/useSmoothScroll'

export function CTA() {
  return (
    <section className="cta section">
      <div className="cta-rings" aria-hidden="true">
        {[
          ['52vmin', '38s'],
          ['74vmin', '50s'],
          ['98vmin', '66s'],
          ['126vmin', '84s'],
        ].map(([s, d]) => (
          <i key={s} style={{ '--s': s, '--d': d }} />
        ))}
      </div>
      <div className="cta-glow" aria-hidden="true" />

      <div className="wrap flex flex-col items-center text-center">
        <Reveal>
          <span className="label eyebrow">07 — Your move</span>
        </Reveal>
        <Heading className="cta-title mt-8" lines={['Ready to', <span className="text-acid">forge?</span>]} />
        <Reveal delay={0.2} className="mt-8 max-w-md text-ash md:text-lg md:leading-relaxed">
          Seven days on the floor, every class, every coach. If it isn’t the best week of training you’ve had, walk away. No card required.
        </Reveal>
        <Reveal delay={0.3} className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Magnetic>
            <a
              href="#pricing"
              className="btn btn-acid"
              onClick={(e) => {
                e.preventDefault()
                scrollToTarget('#pricing')
              }}
            >
              Claim your free week <ArrowUpRight />
            </a>
          </Magnetic>
          <Magnetic>
            <a
              href="#coaches"
              className="btn btn-ghost"
              onClick={(e) => {
                e.preventDefault()
                scrollToTarget('#coaches')
              }}
            >
              Meet the coaches
            </a>
          </Magnetic>
        </Reveal>
      </div>
    </section>
  )
}
