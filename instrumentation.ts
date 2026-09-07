/**
 * Next.js's boot hook: `register()` runs once, before the server takes its
 * first request (`prepare()` awaits it), and it is the only place in this app
 * where "once, before anything else" is a thing that can be said.
 *
 * One job so far — repairing the environment this process inherited. Every
 * harness the app can offer is found by looking through `PATH`, and a desktop
 * launch does not get the user's: macOS hands a GUI process
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so `claude`, `cursor-agent`, `pi` and
 * `ollama` all read as "not installed" until someone runs the app from a
 * terminal and cannot reproduce the bug. `lib/shell-env` asks the login shell
 * instead and merges the answer into `process.env`, which every PATH reader in
 * the app already consults at call time.
 *
 * It is awaited here on purpose: the provider detection that reads PATH runs
 * on a request, and a request cannot arrive until this returns.
 */
export async function register() {
  // The hook also runs in the Edge runtime, which has no child processes and
  // no environment to repair.
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { hydrateProcessEnv } = await import("@/lib/shell-env")
  hydrateProcessEnv()
}
