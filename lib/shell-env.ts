// Adapted from T3 Code (github.com/pingdotgg/t3code), MIT License, (c) 2026 T3 Tools Inc.

import "server-only"

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { userInfo } from "node:os"
import path from "node:path"

/**
 * Teaching the server the PATH its user actually has.
 *
 * Every CLI harness in this app is found by looking through `process.env.PATH`
 * — `claude`, `cursor-agent`, `pi`, `ollama`, `git`, `gh`. That works in a
 * terminal, where the shell has already sourced `.zshrc`, nvm, Volta, fnm,
 * Homebrew and whatever else put those binaries somewhere. It does not work in
 * the desktop app: a GUI process on macOS is launched by `launchd` and
 * inherits a PATH of `/usr/bin:/bin:/usr/sbin:/sbin`, so every harness the
 * user has installed reads as "not installed" and the provider list comes up
 * empty for no reason anyone can see.
 *
 * The repair is to ask the login shell what it thinks PATH is, once, at boot,
 * and merge the answer into this process — the inherited entries kept, the
 * shell's order preferred, nothing dropped. `HOME` gets the same treatment,
 * because a service manager can start a process without one and half the CLIs
 * store their credentials under it.
 *
 * Three rules hold this together:
 *
 * - **It never fails a boot.** Every probe is wrapped; a shell that hangs, a
 *   `launchctl` that is not there, a PowerShell that refuses to run — each is
 *   a warning on stderr and the inherited environment stands.
 * - **It runs before the first request.** `instrumentation.ts` awaits it, and
 *   the harness detection that reads PATH happens on a request.
 * - **It is skippable.** `AGENT_UI_SKIP_SHELL_ENV=1` turns it off for CI and
 *   for tests, which must not spawn the machine's login shell.
 */

/** Long enough for a slow `.zshrc`, short enough not to hold up a boot. */
const SHELL_TIMEOUT_MS = 5_000
const LAUNCHCTL_TIMEOUT_MS = 2_000
const WINDOWS_SHELLS = ["pwsh.exe", "powershell.exe"] as const

/** Variables a shell is asked about must be plain names — they go into a command. */
const ENV_NAME_PATTERN = /^[A-Z0-9_]+$/

export type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number }
) => string

export type HydrateDependencies = {
  platform?: NodeJS.Platform
  execFile?: ExecFileSyncLike
  /** The account's shell, for the `$SHELL`-is-missing case. */
  userShell?: string | undefined
  /** The account's home directory, for the `$HOME`-is-missing case. */
  homeDir?: () => string
  /** Where a warning goes. */
  warn?: (message: string) => void
  /** Whether a command can be found on a candidate PATH (Windows retry). */
  isOnPath?: (command: string, env: NodeJS.ProcessEnv) => boolean
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function delimiterFor(platform: NodeJS.Platform) {
  return platform === "win32" ? ";" : ":"
}

/**
 * The login shells worth asking, in order: what the environment says, then
 * what the account says, then the platform's default. Deduped, so a machine
 * where both agree is asked once.
 */
export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell: string | undefined
): string[] {
  const fallback =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined
  const candidates: string[] = []
  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallback]) {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate)
  }
  return candidates
}

/**
 * The two PATHs as one, `preferred` first, each entry kept once.
 *
 * Order is the whole value of this: the shell's PATH is the order the user's
 * version managers agreed on, and appending the inherited entries after it
 * means a system `/usr/bin/node` can no longer shadow the one nvm selected.
 * Windows compares case-insensitively and drops the quotes a hand-edited PATH
 * sometimes carries.
 */
export function mergePathValues(
  preferred: string | undefined,
  inherited: string | undefined,
  platform: NodeJS.Platform
): string | undefined {
  const delimiter = delimiterFor(platform)
  const merged: string[] = []
  const seen = new Set<string>()
  for (const value of [preferred, inherited]) {
    if (!value) continue
    for (const rawEntry of value.split(delimiter)) {
      const entry =
        platform === "win32" ? rawEntry.trim().replaceAll('"', "") : rawEntry.trim()
      if (!entry) continue
      const key = platform === "win32" ? entry.toLowerCase() : entry
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
    }
  }
  return merged.length > 0 ? merged.join(delimiter) : undefined
}

const captureStart = (name: string) => `__AGENT_UI_ENV_${name}_START__`
const captureEnd = (name: string) => `__AGENT_UI_ENV_${name}_END__`

/**
 * A `printenv` between two sentinels per variable.
 *
 * The sentinels are the point: an interactive login shell prints whatever the
 * user's rc files print — a fortune, a version-manager banner, a `nvm use`
 * line — and the answer has to be findable inside that. `|| true` keeps an
 * unset variable from ending the command under `set -e`.
 */
