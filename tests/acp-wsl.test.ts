import assert from "node:assert/strict"
import { test } from "node:test"

import {
  windowsToWslPath,
  wslCommandMissing,
  wslSpawn,
  wslToWindowsPath,
} from "@/lib/acp-wsl"

test("Windows folders become WSL mounts, and back", () => {
  assert.equal(windowsToWslPath("C:\\Users\\me\\repo"), "/mnt/c/Users/me/repo")
  assert.equal(windowsToWslPath("D:/work/"), "/mnt/d/work")
  assert.equal(windowsToWslPath("C:\\"), "/mnt/c")
  assert.equal(windowsToWslPath("\\\\wsl.localhost\\Ubuntu\\home\\me"), "/home/me")
  assert.equal(windowsToWslPath("\\\\wsl$\\Ubuntu\\home\\me"), "/home/me")
  assert.equal(windowsToWslPath("/already/posix"), "/already/posix")

  assert.equal(wslToWindowsPath("/mnt/c/Users/me/repo/a.ts"), "C:\\Users\\me\\repo\\a.ts")
  assert.equal(wslToWindowsPath("/home/me/x", "Ubuntu"), "\\\\wsl.localhost\\Ubuntu\\home\\me\\x")
  assert.equal(wslToWindowsPath("/home/me/x"), "/home/me/x")
  assert.equal(wslToWindowsPath("relative/path"), "relative/path")
})

test("the spawn goes through a login shell and forwards the environment", () => {
  const spec = wslSpawn({
    command: "tinyagent",
    args: ["--acp", "-m", "ollama/qwen3"],
    cwd: "C:\\repo",
    env: { OPENAI_API_KEY: "k", "BAD-NAME": "x" },
    distro: "Ubuntu",
    inheritedWslEnv: "USERPROFILE/p",
  })
  assert.equal(spec.command, "wsl.exe")
  assert.deepEqual(spec.args, [
    "-d",
    "Ubuntu",
    "--cd",
    "C:\\repo",
    "-e",
    "sh",
    "-lc",
    'exec "$0" "$@"',
    "tinyagent",
    "--acp",
    "-m",
    "ollama/qwen3",
  ])
  assert.equal(spec.env.WSLENV, "USERPROFILE/p:OPENAI_API_KEY/u")
  assert.equal(spec.env.OPENAI_API_KEY, "k")
})

test("a missing command inside WSL is recognized", () => {
  assert.ok(wslCommandMissing("sh: 1: exec: tinyagent: not found", "tinyagent"))
  assert.ok(
    wslCommandMissing("sh: 1: exec: /opt/tinyagent: No such file or directory", "/opt/tinyagent")
  )
  assert.ok(!wslCommandMissing("panic: something else", "tinyagent"))
})
