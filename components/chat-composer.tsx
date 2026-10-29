"use client"

import * as React from "react"
import { CornerUpRight, Paperclip, Play, X } from "lucide-react"
import {
  ChatInput,
  type ChatInputHandle,
  type ChatInputPayload,
  type ChatInputProps,
} from "@/components/ui/chat-input"

type Props = ChatInputProps & {
  ref: React.RefObject<ChatInputHandle | null>
  onSteer: (payload: ChatInputPayload) => Promise<void>
  onQueueSendNow: (id: string) => Promise<void>
}

/** App-owned follow-up controls, composed over the unchanged registry composer. */
export function ChatComposer({ onSteer, onQueueSendNow, ...props }: Props) {
  const [sending, setSending] = React.useState(false)
  const busy = React.useRef(false)
  const steer = React.useCallback(async () => {
    const draft = props.ref.current?.getDraft()
    if (!draft || (!draft.text.trim() && !draft.files.length) || busy.current)
      return
    busy.current = true
    setSending(true)
    props.ref.current?.setDraft({ text: "", files: [], skills: [] })
    try {
      await onSteer(draft)
    } finally {
      busy.current = false
      setSending(false)
    }
  }, [onSteer, props.ref])
  const sendNow = React.useCallback(
    async (id: string) => {
      if (busy.current) return
      busy.current = true
      setSending(true)
      try {
        await onQueueSendNow(id)
      } finally {
        busy.current = false
        setSending(false)
      }
    },
    [onQueueSendNow]
  )
  const action =
    "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
  return (
    <div
      data-slot="follow-up-composer"
      onKeyDownCapture={(event) => {
        if (
          props.isGenerating &&
          event.key === "Enter" &&
          (event.ctrlKey || event.metaKey) &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault()
          event.stopPropagation()
          void steer()
        }
      }}
      onClickCapture={(event) => {
        if (
          props.isGenerating &&
          (event.ctrlKey || event.metaKey) &&
          (event.target as HTMLElement).closest('[data-slot="chat-input-send"]')
        ) {
          event.preventDefault()
          event.stopPropagation()
          void steer()
        }
      }}
    >
      {props.queue?.length ? (
        <div
          data-slot="composer-queue"
          className="mx-auto mb-2 max-h-40 w-full max-w-3xl overflow-y-auto overscroll-contain px-3 sm:px-4"
        >
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            {props.isGenerating
              ? "Queued after this turn"
              : "Queue paused — send a message to continue"}
          </p>
          {props.queue.map((item) => (
            <div
              key={item.id}
              data-slot="composer-queue-item"
              className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 hover:bg-muted/40"
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-[12px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => props.onQueueEdit?.(item.id)}
                title={item.text}
              >
                {item.text || "Attached files"}
              </button>
              {item.fileCount ? (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Paperclip className="size-3" />
                  {item.fileCount}
                </span>
              ) : null}
              <button
                type="button"
                disabled={sending}
                className={action}
                onClick={() => void sendNow(item.id)}
                title={
                  props.isGenerating
                    ? "Stop the current turn and send this message"
                    : "Send this message now"
                }
              >
                <Play className="size-3" />
                Send now
              </button>
              <button
                type="button"
                className={action}
                aria-label="Remove queued message"
                onClick={() => props.onQueueRemove?.(item.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <ChatInput
        {...props}
        disabled={props.disabled || sending}
        queue={undefined}
        tools={
          <>
            {props.tools}
            {props.isGenerating ? (
              <button
                type="button"
                disabled={sending}
                className={action}
                onClick={() => void steer()}
                aria-label="Steer message"
                title="Stop the current turn and send your correction (Ctrl/⌘+Enter)"
              >
                <CornerUpRight className="size-3.5" />
                <span data-composer-label>Steer</span>
              </button>
            ) : null}
          </>
        }
      />
    </div>
  )
}
