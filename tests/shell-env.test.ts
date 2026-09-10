import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildEnvCaptureCommand,
  extractEnvValue,
  hydrateEnv,
  hydrateHome,
  hydrateProcessEnv,
  isCommandOnPath,
  knownWindowsCliDirs,
  listLoginShellCandidates,
  mergePathValues,
  readPathFromLoginShell,
  resetShellEnvHydration,
  type ExecFileSyncLike,
} from "@/lib/shell-env"

/**
 * The PATH repair that runs at boot. A desktop launch inherits four
 * directories and none of the harnesses; asking the login shell is what makes
 * `claude`, `cursor-agent`, `pi` and `ollama` findable — and it has to be
 * impossible for that probe to break a boot.
 */

/** A login shell that prints an rc-file banner around the real answer. */
function shellReturning(value: string, banner = "Welcome to zsh!\n"): ExecFileSyncLike {
  return (_file, args) => {
    const command = String(args[args.length - 1])
    const name = /__AGENT_UI_ENV_([A-Z0-9_]+)_START__/.exec(command)?.[1] ?? "PATH"
    return `${banner}__AGENT_UI_ENV_${name}_START__\n${value}\n__AGENT_UI_ENV_${name}_END__\ngoodbye\n`
  }
}

const failing: ExecFileSyncLike = () => {
  throw new Error("no such shell")
}

/**
 * `NodeJS.ProcessEnv` is augmented with the variables Next.js guarantees, so
 * a hand-built environment has to be asserted into it rather than inferred.
 */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv
}

test("the shells worth asking, in order, deduped", () => {
  assert.deepEqual(listLoginShellCandidates("darwin", "/bin/fish", "/bin/zsh"), [
    "/bin/fish",
    "/bin/zsh",
  ])
  assert.deepEqual(listLoginShellCandidates("darwin", undefined, undefined), ["/bin/zsh"])
  assert.deepEqual(listLoginShellCandidates("linux", "  ", "/bin/bash"), ["/bin/bash"])
  assert.deepEqual(listLoginShellCandidates("linux", "/bin/bash", "/bin/bash"), ["/bin/bash"])
  assert.deepEqual(listLoginShellCandidates("win32", undefined, undefined), [])
})

test("the answer is found between its sentinels, whatever the rc files printed", () => {
  const command = buildEnvCaptureCommand(["PATH"])
  assert.match(command, /printenv PATH \|\| true/)
  assert.equal(
    extractEnvValue("noise\n__AGENT_UI_ENV_PATH_START__\n/a:/b\n__AGENT_UI_ENV_PATH_END__\n", "PATH"),
    "/a:/b"
  )
  assert.equal(extractEnvValue("nothing here", "PATH"), undefined)
  assert.equal(readPathFromLoginShell("/bin/zsh", shellReturning("/opt/homebrew/bin")), "/opt/homebrew/bin")
  // A name that is not a plain variable never reaches a shell command.
  assert.throws(() => buildEnvCaptureCommand(["PATH; rm -rf /"]))
})

test("merging keeps the shell's order and drops nothing", () => {
  assert.equal(
    mergePathValues("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", "linux"),
    "/opt/homebrew/bin:/usr/bin:/bin"
  )
  assert.equal(mergePathValues(undefined, "/usr/bin", "linux"), "/usr/bin")
  assert.equal(mergePathValues("", "", "linux"), undefined)
  // Windows compares case-insensitively and strips the quotes a hand-edited
  // PATH sometimes carries.
  assert.equal(
    mergePathValues('C:\\Tools;"C:\\Node"', "c:\\tools;C:\\Windows", "win32"),
    "C:\\Tools;C:\\Node;C:\\Windows"
  )
})

