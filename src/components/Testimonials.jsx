import { Reveal } from './ui/Reveal'
import { Star } from './ui/Icons'

const QUOTES = [
  ['I came for the equipment and stayed for the coaching. Added 40 kg to my deadlift in six months.', 'Priya S.', 'Member since 2024'],
  ['The HIIT Arena is genuinely the hardest 45 minutes of my week. I love it. I hate it. I love it.', 'Marcus T.', 'Member since 2025'],
  ['Finally a gym that takes recovery as seriously as training. The contrast suite is unreal.', 'Lena K.', 'Member since 2024'],
  ['Coaches actually watch you lift. That alone is worth the membership.', 'Tomás R.', 'Member since 2026'],
  ['The 6am floor is electric. Nobody is on their phone. Everybody is working.', 'Jade M.', 'Member since 2025'],
  ['I was terrified of the Combat Floor. Now I spar on Saturdays.', 'Aiden P.', 'Member since 2025'],
  ['Clean, loud, serious. Exactly what a gym should be.', 'Noor H.', 'Member since 2024'],
  ['Switched from a big-box chain and I will never go back.', 'Chris D.', 'Member since 2026'],
]

function Row({ quotes, reverse, speed }) {
  return (
    <div className="marquee" style={{ '--marquee-speed': speed, padding: '0.5rem 0' }}>
      <div className={`marquee-track ${reverse ? 'reverse' : ''}`}>
        {[0, 1].map((k) => (
          <div key={k} className="marquee-group" aria-hidden={k === 1}>
            {quotes.map(([q, name, meta], i) => (
              <figure key={i} className="quote-card glass">
                <span className="stars" aria-label="5 out of 5 stars">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star key={s} />
                  ))}
                </span>
                <blockquote className="mt-4">
                  <p className="whitespace-normal">“{q}”</p>
                </blockquote>
                <figcaption className="mt-5 flex items-center justify-between">
                  <span className="text-sm font-semibold">{name}</span>
                  <span className="label">{meta}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function Testimonials() {
  return (
    <section className="section overflow-hidden pt-0">
      <div className="wrap mb-10">
        <Reveal>
          <span className="label eyebrow">06 — Word on the floor</span>
        </Reveal>
      </div>
      <Reveal y={60}>
        <Row quotes={QUOTES.slice(0, 4)} speed="52s" />
        <Row quotes={QUOTES.slice(4)} reverse speed="60s" />
      </Reveal>
    </section>
  )
}
