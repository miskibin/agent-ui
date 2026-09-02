import {
  focusWindow,
  isDesktop,
  isWindowFocused,
  notifyNative,
  requestAttention,
  setBadgeCount,
} from "@/lib/desktop"

/**
 * What the app does to get your attention when a turn finishes or an agent
 * asks a question and you are not looking: an OS notification, a badge on
 * the dock icon, a bounce.
 *
 * Every entry point is a no-op when the window is in front — you can see the
 * answer arrive, and a notification on top of it would be noise. The shell's
 * plugin is used when there is one; a browser tab falls back to the web
 * `Notification` API, which can also carry a click back to the chat.
 */

export type AttentionKind = "completion" | "question" | "error"

const TITLES: Record<AttentionKind, string> = {
  completion: "Finished",
  question: "Needs your answer",
  error: "Run failed",
}

/** Web notifications need a one-time permission; asked lazily, never on load. */
async function webPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false
  if (Notification.permission === "granted") return true
  if (Notification.permission === "denied") return false
  try {
    return (await Notification.requestPermission()) === "granted"
  } catch {
    return false
  }
}

/**
 * Notifies about one chat, unless the window is focused. `onClick` runs when
 * the user activates a web notification (the desktop plugin has no click
 * channel on every platform, so the window is bounced there instead).
 */
export async function notifyAttention(options: {
  kind: AttentionKind
  chatTitle: string
  body?: string
  onClick?: () => void
}): Promise<void> {
  if (await isWindowFocused()) return
  const title = `${TITLES[options.kind]} · ${options.chatTitle || "Chat"}`
  const body = options.body?.replace(/\s+/g, " ").trim().slice(0, 160)

  if (isDesktop()) {
    void requestAttention()
    if (await notifyNative(title, body)) return
  }
  if (!(await webPermission())) return
  try {
    const notification = new Notification(title, {
      body,
      tag: `agent-ui-${options.kind}`,
      silent: true,
    })
    notification.onclick = () => {
      void focusWindow()
      options.onClick?.()
      notification.close()
    }
  } catch {
    /* a platform without notifications is fine */
  }
}

let lastBadge = -1

/**
 * Mirrors "chats waiting on you" onto the dock icon, and into the tab title
 * in a browser. Idempotent — the sidebar recomputes this every render.
 */
export function updateAttentionBadge(count: number): void {
  if (count === lastBadge) return
  lastBadge = count
  void setBadgeCount(count)
}

/** The tab-title prefix a browser shows instead of a badge. */
export function badgePrefix(count: number): string {
  return count > 0 ? `(${count}) ` : ""
}
