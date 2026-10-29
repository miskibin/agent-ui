"use client"

import {
  ArrowUpRight,
  Check,
  GitBranch,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react"
import * as React from "react"
import {
  MessageList,
  type MessageListProps,
} from "@/components/ui/message-list"
import type { StoredMessage } from "@/lib/store/types"
import {
  CARD_PATTERN,
  subagentCards,
  withSubagentCards,
  type SubagentCardData,
} from "@/lib/subagents/cards"
import type { SubagentRunSummary } from "@/lib/subagents/types"

const CardContext = React.createContext<{
  cards: Map<string, SubagentCardData>
  open: (id: string) => void
}>({ cards: new Map(), open: () => {} })
const PATTERNS = [
  {
    pattern: CARD_PATTERN,
    render: (match: RegExpExecArray) => (
      <SubagentCard key={match[1]} id={match[1]} />
    ),
  },
]

/** Host composition over the registry's markdown pattern slot; stored messages stay intact. */
export function AgentMessageList({
  rawMessages,
  agentRuns,
  onOpenAgent,
  selectedAgent,
  ...props
}: MessageListProps & {
  rawMessages: StoredMessage[]
  agentRuns: Record<string, SubagentRunSummary>
  onOpenAgent: (id: string) => void
  selectedAgent?: SubagentCardData
}) {
  const data = React.useMemo(
    () =>
      subagentCards(
        rawMessages,
        Object.fromEntries(
          Object.entries(agentRuns).filter(
            // Older CLI launches had no parent, but their receipt still names
            // the exact child session. Include those for status reconciliation.
            ([, run]) => !run.parentId || run.parentId === props.conversationKey
          )
        )
      ),
    [rawMessages, agentRuns, props.conversationKey]
  )
  const last = props.messages.at(-1)
  const liveMessageId = (props.isGenerating || (props.generationStage && props.generationStage !== "idle")) && last?.sender === "assistant" ? last.id : undefined
  const liveCards = React.useMemo(
    () => [...data.cards.keys()].filter((id) => JSON.parse(decodeURIComponent(id))[0] === liveMessageId),
    [data.cards, liveMessageId]
  )
  const messages = React.useMemo(
    () =>
      props.messages.flatMap((message) => {
        const view = withSubagentCards(message, data.cards, data.hidden, message.id !== liveMessageId)
        // A live delegation is drawn below the streaming markdown renderer:
        // its animated text wrappers cannot reliably render pattern cards.
        // Keep an otherwise empty assistant from adding a second status row.
        return message.id === liveMessageId && liveCards.length && !view.content &&
          !view.parts?.length && !view.tools?.length && !view.reasoning ? [] : [view]
      }),
    [props.messages, data, liveMessageId, liveCards.length]
  )
  const context = React.useMemo(
    () => ({ cards: data.cards, open: onOpenAgent }),
    [data.cards, onOpenAgent]
  )
  const patterns = React.useMemo(
    () => [...PATTERNS, ...(props.patternHandlers ?? [])],
    [props.patternHandlers]
  )
  if (selectedAgent)
    return (
      <MessageList
        {...props}
        conversationKey={selectedAgent.id}
        messages={[
          {
            id: "agent-prompt",
            sender: "user",
            content: selectedAgent.prompt || selectedAgent.title,
          },
          {
            id: "agent-response",
            sender: "assistant",
            content: selectedAgent.text || "",
            tools: selectedAgent.tools.map((tool) => ({
              ...tool,
              status:
                tool.status === "running"
                  ? "running"
                  : tool.status === "error"
                    ? "error"
                    : "done",
            })),
          },
        ]}
        isGenerating={selectedAgent.status === "running"}
        renderActions={undefined}
        onAskAnswer={undefined}
        onEditMessage={undefined}
        generationLabel={
          selectedAgent.status === "running" ? "Agent working" : undefined
        }
      />
    )
  return (
    <CardContext value={context}>
      <MessageList
        {...props}
        messages={messages}
        patternHandlers={patterns}
        renderActions={(message) =>
          props.renderActions?.(
            rawMessages.find((raw) => raw.id === message.id) ?? message
          )
        }
      >
        {liveCards.map((id) => <SubagentCard key={id} id={id} />)}
        {props.children}
      </MessageList>
    </CardContext>
  )
}

function SubagentCard({ id }: { id: string }) {
  const { cards, open } = React.useContext(CardContext)
  const agent = cards.get(id)
  if (!agent) return null
  const last = agent.tools.at(-1)
  return (
    <button
      type="button"
      data-slot="subagent-card"
      data-status={agent.status}
      onClick={() => open(id)}
      className="group/agent my-1 flex w-full max-w-lg items-start gap-2 rounded-md px-2 py-1.5 text-left text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="mt-1 shrink-0 text-muted-foreground">
        <AgentState status={agent.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[12px]">
          <span className="truncate font-medium">{agent.title}</span>
          <ArrowUpRight className="ml-auto size-3 shrink-0 text-muted-foreground opacity-50 group-hover/agent:opacity-100" />
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{stateLabel(agent.status)}</span>
          <span aria-hidden>·</span>
          <span className="truncate">
            {(
              {
                "claude-code": "Claude Code",
                codex: "Codex",
                pi: "pi",
                cursor: "Cursor",
              } as Record<string, string>
            )[agent.harness] ?? agent.harness}
            {agent.model ? ` · ${agent.model}` : ""}
          </span>
        </span>
        {last ? (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {agent.tools.length}{" "}
            {agent.tools.length === 1 ? "tool call" : "tool calls"} ·{" "}
            {last.name}
          </span>
        ) : (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {agent.prompt || "Open agent activity"}
          </span>
        )}
      </span>
    </button>
  )
}

function stateLabel(status: string) {
  return (
    (
      {
        running: "Working",
        queued: "Queued",
        done: "Completed",
        error: "Failed or interrupted",
        cancelled: "Stopped",
      } as Record<string, string>
    )[status] ?? status
  )
}

function AgentState({ status }: { status: string }) {
  if (status === "running" || status === "queued")
    return <LoaderCircle className="size-3 shrink-0 motion-safe:animate-spin" />
  if (status === "error" || status === "cancelled")
    return <TriangleAlert className="size-3 shrink-0" />
  if (status === "done") return <Check className="size-3 shrink-0" />
  return <GitBranch className="size-3 shrink-0" />
}
