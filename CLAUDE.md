# Agent UI — instructions for coding agents

> `AGENTS.md` mirrors this file. If you edit one, apply the same edit to the other.

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

### The copies must never drift

`npm run vendor:check` (`scripts/check-vendored.mjs`) diffs every vendored file against a
sibling `../chat-components` checkout — override with `--repo <path>` or `CHAT_COMPONENTS_DIR`
— and fails on any byte that differs, on a file in `components/ui` with no upstream twin, and
on one upstream has that this app has lost. It skips silently when the checkout is absent, so
it is a check you run beside a clone, not something CI can do for you. **Run it after any sync,
and before opening a PR that touches `components/ui`.**

Drift is not a tidiness problem. It is how a fix lands in one repo and silently misses the
other, and how the next `cp` from upstream deletes a feature nobody remembers adding here.
Three features once lived only in this repo's copies — the `--ui-scale` portal fix,
`resolveFileUrl` for image tool rows, and `FilePreviewFile.imageSrc` — and every one of them
was one careless overwrite from being lost.

**This app is the product; the registry follows it.** So when the two disagree, the answer is
almost never "patch it here": it is to take *this* repo's behaviour, land it in
`chat-components` with docs, an example and a registry rebuild, and copy back. Changing a
vendored file here without doing that is the one thing that is always wrong, however small the
change looks.

The eight stock shadcn primitives this app installed directly — `badge`, `card`, `input`,
`label`, `select`, `skeleton`, `slider`, `switch` — are the documented exception: the registry
does not ship them, so they have no upstream to match. They are listed in the check.

**App-local components** (edit freely, same idiom): `components/app-header.tsx`,
`components/command-palette.tsx`, `components/folder-picker.tsx`, `components/handoff-notice.tsx`,
`components/memory-notice.tsx`, `components/message-actions.tsx`, `components/stash-menu.tsx`,
`components/folder-status.tsx`, `components/chat-changes.tsx`, `components/context-usage.tsx`,
`components/provider-picker.tsx`, `components/provider-logo.tsx`, `components/permission-picker.tsx`,
`components/theme-provider.tsx`, `components/chat-sidebar-panel.tsx`, `components/sidebar-sections.tsx`,
`components/chat-skeletons.tsx`, `components/chat-suggestions.tsx`, `components/live-time.tsx`,
`app/settings/model-providers-section.tsx`,
everything in `app/`, `lib/providers/`, `lib/model-providers/`, `lib/store/`, `lib/settings/`,
`lib/theme/`, `lib/memory/`, `lib/handoff/`,
`lib/api-client.ts`, `lib/message-stream.ts`, `lib/turn-files.ts`, `lib/session-groups.ts`,
`lib/desktop.ts`, `lib/folder.ts`, `lib/fs-paths.ts`, `lib/open-target.ts`, `lib/git-status.ts`,
`lib/completion.ts`, `lib/model-pricing.ts`, `lib/file-actions.tsx`, `lib/drafts.ts`,
`lib/slash-commands.ts`, `lib/app-shortcuts.ts`, `lib/notifications.ts`, `lib/attachments.ts`,
`lib/local-media.ts`, `lib/chat-helpers.ts`, `lib/ask-tools.ts`, `lib/ui-cache.ts`,
`lib/todo-plan.ts`, `src-tauri/`.

`components/ui/todo-list.tsx` and `components/ui/context-meter.tsx` are vendored too, same rule
as the rest of `components/ui/**`.

### The chat page is a composition root over `app/hooks/`

`app/page.tsx` wires the surface together and lays it out; it holds no concern of its own.
Each concern is one hook, and they are called in the order the data flows:

- `use-chat-refs` — the shared spine. Every ref more than one concern reads (the open chat, the
  loaded threads, the session index, the settings, the abort controllers, the composer handle)
  plus `useMirrorRefs`, the single dependency-free effect that refreshes them after each paint.
  They exist so a click handler, a shortcut or a stream callback can read what the user is
  looking at *without* closing over it — a closure over state is a new identity every render,
  which is exactly what breaks the memoized rows. **`useMirrorRefs` must stay ahead of
  `use-composer-drafts`**: restoring a chat's parked draft calls the composer's `onTextChange`
  synchronously, and that handler reads `activeIdRef` to decide which chat to save under, so a
  mirror one render behind files the newly opened chat's draft under the one just left.
- `use-session-index` — the sidebar index and the open chat, plus the mutations that touch only
  those. Deliberately the layer with nothing behind it, so `use-agent-config` can write back
  through `patchLocal` without a cycle.
- `use-threads` — the transcripts, lazily loaded, on a 4-entry LRU that protects the open and
  the running ones.
