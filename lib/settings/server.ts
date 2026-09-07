import "server-only"

import { mkdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { writeFileAtomic } from "@/lib/atomic-write"
import {
  normalizeSettings,
  type AppSettings,
} from "@/lib/settings/schema"

export function dataDir() {
  return process.env.AGENT_UI_DIR ?? join(homedir(), ".agent-ui")
}

const settingsPath = () => join(dataDir(), "settings.json")

/**
 * The state this process last wrote, and the mtime the file carried then.
 *
 * settings.json holds one object, so every write is a read-modify-write of the
 * whole thing — and the readers are spread across a browser round trip
 * (`lib/settings/client`), so "read" and "write" are seconds apart. Anything
 * that edits the file in between (the user's editor, a second window, another
 * process) is invisible to a writer that only ever sends what it read, and its
 * PUT would put that edit back the way it was.
 */
let lastRead: { path: string; mtimeMs: number; value: AppSettings } | null = null

/** The baseline belongs to one file; `AGENT_UI_DIR` can point at another. */
function baselineFor(path: string) {
  return lastRead?.path === path ? lastRead : null
}

async function fileMtime(): Promise<number | null> {
  return stat(settingsPath())
    .then((info) => info.mtimeMs)
    .catch(() => null)
}

export async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), "utf8")
    const value = normalizeSettings(JSON.parse(raw))
    // The baseline is what this process last *wrote* (or the first thing it
    // ever read), never the newest read: a read that happens to land after
    // someone else's edit would otherwise adopt that edit as the state every
    // in-flight writer is assumed to have started from, which is exactly the
    // assumption being checked below.
    const path = settingsPath()
    if (!baselineFor(path)) {
      lastRead = { path, mtimeMs: (await fileMtime()) ?? 0, value }
    }
    return value
  } catch {
    return normalizeSettings(undefined)
  }
}

export async function writeSettings(value: unknown): Promise<AppSettings> {
  const next = normalizeSettings(value)
  const merged = await mergeOverExternalEdits(next)
  // Owner-only: this file carries the harness and model-provider API keys.
  // (Both modes are advisory on Windows, which has no POSIX bits.)
  await mkdir(dataDir(), { recursive: true, mode: 0o700 })
  await writeFileAtomic(settingsPath(), JSON.stringify(merged, null, 2), {
    mode: 0o600,
  })
  lastRead = { path: settingsPath(), mtimeMs: (await fileMtime()) ?? 0, value: merged }
  return merged
}

/**
 * The file moved under us since the last read: re-read it, and apply only the
 * subtrees this write actually *changed* against the state it was built from.
 * Everything it merely carried along stays as the file now has it, so a save
 * in flight can no longer write another writer's subtree back stale.
 *
 * With no baseline to compare against there is nothing to be clever about —
 * the incoming object is the whole answer, exactly as before.
 */
async function mergeOverExternalEdits(next: AppSettings): Promise<AppSettings> {
  const baseline = baselineFor(settingsPath())
  if (!baseline) return next
  const mtimeMs = await fileMtime()
  if (mtimeMs === null || mtimeMs === baseline.mtimeMs) return next
  const raw = await readFile(settingsPath(), "utf8").catch(() => null)
  if (raw === null) return next
  let current: AppSettings
  try {
    current = normalizeSettings(JSON.parse(raw))
  } catch {
    // An unparseable file is not a state worth preserving.
    return next
  }
  return applyChanges(baseline.value, next, current) as AppSettings
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Three-way merge: `next` wins wherever it differs from `base`, else `current`. */
function applyChanges(base: unknown, next: unknown, current: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(next) || !isPlainObject(current)) {
    return next
  }
  const merged: Record<string, unknown> = { ...current }
  // A key the write dropped (a model provider the user deleted) is a change
  // like any other, and re-reading must not hand it back.
  for (const key of Object.keys(base)) {
    if (!(key in next)) delete merged[key]
  }
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) === JSON.stringify(base[key])) continue
    merged[key] = applyChanges(base[key], value, current[key])
  }
  return merged
}