test("a POSIX boot takes the login shell's PATH and keeps what it inherited", () => {
  const shellEnv = env({ PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" })
  hydrateEnv(shellEnv, {
    platform: "darwin",
    execFile: shellReturning("/opt/homebrew/bin:/usr/bin"),
    warn: () => {},
  })
  assert.equal(shellEnv.PATH, "/opt/homebrew/bin:/usr/bin:/bin")
})

test("a shell that fails is a warning, and the inherited PATH stands", () => {
  const failingEnv = env({ PATH: "/usr/bin", SHELL: "/bin/zsh" })
  const warnings: string[] = []
  hydrateEnv(failingEnv, {
    platform: "linux",
    execFile: failing,
    userShell: "/bin/bash",
    warn: (message) => warnings.push(message),
  })
  assert.equal(failingEnv.PATH, "/usr/bin")
  // Both candidate shells were tried, and neither took the boot down.
  assert.equal(warnings.length, 2)
})

test("macOS falls back to launchctl when no shell answers", () => {
  const launchdEnv = env({ PATH: "/usr/bin", SHELL: "/bin/zsh" })
  const execFile: ExecFileSyncLike = (file) => {
    if (file === "/bin/launchctl") return "/opt/launchd/bin\n"
    throw new Error("no shell")
  }
  hydrateEnv(launchdEnv, { platform: "darwin", execFile, warn: () => {} })
  assert.equal(launchdEnv.PATH, "/opt/launchd/bin:/usr/bin")
})

test("a missing HOME is repaired, and an existing one is left alone", () => {
  const empty = env({})
  hydrateHome(empty, { homeDir: () => "/home/agent" })
  assert.equal(empty.HOME, "/home/agent")
  const set = env({ HOME: "/home/other" })
  hydrateHome(set, { homeDir: () => "/home/agent" })
  assert.equal(set.HOME, "/home/other")
})

test("Windows adds the well-known install dirs, and only retries a profile when node is missing", () => {
  const dirs = knownWindowsCliDirs(
    env({
      APPDATA: "C:\\Users\\a\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
      USERPROFILE: "C:\\Users\\a",
    })
  )
  assert.deepEqual(dirs, [
    "C:\\Users\\a\\AppData\\Roaming\\npm",
    "C:\\Users\\a\\AppData\\Local\\Programs\\nodejs",
    "C:\\Users\\a\\AppData\\Local\\Volta\\bin",
    "C:\\Users\\a\\AppData\\Local\\pnpm",
    "C:\\Users\\a\\.local\\bin",
    "C:\\Users\\a\\.bun\\bin",
    "C:\\Users\\a\\scoop\\shims",
  ])
  assert.deepEqual(knownWindowsCliDirs(env({})), [])

  const profiles: Array<boolean | undefined> = []
  const execFile: ExecFileSyncLike = (_file, args) => {
    profiles.push(args.includes("-NoProfile"))
    return "__AGENT_UI_ENV_PATH_START__\nC:\\Shell\n__AGENT_UI_ENV_PATH_END__\n"
  }
  const found = env({ PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\a" })
  hydrateEnv(found, { platform: "win32", execFile, warn: () => {}, isOnPath: () => true })
  assert.equal(found.PATH, "C:\\Shell;C:\\Windows;C:\\Users\\a\\.local\\bin;C:\\Users\\a\\.bun\\bin;C:\\Users\\a\\scoop\\shims")
  assert.deepEqual(profiles, [true])

  const missing = env({ PATH: "C:\\Windows" })
  hydrateEnv(missing, { platform: "win32", execFile, warn: () => {}, isOnPath: () => false })
  // The unprofiled probe, then the profiled retry.
  assert.deepEqual(profiles.slice(1), [true, false])
})

test("Windows PATH repair can consume four bounded PowerShell probes", () => {
  const calls: Array<{ shell: string; timeout: number }> = []
  const execFile: ExecFileSyncLike = (shell, _args, options) => {
    calls.push({ shell, timeout: options.timeout })
    throw new Error("PowerShell did not start")
  }
  hydrateEnv(env({ PATH: "C:\\Windows" }), {
    platform: "win32",
    execFile,
    warn: () => {},
    isOnPath: () => false,
  })
  assert.deepEqual(
    calls.map(({ shell }) => shell),
    ["pwsh.exe", "powershell.exe", "pwsh.exe", "powershell.exe"]
  )
  assert.ok(calls.every(({ timeout }) => timeout === 5_000))
})

test("a command is looked for with the platform's extensions", () => {
  assert.equal(isCommandOnPath("node", env({ PATH: "" }), "linux"), false)
  assert.equal(
    isCommandOnPath("definitely-not-a-binary", env({ PATH: "/usr/bin:/bin" }), "linux"),
    false
  )
})

test("hydration runs once, and never when the skip flag is set", () => {
  const previous = process.env.AGENT_UI_SKIP_SHELL_ENV
  process.env.AGENT_UI_SKIP_SHELL_ENV = "1"
  resetShellEnvHydration()
  assert.equal(hydrateProcessEnv(), false)
  resetShellEnvHydration()
  process.env.AGENT_UI_SKIP_SHELL_ENV = ""
  const path = process.env.PATH
  assert.equal(hydrateProcessEnv({ platform: "sunos" }), true)
  // A second call is a no-op, whatever it is handed.
  assert.equal(hydrateProcessEnv({ platform: "linux", execFile: failing }), false)
  assert.equal(process.env.PATH, path)
  if (previous === undefined) delete process.env.AGENT_UI_SKIP_SHELL_ENV
  else process.env.AGENT_UI_SKIP_SHELL_ENV = previous
})
