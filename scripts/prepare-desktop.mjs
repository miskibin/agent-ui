#!/usr/bin/env node
/**
 * Stages everything the Tauri shell bundles:
 *
 *   1. `next build` (standalone output)
 *   2. `.next/standalone` + `.next/static` + `public` -> src-tauri/resources/app
 *   3. the platform's Node runtime  -> src-tauri/binaries/node-<target-triple>
 *
 * Run automatically as `beforeBuildCommand`, from `src-tauri/build.rs` when
 * the sidecar is missing (`tauri dev` / `cargo check`), or by hand:
 *
 *   node scripts/prepare-desktop.mjs
 *   node scripts/prepare-desktop.mjs --target aarch64-apple-darwin
 *   node scripts/prepare-desktop.mjs --skip-next   # only the Node runtime
 *
 * `--skip-next` skips the (slow) web build: tauri-build refuses to compile when
 * `externalBin` / `bundle.resources` cannot be resolved, so it fetches the Node
 * binary and leaves a placeholder resource dir. `build.rs` calls this on a
 * fresh checkout so `tauri dev` works without a manual prepare step.
 *
 * Set AGENT_UI_DESKTOP_PREPARED=1 to make an already-prepared tree a no-op
 * (release CI prepares explicitly, then lets `tauri build` skip the repeat).
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TAURI_DIR = path.join(ROOT, "src-tauri")
const APP_DIR = path.join(TAURI_DIR, "resources", "app")
const BIN_DIR = path.join(TAURI_DIR, "binaries")

/** Pinned so every machine bundles the same runtime. */
const NODE_VERSION = process.env.AGENT_UI_NODE_VERSION ?? "v22.22.2"

/** Rust target triple -> nodejs.org/dist artifact. */
const NODE_BUILDS = {
  "x86_64-pc-windows-msvc": { slug: "win-x64", ext: "zip", bin: "node.exe" },
  "aarch64-apple-darwin": { slug: "darwin-arm64", ext: "tar.gz", bin: "bin/node" },
  "x86_64-apple-darwin": { slug: "darwin-x64", ext: "tar.gz", bin: "bin/node" },
  "x86_64-unknown-linux-gnu": { slug: "linux-x64", ext: "tar.gz", bin: "bin/node" },
}

function parseArgs(argv) {
  const options = { skipNext: false, target: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--skip-next") options.skipNext = true
    else if (arg === "--target") options.target = argv[++i]
    else if (arg.startsWith("--target=")) options.target = arg.slice(9)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

/** The Rust target triple this machine builds for by default. */
function hostTriple() {
  const arch = os.arch()
  switch (os.platform()) {
    case "win32":
      return "x86_64-pc-windows-msvc"
    case "darwin":
      return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
    case "linux":
      return "x86_64-unknown-linux-gnu"
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`)
  }
}

function log(message) {
  process.stdout.write(`[prepare-desktop] ${message}\n`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`)
  }
}

function has(command) {
  const probe = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  })
  return !probe.error && probe.status === 0
}

async function exists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * curl first: it honours HTTPS_PROXY and the system CA store, which matters on
 * locked-down networks. fetch is the fallback for images without curl.
 */
async function download(url, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  if (has("curl")) {
    run("curl", ["-fsSL", "--retry", "3", "--retry-delay", "2", "-o", destination, url])
    return
  }
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}): ${url}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

/**
 * nodejs.org publishes SHASUMS256.txt beside every artifact, so a download is
 * checked before anything is unpacked from it: an archive that does not match
 * is a truncated transfer or a mirror that lied, and either way it must not
 * become the runtime the app ships.
 */
async function verifyArchive(archive, archiveName, workDir) {
  const sumsPath = path.join(workDir, "SHASUMS256.txt")
  await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sumsPath)
  const line = (await fs.readFile(sumsPath, "utf8"))
    .split("\n")
    .find((entry) => entry.trimEnd().endsWith(` ${archiveName}`))
  if (!line) {
    throw new Error(`No SHASUMS256 entry for ${archiveName} in ${NODE_VERSION}`)
  }
  const expected = line.trim().split(/\s+/)[0]
  const actual = await sha256(archive)
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${archiveName}\n  expected ${expected}\n  got      ${actual}`
    )
  }
  log(`sha256 ok: ${archiveName}`)
}

async function sha256(file) {
  const hash = createHash("sha256")
  await pipeline(createReadStream(file), hash)
  return hash.digest("hex")
}

/** Extracts a single member out of the Node archive. */
async function extractNodeBinary(archive, build, workDir, destination) {
  if (build.ext === "zip") {
    // PowerShell ships with every supported Windows version; no unzip needed.
    run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${workDir}' -Force`,
    ])
    const extracted = path.join(
      workDir,
      `node-${NODE_VERSION}-${build.slug}`,
      build.bin
    )
    await fs.copyFile(extracted, destination)
    return
  }

  // tar (GNU and bsdtar alike) understands --strip-components; asking for the
  // single member keeps this to a couple of hundred milliseconds.
  const member = `node-${NODE_VERSION}-${build.slug}/${build.bin}`
  const depth = member.split("/").length - 1
  run("tar", [
    "-xzf",
    archive,
    "-C",
    workDir,
    `--strip-components=${depth}`,
    member,
  ])
  await fs.copyFile(path.join(workDir, path.basename(build.bin)), destination)
  await fs.chmod(destination, 0o755)
}

