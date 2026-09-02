/**
 * Global keys for the chat page. One listener and one handler map, bound
 * from an effect and unbound by the function it returns. `mod` is ⌘ on Apple
 * keyboards and Ctrl elsewhere.
 *
 * Type-to-focus rides along: a printable key pressed with nothing editable
 * focused lands in the composer, so you can start typing from anywhere —
 * unless a dialog or menu is open, where the keys belong to it.
 */

export type AppShortcuts = {
  newChat?: () => void
  toggleSidebar?: () => void
  previousChat?: () => void
  nextChat?: () => void
  /** 1-based index in the sidebar's visible order. */
  jumpToChat?: (index: number) => void
  openInEditor?: () => void
  /** Called with the key so the caller can decide where it lands. */
  typeToFocus?: () => void
}

function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

/** A dialog, menu or listbox is on screen and owns the keyboard. */
function overlayOpen() {
  return !!document.querySelector(
    '[role="dialog"]:not([hidden]), [role="menu"], [role="listbox"][data-state="open"], [data-slot="command-palette"]'
  )
}

export function bindAppShortcuts(handlers: AppShortcuts): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const mod = event.metaKey || event.ctrlKey
      const key = event.key

      if (mod && !event.altKey) {
        const lower = key.toLowerCase()
        if (!event.shiftKey && lower === "n" && handlers.newChat) {
          event.preventDefault()
          handlers.newChat()
          return
        }
        if (!event.shiftKey && lower === "b" && handlers.toggleSidebar) {
          event.preventDefault()
          handlers.toggleSidebar()
          return
        }
        if (!event.shiftKey && lower === "o" && handlers.openInEditor) {
          event.preventDefault()
          handlers.openInEditor()
          return
        }
        // ⌘⇧[ and ⌘⇧] — `key` is the bracket on most layouts; `code` covers
        // the ones where Shift turns it into something else.
        if (event.shiftKey) {
          const bracket =
            key === "[" || key === "{" || event.code === "BracketLeft"
              ? "prev"
              : key === "]" || key === "}" || event.code === "BracketRight"
                ? "next"
                : null
          if (bracket === "prev" && handlers.previousChat) {
            event.preventDefault()
            handlers.previousChat()
            return
          }
          if (bracket === "next" && handlers.nextChat) {
            event.preventDefault()
            handlers.nextChat()
            return
          }
        }
        if (!event.shiftKey && /^[1-9]$/.test(key) && handlers.jumpToChat) {
          event.preventDefault()
          handlers.jumpToChat(Number(key))
          return
        }
        return
      }

      // Type-to-focus: a plain printable key, nowhere editable, no overlay.
      if (
        handlers.typeToFocus &&
        key.length === 1 &&
        !event.altKey &&
        !isEditable(event.target) &&
        !overlayOpen()
      ) {
        // Focus only — the key itself then lands in the composer.
        handlers.typeToFocus()
      }
  }
  window.addEventListener("keydown", onKeyDown)
  return () => window.removeEventListener("keydown", onKeyDown)
}
