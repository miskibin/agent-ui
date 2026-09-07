import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { test } from "node:test"

import { DETACH_CHILDREN, detachedSpawnOptions, killProcessTree } from "@/lib/process-tree"

/**
 * The behaviour under test is the whole point of the module: killing a harness
 * has to kill what the harness started. A CLI agent's shell tool leaves a
 * `npm run dev` or a `pytest` behind, and `child.kill()` never reaches it.
 *
 * Windows takes the `taskkill /T /F` path instead, which cannot be exercised
 * here, so the group assertions are skipped there.
 */

/** A child that spawns a grandchild, prints its pid, and then sleeps. */
const PARENT = `
const { spawn } = require("node:child_process")
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "ignore",
})
process.stdout.write(String(grandchild.pid) + "\\n")
setTimeout(() => {}, 60000)
`

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
  "killing the tree reaches a grandchild the direct kill would orphan",
  { skip: !DETACH_CHILDREN && "POSIX process groups only" },
  async () => {
    const child = spawn(process.execPath, ["-e", PARENT], {
      stdio: ["ignore", "pipe", "ignore"],
      ...detachedSpawnOptions,
    })
    child.stdout.setEncoding("utf8")

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no pid from the child")), 10_000)
      child.stdout.once("data", (chunk: string) => {
        clearTimeout(timer)
        resolve(Number(chunk.trim()))
      })
    })
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)
    assert.equal(alive(grandchildPid), true, "the grandchild is running")

    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
    killProcessTree(child, 100)
    await exited
    // SIGTERM is delivered to the group; give the kernel a beat to reap it.
    for (let attempt = 0; attempt < 40 && alive(grandchildPid); attempt++) {
      await wait(50)
    }
    assert.equal(alive(grandchildPid), false, "and it died with the group")
  }
)

test("a second kill neither throws nor restarts the escalation", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    ...detachedSpawnOptions,
  })
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
  killProcessTree(child, 50)
  killProcessTree(child, 50)
  await exited
  killProcessTree(child, 50)
})

test("a child that never started is not signalled at all", () => {
  const child = spawn("agent-ui-no-such-binary-", [], { stdio: "ignore" })
  child.once("error", () => {
    /* the point is that killProcessTree below does not throw either */
  })
  killProcessTree(child, 10)
})
