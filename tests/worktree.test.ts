import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, test } from "node:test"

/**
 * Worktrees, against real checkouts.
 *
 * Every claim worth making here is a claim about what git actually did — that
 * the worktree is registered, that the branch was cut from the right base,
 * that `gh-merge-base` is recorded (without it, a branch with no upstream is
 * ahead of nothing and `gh pr create` has no target), and that removing a
 * worktree twice is a success both times.
 *
 * `AGENT_UI_DIR` is pointed at a temporary directory before anything is
 * imported: `worktreesRoot()` reads it, and these tests create folders there.
 */

const dataDir = mkdtempSync(join(tmpdir(), "worktree-data-"))
process.env.AGENT_UI_DIR = dataDir

const {
  createWorktree,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  repoRootOf,
  repoSlug,
  resolveBaseRef,
  worktreePathFor,
  worktreeStatus,
  worktreesRoot,
} = await import("@/lib/worktree")

let repo = ""

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" })

before(() => {
  repo = mkdtempSync(join(tmpdir(), "worktree-repo-"))
  git(repo, "init", "-q", "-b", "main", ".")
  git(repo, "config", "user.email", "test@example.com")
  git(repo, "config", "user.name", "Test")
  writeFileSync(join(repo, "a.txt"), "one\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "first")
})

after(() => {
  // The worktrees are inside the data directory, so one removal covers them.
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

test("the porcelain list is read, and a prunable entry is not", () => {
  const entries = parseWorktreeList(
    "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0" +
      "worktree /wt/one\0HEAD def\0branch refs/heads/feature/one\0\0" +
      "worktree /wt/gone\0HEAD ghi\0branch refs/heads/feature/gone\0prunable gitdir file points to non-existent location\0\0" +
      "worktree /wt/detached\0HEAD jkl\0detached\0\0"
  )
  assert.deepEqual(
    entries.map((entry) => [entry.path, entry.branch, entry.main]),
    [
      ["/repo", "main", true],
      ["/wt/one", "feature/one", false],
      ["/wt/detached", undefined, false],
    ]
  )
  assert.ok(entries[2].detached)
})

test("the newline form parses the same way", () => {
  const entries = parseWorktreeList(
    "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/one\nHEAD def\nbranch refs/heads/feature/one\n\n"
  )
  assert.equal(entries.length, 2)
  assert.equal(entries[1].branch, "feature/one")
})

test("a folder resolves to its repository, and a worktree is not its main checkout", async () => {
  const main = await repoRootOf(repo)
  assert.ok(main)
  assert.equal(resolve(main.root), resolve(repo))
  assert.equal(resolve(main.mainRoot), resolve(repo))
  assert.equal(main.linked, false)
  assert.equal(await repoRootOf(tmpdir()), null)
})

test("a new worktree gets a branch, a folder under the data directory, and a base", async () => {
  const created = await createWorktree({ repoRoot: repo, title: "Fix the parser" })
  assert.ok(created.ok, "ok" in created && !created.ok ? created.error : "")
  if (!created.ok) return

  assert.equal(created.branch, "feature/fix-the-parser")
  assert.equal(created.baseBranch, "main")
  assert.equal(created.root, worktreePathFor(repo, created.branch))
  assert.ok(created.root.startsWith(worktreesRoot()))
  assert.ok(created.root.includes(repoSlug(repo)))
  assert.ok(existsSync(join(created.root, "a.txt")))

  // Registered with git, on its own branch, and the main checkout stays put.
  const listed = await listWorktrees(repo)
  const entry = listed.find((item) => resolve(item.path) === resolve(created.root))
  assert.ok(entry, "the new worktree is registered")
  assert.equal(entry.branch, "feature/fix-the-parser")
  assert.equal(listed[0].main, true)
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main")

  // The recorded merge base is what makes "unpushed" answerable for a branch
  // that has never been pushed.
  assert.equal(
    git(repo, "config", "--get", "branch.feature/fix-the-parser.gh-merge-base").trim(),
    "main"
  )

  const inside = await repoRootOf(created.root)
  assert.ok(inside)
  assert.equal(inside.linked, true)
  assert.equal(resolve(inside.mainRoot), resolve(repo))
})

test("a second worktree of the same name takes the next branch and its own folder", async () => {
  const again = await createWorktree({ repoRoot: repo, branch: "feature/fix-the-parser" })
  assert.ok(again.ok, "ok" in again && !again.ok ? again.error : "")
  if (!again.ok) return
  assert.equal(again.branch, "feature/fix-the-parser-2")
  assert.notEqual(again.root, worktreePathFor(repo, "feature/fix-the-parser"))
  assert.ok(existsSync(again.root))
})

test("a worktree started from a chat with no title is named for the clock", async () => {
  const created = await createWorktree({ repoRoot: repo, title: "New chat" })
  assert.ok(created.ok)
  if (!created.ok) return
  assert.match(created.branch, /^agent-ui\/\d{8}-\d{6}$/)
})

test("status counts what removing the worktree would throw away", async () => {
  const created = await createWorktree({ repoRoot: repo, branch: "feature/status" })
  assert.ok(created.ok)
  if (!created.ok) return

  const clean = await worktreeStatus(created.root)
  assert.equal(clean.exists, true)
  assert.equal(clean.branch, "feature/status")
  assert.equal(clean.dirty, 0)
  assert.equal(clean.unpushed, 0)
  assert.equal(clean.hasUpstream, false)

  writeFileSync(join(created.root, "b.txt"), "two\n")
  writeFileSync(join(created.root, "a.txt"), "edited\n")
  const dirty = await worktreeStatus(created.root)
  assert.equal(dirty.dirty, 2, "one edited file and one untracked one")

  git(created.root, "add", "-A")
  git(created.root, "commit", "-qm", "work")
  const committed = await worktreeStatus(created.root)
  assert.equal(committed.dirty, 0)
  // No upstream, so "unpushed" is measured against the recorded base.
  assert.equal(committed.baseBranch, "main")
  assert.equal(committed.unpushed, 1)

  assert.equal((await worktreeStatus(join(repo, "nope"))).exists, false)
})

test("removing a worktree takes the branch with it, and removing it again is fine", async () => {
  const created = await createWorktree({ repoRoot: repo, branch: "feature/disposable" })
  assert.ok(created.ok)
  if (!created.ok) return
  writeFileSync(join(created.root, "scratch.txt"), "uncommitted\n")

  const removed = await removeWorktree(repo, created.root, {
    force: true,
    branch: created.branch,
  })
  assert.ok(removed.ok, !removed.ok ? removed.error : "")
  if (!removed.ok) return
  assert.equal(removed.removed, true)
  assert.equal(removed.branchDeleted, true)
  assert.equal(existsSync(created.root), false)
  assert.equal(
    (await listWorktrees(repo)).some(
      (entry) => resolve(entry.path) === resolve(created.root)
    ),
    false
  )

  // Idempotent: two chats can share a worktree, and a user can delete the
  // folder by hand. "Already gone" is the outcome, not an error.
  const twice = await removeWorktree(repo, created.root, { branch: created.branch })
  assert.ok(twice.ok, !twice.ok ? twice.error : "")
})

test("a worktree the user deleted by hand is pruned rather than reported broken", async () => {
  const created = await createWorktree({ repoRoot: repo, branch: "feature/vanished" })
  assert.ok(created.ok)
  if (!created.ok) return
  rmSync(created.root, { recursive: true, force: true })

  const removed = await removeWorktree(repo, created.root, { branch: created.branch })
  assert.ok(removed.ok, !removed.ok ? removed.error : "")
  // The stale registration is gone too, so the same path can be used again.
  assert.equal(
    (await listWorktrees(repo)).some(
      (entry) => resolve(entry.path) === resolve(created.root)
    ),
    false
  )
})

test("a worktree with uncommitted changes is refused without force", async () => {
  const created = await createWorktree({ repoRoot: repo, branch: "feature/held" })
  assert.ok(created.ok)
  if (!created.ok) return
  writeFileSync(join(created.root, "a.txt"), "changed\n")

  const refused = await removeWorktree(repo, created.root, {})
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.match(refused.error, /uncommitted/i)
  // Nothing was thrown away, and git's own stderr never reached the message.
  assert.ok(existsSync(created.root))
  assert.doesNotMatch(refused.error, /fatal|git/i)

  assert.ok((await removeWorktree(repo, created.root, { force: true })).ok)
})

test("a repository with no commits has nothing to branch from", async () => {
  const empty = mkdtempSync(join(tmpdir(), "worktree-empty-"))
  try {
    git(empty, "init", "-q", "-b", "main", ".")
    const created = await createWorktree({ repoRoot: empty })
    assert.equal(created.ok, false)
    if (created.ok) return
    assert.equal(created.status, 409)
    assert.match(created.error, /no commits/i)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test("a folder that is not a checkout is refused", async () => {
  const plain = mkdtempSync(join(tmpdir(), "worktree-plain-"))
  try {
    const created = await createWorktree({ repoRoot: plain })
    assert.equal(created.ok, false)
    if (created.ok) return
    assert.equal(created.status, 409)
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test("a broken submodule leaves the worktree standing", async () => {
  const parent = mkdtempSync(join(tmpdir(), "worktree-sub-"))
  try {
    git(parent, "init", "-q", "-b", "main", ".")
    git(parent, "config", "user.email", "test@example.com")
    git(parent, "config", "user.name", "Test")
    writeFileSync(join(parent, "a.txt"), "one\n")
    // A `.gitmodules` naming a submodule that cannot be fetched, plus the
    // gitlink that makes `submodule update` actually try. A local path is used
    // deliberately: a bogus URL would send the test to the network.
    writeFileSync(
      join(parent, ".gitmodules"),
      '[submodule "vendor/dep"]\n\tpath = vendor/dep\n\turl = ./nonexistent-dep\n'
    )
    git(parent, "add", "-A")
    git(parent, "commit", "-qm", "first")
    const head = git(parent, "rev-parse", "HEAD").trim()
    git(parent, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/dep`)
    git(parent, "commit", "-qm", "add broken submodule")

    const created = await createWorktree({ repoRoot: parent, branch: "feature/subs" })
    assert.ok(created.ok, !created.ok ? created.error : "")
    if (!created.ok) return
    // Populating the submodule failed; the worktree is still usable, which is
    // the whole point of the best-effort call.
    assert.ok(existsSync(join(created.root, "a.txt")))
    assert.ok(existsSync(join(created.root, ".gitmodules")))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("the base is the local default branch when there is no origin", async () => {
  const base = await resolveBaseRef(repo, {})
  assert.deepEqual(base, { ref: "main", branch: "main" })
})

test("the base is origin's default branch when that ref is already local", async () => {
  const remote = mkdtempSync(join(tmpdir(), "worktree-remote-"))
  const clone = mkdtempSync(join(tmpdir(), "worktree-clone-"))
  try {
    git(remote, "init", "-q", "--bare", "-b", "main", ".")
    git(repo, "remote", "add", "origin", remote)
    git(repo, "push", "-q", "origin", "main")
    execFileSync("git", ["clone", "-q", remote, clone], { encoding: "utf8" })
    git(clone, "config", "user.email", "test@example.com")
    git(clone, "config", "user.name", "Test")

    // `origin/main` is in the clone's object store already; nothing is fetched.
    const base = await resolveBaseRef(clone, {})
    assert.deepEqual(base, { ref: "origin/main", branch: "main" })
    assert.deepEqual(await resolveBaseRef(clone, { startFromOrigin: false }), {
      ref: "main",
      branch: "main",
    })
    // An explicit base keeps its ref but records the branch it names.
    assert.deepEqual(await resolveBaseRef(clone, { baseRef: "origin/main" }), {
      ref: "origin/main",
      branch: "main",
    })

    const created = await createWorktree({ repoRoot: clone, branch: "feature/from-origin" })
    assert.ok(created.ok, !created.ok ? created.error : "")
    if (!created.ok) return
    assert.equal(created.baseBranch, "main")
    assert.equal(
      git(clone, "config", "--get", "branch.feature/from-origin.gh-merge-base").trim(),
      "main"
    )
  } finally {
    git(repo, "remote", "remove", "origin")
    rmSync(remote, { recursive: true, force: true })
    rmSync(clone, { recursive: true, force: true })
  }
})
