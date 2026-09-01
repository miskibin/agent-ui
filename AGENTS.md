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
`components/command-palette.tsx`, `components/folder-picker.tsx`, `components/memory-notice.tsx`,
`components/message-actions.tsx`,
`components/provider-picker.tsx`, `components/provider-logo.tsx`, `components/permission-picker.tsx`,
`components/theme-provider.tsx`, `app/settings/model-providers-section.tsx`,
everything in `app/`, `lib/providers/`, `lib/model-providers/`, `lib/store/`, `lib/settings/`,
`lib/theme/`, `lib/memory/`,
`lib/api-client.ts`, `lib/message-stream.ts`, `lib/turn-files.ts`, `lib/session-groups.ts`,
`lib/desktop.ts`, `lib/folder.ts`,
`lib/fs-paths.ts`, `src-tauri/`.

`components/ui/todo-list.tsx` and `components/ui/context-meter.tsx` are vendored too, same rule
as the rest of `components/ui/**`.

## What this app is

A fast, local-first desktop (Tauri) / web chat app for coding agents. Swappable backends behind
one interface:

- `lib/providers/types.ts` — `AgentProvider { info, listModels, run }` + capability flags
  (`tools`, `resume`, `effort`, `vision`). One streaming protocol for every backend:
  `AgentStreamEvent` (`session · status · thinking · tool · text · done · error`).
  `status` is progress that is *not* message content (a cold model being loaded, a CLI
  being spawned); the UI shows the latest one while the turn is still empty and drops it
  when real output arrives. `done` carries the turn's token usage, which the chat route
  persists as message metadata. Reasoning effort is offered wherever the backend can carry
  it, not only where it is native: Ollama walks a `think` ladder (graded level → boolean →
  off) on the 400s that tell those cases apart, ACP sets a `reasoning_effort` session config
  option whose failure is already swallowed, and the OpenAI-compatible paths send
  `reasoning_effort` and retry without it. `cursor` is the one harness without the control —
  its CLI has no flag for it. Permission is unified the same way: `PermissionMode` is
  `read-only | edits | full`, a provider lists which of those it can enforce in
  `capabilities.permissionModes`, and the composer's `components/permission-picker.tsx`
  shows up only then — ACP's generic client offers read-only/full, dsh maps all three onto
  its own sandbox — with the chosen mode persisted per session.
- Providers: `mock` (scripted), `cursor` (spawns the `cursor-agent` CLI, resumes by session id),
  `ollama` (direct NDJSON streaming, stateless — the chat route replays stored history),
  `pi` (spawns the `pi` CLI in `--mode json` as an agentic harness over *every* configured
  model source — the local Ollama server, the hosted providers under `settings.modelProviders`,
  or either on its own; it is unavailable only when neither is there. Four tools, resumes by pi
  session id; `lib/pi-runtime.ts` finds the binary, `lib/pi-agent.ts` owns the subprocess and
  event translation, and a generated `models.json` under `$AGENT_UI_DIR/pi` writes one entry per
  source — with `compat.supportsReasoningEffort` off for Ollama's shim, which rejects it, and on
  for the hosted ones, which read it).
  New backend = one file in `lib/providers/` + a `registry.ts` entry + settings schema wiring.
  Picking a model is a three-step choice — harness, then model provider, then model — and a
  provider that runs its own agent loop (`pi`) or streams tool-less chat directly
  (`chat`, `lib/providers/openai-chat.ts`) both draw from the same `settings.modelProviders`:
  ten built-in OpenAI-compatible presets (OpenAI, Anthropic, xAI, Google, DeepSeek, Groq,
  Mistral, OpenRouter, Together AI, Fireworks — `lib/model-providers/presets.ts`) plus custom
  entries a user adds, each `{ name, baseUrl, apiKey, models[] }` keyed by a slug
  (`[a-z0-9-]{1,32}`, `ollama` reserved for the local server). `lib/model-providers/server.ts`
  turns the enabled ones into a catalog (`Bearer` + `x-api-key`/`anthropic-version` so both
  OpenAI- and Anthropic-shaped `/models` work) that pi's generated `models.json` unions with
  Ollama's, and that Settings → Model providers probes via `POST /api/model-providers/probe`.
  A model everywhere else is a composite id, `<source>/<model>` (`lib/model-providers/ids.ts`),
  split on the first slash so a hosted id that itself contains one (`openai/gpt-4o` on
  OpenRouter) still round-trips; the vendored model picker groups options by that source.
- Themes: complete shadcn theme items vendored from the tweakcn registry.
  `lib/theme/themes/generated.ts` is generated by `scripts/import-tweakcn.mjs` (curated list
  lives in that script) and holds each item's `cssVars` verbatim; `lib/theme/apply.ts` emits
  every variable — colors, radius, fonts, shadows, tracking — into one `[data-theme]`
  stylesheet, `app/fonts.ts` loads the typefaces they name, and the app's own surface aliases
  in `globals.css` are `color-mix`ed from those tokens. Do not hand-edit theme data.
  The typeface is the one token the user may pin across themes:
  `lib/theme/font-options.ts` lists the choices, and `applyAppearance` writes the picked
  stack inline on `<html>`, which outranks the `[data-theme]` block. A new family needs a
  `next/font` loader in `app/fonts.ts` as well as an entry there.
