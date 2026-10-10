import { Reveal } from './ui/Reveal'
import { Heading } from './ui/Heading'
import { Tilt } from './ui/Tilt'
import { ArrowUpRight } from './ui/Icons'

const PROGRAMS = [
  {
    n: '01',
    title: 'Strength Lab',
    tag: 'Barbell · Powerlifting',
    desc: 'Periodised programming on competition-grade platforms. Chase numbers that used to scare you.',
    duration: '60 min',
    intensity: 4,
    hue: 'acid',
  },
  {
    n: '02',
    title: 'HIIT Arena',
    tag: 'Conditioning · Engine',
    desc: 'Heart-rate-zoned intervals on assault bikes, skiergs and sleds. Leave in a puddle. Come back tomorrow.',
    duration: '45 min',
    intensity: 5,
    hue: 'ember',
  },
  {
    n: '03',
    title: 'Mobility & Recovery',
    tag: 'Movement · Longevity',
    desc: 'Contrast therapy, assisted stretch and breathwork. The work that lets you keep working.',
    duration: '40 min',
    intensity: 2,
    hue: 'ice',
  },
  {
    n: '04',
    title: 'Combat Floor',
    tag: 'Boxing · Muay Thai',
    desc: 'Pad rounds, footwork and sparring for every level. Technical, humbling, addictive.',
    duration: '60 min',
    intensity: 4,
    hue: 'violet',
  },
]

export function Programs() {
  return (
    <section id="programs" className="section">
      <div className="wrap">
        <div className="mb-12 flex flex-col gap-8 md:mb-16 md:flex-row md:items-end md:justify-between">
          <div>
            <Reveal>
              <span className="label eyebrow">02 — Programs</span>
            </Reveal>
            <Heading className="mt-6 text-[clamp(3.8rem,9vw,9.5rem)]" lines={['Pick your', <span className="outline">poison.</span>]} />
          </div>
          <Reveal className="max-w-sm text-ash md:text-lg md:leading-relaxed">
            Four floors. Four disciplines. One membership. Every program is coached, tracked and periodised, so progress is a plan, not an
            accident.
          </Reveal>
        </div>

        <div className="grid gap-4 md:grid-cols-2 md:gap-5">
          {PROGRAMS.map((p, i) => (
            <Reveal key={p.n} delay={(i % 2) * 0.1}>
              <Tilt className="card program-card" style={{ '--hue': `var(--color-${p.hue})` }} data-cursor="Explore">
                <span className="watermark" aria-hidden="true">
                  {p.n}
                </span>
                <div className="relative flex items-start justify-between">
                  <span className="label">
                    {p.n} / {p.tag}
                  </span>
                  <span className="program-arrow">
                    <ArrowUpRight className="" />
                  </span>
                </div>
                <div className="relative">
                  <h3 className="display program-title">{p.title}</h3>
                  <p className="mt-4 max-w-md text-ash">{p.desc}</p>
                  <div className="mt-6 flex flex-wrap gap-2">
                    <span className="chip">{p.duration}</span>
                    <span className="chip">
                      Intensity
                      <span className="bars">
                        {[1, 2, 3, 4, 5].map((b) => (
                          <i key={b} className={b <= p.intensity ? 'on' : ''} style={{ height: 4 + b * 2 }} />
                        ))}
                      </span>
                    </span>
                  </div>
                </div>
              </Tilt>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
