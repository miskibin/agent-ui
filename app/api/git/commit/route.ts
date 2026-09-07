import path from "node:path"

import { NextResponse } from "next/server"

import { checkpointRoot } from "@/app/api/checkpoints/session-root"
import { canComplete, complete } from "@/lib/completion"
import { realPath } from "@/lib/fs-roots"
import {
  commit,
  currentBranch,
  generateCommitMessage,
  prepareCommitContext,
  sanitizeCommitMessage,
  type CommitStyle,
} from "@/lib/git-commit"
import { invalidateGitStatus } from "@/lib/git-status"
import { crossOriginRefusal } from "@/lib/request-origin"
import { readSettings } from "@/lib/settings/server"
import { getSession } from "@/lib/store/sessions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STYLES: CommitStyle[] = ["conventional", "repo-conventions", "custom"]

/** A generated message is a subject and a few lines; nothing needs more. */
const MAX_MESSAGE_TOKENS = 400

/**
 * `POST /api/git/commit { sessionId, paths?, message?, style?,
 * allowDefaultBranch? }` — stages what the chat changed and commits it, with a
 * message the user wrote or one written from the diff.
 *
 * The folder is resolved from the *chat*, never from the client (see
 * `app/api/checkpoints/session-root.ts`), and every path in `paths` has to
 * resolve inside it — with symlinks followed on both sides, the same way
 * `POST /api/git/revert` does it.
 *
 * Two answers are not failures and are typed as such: `needsConfirmation:
 * "default-branch"` when the branch is the repo's trunk (the UI asks, and
 * calls again with `allowDefaultBranch`), and a 409 when staging produced
 * nothing to commit.
 *
 * The confirmation carries the message that was written for the commit, and
 * the second call is expected to pass it back as `message` — the question was
 * "commit *this* onto main?", and answering it should not pay for a second
 * completion or risk a differently worded one.
 */
export async function POST(req: Request) {
  const refused = crossOriginRefusal(req)
  if (refused) return refused

  let body: {
    sessionId?: string
    paths?: unknown
    message?: string
    style?: string
    allowDefaultBranch?: boolean
  }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const root = await checkpointRoot(body.sessionId)
  if (!root.ok) {
    return NextResponse.json({ error: root.error }, { status: root.status })
  }
  const cwd = root.cwd

  // Every path is resolved into the chat's folder before git sees it, and git
  // only ever sees the relative form.
  const requested = Array.isArray(body.paths)
    ? body.paths.filter((entry): entry is string => typeof entry === "string")
    : []
  const paths: string[] = []
  const realRoot = await realPath(cwd)
  for (const entry of requested) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const target = await realPath(path.resolve(cwd, trimmed))
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
      return NextResponse.json(
        { error: "That path is outside the chat's folder" },
        { status: 403 }
      )
    }
    paths.push(path.relative(realRoot, target) || ".")
  }

  const branch = await currentBranch(cwd)
  const context = await prepareCommitContext(cwd, paths.length ? paths : undefined)
  if (context.nothingStaged) {
    return NextResponse.json(
      { error: "Nothing to commit — the working tree is clean" },
      { status: 409 }
    )
  }

  const typed = body.message?.trim()
  let message: string
  if (typed) {
    message = sanitizeCommitMessage(typed).message
  } else {
    const settings = await readSettings()
    const session = await getSession(body.sessionId ?? "")
    // The chat's own model when this app can reach it directly, else the one
    // the memory extractor uses — the same order `POST /api/sessions/<id>/title`
    // follows, and for the same reason: a CLI harness's model is not something
    // a plain completion can call.
    const candidates = [
      ...new Set(
        [session?.model, settings.memory.model].filter(
          (model): model is string => !!model && canComplete(settings, model)
        )
      ),
    ]
    if (!candidates.length) {
      return NextResponse.json(
        {
          error:
            "No model to ask — pick an Ollama or hosted model for this chat, or set a memory model in Settings",
        },
        { status: 409 }
      )
    }
    const style = STYLES.includes(body.style as CommitStyle)
      ? (body.style as CommitStyle)
      : "repo-conventions"

    let failure = ""
    let generated = ""
    for (const model of candidates) {
      try {
        const written = await generateCommitMessage({
          cwd,
          context,
          style,
          branch,
          complete: (prompt) =>
            complete(
              settings,
              model,
              [
                { role: "system", content: prompt.system },
                { role: "user", content: prompt.user },
              ],
              { maxTokens: MAX_MESSAGE_TOKENS }
            ),
        })
        generated = written.message
        if (generated.trim()) break
      } catch (err) {
        failure =
          err instanceof Error ? err.message : "Could not write a commit message"
      }
    }
    if (!generated.trim()) {
      return NextResponse.json(
        { error: failure || "The model returned an empty commit message" },
        { status: 502 }
      )
    }
    message = generated
  }

  const result = await commit(cwd, message, {
    allowDefaultBranch: body.allowDefaultBranch === true,
  })
  if (!result.ok) {
    if (result.needsConfirmation) {
      // Not an error: the UI asks, then calls again with allowDefaultBranch.
      return NextResponse.json({
        needsConfirmation: result.needsConfirmation,
        branch: result.branch,
        message,
        subject: sanitizeCommitMessage(message).subject,
      })
    }
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  invalidateGitStatus(cwd)
  return NextResponse.json({
    ok: true,
    sha: result.sha,
    message: result.message,
    subject: result.subject,
  })
}
