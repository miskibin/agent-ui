import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"

import {
  desktopBuildPaths,
  desktopStaticDestination,
} from "../scripts/desktop-build-paths.mjs"

test("desktop artifacts all come from the default Next build", () => {
  const root = path.resolve("project")
  const paths = desktopBuildPaths(root, "")

  assert.equal(paths.distDir, ".next")
  assert.equal(paths.dist, path.join(root, ".next"))
  assert.equal(paths.standalone, path.join(root, ".next", "standalone"))
  assert.equal(paths.static, path.join(root, ".next", "static"))
})

test("desktop staging preserves Next's exact dist directory semantics", () => {
  const root = path.resolve("project")
  const paths = desktopBuildPaths(root, " review output ")

  assert.equal(paths.distDir, " review output ")
  assert.equal(paths.dist, path.resolve(root, " review output "))
})

test("an isolated Next build cannot be mixed with stale .next artifacts", () => {
  const root = path.resolve("project")
  const paths = desktopBuildPaths(root, ".next-review")

  assert.equal(paths.distDir, ".next-review")
  assert.equal(paths.dist, path.join(root, ".next-review"))
  assert.equal(paths.standalone, path.join(root, ".next-review", "standalone"))
  assert.equal(paths.static, path.join(root, ".next-review", "static"))
  assert.equal(
    desktopStaticDestination(path.join(root, "staged-app"), paths.distDir),
    path.join(root, "staged-app", ".next-review", "static")
  )
})
