import { useRef } from 'react'
import { gsap, useGSAP } from '../../lib/gsap'

/** Fades + lifts its children in once they scroll into view. */
export function Reveal({ children, as: Tag = 'div', delay = 0, y = 40, className = '', ...rest }) {
  const ref = useRef(null)

  useGSAP(
    () => {
      gsap.fromTo(
        ref.current,
        { y, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 1.2,
          delay,
          ease: 'power3.out',
          scrollTrigger: { trigger: ref.current, start: 'top 88%', once: true },
        },
      )
    },
    { scope: ref },
  )

  return (
    <Tag ref={ref} className={className} {...rest}>
      {children}
    </Tag>
  )
}
