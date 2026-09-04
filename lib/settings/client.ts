"use client"

import { normalizeSettings, type AppSettings } from "@/lib/settings/schema"

/**
 * The browser's write path to settings.json.
 *
 * The file holds one object, so every write is a read-modify-write of the
 * whole thing — and the app has more than one writer: the settings panel
 * (`app/settings/use-app-settings`) owns the provider/chat/files/editor/memory
 * subtrees, `lib/theme/theme-client` owns `appearance`. Two of those in flight
 * at once and the later GET misses the earlier PUT, which writes the other
 * writer's subtree back stale. One module-level chain is what stops that: a
 * write never starts until the previous one has settled.
 *
 * Each caller keeps its own debounce — this only serialises what they decide
 * to send — and patches the subtrees it owns, leaving the rest as read.
 */
let chain: Promise<void> = Promise.resolve()

export function writeSettings(
  patch: (current: AppSettings) => AppSettings
): Promise<void> {
  const write = chain.then(() => put(patch))
  // The chain itself must survive a failure, or one bad write would skip
  // every later one; the rejection is still handed to this caller.
  chain = write.catch(() => {})
  return write
}

async function put(patch: (current: AppSettings) => AppSettings) {
  const res = await fetch("/api/settings")
  if (!res.ok) throw new Error(`GET /api/settings ${res.status}`)
  const current = normalizeSettings(await res.json())
  const written = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch(current)),
  })
  if (!written.ok) throw new Error(`PUT /api/settings ${written.status}`)
}
