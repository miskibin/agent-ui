import { register } from "node:module"

/**
 * Teaches `node --test` the two things the app's source assumes and Node does
 * not: the `@/…` path alias from tsconfig, and extensionless imports between
 * TypeScript modules. Node ≥ 22.18 strips the types itself, so the suite needs
 * no compiler, no bundler and no dependency of its own.
 */
register("./alias-hook.mjs", import.meta.url)
