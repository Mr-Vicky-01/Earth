import { useEffect, useState } from 'react'

/** True while `ref`'s element is within the viewport (plus margin). Use it to pause canvases and loops. */
export function useInView(ref, rootMargin = '15% 0px') {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, rootMargin])
  return inView
}
