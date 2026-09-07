"use client"

import * as React from "react"

import type { ChatSlashCommand } from "@/components/ui/chat-input"
import * as api from "@/lib/api-client"
import { EMPTY_SKILL_CATALOG, type SkillCatalog } from "@/lib/skills"
import { slashCommandsWith } from "@/lib/slash-commands"

/**
 * What the open chat can run: the skills its `$` menu offers and the harness
 * commands its `/` menu adds, scanned server-side from the chat's own folder
 * (`GET /api/skills`).
 *
 * Three moments are worth a scan and no others. A chat opening, because the
 * catalog is per folder. Its folder changing, for the same reason. And a turn
 * *ending*, because that is when an agent has just written one — a scan on
 * every keystroke would be a filesystem walk per character, and the route
 * caches for 30s anyway. The falling edge is taken through a token rather than
 * by watching `isGenerating` in the fetch itself, so starting a turn does not
 * re-ask for what was read a second earlier.
 *
 * The catalog is kept beside the chat it was read for and only handed out when
 * the two still agree: opening a second chat must show *its* skills or none,
 * never the last one's.
 */
export function useSkills({
  activeId,
  cwd,
  isGenerating,
}: {
  activeId: string
  /** The chat's working folder — the catalog is scanned relative to it. */
  cwd: string | undefined
  isGenerating: boolean
}) {
  const [loaded, setLoaded] = React.useState<{
    id: string
    catalog: SkillCatalog
  }>({ id: "", catalog: EMPTY_SKILL_CATALOG })

  /** Bumped once per turn that settles — see the note above. */
  const [turnToken, setTurnToken] = React.useState(0)
  const wasGenerating = React.useRef(false)
  React.useEffect(() => {
    const ended = wasGenerating.current && !isGenerating
    wasGenerating.current = isGenerating
    // Deferred: a synchronous setState in an effect body is a cascading render.
    if (ended) queueMicrotask(() => setTurnToken((token) => token + 1))
  }, [isGenerating])

  React.useEffect(() => {
    if (!activeId) return
    let cancelled = false
    api
      .fetchSkills(activeId)
      .then((catalog) => {
        if (!cancelled) setLoaded({ id: activeId, catalog })
      })
      .catch(() => {
        /* A catalog nobody could scan is an empty menu, not an error. */
      })
    return () => {
      cancelled = true
    }
  }, [activeId, cwd, turnToken])

  const catalog = loaded.id === activeId ? loaded.catalog : EMPTY_SKILL_CATALOG

  /**
   * The app's own `/` commands plus the harness's. Memoized on the catalog:
   * the composer that receives it is memoized, and a fresh array every render
   * would rebuild it on every streamed token.
   */
  const slashCommands = React.useMemo<ChatSlashCommand[]>(
    () => slashCommandsWith(catalog.commands),
    [catalog.commands]
  )

  /**
   * The names `send` dispatches on. A ref, because `send` must read the
   * catalog the user is looking at without closing over it — the same reason
   * everything in `use-chat-refs` is one.
   */
  const knownSkillNamesRef = React.useRef<ReadonlySet<string>>(new Set())
  const skillNames = React.useMemo(
    () => new Set(catalog.skills.map((skill) => skill.name)),
    [catalog.skills]
  )
  React.useEffect(() => {
    knownSkillNamesRef.current = skillNames
  }, [skillNames])

  return {
    catalog,
    skills: catalog.skills,
    commands: catalog.commands,
    slashCommands,
    knownSkillNamesRef,
  }
}
