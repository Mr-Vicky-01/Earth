import { gsap, useGSAP, reducedMotion } from './gsap'

/**
 * Animates the diagonal top edge of a `.cut` section: the wedge rises out of the
 * section above as this one scrolls into view. Pass the section ref.
 */
export function useSectionEdge(ref) {
  useGSAP(
    () => {
      if (reducedMotion() || !ref.current) return
      gsap.fromTo(
        ref.current,
        { '--cut-tilt': '100%' },
        {
          '--cut-tilt': '0%',
          ease: 'none',
          scrollTrigger: { trigger: ref.current, start: 'top bottom', end: 'top 45%', scrub: true },
        },
      )
    },
    { scope: ref },
  )
}
