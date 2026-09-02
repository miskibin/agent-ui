import "server-only"

import { spawn } from "node:child_process"
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

/**
 * "Open in …" for the machine the server runs on: which editors and terminals
 * are installed, and how to hand each one a path.
 *
 * Everything is spawned as a fixed argv with the path as one argument — never
 * `shell: true` — so a file called `; rm -rf ~` opens like any other. The one
 * place a shell is unavoidable, a Windows `.cmd` shim, gets a command line
 * quoted here element by element (see `spawnViaCmd`). The child is detached
 * and unreferenced: the app server must not wait on an editor window, and
 * closing the app must not close the editor.
 */

const run = promisify(execFile)

/** A `which` that timed out is as good as "not installed". */
const PROBE_TIMEOUT_MS = 2_000
/** Installed apps do not change mid-session; probing on every menu is waste. */
const CACHE_TTL_MS = 60_000

export type OpenTarget = {
  id: string
  name: string
}

export type DetectedTargets = {
  platform: NodeJS.Platform
  editors: OpenTarget[]
  terminals: OpenTarget[]
}

type EditorSpec = OpenTarget & {
  /** CLI shims to look for on PATH, in order of preference. */
  bins: string[]
  /** macOS bundle names — `open -a` handles an app without a shim. */
  apps?: string[]
  /** Well-known install paths (Windows mostly, where PATH is often stale). */
  paths?: string[]
  /** How the shim takes a line number. */
  line: "goto" | "colon" | "line-flag" | "none"
}

type ResolvedEditor = EditorSpec & {
  /** Absolute shim path, or "" when only the macOS bundle was found. */
  bin: string
  app: string
}

const EDITORS: EditorSpec[] = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    bins: ["code"],
    apps: ["Visual Studio Code"],
    paths: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd",
      "%PROGRAMFILES%\\Microsoft VS Code\\bin\\code.cmd",
    ],
    line: "goto",
  },
  {
    id: "cursor",
    name: "Cursor",
    bins: ["cursor"],
    apps: ["Cursor"],
    paths: ["%LOCALAPPDATA%\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd"],
    line: "goto",
  },
  {
    id: "zed",
    name: "Zed",
    bins: ["zed", "zeditor"],
    apps: ["Zed"],
    paths: ["%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe"],
    line: "colon",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    bins: ["windsurf"],
    apps: ["Windsurf"],
    paths: ["%LOCALAPPDATA%\\Programs\\Windsurf\\bin\\windsurf.cmd"],
    line: "goto",
  },
  {
    id: "vscode-insiders",
    name: "VS Code Insiders",
    bins: ["code-insiders"],
    apps: ["Visual Studio Code - Insiders"],
    paths: [
      "%LOCALAPPDATA%\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd",
    ],
    line: "goto",
  },
  {
    id: "vscodium",
    name: "VSCodium",
    bins: ["codium"],
    apps: ["VSCodium"],
    paths: ["%LOCALAPPDATA%\\Programs\\VSCodium\\bin\\codium.cmd"],
    line: "goto",
  },
  {
    id: "trae",
    name: "Trae",
    bins: ["trae"],
    apps: ["Trae"],
    line: "goto",
  },
  {
    id: "kiro",
    name: "Kiro",
    bins: ["kiro"],
    apps: ["Kiro"],
    line: "goto",
  },
  {
    id: "sublime",
    name: "Sublime Text",
    bins: ["subl"],
    apps: ["Sublime Text"],
    paths: ["%PROGRAMFILES%\\Sublime Text\\subl.exe"],
    line: "colon",
  },
  { id: "idea", name: "IntelliJ IDEA", bins: ["idea"], apps: ["IntelliJ IDEA"], line: "line-flag" },
  { id: "webstorm", name: "WebStorm", bins: ["webstorm"], apps: ["WebStorm"], line: "line-flag" },
  { id: "pycharm", name: "PyCharm", bins: ["pycharm"], apps: ["PyCharm"], line: "line-flag" },
  { id: "goland", name: "GoLand", bins: ["goland"], apps: ["GoLand"], line: "line-flag" },
  { id: "rider", name: "Rider", bins: ["rider"], apps: ["Rider"], line: "line-flag" },
  { id: "clion", name: "CLion", bins: ["clion"], apps: ["CLion"], line: "line-flag" },
  { id: "rustrover", name: "RustRover", bins: ["rustrover"], apps: ["RustRover"], line: "line-flag" },
  { id: "phpstorm", name: "PhpStorm", bins: ["phpstorm"], apps: ["PhpStorm"], line: "line-flag" },
]

