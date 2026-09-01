import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { promisify } from "node:util"

import { NextResponse } from "next/server"

import { expandHome } from "@/lib/fs-paths"
import type { FolderInfo } from "@/lib/folder"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const run = promisify(execFile)

/** Enough for a large monorepo; a runaway `git branch` is not worth waiting on. */
const GIT_TIMEOUT_MS = 3_000
const MAX_BRANCHES = 200

/**
 * Inspects a candidate working folder for the per-chat folder picker: does it
 * exist, is it a directory, is it a git repo, and which local branches does it
 * have.
 *
 * Every git call goes through `execFile` with a fixed argv and the user's path
 * only ever as `cwd`, so nothing the user types can become a git argument, let
 * alone a shell word.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("path")?.trim() ?? ""
  if (!raw) {
    return NextResponse.json({ error: "path is required" }, { status: 400 })
  }

  const path = expandHome(raw)
  const empty: FolderInfo = {
    path,
    exists: false,
    isDir: false,
    isGitRepo: false,
    branches: [],
    currentBranch: "",
  }

  if (!isAbsolute(path)) {
    return NextResponse.json(empty)
  }

  const info = await stat(path).catch(() => null)
  if (!info) return NextResponse.json(empty)
  if (!info.isDirectory()) {
    return NextResponse.json({ ...empty, exists: true })
  }

  const git = await readGit(path)
  return NextResponse.json({ ...empty, exists: true, isDir: true, ...git })
}

async function readGit(cwd: string) {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"])
  if (inside?.trim() !== "true") return { isGitRepo: false }

  const [current, list] = await Promise.all([
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["branch", "--format=%(refname:short)"]),
  ])

  const branches = (list ?? "")
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean)
    .slice(0, MAX_BRANCHES)

  return {
    isGitRepo: true,
    branches,
    currentBranch: current?.trim() ?? "",
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    return stdout
  } catch {
    // Not a repo, no git on PATH, or the call timed out — all "no branches".
    return null
  }
}
