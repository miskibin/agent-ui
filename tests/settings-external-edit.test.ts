import assert from "node:assert/strict"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { readSettings, writeSettings } from "@/lib/settings/server"

/**
 * settings.json holds one object and has more than one writer — the settings
 * panel, the theme client, the folder picker — each sending back the whole
 * file it read seconds earlier. A file that changed in between must not be
 * flattened by whichever writer lands last.
 */

async function useTempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "agent-ui-settings-"))
  process.env.AGENT_UI_DIR = dir
  return { dir, file: join(dir, "settings.json") }
}

test("settings are written owner-only, and read back", async () => {
  const { file } = await useTempDataDir()
  const written = await writeSettings({ chat: { desktopNotifications: false } })
  assert.equal(written.chat.desktopNotifications, false)
  assert.equal((await readSettings()).chat.desktopNotifications, false)
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
})

test("an edit that landed in between survives the write that missed it", async () => {
  const { file } = await useTempDataDir()
  await writeSettings({})

  // One writer reads the file...
  const current = await readSettings()

  // ...another process rewrites it while that one is deciding.
  const external = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
  // A filesystem with a coarse clock could stamp this with the mtime the read
  // above already saw.
  await new Promise((resolve) => setTimeout(resolve, 12))
  await writeFile(
    file,
    JSON.stringify({
      ...external,
      appearance: { ...(external.appearance as object), theme: "notebook" },
    }),
    "utf8"
  )

  // The first writer now sends back what it read, with only its own subtree
  // changed. Its stale `appearance` must not undo the edit it never saw.
  const saved = await writeSettings({
    ...current,
    chat: { ...current.chat, desktopNotifications: false },
  })
  assert.equal(saved.appearance.theme, "notebook")
  assert.equal(saved.chat.desktopNotifications, false)
  assert.equal((await readSettings()).appearance.theme, "notebook")
})

test("with no external edit the write is taken as it stands", async () => {
  await useTempDataDir()
  const first = await writeSettings({ appearance: { theme: "notebook" } })
  assert.equal(first.appearance.theme, "notebook")
  const current = await readSettings()
  const saved = await writeSettings({
    ...current,
    appearance: { ...current.appearance, theme: "vercel" },
  })
  assert.equal(saved.appearance.theme, "vercel")
})
