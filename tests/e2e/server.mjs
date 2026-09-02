import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Everything the flow suite needs around the app itself: a production build,
 * the standalone server running on a free port against a throwaway
 * `AGENT_UI_DIR`, and a Chromium from the browsers already installed on this
 * machine.
 *
 * Playwright is resolved from wherever it happens to live — the project, or a
 * global install — rather than added as a dependency of the app: this suite is
 * deliberately outside `npm test`, and the app ships no test runner.
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const STANDALONE = path.join(ROOT, ".next", "standalone")

/** Where the tests park their data directories and fixtures. */
const SCRATCH = process.env.AGENT_UI_E2E_TMP ?? path.join(tmpdir(), "agent-ui-e2e")

export async function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const globalRoot = path.join(path.dirname(process.execPath), "..", "lib", "node_modules")
  const candidates = [
    process.env.AGENT_UI_PLAYWRIGHT,
    "playwright",
    "playwright-core",
    path.join(globalRoot, "playwright", "index.mjs"),
    path.join(globalRoot, "playwright-core", "index.mjs"),
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      // A bare specifier resolves against this file; an absolute path is used
      // as it stands, which is how a global install is reached.
      const target = candidate.startsWith("/") ? candidate : require.resolve(candidate)
      return await import(target.startsWith("file:") ? target : `file://${target}`)
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    "Playwright was not found. Install it (npm i -D playwright) or point AGENT_UI_PLAYWRIGHT at it."
  )
}

/** Chromium, preferring whatever browser this machine already has installed. */
export async function launchChromium(playwright) {
  const explicit = process.env.AGENT_UI_CHROMIUM
  const wellKnown = "/opt/pw-browsers/chromium"
  const options = { headless: true }
  try {
    return await playwright.chromium.launch(options)
  } catch (error) {
    const executablePath = explicit ?? (existsSync(wellKnown) ? wellKnown : "")
    if (!executablePath) throw error
    return playwright.chromium.launch({ ...options, executablePath })
  }
}

/** `next build`, unless a standalone bundle is already sitting there. */
export function ensureBuild({ force = false } = {}) {
  if (!force && existsSync(path.join(STANDALONE, "server.js"))) return
  const build = spawnSync("npm", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  })
  if (build.status !== 0) throw new Error("next build failed")
}

/**
 * The standalone bundle carries `server.js` and its pruned `node_modules`;
 * static assets and `public` are left out of it, exactly as
 * `scripts/prepare-desktop.mjs` describes.
 */
async function stageAssets() {
  await fs.cp(path.join(ROOT, ".next", "static"), path.join(STANDALONE, ".next", "static"), {
    recursive: true,
    force: true,
  })
  if (existsSync(path.join(ROOT, "public"))) {
    await fs.cp(path.join(ROOT, "public"), path.join(STANDALONE, "public"), {
      recursive: true,
      force: true,
    })
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function waitForServer(baseUrl, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server exited with ${child.exitCode} before answering`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/settings`)
      if (response.ok) return
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`the server did not answer on ${baseUrl}`)
}

/**
 * Starts `node .next/standalone/server.js` on a free port with its own data
 * directory, and returns everything the suite needs to talk to it — including
 * `folder`, a scratch directory a chat can be pointed at.
 */
export async function startApp() {
  ensureBuild()
  await stageAssets()

  await fs.mkdir(SCRATCH, { recursive: true })
  const workDir = await mkdtemp(path.join(SCRATCH, "run-"))
  const dataDir = path.join(workDir, "data")
  const folder = path.join(workDir, "project")
  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(folder, { recursive: true })

  const port = await freePort()
  const child = spawn(process.execPath, [path.join(STANDALONE, "server.js")], {
    // `process.cwd()` is one of the roots the file routes resolve against, so
    // the server is started where a user would start it.
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_UI_DIR: dataDir,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const log = []
  child.stdout.on("data", (chunk) => log.push(String(chunk)))
  child.stderr.on("data", (chunk) => log.push(String(chunk)))

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitForServer(baseUrl, child)
  } catch (error) {
    child.kill("SIGKILL")
    throw new Error(`${error.message}\n${log.join("")}`)
  }

  return {
    baseUrl,
    dataDir,
    workDir,
    folder,
    log,
    async stop() {
      child.kill("SIGTERM")
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve()
        }, 3_000)
        child.once("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
      await rm(workDir, { recursive: true, force: true })
    },
  }
}
