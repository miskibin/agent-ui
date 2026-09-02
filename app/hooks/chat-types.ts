import type { FileActionItem } from "@/components/ui/change-summary"
import type {
  ChatInputMentionItem,
  ChatInputQueuedMessage,
} from "@/components/ui/chat-input"
import type { GenerationStage } from "@/components/ui/generation-status"
import type { PermissionMode } from "@/lib/providers/types"
import type { StoredMessage } from "@/lib/store/types"

/** A turn in flight, keyed by chat. */
export type SessionRun = {
  startedAt: number
  stage: GenerationStage
  /**
   * Latest `status` line from the backend — "Loading qwen3:8b into memory ·
   * 24s". Shown instead of the stage word, and dropped the moment real output
   * arrives, because by then the stage word is true again.
   */
  status?: string
}

/** A message typed while a turn streamed, waiting for that turn to end. */
export type QueuedMessage = ChatInputQueuedMessage & {
  files: File[]
  skills: string[]
}

/*
 * Frozen empties. Each one is a stable identity for "nothing here", which is
 * what keeps a memoized row, list or picker from re-rendering for a value that
 * did not actually change.
 */
export const EMPTY_MESSAGES: StoredMessage[] = []
export const EMPTY_QUEUE: ChatInputQueuedMessage[] = []
export const EMPTY_MENTIONS: ChatInputMentionItem[] = []
export const EMPTY_FILE_ACTIONS: FileActionItem[] = []
/** Stable identity for "this harness offers no permission choice". */
export const EMPTY_PERMISSION_MODES: PermissionMode[] = []
