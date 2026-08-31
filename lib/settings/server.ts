import "server-only"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  normalizeSettings,
  type AppSettings,
} from "@/lib/settings/schema"

export function dataDir() {
  return process.env.AGENT_UI_DIR ?? join(homedir(), ".agent-ui")
}

const settingsPath = () => join(dataDir(), "settings.json")

export async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), "utf8")
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return normalizeSettings(undefined)
  }
}

export async function writeSettings(value: unknown): Promise<AppSettings> {
  const next = normalizeSettings(value)
  await mkdir(dataDir(), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8")
  return next
}
