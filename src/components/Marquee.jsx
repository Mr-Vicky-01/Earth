import { Spark } from './ui/Icons'

const ITEMS = ['Strength', 'Conditioning', 'Mobility', 'Combat', 'Recovery', 'Community']

function Row({ reverse = false, variant = 'acid', speed = '38s' }) {
  const items = [...ITEMS, ...ITEMS, ...ITEMS]
  return (
    <div className={`marquee ${variant}`} style={{ '--marquee-speed': speed }}>
      <div className={`marquee-track ${reverse ? 'reverse' : ''}`}>
        {[0, 1].map((k) => (
          <div key={k} className="marquee-group" aria-hidden={k === 1}>
            {items.map((t, i) => (
              <span key={i} className="marquee-item">
                {t}
                <Spark />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function Marquee() {
  return (
    <div className="relative -mt-10 overflow-hidden py-16 md:py-24" aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2">
        <Row variant="dark" reverse speed="46s" />
      </div>
      <Row variant="acid" />
    </div>
  )
}
