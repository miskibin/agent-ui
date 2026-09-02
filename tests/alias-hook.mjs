import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)

/**
 * Resolves `@/lib/handoff/build` the way the bundler does: the alias points at
 * the repo root, and a specifier with no extension is tried as `.ts` and then
 * as `.ts` inside a directory.
 */
export function resolve(specifier, context, nextResolve) {
  // `server-only` exists to throw outside a server component; under the test
  // runner it would refuse every server module the suite wants to exercise.
  if (specifier === "server-only") {
    return nextResolve(new URL("./server-only-stub.mjs", import.meta.url).href, context)
  }
  const target = specifier.startsWith("@/")
    ? new URL(specifier.slice(2), root)
    : specifier.startsWith(".") && context.parentURL
      ? new URL(specifier, context.parentURL)
      : null
  if (!target) return nextResolve(specifier, context)

  for (const candidate of [target.href, `${target.href}.ts`, `${target.href}/index.ts`]) {
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate, context)
    }
  }
  return nextResolve(specifier, context)
}
