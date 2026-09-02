"use client"

import * as React from "react"

const DESKTOP_QUERY = "(min-width: 768px)"

/** Desktop-first so SSR and the first paint agree on the wide layout. */
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = React.useState(true)

  React.useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY)
    const sync = () => setIsDesktop(mql.matches)
    sync()
    mql.addEventListener("change", sync)
    return () => mql.removeEventListener("change", sync)
  }, [])

  return isDesktop
}
