import assert from "node:assert/strict"
import { test } from "node:test"

import { ancestorsOf, mentionsFolder, type ProcInfo } from "@/lib/process-list"

const proc = (pid: number, ppid: number, command = "", startedAt = 0): ProcInfo => ({
  pid,
  ppid,
  startedAt,
  name: "node",
  command,
})

test("mentionsFolder matches a Windows folder at a path boundary only", () => {
  const cmd = 'node "C:\\Users\\me\\pmtwin\\node_modules\\next\\dist\\bin\\next" dev'
  assert.equal(mentionsFolder(cmd, "c:/users/me/pmtwin"), true)
  assert.equal(mentionsFolder(cmd, "C:\\Users\\me\\pmtwin\\"), true)
  assert.equal(mentionsFolder(cmd, "C:\\Users\\me\\pmt"), false)
  assert.equal(mentionsFolder(cmd, "C:\\Users\\me\\pimc-agent"), false)
})

test("mentionsFolder is case-sensitive on POSIX paths", () => {
  assert.equal(mentionsFolder("node /home/me/App/server.js", "/home/me/app"), false)
  assert.equal(mentionsFolder("node /home/me/app/server.js", "/home/me/app"), true)
})

test("ancestorsOf walks up, nearest first, and stops at a recycled parent", () => {
  const procs = [proc(1, 0, "init"), proc(10, 1, "sh", 100), proc(20, 10, "node", 200)]
  assert.deepEqual(ancestorsOf(procs, 20).map((p) => p.pid), [20, 10, 1])
  const recycled = [proc(10, 1, "sh", 9_000), proc(20, 10, "node", 200)]
  assert.deepEqual(ancestorsOf(recycled, 20).map((p) => p.pid), [20])
})