type TerminalSpec = OpenTarget & {
  bins?: string[]
  apps?: string[]
  paths?: string[]
  /** argv that opens the terminal in `dir`; `{dir}` is substituted. */
  argv: (bin: string, dir: string) => string[]
}

/** macOS terminals all take the folder through `open -a`. */
const macTerminal = (id: string, name: string): TerminalSpec => ({
  id,
  name,
  apps: [name],
  argv: (app, dir) => ["open", "-a", app, dir],
})

const TERMINALS: Record<string, TerminalSpec[]> = {
  darwin: [
    macTerminal("iterm", "iTerm"),
    macTerminal("ghostty", "Ghostty"),
    macTerminal("warp", "Warp"),
    macTerminal("kitty", "kitty"),
    macTerminal("alacritty", "Alacritty"),
    macTerminal("wezterm", "WezTerm"),
    macTerminal("terminal", "Terminal"),
  ],
  linux: [
    {
      id: "ghostty",
      name: "Ghostty",
      bins: ["ghostty"],
      argv: (bin, dir) => [bin, `--working-directory=${dir}`],
    },
    { id: "kitty", name: "kitty", bins: ["kitty"], argv: (bin, dir) => [bin, "-d", dir] },
    {
      id: "alacritty",
      name: "Alacritty",
      bins: ["alacritty"],
      argv: (bin, dir) => [bin, "--working-directory", dir],
    },
    {
      id: "wezterm",
      name: "WezTerm",
      bins: ["wezterm"],
      argv: (bin, dir) => [bin, "start", "--cwd", dir],
    },
    {
      id: "gnome-terminal",
      name: "GNOME Terminal",
      bins: ["gnome-terminal"],
      argv: (bin, dir) => [bin, `--working-directory=${dir}`],
    },
    {
      id: "konsole",
      name: "Konsole",
      bins: ["konsole"],
      argv: (bin, dir) => [bin, "--workdir", dir],
    },
    {
      id: "xfce4-terminal",
      name: "Xfce Terminal",
      bins: ["xfce4-terminal"],
      argv: (bin, dir) => [bin, `--working-directory=${dir}`],
    },
    {
      id: "x-terminal-emulator",
      name: "Default terminal",
      bins: ["x-terminal-emulator"],
      // The alternatives shim takes no cwd flag; the spawn's own cwd is it.
      argv: (bin) => [bin],
    },
    { id: "xterm", name: "xterm", bins: ["xterm"], argv: (bin) => [bin] },
  ],
  win32: [
    {
      id: "windows-terminal",
      name: "Windows Terminal",
      bins: ["wt"],
      paths: ["%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe"],
      argv: (bin, dir) => [bin, "-d", dir],
    },
    {
      id: "powershell",
      name: "PowerShell",
      bins: ["pwsh", "powershell"],
      argv: (bin, dir) => [
        "cmd.exe",
        "/c",
        "start",
        "",
        "/d",
        dir,
        bin,
        "-NoExit",
      ],
    },
    {
      id: "cmd",
      name: "Command Prompt",
      bins: ["cmd"],
      argv: (_bin, dir) => ["cmd.exe", "/c", "start", "", "/d", dir, "cmd.exe"],
    },
  ],
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

function expandEnv(template: string) {
  return template.replace(/%([A-Z_]+)%/gi, (_match, name: string) =>
    process.env[name] ?? process.env[name.toUpperCase()] ?? ""
  )
}

async function exists(path: string) {
  if (!path) return false
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** First hit on PATH, or "". `where` on Windows, `which` elsewhere. */
async function which(bin: string): Promise<string> {
  const finder = process.platform === "win32" ? "where.exe" : "which"
  try {
    const { stdout } = await run(finder, [bin], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    return first ?? ""
  } catch {
    return ""
  }
}

async function findBin(bins: string[] = [], paths: string[] = []) {
  for (const bin of bins) {
    const found = await which(bin)
    if (found) return found
  }
  for (const template of paths) {
    const path = expandEnv(template)
    if (await exists(path)) return path
  }
  return ""
}

async function findApp(apps: string[] = []) {
  if (process.platform !== "darwin") return ""
  for (const app of apps) {
    for (const root of ["/Applications", join(homedir(), "Applications")]) {
      if (await exists(join(root, `${app}.app`))) return app
    }
  }
  return ""
}

type Detected = {
  at: number
  editors: ResolvedEditor[]
  terminals: Array<TerminalSpec & { bin: string }>
}

let detected: Promise<Detected> | null = null

async function detect(): Promise<Detected> {
  const editors: ResolvedEditor[] = []
  await Promise.all(
    EDITORS.map(async (spec) => {
      const [bin, app] = await Promise.all([
        findBin(spec.bins, spec.paths),
        findApp(spec.apps),
      ])
      if (bin || app) editors.push({ ...spec, bin, app })
    })
  )
  // Detection ran in parallel; the list should read in preference order.
  editors.sort(
    (a, b) =>
      EDITORS.findIndex((e) => e.id === a.id) -
      EDITORS.findIndex((e) => e.id === b.id)
  )

  const specs = TERMINALS[process.platform] ?? TERMINALS.linux
  const terminals: Detected["terminals"] = []
  await Promise.all(
    specs.map(async (spec) => {
      const app = await findApp(spec.apps)
      if (app) {
        terminals.push({ ...spec, bin: app })
        return
      }
      const bin = await findBin(spec.bins, spec.paths)
      if (bin) terminals.push({ ...spec, bin })
    })
  )
  terminals.sort(
    (a, b) =>
      specs.findIndex((t) => t.id === a.id) - specs.findIndex((t) => t.id === b.id)
  )
  return { at: Date.now(), editors, terminals }
}

async function detectCached(): Promise<Detected> {
  if (detected) {
    const current = await detected
    if (Date.now() - current.at < CACHE_TTL_MS) return current
  }
  detected = detect()
  return detected
}

export async function detectOpenTargets(): Promise<DetectedTargets> {
  const found = await detectCached()
  return {
    platform: process.platform,
    editors: found.editors.map(({ id, name }) => ({ id, name })),
    terminals: found.terminals.map(({ id, name }) => ({ id, name })),
  }
}

/* -------------------------------------------------------------------------- */
/* Launching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Characters that have no place in an argument handed to `cmd.exe`: a quote
 * would end the quoting below, `%` triggers variable expansion even inside
 * quotes, and a newline is a second command line. Refused up front — an
 * agent-named file is not worth a clever escape.
 */
const CMD_UNSAFE = /["%\r\n]/

/**
 * `cmd.exe` argument quoting. `cmd /d /s /c "…"` strips the outer quotes and
 * runs the rest; inside, every element is double-quoted, which protects the
 * shell metacharacters (`& | < > ^`) a path may carry.
 */
function cmdQuote(arg: string) {
  if (CMD_UNSAFE.test(arg)) throw new Error("That path cannot be opened on Windows")
  return `"${arg}"`
}

/**
 * The one command line this app ever builds by hand, exported so a test can
 * hold it to its two rules: every element quoted, and a path carrying `"`,
 * `%` or a newline refused rather than escaped.
 */
export function cmdCommandLine(argv: string[]) {
  return argv.map(cmdQuote).join(" ")
}

/** The argv `cmd.exe` itself is spawned with — `/d /s /c "<line>"`. */
export function cmdShimArgs(argv: string[]) {
  return ["/d", "/s", "/c", `"${cmdCommandLine(argv)}"`]
}

/**
 * Batch shims (`code.cmd`) and `start` need `cmd.exe`, which parses its own
 * command line; Node's `shell: true` would join the argv with spaces and no
 * quoting at all. So the line is quoted here, element by element, and passed
 * verbatim.
 */
function spawnViaCmd(argv: string[], cwd?: string) {
  return spawn(process.env.ComSpec ?? "cmd.exe", cmdShimArgs(argv), {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
}

function launch(argv: string[], cwd?: string) {
  const [command, ...args] = argv
  const viaCmd =
    process.platform === "win32" &&
    (/\.(cmd|bat)$/i.test(command) || /^cmd(\.exe)?$/i.test(command))
  const child = viaCmd
    ? spawnViaCmd(command.toLowerCase().startsWith("cmd") ? args : argv, cwd)
    : spawn(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
  child.on("error", () => {
    /* surfaced to the caller as a rejected promise below */
  })
  child.unref()
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("spawn", () => resolve())
  })
}

/**
 * Opens `path` (a file or a folder) in the editor with the given id, or the
 * first detected one when the id is empty or not installed. `line` lands the
 * cursor where the shim can take it; `root` opens that folder as the workspace
 * in editors that understand a folder plus a file in one call.
 */
export async function openInEditor(options: {
  editor?: string
  path: string
  line?: number
  root?: string
}): Promise<OpenTarget> {
  const { editors } = await detectCached()
  const editor = options.editor
    ? editors.find((entry) => entry.id === options.editor)
    : editors[0]
  if (!editor) {
    throw new Error(
      options.editor
        ? `The editor "${options.editor}" was not found on this machine — pick another in Settings → Editor & terminal`
        : "No editor found on this machine"
    )
  }

  const { path, line, root } = options
  const argv = editorArgv(editor, { path, line, root })
  await launch(argv, editor.bin ? root : undefined)
  return { id: editor.id, name: editor.name }
}

/** How the chosen shim takes a line number. */
export type EditorLineStyle = EditorSpec["line"]

/**
 * The argv one editor is launched with — pure, and exported so a test can hold
 * it to the shape that makes this safe: a fixed command with the path as one
 * argument of its own, never a string a shell parses.
 */
export function editorArgv(
  editor: { bin: string; app: string; line: EditorLineStyle },
  options: { path: string; line?: number; root?: string }
): string[] {
  const { path, line, root } = options
  // Bundle only: `open -a` cannot carry a line, but it opens the file.
  if (!editor.bin) return ["open", "-a", editor.app, path]

  const args: string[] = []
  if (root && root !== path && editor.line === "goto") args.push(root)
  if (line && editor.line === "goto") args.push("-g", `${path}:${line}`)
  else if (line && editor.line === "colon") args.push(`${path}:${line}`)
  else if (line && editor.line === "line-flag") args.push("--line", String(line), path)
  else args.push(path)
  return [editor.bin, ...args]
}

/** Shows `path` selected in the OS file manager. */
export async function revealInFileManager(path: string, isDir: boolean) {
  if (process.platform === "darwin") {
    await launch(isDir ? ["open", path] : ["open", "-R", path])
    return
  }
  if (process.platform === "win32") {
    await launch(
      isDir ? ["explorer.exe", path] : ["explorer.exe", `/select,${path}`]
    )
    return
  }
  // Freedesktop file managers can select an item; the fallback opens the folder.
  const target = isDir ? path : dirname(path)
  if (!isDir) {
    try {
      await run(
        "dbus-send",
        [
          "--session",
          "--dest=org.freedesktop.FileManager1",
          "--type=method_call",
          "/org/freedesktop/FileManager1",
          "org.freedesktop.FileManager1.ShowItems",
          `array:string:file://${path}`,
          "string:",
        ],
        { timeout: PROBE_TIMEOUT_MS }
      )
      return
    } catch {
      /* no FileManager1 on the bus — open the folder instead */
    }
  }
  await launch(["xdg-open", target])
}

/** Opens a terminal window in `dir`. */
export async function openTerminal(options: {
  terminal?: string
  dir: string
}): Promise<OpenTarget> {
  const { terminals } = await detectCached()
  const terminal =
    terminals.find((entry) => entry.id === options.terminal) ?? terminals[0]
  if (!terminal) throw new Error("No terminal found on this machine")
  await launch(terminal.argv(terminal.bin, options.dir), options.dir)
  return { id: terminal.id, name: terminal.name }
}

/** True when `id` names an installed editor — a stale setting is not "the first one". */
export async function hasEditor(id: string) {
  const { editors } = await detectCached()
  return editors.some((editor) => editor.id === id)
}
