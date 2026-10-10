import { useEffect, useState } from 'react'

/** True while `ref`'s element intersects the viewport (with a margin). Used to pause offscreen canvases. */
export function useInView(ref, rootMargin = '20% 0px') {
  const [inView, setInView] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, rootMargin])
  return inView
}