- Persistence: JSON under `~/.agent-ui` (`AGENT_UI_DIR` override) via `lib/store/` —
  `sessions/index.json` (sidebar metadata) separate from `sessions/<id>.json` (transcripts).
  Settings in `settings.json` via `lib/settings/` (`GET/PUT /api/settings`, deep-merged over
  defaults so old files keep loading).
- User memory (`lib/memory/`, off by default): durable preferences in
  `memory/<category>.md`, one markdown file per category — a directory rather than a key in
  settings.json precisely so it can be read, edited, exported and shredded on its own.
  `context.ts` builds the block a turn is handed, which reaches the backend through the
  `system` field of `AgentRunOptions`: Ollama sends it as a real system role, the CLI harnesses
  (one prompt string each) get it fenced in front of the prompt by `withSystemPrefix`, and a
  provider with `capabilities.resume` is sent it only on the first turn of its conversation.
  `extract.ts` is the write path and runs *outside* the chat turn, on `POST /api/memory/update`
  after the answer has settled, against a small Ollama model — so a slow or broken extraction
  can never delay an answer. It rewrites whole categories rather than patching lines (that is
  what lets one call add, correct, merge and shorten at once) and the UI's change list is a
  line diff of the whole run, taken against the state it started from. The
  `memory.maxChars` budget is enforced *after* the write, with a second merge-and-shorten pass
  when it is exceeded — a small model will promise to stay under a cap and then not.
  Two rules are load-bearing and must not be relaxed: the extractor is handed **only the
  user's own messages** (never assistant text, tool calls, tool output or file contents), so
  content the agent merely read cannot write itself into every future prompt; and category
  ids are validated against a separator-free alphabet rather than escaped, because they
  become file names.
- Local files an answer points at: `lib/message-stream.ts` rewrites markdown image targets that
  name a path on this machine (`lib/local-media.ts`) to `GET /api/files`, which streams the file
  back on the app's own origin — a browser will not load `file://` from an http page. The route
  refuses cross-site requests and serves everything sandboxed and `nosniff`; `files.anyPath` in
  settings narrows it from any path (the default) to the app's folders. The same route is what
  makes an image *visible* everywhere else: `resolveFileUrl` (a `MessageList` prop, wired in
  `app/page.tsx`) turns a path a tool named into that URL, so a Read of a `.png` renders the
  picture instead of the `image/webp image, 1531x889 px` line the harness returns, and the file
  panel shows it through `FilePreviewFile.imageSrc`. A relative path is joined with the chat's
  cwd (`localFileUrlFrom`).
- What a turn *produced*, not just what it edited: `lib/turn-files.ts` widens the Files Changed
  card past the mutation tools the vendored `fileChangesFromTools` sees. A chart a shell command
  wrote leaves no edit behind, so the extras come from the rest of the turn — images a tool
  opened, images the answer embeds, and artifact-typed files the answer merely names in a
  `wykres.png` chip (that list is deliberately narrow: an answer cites source files constantly,
  and those are not output). Rows are deduped across relative and absolute spellings, and the
  helper returns undefined when it has nothing to add, which leaves the card to the component
  and the message object untouched — the memoized row must not re-render for this.
- The sidebar is grouped, not one flat list: `lib/session-groups.ts` splits the index into the
  pinned chats and one section per working folder (`SessionMeta.cwd`), with the folderless ones
  last. The folder is the section header — its last segment, widened to two when two checkouts
  share a basename, plus the branch of the group's newest chat — so a row is free to say what
  answered in it, and a closed section keeps a live dot while a chat inside it streams. Groups
  and their rows are ordered by `updatedAt`; hand-made order (`order`, drag-to-reorder) survives
  only in the pinned group, because `order` is one global sequence with nothing per-folder to
  write back to. Closed sections are remembered under `agent-ui:folder-sections` — closed ones
  only, so a folder seen for the first time opens.
- The file panel: every file a turn touched opens beside the conversation. The components are
  vendored (`file-preview.tsx`, `file-icon.tsx`, `resizable.tsx`); `app/page.tsx` owns the state
  — which file is open, the split width under `agent-ui:preview-size`, closing on a chat switch —
  and mounts the panel as the second pane of a `ResizablePanelGroup` *below* the `AppHeader`, which
  keeps spanning the full width because it is also the desktop window's drag chrome. Below `md` the
  same panel slides over the conversation inside that wrapper. `GET /api/file` reads the text: the
  root is the chat's stored folder, else the provider's workspace, and it is resolved server-side
  from the session id — the client never names a root. Anything outside it, or inside the app's
  data directory, is a 403; the panel falls back to the diff alone on any failure.
- Desktop shell: Tauri v2, frameless; the web app's `AppHeader` IS the window chrome.
  `lib/desktop.ts` talks to the shell only through the injected `window.__TAURI__` global
  (`withGlobalTauri`) — keep it dependency-free and every call a no-op in a browser tab.
  Production spawns the Next standalone server as a Node sidecar on a free port and shows the
  window only when it's ready. Auto-update rides the same bridge: `tauri-plugin-updater` +
  `tauri-plugin-process` are registered in `src-tauri`, `lib/desktop.ts` wraps
  `check / downloadAndInstall / relaunch`, and `components/desktop-updater.tsx` (mounted in
  `app/layout.tsx`) schedules the startup check off the critical path and owns the toasts.
  The updater public key in `tauri.conf.json` is a placeholder — see "Updater" in README.md.

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

npm run desktop:dev                            # Tauri shell; stages the Node sidecar if missing
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
