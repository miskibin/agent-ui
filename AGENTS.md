# Agent UI — instructions for coding agents

> `CLAUDE.md` mirrors this file. If you edit one, apply the same edit to the other.

## The one rule that matters: UI components are vendored from chat-components

Everything in `components/ui/**`, `hooks/use-click-outside.ts`, and these lib files:
`lib/cursor-agent-types.ts`, `lib/cursor-stream.ts`, `lib/cursor-agent.ts`,
`lib/agent-runtime.ts`, `lib/mock-agent.ts`, `lib/layout-transition.ts`
comes from **[miskibin/chat-components](https://github.com/miskibin/chat-components)** — the shadcn/ui registry this app is built to showcase. These files must stay byte-identical to upstream.

**Do NOT patch, fork, or extend them here.** If a component needs a fix, a new prop, or a new
component is needed:

1. Make the change in the `chat-components` repo — with its docs page, example, and
   `registry.json` entry updated, per that repo's conventions (it has its own `AGENTS.md`).
2. Merge it there.
3. Pull the updated files into this repo, either by copying from a checkout:
   `cp ../chat-components/components/ui/<file>.tsx components/ui/`
   or via the registry:
   `npx shadcn@latest add https://chat-input-azure.vercel.app/r/<item>.json --overwrite`
4. Re-verify here (`npm run lint && npm run typecheck && npm run build`).

Need app-specific behavior a generic component shouldn't carry? Compose around the component
(wrap it, use its `data-slot` attributes and `className` overrides) in app-local code — never
edit the vendored file. If composition genuinely can't express it, that's the signal the
upstream component needs a new prop or slot: go through steps 1–4.

**App-local components** (edit freely, same idiom): `components/app-header.tsx`,
`components/command-palette.tsx`, `components/provider-picker.tsx`, `components/theme-provider.tsx`,
everything in `app/`, `lib/providers/`, `lib/store/`, `lib/settings/`, `lib/theme/`,
`lib/api-client.ts`, `lib/message-stream.ts`, `lib/desktop.ts`, `src-tauri/`.

## What this app is

A fast, local-first desktop (Tauri) / web chat app for coding agents. Swappable backends behind
one interface:

- `lib/providers/types.ts` — `AgentProvider { info, listModels, run }` + capability flags
  (`tools`, `resume`, `effort`, `vision`). One streaming protocol for every backend:
  `AgentStreamEvent` (`session · thinking · tool · text · done · error`).
- Providers: `mock` (scripted), `cursor` (spawns the `cursor-agent` CLI, resumes by session id),
  `ollama` (direct NDJSON streaming, stateless — the chat route replays stored history),
  `pi` (spawns the `pi` CLI in `--mode json` as an agentic harness over the same Ollama server —
  four tools, resumes by pi session id; `lib/pi-runtime.ts` finds the binary, `lib/pi-agent.ts`
  owns the subprocess and event translation, and a generated `models.json` under
  `$AGENT_UI_DIR/pi` points pi at Ollama's OpenAI-compatible endpoint).
  New backend = one file in `lib/providers/` + a `registry.ts` entry + settings schema wiring.
- Persistence: JSON under `~/.agent-ui` (`AGENT_UI_DIR` override) via `lib/store/` —
  `sessions/index.json` (sidebar metadata) separate from `sessions/<id>.json` (transcripts).
  Settings in `settings.json` via `lib/settings/` (`GET/PUT /api/settings`, deep-merged over
  defaults so old files keep loading).
- Desktop shell: Tauri v2, frameless; the web app's `AppHeader` IS the window chrome.
  `lib/desktop.ts` talks to the shell only through the injected `window.__TAURI__` global
  (`withGlobalTauri`) — keep it dependency-free and every call a no-op in a browser tab.
  Production spawns the Next standalone server as a Node sidecar on a free port and shows the
  window only when it's ready.

## Non-negotiable conventions

- **Performance first.** Pages are pure client components: nothing on the critical path waits
  for the server (sidebar seeds from a localStorage snapshot). Preserve the streaming
  memoization guarantees: message rows never receive per-render closures; callbacks go through
  the stable-callback patterns already in the code. No new runtime dependencies without a
  strong reason.
- **shadcn idiom** (same as chat-components): semantic tokens only, `data-slot` attributes,
  `cn()` with consumer `className` merged last, cva for real variant sets,
  `focus-visible` rings, 11–13.5px type scale.
- **Strict react-hooks rules are CI-enforced.** No synchronous `setState` in effect bodies —
  defer via `queueMicrotask` (existing examples in `app/page.tsx`) or restructure.
- Errors surface via `sonner` toasts; availability degrades gracefully (see provider badges).

## Commands

```bash
npm run dev          # web dev server
npm run lint         # eslint (CI)
npm run typecheck    # tsc --noEmit (CI)
npm run build        # next build, standalone output (CI)

node scripts/prepare-desktop.mjs --skip-next   # once after cloning, before desktop work
npm run desktop:dev                            # Tauri shell against localhost:3000
npm run desktop:build                          # platform installer
```

CI: `ci.yml` (lint + typecheck + build) and `desktop.yml` (`cargo check` of src-tauri) run on
every push. `release.yml` builds Win/macOS/Linux installers on `v*` tags.

## Definition of done

`lint`, `typecheck`, `build` clean — and for anything user-visible, run the app
(`AGENT_UI_DIR=/tmp/agent-ui-test node .next/standalone/server.js` after a build) and exercise
the flow for real; there is a Playwright-style flow suite precedent in the repo history. If the
UI changed visibly, refresh the screenshots in `.github/screenshots/` and keep `README.md`
accurate.