- `use-agent-config` — settings, harnesses, the model catalog, effort and permission, and the
  writing-back that makes a chat remember its own agent.
- `use-chat-nav` — sidebar collapse, the mobile drawer, folded folder sections, the palette,
  the rename token.
- `use-file-panel` — which file is open, the split, the diff prefs, and every way a file gets
  opened (tool row, change card, `path.ts:42` chip, the whole-chat list).
- `use-memory-notices`, `use-prompt-stash`, `use-message-queue`, `use-composer-drafts` — the
  memory marker and the composer's own conveniences.
- `use-chat-actions` — the mutations that cross concerns: opening a chat re-points the pickers
  and closes the panel; deleting one drops its thread, queue, draft and run.
- `use-turn-runner` — one streaming turn end to end; `use-chat-turns` — send (slash commands,
  attachments, the detached queued run), stop, and the in-place transcript edits.
- `use-thread-view`, `use-sidebar-items`, `use-command-palette` — the derived view models;
  `use-chat-bootstrap`, `use-attention`, `use-chat-shortcuts`, `use-composer-height` and
  `use-is-desktop` — the small ones.

Pure helpers stay in `lib/` and are exported so they can be unit tested: `lib/chat-helpers.ts`
(time and label formatting, `pickProvider`, `omit`, `errorMessage`), `lib/ask-tools.ts`
(`findPendingAsk`, `completeAsk`, `isInternalMessage`), `lib/ui-cache.ts` (every `agent-ui:*`
snapshot key, in one place) and `lib/todo-plan.ts` (`latestTodos`).

## What this app is

A fast, local-first desktop (Tauri) / web chat app for coding agents. Swappable backends behind
one interface:

- `lib/providers/types.ts` — `AgentProvider { info, listModels, run }` + capability flags
  (`tools`, `resume`, `effort`, `vision`). One streaming protocol for every backend:
  `AgentStreamEvent` (`session · status · thinking · tool · text · done · error`).
  `status` is progress that is *not* message content (a cold model being loaded, a CLI
  being spawned); the UI shows the latest one while the turn is still empty and drops it
  when real output arrives. A `tool` event may carry an `exitCode`, and only ever one the
  backend actually published — absent is not zero. `done` carries the turn's token usage, which the chat route
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

  Two token families are *not* taken verbatim, and `lib/theme/contrast.ts` owns both.
  **`accent` / `sidebar-accent` are derived**: a tint of the theme's own primary over its own
  surface, with the tint weakened until the surface's own ink reads on it. A registry accent is
  whatever its author picked, and the app leans on it for every hover and every selected row —
  `notebook` dark ships one at oklch(0.907) under a foreground of oklch(0.895), which is white
  on white. Deriving it keeps the theme's hue (and carries more of it than most originals did)
  while making the hover the same shape everywhere. **Contrast is a setting**, `soft |
  standard | high` (Settings → Appearance, persisted in `appearance.contrast`): `standard`
  holds every text pair to WCAG AA against the surface it actually sits on, `high` to AAA,
  `soft` relaxes the greys down to a floor. Each level is emitted as its own small
  `[data-contrast]` block carrying only the tokens it moves, and the light half is guarded with
  `:not(.dark)` — the extra attribute would otherwise outrank the *dark* base block. Repair
  moves lightness only, never hue or chroma. `tests/theme-contrast.test.ts` is the net: every
  shipped theme, both modes, all three levels.

  The typeface is the one token the user may pin across themes:
  `lib/theme/font-options.ts` lists the choices, and `applyAppearance` writes the picked
  stack inline on `<html>`, which outranks the `[data-theme]` block. A new family needs a
  `next/font` loader in `app/fonts.ts` as well as an entry there.
- Persistence: JSON under `~/.agent-ui` (`AGENT_UI_DIR` override) via `lib/store/` —
  `sessions/index.json` (sidebar metadata) separate from `sessions/<id>.json` (transcripts)
  and `sessions/<id>.journal.json` (the handoff journal).
  Settings in `settings.json` via `lib/settings/` (`GET/PUT /api/settings`, deep-merged over
  defaults so old files keep loading).
