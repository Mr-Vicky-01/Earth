import { Reveal } from './ui/Reveal'
import { Heading } from './ui/Heading'

const COACHES = [
  {
    id: '001',
    name: 'Maya Okonkwo',
    role: 'Head of Strength',
    years: 12,
    hue: 'acid',
    bio: 'Former national powerlifter. 180 kg squat, zero patience for ego lifting.',
  },
  {
    id: '002',
    name: 'Dante Reyes',
    role: 'Conditioning Lead',
    years: 9,
    hue: 'ember',
    bio: 'Ex-pro boxer. Builds engines, breaks excuses.',
  },
  {
    id: '003',
    name: 'Ingrid Solberg',
    role: 'Mobility & Recovery',
    years: 11,
    hue: 'ice',
    bio: 'Physio turned coach. Keeps the roster on the floor and out of the clinic.',
  },
  {
    id: '004',
    name: 'Kai Nakamura',
    role: 'Combat Floor',
    years: 8,
    hue: 'violet',
    bio: 'Muay Thai champion. Teaches footwork like a language.',
  },
]

const initials = (name) =>
  name
    .split(' ')
    .map((n) => n[0])
    .join('')

function Barcode({ seed }) {
  const bars = Array.from({ length: 22 }, (_, i) => ((seed * 31 + i * 17) % 4) + 1)
  return (
    <span className="barcode" aria-hidden="true">
      {bars.map((w, i) => (
        <i key={i} style={{ width: w, opacity: i % 3 === 0 ? 0.35 : 0.8 }} />
      ))}
    </span>
  )
}

export function Coaches() {
  return (
    <section id="coaches" className="section">
      <div className="wrap">
        <div className="mb-12 flex flex-col gap-8 md:mb-16 md:flex-row md:items-end md:justify-between">
          <div>
            <Reveal>
              <span className="label eyebrow">04 — Coaches</span>
            </Reveal>
            <Heading
              className="mt-6 text-[clamp(3.8rem,9vw,9.5rem)]"
              lines={['Learn from', <span className="text-acid">the ones</span>, 'who did it.']}
            />
          </div>
          <Reveal className="max-w-sm text-ash md:text-lg md:leading-relaxed">
            Forty coaches. Combined, a few centuries under the bar. Each one hand-picked for how they teach, not just what they lifted.
          </Reveal>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 md:gap-5">
          {COACHES.map((c, i) => (
            <Reveal key={c.id} delay={i * 0.08}>
              <article className="card coach-card" style={{ '--hue': `var(--color-${c.hue})` }} data-cursor="Meet">
                <div className="portrait" aria-hidden="true" />
                <span className="initials" aria-hidden="true">
                  {initials(c.name)}
                </span>
                <div className="relative flex items-start justify-between">
                  <span className="label">
                    ID {c.id}
                    <br />
                    {c.years} yrs
                  </span>
                  <Barcode seed={i + 1} />
                </div>
                <div className="relative">
                  <h3 className="display coach-name">{c.name}</h3>
                  <p className="label mt-2" style={{ color: 'var(--hue)' }}>
                    {c.role}
                  </p>
                  <p className="bio mt-3 text-sm leading-relaxed text-bone/80">{c.bio}</p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
