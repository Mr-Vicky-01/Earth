import { useRef } from 'react'
import { gsap, useGSAP } from '../../lib/gsap'

/**
 * Big display heading whose lines slide up out of masks when scrolled into view.
 * `lines` is an array of strings or React nodes.
 */
export function Heading({ lines, as: Tag = 'h2', className = '', start = 'top 85%' }) {
  const ref = useRef(null)

  useGSAP(
    () => {
      gsap.fromTo(
        ref.current.querySelectorAll('.heading-line > span'),
        { yPercent: 112 },
        {
          yPercent: 0,
          duration: 1.3,
          stagger: 0.1,
          ease: 'power4.out',
          scrollTrigger: { trigger: ref.current, start, once: true },
        },
      )
    },
    { scope: ref },
  )

  return (
    <Tag ref={ref} className={`display ${className}`}>
      {lines.map((line, i) => (
        <span key={i} className="line-mask heading-line">
          <span>{line}</span>
        </span>
      ))}
    </Tag>
  )
}