export function buildEnvCaptureCommand(names: readonly string[]): string {
  return names
    .map((name) => {
      if (!ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`)
      }
      return [
        `printf '%s\\n' '${captureStart(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${captureEnd(name)}'`,
      ].join("; ")
    })
    .join("; ")
}

/** The value between one variable's sentinels, or undefined. */
export function extractEnvValue(output: string, name: string): string | undefined {
  const start = output.indexOf(captureStart(name))
  if (start === -1) return undefined
  const valueStart = start + captureStart(name).length
  const end = output.indexOf(captureEnd(name), valueStart)
  if (end === -1) return undefined
  const value = output
    .slice(valueStart, end)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "")
  return value.length > 0 ? value : undefined
}

/**
 * The well-known places Windows installers put CLIs, for the case where the
 * shell probe fails or a desktop launch never had the user's PATH at all.
 */
export function knownWindowsCliDirs(env: NodeJS.ProcessEnv): string[] {
  const appData = trimNonEmpty(env.APPDATA)
  const localAppData = trimNonEmpty(env.LOCALAPPDATA)
  const userProfile = trimNonEmpty(env.USERPROFILE)
  return [
    ...(appData ? [`${appData}\\npm`] : []),
    ...(localAppData
      ? [
          `${localAppData}\\Programs\\nodejs`,
          `${localAppData}\\Volta\\bin`,
          `${localAppData}\\pnpm`,
        ]
      : []),
    ...(userProfile
      ? [
          `${userProfile}\\.local\\bin`,
          `${userProfile}\\.bun\\bin`,
          `${userProfile}\\scoop\\shims`,
        ]
      : []),
  ]
}

/* -------------------------------------------------------------------------- */
/* Probes                                                                      */
/* -------------------------------------------------------------------------- */

/** `-ilc`: interactive *and* login, because the two read different rc files. */
export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = execFileSync as unknown as ExecFileSyncLike
): string | undefined {
  const output = execFile(shell, ["-ilc", buildEnvCaptureCommand(["PATH"])], {
    encoding: "utf8",
    timeout: SHELL_TIMEOUT_MS,
  })
  return extractEnvValue(output, "PATH")
}

/** macOS keeps a PATH for GUI processes that no shell file mentions. */
export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = execFileSync as unknown as ExecFileSyncLike
): string | undefined {
  try {
    return trimNonEmpty(
      execFile("/bin/launchctl", ["getenv", "PATH"], {
        encoding: "utf8",
        timeout: LAUNCHCTL_TIMEOUT_MS,
      })
    )
  } catch {
    return undefined
  }
}

/**
 * PowerShell's idea of an environment variable, read without the user's
 * profile first — profiles are slow and can fail — and with it only when the
 * caller asks, which it only does when the unprofiled answer was not enough.
 */
export function readWindowsEnv(
  names: readonly string[],
  options: { loadProfile?: boolean } = {},
  execFile: ExecFileSyncLike = execFileSync as unknown as ExecFileSyncLike
): Record<string, string> {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => {
      if (!ENV_NAME_PATTERN.test(name)) {
        throw new Error(`Unsupported environment variable name: ${name}`)
      }
      return [
        `Write-Output '${captureStart(name)}'`,
        `$value = [Environment]::GetEnvironmentVariable('${name}')`,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${captureEnd(name)}'`,
      ]
    }),
  ].join("; ")
  const args = [
    "-NoLogo",
    ...(options.loadProfile ? [] : ["-NoProfile"]),
    "-NonInteractive",
    "-Command",
    command,
  ]
  for (const shell of WINDOWS_SHELLS) {
    try {
      const output = execFile(shell, args, {
        encoding: "utf8",
        timeout: SHELL_TIMEOUT_MS,
      })
      const found: Record<string, string> = {}
      for (const name of names) {
        const value = extractEnvValue(output, name)
        if (value !== undefined) found[name] = value
      }
      return found
    } catch {
      // pwsh is not installed on every machine; powershell.exe is the retry.
      continue
    }
  }
  return {}
}

/** Is `command` findable on this env's PATH? Used only to decide the retry. */
export function isCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): boolean {
  const dirs = (env.PATH ?? env.Path ?? "")
    .split(delimiterFor(platform))
    .map((entry) => entry.trim().replaceAll('"', ""))
    .filter(Boolean)
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [""]
  return dirs.some((dir) =>
    extensions.some((extension) => {
      try {
        return existsSync(path.join(dir, `${command}${extension}`))
      } catch {
        return false
      }
    })
  )
}

/* -------------------------------------------------------------------------- */
/* Hydration                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Mutates `env` in place with a repaired PATH (and, on POSIX, HOME).
 *
 * In place, and on `process.env` itself, on purpose: every PATH reader in the
 * app — `lib/agent-runtime-paths`, the harness runtimes, a spawned CLI that
 * inherits the environment — reads `process.env.PATH` when it is asked, so one
 * repair at boot reaches all of them without any of them knowing this exists.
 */
