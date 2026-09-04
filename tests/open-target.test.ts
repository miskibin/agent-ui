import assert from "node:assert/strict"
import { test } from "node:test"

import {
  cmdCommandLine,
  cmdShimArgs,
  editorArgv,
  terminalArgv,
} from "@/lib/open-target"

/**
 * "Open in …" hands a path an agent named to a program on this machine. Two
 * properties keep that from being a command injection, and both are asserted
 * here rather than left to review:
 *
 *  - the path is always its own argv element, never part of a string a shell
 *    parses (`shell: true` appears nowhere in `lib/open-target.ts`);
 *  - the one command line the app does build by hand — the Windows `cmd.exe`
 *    shim — quotes every element and refuses the characters that would break
 *    back out of that quoting.
 */

test("every element of a cmd.exe line is quoted", () => {
  assert.equal(
    cmdCommandLine(["C:\\bin\\code.cmd", "C:\\Users\\me\\Agent UI\\app.ts"]),
    '"C:\\bin\\code.cmd" "C:\\Users\\me\\Agent UI\\app.ts"'
  )
})

test("shell metacharacters survive as text because the quotes hold", () => {
  const line = cmdCommandLine(["code.cmd", "C:\\tmp\\a & del b | c > d ^ e.ts"])
  assert.equal(line, '"code.cmd" "C:\\tmp\\a & del b | c > d ^ e.ts"')
  // Nothing outside the quoted spans: the only unquoted character is the
  // separating space.
  assert.deepEqual(line.split('" "').length, 2)
})

test("a quote, a percent or a newline is refused, never escaped", () => {
  for (const nasty of [
    'C:\\tmp\\a" & del c:\\x "',
    "C:\\tmp\\%USERPROFILE%\\a.ts",
    "C:\\tmp\\a.ts\nshutdown",
    "C:\\tmp\\a.ts\rshutdown",
  ]) {
    assert.throws(
      () => cmdCommandLine(["code.cmd", nasty]),
      /cannot be opened on Windows/,
      nasty
    )
  }
})

test("the shim spawns cmd.exe with /d /s /c and one quoted line", () => {
  assert.deepEqual(cmdShimArgs(["code.cmd", "C:\\a b.ts"]), [
    "/d",
    "/s",
    "/c",
    '""code.cmd" "C:\\a b.ts""',
  ])
})

test("an editor gets the path as one argument of its own", () => {
  assert.deepEqual(
    editorArgv(
      { bin: "/usr/bin/code", app: "", line: "goto" },
      { path: "/home/me/p/a; rm -rf ~.ts" }
    ),
    ["/usr/bin/code", "/home/me/p/a; rm -rf ~.ts"]
  )
})

test("a line number takes the shape the chosen shim understands", () => {
  assert.deepEqual(
    editorArgv({ bin: "code", app: "", line: "goto" }, { path: "/p/a.ts", line: 42 }),
    ["code", "-g", "/p/a.ts:42"]
  )
  assert.deepEqual(
    editorArgv({ bin: "subl", app: "", line: "colon" }, { path: "/p/a.ts", line: 42 }),
    ["subl", "/p/a.ts:42"]
  )
  assert.deepEqual(
    editorArgv({ bin: "idea", app: "", line: "line-flag" }, { path: "/p/a.ts", line: 42 }),
    ["idea", "--line", "42", "/p/a.ts"]
  )
  // A shim with no line syntax opens the file plain rather than guessing.
  assert.deepEqual(
    editorArgv({ bin: "kiro", app: "", line: "none" }, { path: "/p/a.ts", line: 42 }),
    ["kiro", "/p/a.ts"]
  )
})

test("a workspace root is opened alongside the file, and never twice", () => {
  assert.deepEqual(
    editorArgv(
      { bin: "code", app: "", line: "goto" },
      { path: "/p/a.ts", line: 7, root: "/p" }
    ),
    ["code", "/p", "-g", "/p/a.ts:7"]
  )
  // Opening the folder itself must not pass it as both workspace and target.
  assert.deepEqual(
    editorArgv({ bin: "code", app: "", line: "goto" }, { path: "/p", root: "/p" }),
    ["code", "/p"]
  )
})

test("a macOS bundle with no shim opens through `open -a`", () => {
  assert.deepEqual(
    editorArgv({ bin: "", app: "Zed", line: "colon" }, { path: "/p/a.ts", line: 9 }),
    ["open", "-a", "Zed", "/p/a.ts"]
  )
})

test("a Windows terminal reaches cmd.exe as `start`, not as a switch", () => {
  // `launch` drops the leading `cmd.exe` and lets `spawnViaCmd` write the
  // switches, so whatever the spec puts next is the command cmd.exe runs — a
  // second `/c` here was one cmd.exe tried to execute.
  for (const id of ["powershell", "cmd"]) {
    const argv = terminalArgv("win32", id, "pwsh.exe", "C:\\repo")
    assert.ok(argv, id)
    assert.equal(argv[0], "cmd.exe", id)
    const args = cmdShimArgs(argv.slice(1))
    assert.deepEqual(args.slice(0, 3), ["/d", "/s", "/c"], id)
    assert.ok(args[3].startsWith('""start"'), `${id}: ${args[3]}`)
  }
})

test("an unknown terminal id is null rather than the first one installed", () => {
  assert.equal(terminalArgv("win32", "nope", "", "C:\\repo"), null)
})