/** Downloads the Node runtime for `triple` into src-tauri/binaries. */
async function prepareNode(triple) {
  const build = NODE_BUILDS[triple]
  if (!build) {
    throw new Error(
      `No Node build mapped for ${triple}. Known: ${Object.keys(NODE_BUILDS).join(", ")}`
    )
  }

  const suffix = triple.includes("windows") ? ".exe" : ""
  const destination = path.join(BIN_DIR, `node-${triple}${suffix}`)
  if (await exists(destination)) {
    log(`node sidecar already present: ${path.relative(ROOT, destination)}`)
    return destination
  }

  const archiveName = `node-${NODE_VERSION}-${build.slug}.${build.ext}`
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}`
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ui-node-"))

  try {
    log(`downloading ${url}`)
    const archive = path.join(workDir, archiveName)
    await download(url, archive)
    await verifyArchive(archive, archiveName, workDir)
    await fs.mkdir(BIN_DIR, { recursive: true })
    await extractNodeBinary(archive, build, workDir, destination)
    log(`node sidecar -> ${path.relative(ROOT, destination)}`)
  } finally {
    await fs.rm(workDir, { recursive: true, force: true })
  }

  return destination
}

/** Builds Next and stages the standalone server under src-tauri/resources/app. */
async function prepareWebApp() {
  log("building the web app (next build)")
  run("npm", ["run", "build"], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  })

  const standalone = path.join(ROOT, ".next", "standalone")
  if (!(await exists(path.join(standalone, "server.js")))) {
    throw new Error(
      "`.next/standalone/server.js` is missing — is `output: \"standalone\"` still set in next.config.ts?"
    )
  }

  log("staging the standalone server")
  await fs.rm(APP_DIR, { recursive: true, force: true })
  await fs.mkdir(APP_DIR, { recursive: true })

  // The standalone bundle carries server.js plus its pruned node_modules.
  await fs.cp(standalone, APP_DIR, { recursive: true })
  // Static assets and public files are deliberately left out of it.
  await fs.cp(path.join(ROOT, ".next", "static"), path.join(APP_DIR, ".next", "static"), {
    recursive: true,
  })
  if (await exists(path.join(ROOT, "public"))) {
    await fs.cp(path.join(ROOT, "public"), path.join(APP_DIR, "public"), {
      recursive: true,
    })
  }
  log(`web app -> ${path.relative(ROOT, APP_DIR)}`)
}

/**
 * `bundle.resources` points at a directory, and tauri-build errors out when it
 * does not exist — so `--skip-next` still leaves something resolvable.
 */
async function ensureResourcePlaceholder() {
  if (await exists(path.join(APP_DIR, "server.js"))) {
    log("keeping the already staged web app")
    return
  }
  await fs.mkdir(APP_DIR, { recursive: true })
  await fs.writeFile(
    path.join(APP_DIR, "PLACEHOLDER"),
    "Populated by scripts/prepare-desktop.mjs. Not a runnable build.\n"
  )
  log("wrote a placeholder resource dir (--skip-next)")
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const triple = options.target ?? hostTriple()

  if (
    process.env.AGENT_UI_DESKTOP_PREPARED === "1" &&
    (await exists(path.join(APP_DIR, "server.js")))
  ) {
    log("AGENT_UI_DESKTOP_PREPARED=1 and the bundle is staged — nothing to do")
    return
  }

  log(`target ${triple}, node ${NODE_VERSION}`)
  if (options.skipNext) await ensureResourcePlaceholder()
  else await prepareWebApp()
  await prepareNode(triple)
  log("ready")
}

main().catch((error) => {
  process.stderr.write(`[prepare-desktop] ${error?.stack ?? error}\n`)
  process.exit(1)
})
