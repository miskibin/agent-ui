/**
 * Running an ACP agent that is installed inside WSL, from the Windows app.
 *
 * The agent is a Linux process reached through `wsl.exe`, which changes three
 * things and nothing else: how it is spawned, which environment it sees, and
 * how a path is spelled on each side of the pipe. The protocol itself is
 * untouched — ACP is bytes over stdio, and `wsl.exe` forwards stdio as-is.
 *
 * Pure string work, importing nothing from `node:`, so `node --test` covers
 * the translations without a Windows machine.
 */

export type WslSpawn = {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * `wsl.exe -e sh -lc 'exec "$0" "$@"' <command> <args…>`.
 *
 * `-e` runs the program directly rather than through a shell that would
 * re-parse every argument (a prompt-sized `-m` value, a path with spaces).
 * The one shell in the chain is a *login* `sh`, there only so the user's
 * profile puts `~/.local/bin` — where tinyagent's installer lands without
 * `sudo` — on `PATH`; `exec "$0" "$@"` then hands every argument over
 * untouched. `--cd` takes the Windows folder and translates it itself.
 *
 * The environment does not cross into WSL by default. `WSLENV` names the
 * variables that should, and `/u` limits each to the Windows → Linux
 * direction; an existing `WSLENV` is kept rather than replaced.
 */
export function wslSpawn(input: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  distro?: string
  inheritedWslEnv?: string
}): WslSpawn {
  const distro = input.distro?.trim()
  const names = Object.keys(input.env).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  const forwarded = [
    ...(input.inheritedWslEnv ?? "").split(":").filter(Boolean),
    ...names.map((name) => `${name}/u`),
  ]
  return {
    command: "wsl.exe",
    args: [
      ...(distro ? ["-d", distro] : []),
      "--cd",
      input.cwd,
      "-e",
      "sh",
      "-lc",
      'exec "$0" "$@"',
      input.command,
      ...input.args,
    ],
    env: {
      ...input.env,
      ...(forwarded.length ? { WSLENV: [...new Set(forwarded)].join(":") } : null),
    },
  }
}

/**
 * A Windows path as WSL sees it: `C:\repo\app` → `/mnt/c/repo/app`, and a
 * `\\wsl.localhost\<distro>\home\me` share back to `/home/me`. Anything else
 * (already POSIX, relative) is returned unchanged.
 *
 * `/mnt` is WSL's default automount root; a distro that moved it in
 * `wsl.conf` is the one case this does not follow.
 */
export function windowsToWslPath(value: string): string {
  const drive = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(value)
  if (drive) {
    const rest = (drive[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`
  }
  const share = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+(?:[\\/](.*))?$/i.exec(value)
  if (share) return `/${(share[1] ?? "").replace(/\\/g, "/")}`
  return value
}

/**
 * The other direction, for paths the agent reports — tool locations, diffs,
 * `fs/*` requests. `/mnt/c/repo` → `C:\repo`; a path inside the distro's own
 * filesystem becomes its `\\wsl.localhost` share when the distro is known
 * (and stays POSIX when it is not, which the file panel then cannot open — an
 * honest miss rather than a wrong file).
 */
export function wslToWindowsPath(value: string, distro?: string): string {
  const mount = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(value)
  if (mount) {
    const rest = (mount[2] ?? "").replace(/\//g, "\\")
    return `${mount[1].toUpperCase()}:\\${rest}`
  }
  const name = distro?.trim()
  if (name && value.startsWith("/")) {
    return `\\\\wsl.localhost\\${name}${value.replace(/\//g, "\\")}`
  }
  return value
}

/**
 * The shell inside WSL saying it could not find the agent. Spelled by `sh`
 * as `sh: 1: exec: tinyagent: not found` (dash) or `…: No such file or
 * directory`; either way the useful answer is where to look.
 */
export function wslCommandMissing(stderr: string, command: string): boolean {
  if (!stderr) return false
  const name = command.split("/").pop() ?? command
  return (
    stderr.includes(`${name}: not found`) ||
    (stderr.includes(name) && /No such file or directory|command not found/.test(stderr))
  )
}
