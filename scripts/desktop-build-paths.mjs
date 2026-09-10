import path from "node:path"

/**
 * Resolve every artifact from the same Next dist directory. Desktop builds may
 * inherit AGENT_UI_BUILD_DIR from an isolated verification build; mixing that
 * build with `.next` can silently package an older standalone server.
 */
export function desktopBuildPaths(root, buildDir = process.env.AGENT_UI_BUILD_DIR) {
  const distDir = buildDir || ".next"
  const dist = path.resolve(root, distDir)
  return {
    distDir,
    dist,
    standalone: path.join(dist, "standalone"),
    static: path.join(dist, "static"),
  }
}

/** Keep static assets under the dist directory named in the built server. */
export function desktopStaticDestination(appDir, distDir) {
  return path.join(appDir, distDir, "static")
}
