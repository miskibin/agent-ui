import { NextResponse } from "next/server"

import { importConversations } from "@/lib/import/import"
import { isImportProvider, type ImportRequest } from "@/lib/import/types"
import { crossOriginRefusal } from "@/lib/request-origin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * `POST /api/import` — bring the named folders' conversations in as chats.
 *
 * `{ provider, cwds?, sessionIds? }`; both filters narrow, and a request with
 * neither imports everything that provider has. The answer is a count, not the
 * chats themselves: the caller reloads the sidebar index it already reads.
 *
 * Importing is idempotent. A conversation already brought over is counted in
 * `skipped` and left exactly as it stands, turns added here included.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 })
  }

  const request = parseRequest(body)
  if (!request) {
    return NextResponse.json(
      { error: "provider must be 'claude-code' or 'codex'" },
      { status: 400 }
    )
  }
  return NextResponse.json(await importConversations(request))
}

function parseRequest(body: unknown): ImportRequest | null {
  if (typeof body !== "object" || body === null) return null
  const value = body as Record<string, unknown>
  if (!isImportProvider(value.provider)) return null
  return {
    provider: value.provider,
    ...(Array.isArray(value.cwds)
      ? { cwds: value.cwds.filter((entry): entry is string => typeof entry === "string") }
      : null),
    ...(Array.isArray(value.sessionIds)
      ? {
          sessionIds: value.sessionIds.filter(
            (entry): entry is string => typeof entry === "string"
          ),
        }
      : null),
  }
}
