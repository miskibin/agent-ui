"use client"

import * as React from "react"

const query = "(min-width: 1280px)"
const subscribe = (listener: () => void) => {
  const media = window.matchMedia(query)
  media.addEventListener("change", listener)
  return () => media.removeEventListener("change", listener)
}

export function useWorkspacePanel() {
  const wide = React.useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
  const [choice, setChoice] = React.useState<boolean | null>(null)
  const open = choice ?? wide
  const toggle = React.useCallback(() => setChoice((current) => !(current ?? wide)), [wide])
  const close = React.useCallback(() => setChoice(false), [])
  return { wide, open, toggle, close }
}
