import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  harnessWork,
  orphanedDuring,
  outermost,
  parseEtime,
  parsePsOutput,
  parseWindowsProcessLines,
  sameProcess,
  type ProcInfo,
} from "@/lib/process-list"

const proc = (
  pid: number,
  ppid: number,
  name: string,
  extra: Partial<ProcInfo> = {}
): ProcInfo => ({ pid, ppid, name, command: name, startedAt: 1_000, ...extra })

describe("parseEtime", () => {
  it("reads every ps shape", () => {
    assert.equal(parseEtime("00:05"), 5)
    assert.equal(parseEtime("12:34"), 754)
    assert.equal(parseEtime("01:00:00"), 3600)
    assert.equal(parseEtime("2-03:04:05"), 2 * 86400 + 3 * 3600 + 4 * 60 + 5)
    assert.equal(parseEtime("junk"), null)
  })
})

describe("parsePsOutput", () => {
  it("keeps spaces in the command and derives the start", () => {
    const procs = parsePsOutput(
      "    1     0     1    10-00:00:00 /sbin/init splash\n" +
        "  420     1   420          01:05 /usr/bin/node /srv/my app/server.js --port 3000\n" +
        "garbage line\n",
      100_000
    )
    assert.equal(procs.length, 2)
    assert.deepEqual(procs[1], {
      pid: 420,
      ppid: 1,
      pgid: 420,
      startedAt: 100_000 - 65_000,
      name: "node",
      command: "/usr/bin/node /srv/my app/server.js --port 3000",
    })
  })
})

describe("parseWindowsProcessLines", () => {
  it("reads the tab-separated scan and skips undescribed processes", () => {
    const procs = parseWindowsProcessLines(
      "4\t0\t\tSystem\t\r\n" +
        '9120\t388\t2026-10-27T12:35:00.0000000Z\tbash.exe\t"C:\\Program Files\\Git\\bin\\bash.exe" watcher.sh\r\n'
    )
    assert.equal(procs.length, 1)
    assert.equal(procs[0].name, "bash")
    assert.equal(procs[0].startedAt, Date.parse("2026-10-27T12:35:00Z"))
    assert.equal(procs[0].command, '"C:\\Program Files\\Git\\bin\\bash.exe" watcher.sh')
  })
})

describe("sameProcess", () => {
  it("tolerates ps's second but not a recycled pid", () => {
    assert.ok(sameProcess({ pid: 5, startedAt: 10_000 }, proc(5, 1, "x", { startedAt: 11_000 })))
    assert.ok(!sameProcess({ pid: 5, startedAt: 10_000 }, proc(5, 1, "x", { startedAt: 60_000 })))
  })
})

describe("harnessWork", () => {
  // harness 100 (group leader) → bash 101 → npm 102 → node 103 (dev server)
  //                           → node 110 (an MCP server, no shell above it)
  // nohup'd 120: reparented to 1, still in group 100
  // 130: some other program in another group
  const table = [
    proc(1, 0, "init", { pgid: 1 }),
    proc(100, 50, "claude", { pgid: 100 }),
    proc(101, 100, "bash", { pgid: 100 }),
    proc(102, 101, "npm", { pgid: 100 }),
    proc(103, 102, "node", { pgid: 100 }),
    proc(110, 100, "node", { pgid: 100 }),
    proc(120, 1, "python3", { pgid: 100 }),
    proc(130, 1, "python3", { pgid: 130 }),
  ]

  it("keeps what a shell ran and what escaped by nohup, not the CLI's helpers", () => {
    const pids = harnessWork(table, 100).map((p) => p.pid).sort((a, b) => a - b)
    assert.deepEqual(pids, [101, 102, 103, 120])
    assert.deepEqual(outermost(harnessWork(table, 100)).map((p) => p.pid).sort(), [101, 120])
  })

  it("ignores the group when the harness does not lead one", () => {
    const shared = table.map((p) => (p.pgid === 100 ? { ...p, pgid: 50 } : p))
    const pids = harnessWork(shared, 100).map((p) => p.pid).sort((a, b) => a - b)
    assert.deepEqual(pids, [101, 102, 103])
  })
})

describe("orphanedDuring", () => {
  it("finds a Start-Process escape and nothing the user opened", () => {
    const table = [
      proc(4, 0, "explorer", { startedAt: 0 }),
      proc(500, 9999, "cmd", { startedAt: 5_000 }), // parent gone: escaped
      proc(501, 500, "bash", { startedAt: 5_100 }), // attached under it
      proc(600, 4, "chrome", { startedAt: 5_000 }), // user's own app
      proc(700, 9998, "notepad", { startedAt: 5_000 }), // not background work
      proc(800, 9997, "node", { startedAt: 500 }), // before the turn
      proc(900, 4, "node", { startedAt: 6_000 }), // parent alive
    ]
    const found = orphanedDuring(table, { from: 1_000, to: 10_000 }, new Set())
    assert.deepEqual(found.map((p) => p.pid), [500])
  })
  it("treats a parent younger than the child as a recycled pid", () => {
    const table = [proc(10, 0, "svchost", { startedAt: 9_000 }), proc(500, 10, "node", { startedAt: 5_000 })]
    assert.deepEqual(orphanedDuring(table, { from: 1_000, to: 10_000 }, new Set()).map((p) => p.pid), [500])
  })
})

describe("parseNetstatListeners", () => {
  it("reads listeners in any locale, with pids, and skips the system's", async () => {
    const { parseNetstatListeners } = await import("@/lib/dev-servers")
    const out = [
      "Aktywne połączenia",
      "  Protokół  Adres lokalny          Obcy adres             Stan            PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              NASŁUCHIWANIE   1120",
      "  TCP    0.0.0.0:3000           0.0.0.0:0              NASŁUCHIWANIE   9120",
      "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       9200",
      "  TCP    127.0.0.1:5173         127.0.0.1:61000        ESTABLISHED     9200",
      "  TCP    192.168.1.5:8080       0.0.0.0:0              LISTENING       77",
      "  TCP    0.0.0.0:49664          0.0.0.0:0              LISTENING       900",
      "  TCP    [::]:8000              [::]:0                 LISTENING       4410",
      "  TCP    0.0.0.0:2869           0.0.0.0:0              LISTENING       4",
    ].join("\r\n")
    assert.deepEqual(parseNetstatListeners(out), [
      { port: 3000, pid: 9120 },
      { port: 5173, pid: 9200 },
      { port: 8000, pid: 4410 },
    ])
  })
})