- User memory (`lib/memory/`, off by default): durable preferences in
  `memory/<category>.md`, one markdown file per category — a directory rather than a key in
  settings.json precisely so it can be read, edited, exported and shredded on its own.
  `context.ts` builds the block a turn is handed, which reaches the backend through the
  `standingContext` field of `AgentRunOptions`: Ollama and the OpenAI-compatible paths send it
  as a real system role, the CLI harnesses (one prompt string each) get it fenced as
  `<context>` in front of the prompt by `withPromptContext`, and a provider with
  `capabilities.resume` is sent it only on the first turn of its conversation. It is the
  *standing* half of the two-context split — see `lib/handoff/` for the other half, and for
  why the two must not blur together.
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
- Handing one agent's work to the next (`lib/handoff/`, on by default): a chat is one
  conversation, but each backend in it is a different one. `SessionMeta.agentSessions` keys a
  small record by provider id — `{ providerSessionId, cwd, lastSeenSeq, lastWroteSeq,
  lastActiveAt, snapshot }` — so switching agents mid-chat no longer throws the other one's
  resumable session away. An index written before this migrates on read from the single
  `providerSessionId` field (still written, for whichever provider ran last). A stored id is
  only reused when the chat's folder still matches the one it was minted in; the model is not
  part of that identity.

  Beside the transcript, each chat keeps `sessions/<id>.journal.json`: an append-only log of
  *semantic* events — `user-message` (truncated), `tool` (name, done/error, paths, command,
  published `exitCode`) and `turn-end` (model, ok/error/aborted) — each with a monotonic `seq`
  and the provider that wrote it, capped at the newest 500. No streamed text, no thinking, no
  tool output: a transcript already exists, and this is the far smaller thing a returning agent
  needs. Seqs survive the cap, because they are what the cursors index. `build.ts` turns the
  events an agent has not seen (`seq > lastSeenSeq`, and never its own) into one deterministic
  block — requests, files changed (tool paths plus `git diff --stat` against the head it last
  saw, else the current dirty list), commands with exit codes, test runs, errors and unfinished
  work — inside an 8k budget that sheds oldest-first and never sheds the stale-worktree warning
  or the newest errors. `snapshot.ts` is the cheap worktree read behind that: one `rev-parse`
  and one `--no-optional-locks status --porcelain`, 1.5s each, undefined on any failure — it
  never stages, writes a tree or takes a lock, so running it after every turn cannot disturb
  what the user has staged.

  Two cursors, deliberately separate (`cursor.ts`): an agent's own turn advances `lastSeenSeq`
  to the end of that turn — but only once the backend actually spoke (a `session` id, a token,
  a tool call, a completed turn), so a spawn failure, a refused connection or a stop before any
  output re-offers the same handoff instead of swallowing it. `lastWroteSeq` is the other one,
  and exists so the composer can say "handoff pending" without opening the journal.

  **The division with `lib/memory` is load-bearing and must not blur.** Memory is durable,
  cross-chat and about the *user*; a handoff is ephemeral, single-chat and about the *other
  agents*. They travel in two different fields (`standingContext` / `turnContext`), are fenced
  once each in one fixed order by the single builder in `lib/providers/system-prefix.ts`, and
  never feed each other: no memory fact is ever put in a handoff, and nothing here is written
  to `memory/` or shown to the extractor — which keeps seeing only the stored user messages,
  and the stored user message stays exactly what the user typed. `turnContext` is the one that
  rides in front of the prompt on *every* turn, resumed sessions included, because a backend
  that has been away is precisely the one that does not know what changed.

  It is visible, not implicit: the block is stored on the assistant message
  (`metadata.handoff`) and rendered by `components/handoff-notice.tsx` through `MessageList`'s
  `renderActions` slot, and the composer's provider list says which agents resume, when they
  last ran, and which are owed a handoff. `handoff.enabled` (Settings → Chat) turns the journal,
  the git reads and the block off together; per-provider session ids are kept either way.
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
  vendored (`file-preview.tsx`, `file-icon.tsx`, `resizable.tsx`); `app/hooks/use-file-panel.ts`
  owns the state — which file is open, the split width under `agent-ui:preview-size`, closing on
  a chat switch — and `app/page.tsx` mounts the panel as the second pane of a
  `ResizablePanelGroup` *below* the `AppHeader`, which
  keeps spanning the full width because it is also the desktop window's drag chrome. Below `md` the
  same panel slides over the conversation inside that wrapper. `GET /api/file` reads the text: the
  root is the chat's stored folder, else the provider's workspace, and it is resolved server-side
  from the session id — the client never names a root. Anything outside it, or inside the app's
  data directory, is a 403; the panel falls back to the diff alone on any failure.
