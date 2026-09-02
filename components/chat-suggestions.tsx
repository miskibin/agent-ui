import { HelpCircle, Palette, Paperclip, Sparkles, Waves } from "lucide-react"

import type { PromptSuggestion } from "@/components/ui/prompt-suggestions"

/** The openers offered on an empty chat, when the settings leave them on. */
export const CHAT_SUGGESTIONS: PromptSuggestion[] = [
  { id: "streaming", label: "How does streaming work?", icon: <Waves /> },
  {
    id: "theming",
    label: "How do theme tokens work in dark mode?",
    icon: <Palette />,
  },
  {
    id: "composer",
    label: "What does the composer send when I attach a file?",
    icon: <Paperclip />,
  },
  {
    id: "markdown",
    label: "Walk me through the markdown, math and mermaid rendering",
    icon: <Sparkles />,
  },
  {
    id: "ask",
    label: "Use the ask tool so I can try the UI",
    icon: <HelpCircle />,
  },
]
