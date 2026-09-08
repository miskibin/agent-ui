import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, beforeEach, test } from "node:test"

import { folderHue, folderMonogram } from "@/lib/folder-logo"
import { clearFolderLogoCache, folderLogo } from "@/lib/folder-logo-scan"

/**
 * The mark beside a sidebar folder. Three things a wrong answer would hide:
 * which of several icon files a project's own choice wins over a framework
 * default, that a folder with no icon still gets something distinguishable,
 * and that the home directory is left as a home directory rather than dressed
 * up as a project.
 */

const roots: string[] = []

function tempFolder(name: string) {
  const root = mkdtempSync(join(tmpdir(), "agent-ui-logo-"))
  roots.push(root)
  const folder = join(root, name)
  mkdirSync(folder, { recursive: true })
  return folder
}

function file(folder: string, relative: string, body: string) {
  const path = join(folder, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

beforeEach(() => {
  clearFolderLogoCache()
})

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

test("a project's icon is inlined as a data URL", async () => {
  const folder = tempFolder("dashboard")
  file(folder, "public/favicon.ico", "icon-bytes")
  const logo = await folderLogo(folder)
  assert.equal(logo.kind, "icon")
  assert.ok(logo.kind === "icon" && logo.src.startsWith("data:image/x-icon;base64,"))
  assert.equal(
    logo.kind === "icon"
      ? Buffer.from(logo.src.split(",")[1], "base64").toString()
      : "",
    "icon-bytes"
  )
})

test("the mark the project chose beats the framework's default", async () => {
  const folder = tempFolder("shop")
  file(folder, "public/favicon.ico", "default")
  file(folder, "public/logo.svg", "<svg/>")
  const logo = await folderLogo(folder)
  assert.equal(
    logo.kind === "icon" ? Buffer.from(logo.src.split(",")[1], "base64").toString() : "",
    "<svg/>"
  )
})

test("an icon too big for a 16px glyph is skipped, not shrunk", async () => {
  const folder = tempFolder("press-kit")
  file(folder, "public/logo.png", "x".repeat(200 * 1024))
  const logo = await folderLogo(folder)
  assert.equal(logo.kind, "monogram")
})

test("a project with no icon still gets a mark of its own", async () => {
  const folder = tempFolder("agent-ui")
  const logo = await folderLogo(folder)
  assert.equal(logo.kind, "monogram")
  assert.equal(logo.kind === "monogram" && logo.text, "AU")
})

test("the home directory is not a project", async () => {
  assert.equal((await folderLogo(homedir())).kind, "generic")
  assert.equal((await folderLogo(dirname(homedir()))).kind, "generic")
  assert.equal((await folderLogo("/")).kind, "generic")
})

test("a folder that has gone away is a folder glyph, not a throw", async () => {
  const logo = await folderLogo(join(tmpdir(), "agent-ui-logo-nothing-here"))
  assert.equal(logo.kind, "generic")
})

test("initials read the folder's own name", () => {
  assert.equal(folderMonogram("agent-ui"), "AU")
  assert.equal(folderMonogram("chat_components"), "CC")
  assert.equal(folderMonogram("my.app"), "MA")
  // One word gives two letters: a single initial collides constantly.
  assert.equal(folderMonogram("monorepo"), "MO")
  // A leading dot is punctuation, not a word.
  assert.equal(folderMonogram(".config"), "CO")
  assert.equal(folderMonogram("2fa"), "2F")
  assert.equal(folderMonogram("···"), "·")
})

test("the colour is a stable function of the whole path", () => {
  assert.equal(folderHue("/home/me/web"), folderHue("/home/me/web"))
  // Two `web` folders in two checkouts are two projects.
  assert.notEqual(folderHue("/a/web"), folderHue("/b/web"))
  for (const path of ["/", "/a", "/home/me/agent-ui", "C:\\repo"]) {
    const hue = folderHue(path)
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, path)
  }
})