export function hydrateEnv(
  env: NodeJS.ProcessEnv,
  deps: HydrateDependencies = {}
): void {
  const platform = deps.platform ?? process.platform
  const warn = deps.warn ?? ((message: string) => console.warn(`[shell-env] ${message}`))
  const execFile = deps.execFile ?? (execFileSync as unknown as ExecFileSyncLike)

  if (platform === "win32") {
    hydrateWindows(env, { ...deps, platform, warn, execFile })
    return
  }
  if (platform !== "darwin" && platform !== "linux") return

  try {
    hydrateHome(env, deps)
  } catch (error) {
    warn(`Could not repair HOME: ${describe(error)}`)
  }
  try {
    hydratePosixPath(env, { ...deps, platform, warn, execFile })
  } catch (error) {
    warn(`Could not repair PATH: ${describe(error)}`)
  }
}

/** A service manager can start a process with no HOME; the CLIs all want one. */
export function hydrateHome(
  env: NodeJS.ProcessEnv,
  deps: Pick<HydrateDependencies, "homeDir"> = {}
): void {
  if (trimNonEmpty(env.HOME)) return
  const home = (deps.homeDir ?? (() => userInfo().homedir))()
  if (home && home.length > 0) env.HOME = home
}

type ResolvedDeps = HydrateDependencies &
  Required<Pick<HydrateDependencies, "platform" | "warn" | "execFile">>

function hydratePosixPath(env: NodeJS.ProcessEnv, deps: ResolvedDeps): void {
  const { platform, warn, execFile } = deps
  let shellPath: string | undefined
  const userShell =
    deps.userShell !== undefined ? deps.userShell : safeUserShell(warn)
  for (const shell of listLoginShellCandidates(platform, env.SHELL, userShell)) {
    try {
      shellPath = readPathFromLoginShell(shell, execFile)
    } catch (error) {
      warn(`Could not read PATH from login shell ${shell}: ${describe(error)}`)
    }
    if (shellPath) break
  }

  // launchctl is the macOS-only second answer, and only when the shell had none.
  const launchctlPath =
    platform === "darwin" && !shellPath ? readPathFromLaunchctl(execFile) : undefined
  const merged = mergePathValues(shellPath ?? launchctlPath, env.PATH, platform)
  if (merged) env.PATH = merged
}

function hydrateWindows(env: NodeJS.ProcessEnv, deps: ResolvedDeps): void {
  const { warn, execFile } = deps
  const isOnPath =
    deps.isOnPath ?? ((command, candidate) => isCommandOnPath(command, candidate, "win32"))
  let probed: Record<string, string> = {}
  try {
    probed = readWindowsEnv(["PATH"], { loadProfile: false }, execFile)
  } catch (error) {
    warn(`Could not read PATH from PowerShell: ${describe(error)}`)
  }
  const withShell = mergePathValues(probed.PATH, env.PATH, "win32")
  const baseline = mergePathValues(
    withShell,
    knownWindowsCliDirs(env).join(";"),
    "win32"
  )
  if (baseline) env.PATH = baseline

  // A profiled PowerShell is slow and can fail on its own; it is worth paying
  // for only when the cheap answer still cannot find a Node — which is what
  // fnm and the other per-shell version managers look like from out here.
  if (isOnPath("node", env)) return
  let profiled: Record<string, string> = {}
  try {
    profiled = readWindowsEnv(
      ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"],
      { loadProfile: true },
      execFile
    )
  } catch (error) {
    warn(`Could not read PATH from a profiled PowerShell: ${describe(error)}`)
    return
  }
  const merged = mergePathValues(profiled.PATH, env.PATH, "win32")
  if (merged) env.PATH = merged
  if (profiled.FNM_DIR) env.FNM_DIR = profiled.FNM_DIR
  if (profiled.FNM_MULTISHELL_PATH) {
    env.FNM_MULTISHELL_PATH = profiled.FNM_MULTISHELL_PATH
  }
}

function safeUserShell(warn: (message: string) => void): string | undefined {
  try {
    return trimNonEmpty(userInfo().shell)
  } catch (error) {
    warn(`Could not read the account's login shell: ${describe(error)}`)
    return undefined
  }
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

let hydrated = false

/**
 * Runs the repair once per process. Idempotent, so a double-registered
 * instrumentation hook (dev server, a route that imports it) costs nothing —
 * and skipped entirely under `AGENT_UI_SKIP_SHELL_ENV`, because a test suite
 * must never spawn the machine's login shell.
 */
export function hydrateProcessEnv(deps: HydrateDependencies = {}): boolean {
  if (hydrated) return false
  hydrated = true
  if (trimNonEmpty(process.env.AGENT_UI_SKIP_SHELL_ENV)) return false
  hydrateEnv(process.env, deps)
  return true
}

/** Testing seam: forgets that the once-guard has fired. */
export function resetShellEnvHydration() {
  hydrated = false
}