- Quality of life around files: every file the chat names — a change-card row, the file
  panel's header, a path chip or an image in an answer, a chat row's folder — carries one
  right-click menu, built by `lib/file-actions.tsx` from what `GET /api/open` detected on this
  machine (VS Code, Cursor, Zed, Windsurf, Sublime, the JetBrains IDEs; the terminals). The
  vendored components only show the menu (`FileActionItem[]`, threaded through `MessageList`,
  `ChangeSummary`, `FilePreview` and `MessageMarkdown`); `POST /api/open` does the opening,
  server-side, as a fixed argv with the path as one argument — never `shell: true`; a Windows
  `.cmd` shim or `start` goes through `cmd.exe` with every argument quoted by the app and
  paths carrying `"`, `%` or a newline refused — resolves a relative path against the chat's
  stored folder, refuses the data directory, and under `files.anyPath` off is confined to the
  app's own folders like `/api/files` (`lib/fs-roots.ts`). `Settings → Editor & terminal`
  picks the defaults (`settings.editor`), ⌘O opens the chat's folder. "Revert changes" is
  `POST /api/git/revert` (`git checkout -- <file>`, tracked files only, confirmed through a
  toast action). A `file.ts:42` chip hands its line to `FilePreviewFile.focusLine`. The
  panel's split/unified and wrap choices persist under `agent-ui:preview-prefs`; the header's
  "N files changed in this chat" (`components/chat-changes.tsx`) is the union of every turn's
  card, for the whole-thread scope next to the per-turn one.
- Composer conveniences, all app-owned state over the vendored composer's handle
  (`ChatInputHandle`): messages typed mid-turn are queued per chat
  (`app/hooks/use-message-queue.ts`) and sent one at a time as turns end — a stopped turn keeps its queue; `@` lists files under
  the chat's folder through `GET /api/fs/search` (a bounded, briefly cached walk that skips
  `node_modules`-style directories); each chat's draft is parked in memory on switch (files
  included) and its text under `agent-ui:drafts` (`lib/drafts.ts`); ⌘S stashes the draft into
  a global list (`agent-ui:stash`, text only across reloads) restored from
  `components/stash-menu.tsx`; a long paste becomes a `[Pasted text #1 +40 lines]` chip
  inside the composer; text attachments are read and fenced into the prompt
  (`lib/attachments.ts`, `MAX_TEXT_ATTACHMENT_BYTES`), other non-images are named; the app's
  own `/` commands live in `lib/slash-commands.ts` and are handled in `send` before anything
  reaches a model; selecting text in an answer offers "Quote", which drops a blockquote at the
  caret. Global keys are one listener in `lib/app-shortcuts.ts` — ⌘N, ⌘B, ⌘⇧[ / ⌘⇧], ⌘1…9,
  ⌘O, and type-to-focus — bound from an effect because the handlers read refs.
- Attention: `lib/notifications.ts` posts an OS notification when a turn ends, asks or fails
  while the window is not in front (the shell's `tauri-plugin-notification`, else the web
  `Notification` API, whose click reopens the chat), bounces the dock, and mirrors the count
  of chats waiting on an answer onto the dock badge (`setBadgeCount`) and the tab title.
  `settings.chat.desktopNotifications` switches it off. Sidebar folder headers poll
  `GET /api/git/status` (`lib/git-status.ts`: ahead/behind, dirty count, the branch's PR via
  `gh` when present) once a minute and on focus. "Regenerate title" (`POST
  /api/sessions/<id>/title`, `lib/completion.ts`) asks the chat's own model when it is one the
  app can reach directly, else the memory model. Token counts get an estimated price from
  `lib/model-pricing.ts` — list prices by `<source>/<model>`; Ollama is free, a CLI harness's
  bare id is unknown rather than free.
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
  defer via `queueMicrotask` (existing examples in `app/hooks/`) or restructure.
- Errors surface via `sonner` toasts; availability degrades gracefully (see provider badges).

## Commands

```bash
npm run dev          # web dev server
npm run lint         # eslint (CI)
npm run typecheck    # tsc --noEmit (CI)
npm run test         # node --test over tests/*.test.ts (no runner dependency:
                     #   Node strips the types, tests/register.mjs resolves `@/`)
npm run build        # next build, standalone output (CI)

npm run desktop:dev                            # Tauri shell; stages the Node sidecar if missing
npm run desktop:build                          # platform installer
```

CI: `ci.yml` (lint + typecheck + test + build) and `desktop.yml` (`cargo check` of src-tauri) run on
every push. `release.yml` builds Win/macOS/Linux installers on `v*` tags.

## Definition of done

`lint`, `typecheck`, `test`, `build` clean — plus `vendor:check` whenever `components/ui/**`
or a shared `lib/` module was touched — and for anything user-visible, run the app
(`AGENT_UI_DIR=/tmp/agent-ui-test node .next/standalone/server.js` after a build) and exercise
the flow for real; there is a Playwright-style flow suite precedent in the repo history. If the
UI changed visibly, refresh the screenshots in `.github/screenshots/` and keep `README.md`
accurate.
