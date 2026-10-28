"use client"

import * as React from "react"
import type { StoredMessage } from "@/lib/store/types"
import { subagentCards } from "@/lib/subagents/cards"
import type { SubagentRunSummary } from "@/lib/subagents/types"

/** Native agents share their parent's session; delegated agents have their own. */
export function useAgentNavigation({ activeId, messages, agentRuns, selectSession }: {
  activeId: string
  messages: StoredMessage[]
  agentRuns: Record<string, SubagentRunSummary>
  selectSession: (id: string) => void
}) {
  const [selection, setSelection] = React.useState<{ parentId: string; cardId: string } | null>(null)
  const cards = React.useMemo(() => [...subagentCards(messages, agentRuns).cards.values()], [messages, agentRuns])
  const selected = selection?.parentId === activeId ? cards.find((card) => card.id === selection.cardId) : undefined
  const navigate = React.useCallback((id: string) => {
    setSelection(null)
    selectSession(id)
  }, [selectSession])
  const openAgent = React.useCallback((id: string) => {
    const card = cards.find((item) => item.id === id)
    if (!card) return
    if (card.sessionId) navigate(card.sessionId)
    else setSelection({ parentId: activeId, cardId: id })
  }, [activeId, cards, navigate])
  const returnToParent = React.useCallback(() => setSelection(null), [])
  const openNativeTool = React.useCallback((toolId: string) => {
    const card = cards.find((item) => JSON.parse(decodeURIComponent(item.id))[1] === toolId)
    if (card) openAgent(card.id)
  }, [cards, openAgent])
  return { cards, selected, navigate, openAgent, openNativeTool, returnToParent }
}
