export type AgentNotificationSound = "completion" | "question"

const SOUND_SOURCES: Record<AgentNotificationSound, string> = {
  completion: "/sounds/agent-completion.wav",
  question: "/sounds/agent-question.wav",
}

/**
 * Notification audio is progressive enhancement: browser autoplay policies,
 * a missing output device, or a transient media error must never affect a run.
 */
export function playAgentNotificationSound(kind: AgentNotificationSound) {
  const audio = new Audio(SOUND_SOURCES[kind])
  audio.preload = "auto"
  void audio.play().catch(() => {
    // The visual state remains the source of truth when audio is unavailable.
  })
}
