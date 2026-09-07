# Agent UI — instructions for coding agents

> `CLAUDE.md` mirrors this file. If you edit one, apply the same edit to the other.

## The one rule that matters: UI components are vendored from chat-components

Everything in `components/ui/**`, `hooks/use-click-outside.ts`, and these lib files:
`lib/cursor-agent-types.ts`, `lib/cursor-stream.ts`, `lib/cursor-agent.ts`,
`lib/cursor-transport-failure.ts`,
`lib/agent-runtime.ts`, `lib/mock-agent.ts`, `lib/layout-transition.ts`,
`lib/command-label.ts`, `lib/lru-cache.ts`, `lib/markdown-clipboard.ts`,
`lib/markdown-file-paths.ts`, `lib/markdown-github-alerts.ts`, `lib/markdown-list-indentation.ts`,
`lib/prompt-history.ts`, `lib/syntax-highlighting.ts`, `lib/visible-animation.ts`
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
`components/pending-question.tsx`, `components/theme-provider.tsx`,
`components/chat-sidebar-panel.tsx`, `components/sidebar-sections.tsx`,
`components/binary-file.tsx`, `components/diff-workers.tsx`,
`components/chat-skeletons.tsx`, `components/chat-suggestions.tsx`, `components/live-time.tsx`,
`components/import-dialog.tsx`, `components/quit-hold.tsx`, `components/desktop-updater.tsx`,
`app/settings/model-providers-section.tsx`,
everything in `app/`, `lib/providers/`, `lib/model-providers/`, `lib/store/`, `lib/settings/`,
`lib/theme/`, `lib/memory/`, `lib/handoff/`,
`lib/api-client.ts`, `lib/message-stream.ts`, `lib/turn-files.ts`, `lib/session-groups.ts`,
`lib/desktop.ts`, `lib/folder.ts`, `lib/fs-paths.ts`, `lib/open-target.ts`, `lib/git-status.ts`,
`lib/completion.ts`, `lib/model-pricing.ts`, `lib/file-actions.tsx`, `lib/drafts.ts`,
`lib/slash-commands.ts`, `lib/app-shortcuts.ts`, `lib/notifications.ts`, `lib/attachments.ts`,
`lib/local-media.ts`, `lib/chat-helpers.ts`, `lib/ask-tools.ts`, `lib/ui-cache.ts`,
`lib/todo-plan.ts`, `lib/turn-requests.ts`, `lib/usage.ts`, `components/chat-usage.tsx`,
`lib/message-search.ts`, `lib/search-ranking.ts`, `lib/skills.ts`, `lib/skills-scan.ts`,
`lib/import/`, `lib/worktree.ts`, `lib/git-naming.ts`, `lib/git-commit.ts`, `lib/git-exec.ts`,
`lib/checkpoints.ts`, `lib/dev-servers.ts`, `lib/shell-env.ts`, `instrumentation.ts`,
`app/settings/usage-section.tsx`, `src-tauri/`.

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
  memory marker and the composer's own conveniences; `use-skills` — the skills and harness
  commands the open chat's folder offers, and the names `send` dispatches on.
- `use-chat-actions` — the mutations that cross concerns: opening a chat re-points the pickers
  and closes the panel; deleting one drops its thread, queue, draft and run.
- `use-turn-runner` — one streaming turn end to end; `use-chat-turns` — send (slash commands,
  attachments, the detached queued run), stop, and the in-place transcript edits.
- `use-thread-view`, `use-sidebar-items`, `use-command-palette` — the derived view models;
  `use-chat-bootstrap`, `use-attention`, `use-chat-shortcuts`, `use-composer-height` and
  `use-is-desktop` — the small ones.

Pure helpers stay in `lib/` and are exported so they can be unit tested: `lib/chat-helpers.ts`
(time and label formatting, `pickProvider`, `omit`, `errorMessage`), `lib/ask-tools.ts`
(`findPendingAsk`, `findPendingRequest`, `completeAsk`, `isInternalMessage`),
`lib/ui-cache.ts` (every `agent-ui:*` snapshot key, in one place) and
`lib/todo-plan.ts` (`latestTodos`).

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
  `read-only | plan | edits | full`, a provider lists which of those it can enforce in
  `capabilities.permissionModes`, and the composer's `components/permission-picker.tsx`
  shows up only then — ACP's generic client offers read-only/full, dsh maps all three of
  its levels onto its own sandbox, and `cursor` offers read-only/plan/full, which are its
  CLI's own `--mode ask`, `--mode plan` and no flag at all (`edits` is absent because
  cursor-agent has nothing between "does not write" and "writes anywhere"). Because the
  third of those is the *absence* of a flag, `--resume` cannot take a cursor conversation
  back out of ask or plan mode — it answers "I'm in Ask mode" for the rest of the chat — so
  `cursor` alone declares `capabilities.permissionModePerSession` and a turn that asks for
  another mode starts a fresh backend session instead of resuming one that cannot honour
  it. `plan` is the
  one mode no policy can be synthesized into: it is read-only *plus* an obligation to
  write the change down, so only a backend that has such a mode publishes it. The chosen
  mode is persisted per session.
- A turn that must ask the user something before it can continue: `lib/turn-requests.ts`.
  `AgentRunOptions.askUser` hands the provider one `UserRequest` (`permission | select |
  confirm | input`) and waits; an in-memory registry keyed by `${sessionId}:${request.id}` is
  what `POST /api/chat/respond` resolves, and the turn's own abort answers
  `{ cancelled: true }` for everything still parked on it. **The wire protocol grows nothing**:
  a waiting provider emits an ordinary `tool` event named `permission` (or `question` for the
  other kinds) whose `input` *is* the request, then re-emits that same tool id as
  `done`/`error` with the outcome — `parseUserRequestInput` and `isOpenUserRequestTool` are the
  one definition of that shape, and the module imports nothing from `node:` so the page shares
  it. The page lifts it into `components/pending-question.tsx` above the composer and leaves it
  **enabled while the turn generates**, which is the only time it exists; the AskQuestion form
  beside it ends its turn and so stays disabled then, and the transcript row reads "Waiting for
  your answer" rather than growing a second form. ACP is the first caller: its `ask` permission
  mode puts every `session/request_permission` to the user instead of to a policy, and a chat's
  own permission mode then only narrows dsh's sandbox — it never turns `ask` back into an
  automatic approval. `fs/write_text_file` is served outside that dance, so under `ask` it
  follows the chat's mode: a read-only chat gets no writer.
- Providers: `mock` (scripted), `cursor` (spawns the `cursor-agent` CLI, resumes by session id),
  `ollama` (direct NDJSON streaming, stateless — the chat route replays stored history),
  `pi` (spawns the `pi` CLI in `--mode rpc` as an agentic harness over *every* configured
  model source — the local Ollama server, the hosted providers under `settings.modelProviders`,
  or either on its own; it is unavailable only when neither is there. Four tools plus one of
  ours, resumes by pi session id; `lib/pi-runtime.ts` finds the binary, `lib/pi-protocol.ts` is
  the pure half — the argv, the stdin commands and the event translation, importing nothing
  `node --test` cannot load — and `lib/pi-agent.ts` owns the subprocess. RPC rather than json
  mode because json mode is one-way: the prompt goes over stdin as a `prompt` command, which is
  the same channel an `extension_ui_request` is answered on, and a turn ends on `agent_settled`
  (`agent_end` arms a short grace as the fallback) rather than on end of stdout. There is no
  session header line either, so the id to resume with is asked for with `get_state`, written up
  front beside the prompt. A generated `models.json` under `$AGENT_UI_DIR/pi` writes one entry
  per source — with `compat.supportsReasoningEffort` off for Ollama's shim, which rejects it, and
  on for the hosted ones, which read it, and `input` per model, without which pi drops an
  attached image from the request without a word.

  Two things that config directory now carries beside the catalog. **A generated extension**,
  `extensions/ask-user.ts` from a string constant in `lib/pi-extension.ts`, loaded with an
  explicit `--extension`: `--no-extensions` stays, because it turns *discovery* off — the user's
  own extensions, each one context the model pays for — while an explicit path still loads. It
  registers `request_user_input`, whose `execute` calls `ctx.ui.select`/`ctx.ui.input` and
  returns the answer as the tool result, so the model carries on in the *same* run. The dialog
  surfaces as an `extension_ui_request`, is mapped to a `UserRequest` (`lib/turn-requests.ts`),
  put to `AgentRunOptions.askUser`, and published as a `question` tool row — running before the
  wait, done or error after. No `askUser` cancels every request rather than hanging, and a
  dialog carrying a `timeout` stops being waited on when pi's own clock runs out. The tool is
  deliberately *not* one of the names `isAskToolName` claims: those belong to the between-turns
  ask flow, which answers by rewriting the transcript and sending a fresh user turn, while this
  one's run is still open and blocked on stdin. **Vision**, per model rather than per provider:
  a local tag is asked (`/api/show` reports `vision`), a hosted one can only be read off its id
  because no OpenAI-compatible `/models` reports modality, and the one predicate drives both
  `visionModels()` and the `input` written into the catalog, so the attachment button and the
  request can never disagree),
  `claude-code` (spawns the `claude` CLI as `-p --output-format stream-json --verbose
  --include-partial-messages`, resumes by CLI session id; `lib/claude-code-runtime.ts` finds the
  binary, `lib/claude-code-protocol.ts` is the pure half — the argv and the event translation,
  importing nothing `node --test` cannot load, which is what makes `tests/claude-code-stream.ts`
  possible — and `lib/claude-code-agent.ts` owns the subprocess. The prompt goes on **stdin**,
  never argv: the CLI's flags are variadic, so a trailing prompt is swallowed as one more tool
  name. With `--include-partial-messages` every assistant message arrives twice, as deltas and
  then whole; text and thinking come from the deltas and only `tool_use` blocks are read off the
  whole message, whose `input_json_delta` fragments are unusable partial JSON. A failed run is
  `result.is_error`, while `subtype` stays `"success"`. All three permission modes are real:
  `read-only` is `--permission-mode dontAsk` plus a `--disallowedTools` deny list, which outranks
  every allow rule and reaches subagents; `full` is `acceptEdits` plus an allow list rather than
  `bypassPermissions`, which skips the CLI's own guardrails and refuses to start under root).
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

  A local Ollama is started rather than reported down: `lib/providers/ollama-autostart.ts`
  (`ensureOllama`) probes `/api/tags` and spawns a detached `ollama serve` only when the
  configured URL is loopback http — from `/api/chat`, `/api/models` and the `ollama`, `pi` and
  dsh `info()` paths, deduped across concurrent callers and cooled down for 10s after a failed
  start; a remote URL is never spawned for, only probed. `lib/providers/acp-availability.ts`
  (`hasDeepSeekCredentials`) is the matching fallback on the other side: dsh — and only dsh,
  never a generic ACP agent — stays available on its hosted DeepSeek route when that optional
  local overlay is down.
  An ACP agent's `capabilities.vision` is whatever it said on `initialize`
  (`promptCapabilities.image`), captured by the same handshake the model probe already pays
  for and cached per agent; images then ride as `{type:"image"}` prompt blocks, with the mime
  type sniffed from the payload (`sniffImageMimeType`, `lib/attachments.ts`) because the route
  hands providers bare base64. dsh reports `image: false` today, so it stays vision-less — a
  catalog entry naming vision is not evidence of a transport.
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
  moves lightness only, never hue or chroma; the one thing that can lower chroma is the sRGB
  gamut map at the emit step, and only down to what a display can reach, because a ratio
  measured against an unrenderable colour is a ratio nobody sees. Parsing goes through
  `culori/fn`, so hex, `hsl()`, `oklab()` and `color()` tokens reach the repair path rather
  than being passed through. `tests/theme-contrast.test.ts` is the net: every
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
- History that happened before this app (`lib/import/**`, `GET /api/import/scan`,
  `POST /api/import`, `components/import-dialog.tsx`): the folders Claude Code and Codex have
  already run in on this machine, with a checkbox each and nothing decided on the user's
  behalf. The distinction that runs through it is **resumable vs history** — a Claude Code
  conversation arrives with its session id in `agentSessions`, so the next turn in that chat
  resumes the CLI's own session, while Codex has no backend here and is imported *without*
  one rather than pretending it can be continued. Importing is idempotent on the CLI's
  conversation id, and which chat came from where lives in its own file
  (`~/.agent-ui/imports.json`, `lib/import/ledger.ts`) rather than as a field on
  `SessionMeta`: the index is read on every page load and is the app's hottest file. The
  dialog is a `next/dynamic` import opened from ⌘K, and `onImported` re-reads the index alone
  — the transcripts it wrote load when a chat is opened, like any other's.
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
  Two rules are load-bearing and must not be relaxed: the extractor is handed **only what
  the user typed** — `metadata.typedText` on a user message, which the composer sends beside
  the prompt, never the attachments fenced into the stored content, assistant text, tool
  calls, tool output or the app's own ask-answer turns — so content the agent merely read
  cannot write itself into every future prompt; and category
  ids are validated against a separator-free alphabet rather than escaped, because they
  become file names.
- Handing one agent's work to the next (`lib/handoff/`, on by default): a chat is one
  conversation, but each backend in it is a different one. `SessionMeta.agentSessions` keys a
  small record by provider id — `{ providerSessionId, cwd, permissionMode, lastSeenSeq,
  lastWroteSeq, lastActiveAt, snapshot }` — so switching agents mid-chat no longer throws the
  other one's resumable session away. An index written before this migrates on read from the
  single `providerSessionId` field (still written, for whichever provider ran last). A stored
  id is only reused when the chat's folder still matches the one it was minted in — and, for a
  harness that declares `capabilities.permissionModePerSession`, when the permission mode does
  too; the model is not part of that identity. `permissionMode` is recorded only beside an id
  the turn actually minted, so a run that never reached the backend leaves the stored pair
  resumable by the mode that made it.

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
- Several agents on one repository (`lib/worktree.ts`, `lib/git-naming.ts`, `/api/worktrees`):
  a chat's `cwd` is the only thing that decides where its agent runs, so a second checkout of
  the same repo, on its own branch, in its own folder *is* the whole feature — two chats then
  edit one project without editing one file. Three things hold it up. The worktrees the app
  makes live under its own data directory (`$AGENT_UI_DIR/worktrees/<repo>/<branch>`), never
  beside the user's checkout, because it is the app's litter to clean up.
  `branch.<name>.gh-merge-base` is recorded at creation, which is what makes "ahead/behind
  what?" answerable for a branch with no upstream — the sidebar's counts and `gh pr create`
  both read it. And removal is idempotent: a folder the user deleted by hand ends in "already
  gone", which is a success. Branch names are *built* rather than escaped
  (`sanitizeBranchFragment` reduces a title to an alphabet in which none of git's ref rules
  can be broken), and `lib/git-naming` is pure and free of `node:` so the folder picker can
  show the name a worktree *would* get before anything is created — which is why
  `<FolderPicker>` is handed the chat's `title`. `SessionMeta.worktree` is the provenance
  beside `cwd`: which repository, which branch, cut from what.
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

  A name an *answer* wrote is not a path, and that is what `lib/fs-search.ts` repairs. Cursor
  says `` `Messages.tsx` `` in a sentence and `frontend/app/globals.css` above a snippet;
  joined with the chat's folder both land on nothing, and every click on them used to open an
  empty panel. `resolveInRoot` tries the join first and then the folder's own bounded walk (the
  same cached one `@`-mentions use), where the *deepest* suffix agreement wins and has to be the
  only one at that depth — so a bare `Messages.tsx` resolves when one file carries the name, and
  a `utils.ts` two packages both carry resolves to nothing rather than to a guess. `/api/file`
  answers with the path it actually read, so the panel header, its menu and "Copy path" name that
  file; `/api/open` runs the same repair before it launches anything.
- Quality of life around files: every file the chat names — a change-card row, the file
  panel's header, a path chip or an image in an answer, a chat row's folder — carries one
  right-click menu, built by `lib/file-actions.tsx` from what `GET /api/open` detected on this
  machine (VS Code, Cursor, Zed, Windsurf, Sublime, the JetBrains IDEs; the terminals). The
  vendored components only show the menu (`FileActionItem[]`, threaded through `MessageList`,
  `ChangeSummary`, `FilePreview` and `MessageMarkdown`); `POST /api/open` does the opening,
  server-side, as a fixed argv with the path as one argument — never `shell: true`; a Windows
  `.cmd` shim or `start` goes through `cmd.exe` with every argument quoted by the app and
  paths carrying `"`, `%` or a newline refused — resolves a relative path against the chat's
  stored folder, normalizes the separators (a `C:\repo` joined with an answer's
  `app/globals.css` arrives mixed, and Explorer's `/select,` silently does nothing with a
  forward slash in it), refuses the data directory, and under `files.anyPath` off is confined to the
  app's own folders like `/api/files` (`lib/fs-roots.ts`). `Settings → Editor & terminal`
  picks the defaults (`settings.editor`), ⌘O opens the chat's folder. "Revert changes" is
  `POST /api/git/revert` (`git checkout -- <file>`, tracked files only, confirmed through a
  toast action). A `file.ts:42` chip hands its line to `FilePreviewFile.focusLine`. The
  panel's split/unified and wrap choices persist under `agent-ui:preview-prefs`; the header's
  "N files changed in this chat" (`components/chat-changes.tsx`) is the union of every turn's
  card, for the whole-thread scope next to the per-turn one.
- `GET /api/fs/tree` is the file panel's folder browser: one level per request, never a walk,
  so a monorepo costs one `readdir` per folder the reader actually opens. Its root is read
  back from the stored chat exactly the way `/api/file` does it, and containment is decided on
  real paths, so a symlink under the folder is not a way out of it. Its neighbour
  `/api/fs/list` answers a different question — browsing the machine for a folder to point a
  chat *at*, absolute and directories only, before any chat exists.
- Per-turn undo (`lib/checkpoints.ts`, `POST /api/checkpoints/capture|diff|restore`): every
  turn in a git folder is bracketed by a checkpoint, and a checkpoint is a real commit
  reachable from nothing — `add -A` into a **temporary index** (`GIT_INDEX_FILE`, deleted in
  the `finally`), `write-tree`, a *parentless* `commit-tree`, and a ref under
  `refs/agent-ui/checkpoints/`. Which means, in order of how much it matters: nothing the user
  staged is touched, nothing appears in `git log` or on a branch, and untracked files are
  included — which is why restore is `restore --worktree --staged` plus `clean -fd` plus a
  `reset` rather than a checkout. The numstat between a turn's two refs is stored on the
  assistant message and is the ground truth `lib/turn-files` prefers: what the turn changed on
  *disk*, not what its tool calls claimed.
- Committing what a chat produced (`lib/git-commit.ts`, `POST /api/git/commit`,
  `POST /api/git/push`): staging and `git commit` are three lines and the *message* is the
  work, so the evidence gathered is deliberately more than the diff — a `--name-status`
  summary that survives a huge change and a capped `--patch --minimal` beside it, plus the
  repository's own last twenty subjects and its `AGENTS.md` / `CLAUDE.md`, because a repo that
  writes `fix(store): …` and one that writes `Fix the store` are both consistent and neither
  is improved by having a house style imposed on it. The folder comes from the chat and every
  path has to resolve inside it. Two answers are not failures and are typed as such:
  committing on the repo's trunk asks first, and a push refused for want of credentials is a
  different offer from one that lost a race.
- Dev servers the work left running (`lib/dev-servers.ts`, `GET /api/dev-servers`): `lsof -F`
  where there is one — the `-F` form is the only one worth parsing, since lsof's columns are
  aligned rather than delimited — a curated port list where there is not, and in both cases a
  bounded loopback GET decides. A listener is a dev server only when it answers with an HTML
  document or redirects to one, which is what keeps Postgres, Redis and the app's own port out
  of a list meant to be clicked. A `sessionId` narrows it to the chat's own folder where the
  platform can attribute a listener to one.
- One way to run git (`lib/git-exec.ts`): every `git` and `gh` call goes through it, so four
  things are true of all of them rather than of the ones somebody remembered.
  `--literal-pathspecs` comes first — a path in this app comes from a tool call, an answer or
  a click, and to git a path argument is a *pathspec*: `git checkout -- '*.bak'` throws away
  every backup file in the repo, and the flag is the fix because there is no escaping to do.
  `--no-optional-locks`, so a read never takes the index lock out from under the user. Output
  is bounded and flagged `truncated` rather than silently halved. And nothing can block on a
  human — no credential prompt, no pager, `LC_ALL=C` so the messages stay readable. Failures
  are classified, not collapsed: "not a git repository" is a fact about the folder while a
  timeout or an index lock is a fact about this moment, and a sidebar that confuses the two
  throws away a badge the user was reading.
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
  ⌘O, and type-to-focus — bound from an effect because the handlers read refs. The context
  meter (`components/context-usage.tsx`) carries the one action that belongs to the *window*
  rather than to the app: "Compact context" sends the harness's own `/compact` as an ordinary
  turn, offered only where that command exists (`claude-code` always, anything else only when
  the scan found it). A `claude-code` chat reopened after 70 minutes with more than 100k of
  context also gets it as a one-time, non-blocking "Compact before resuming?" beside the
  meter, whose "Don't ask again" is one flag under `agent-ui:compact-hint` — the heuristic is
  ported from T3 Code's `shouldOfferResumeCompaction`, and the clock it measures against is
  read once per chat opened rather than during a render.
- Skills, and the harnesses' own commands (`lib/skills.ts`, `lib/skills-scan.ts`,
  `GET /api/skills`): a skill is a folder on this machine — `.claude/skills/<name>/SKILL.md`
  and its `.cursor` / `.agents` neighbours — that a harness knows how to run, and the scan
  reads the same directories the CLIs do rather than waiting for a protocol to announce them:
  Claude Code's init line names its commands but not where they live, and Cursor's catalog
  only exists once a session is open, so a composer that waited for either would have an empty
  menu until the user had already sent something. The route takes a *chat* and never a folder
  — the rule `/api/file` and `/api/fs/search` follow — and every read is best-effort behind a
  30s cache: a broken skill must not cost the user their menu. `app/hooks/use-skills.ts` asks
  once per chat opened, once per folder change and once per turn that *ends* (an agent that
  just wrote a skill is the whole reason for the last one), and hands the composer `skills`
  for its `$` menu and `slashCommandsWith(commands)` for its `/` one, every discovered command
  marked `mustStartMessage` because anywhere but offset 0 a CLI reads it as prose.

  The dispatch rule is the load-bearing half. `send` rewrites the **prompt** only, through
  `dispatchSkillMentions`, and `metadata.typedText` stays exactly what the user typed — the
  same boundary the memory extractor is held to. `claude-code` expands one `/name` and only at
  the head of a message, so the first mention is hoisted there and the rest are rewritten in
  place for the model's own Skill tool; `cursor` invokes `/name` where it stands; every other
  backend is handed the text as typed, and the `[skills: …]` prefix then names only what the
  harness could not invoke — never a skill already dispatched. `lib/skills` speaks the CLIs'
  own names (`claude-code`, `cursor`) while the app keys providers by their settings key
  (`claudeCode`, `cursorAgent`), which one map in `use-chat-turns` translates; a `$HOME` in a
  shell line stays prose, because a mention of something nobody discovered is not a command.
- Searching what was *said* (`lib/message-search.ts`, `GET /api/search`): a title is generated,
  which makes it the last thing a chat is remembered by, so ⌘K also walks the stored
  transcripts and answers with the single best message per chat — a snippet plus the offsets
  to mark inside it, so the browser never re-finds a match it was already given. What is
  searched is deliberately narrow: the user's own `metadata.typedText` and the assistant's
  answer text, never thinking, tool input or tool output — a grep over tool output finds every
  chat that ever ran `ls`. `lib/message-search` is pure and free of `node:` (same shape as
  `lib/usage`), so the route owns the reading and the caching: one searchable projection per
  chat keyed by its `updatedAt`, size-aware because what it holds is message text, which makes
  the key going stale *the* invalidation and one more character re-read nothing. The palette
  debounces and aborts, keeps the last answer beside the query it answered, and selecting a
  hit opens the chat *at* that message — `useMessageJump` awaits the transcript, waits for the
  list to be showing that chat, then scrolls and flashes the row, all off refs so the memoized
  rows never see a new callback.
- Attention: `lib/notifications.ts` posts an OS notification when a turn ends, asks or fails
  while the window is not in front (the shell's `tauri-plugin-notification`, else the web
  `Notification` API, whose click reopens the chat), bounces the dock, and mirrors the count
  of chats waiting on an answer onto the dock badge (`setBadgeCount`) and the tab title.
  Waiting is both shapes: a finished turn holding an unanswered question, and a *running*
  one blocked on a `lib/turn-requests` request — which is also notified the moment it
  arrives, since its turn will not end until it is answered.
  `settings.chat.desktopNotifications` switches it off. Sidebar folder headers poll
  `GET /api/git/status` (`lib/git-status.ts`: ahead/behind, dirty count, the branch's PR via
  `gh` when present) once a minute and on focus. "Regenerate title" (`POST
  /api/sessions/<id>/title`, `lib/completion.ts`) asks the chat's own model when it is one the
  app can reach directly, else the memory model. Token counts get an estimated price from
  `lib/model-pricing.ts` — list prices by `<source>/<model>`; Ollama is free, a CLI harness's
  bare id is unknown rather than free. `claude-code` is the one exception, because unlike
  Cursor it resells nothing: its bare ids *are* Anthropic ids at Anthropic's own rates, so
  they are priced from the `ANTHROPIC` table, with the tier aliases (`sonnet`, `opus`, …)
  resolved to whatever that tier is today.
- What it all cost, at two scopes, from one aggregation: `lib/usage.ts` turns stored messages
  into `UsageTurn`s (model, provider, folder, tokens, the finish timestamp the turn already
  records) and groups them per model and per folder. It is pure and free of `node:`, so the
  same code runs in the browser over the open transcript — `chatUsage`, memoized in
  `use-thread-view`, behind the header's total next to "N files changed"
  (`components/chat-usage.tsx`) — and on the server over every stored one, behind
  `GET /api/usage?days=N` and **Settings → Usage** (7d / 30d / all, totals plus a table per
  model and per folder). The route reads the index and each transcript through `lib/store`
  and answers with aggregated rows only; per-session turns are memoized in module state
  keyed by the session's `updatedAt`, so reopening the page or switching windows re-reads
  nothing. The distinction that runs through all of it is **free vs unknown**: an unpriced
  turn is counted in tokens and in the turn count but never folded into a cost, and the UI
  says how many there were, so a partial sum can never read as the whole.
- Settings are a panel over the chat, not a route the sidebar navigates to: `app/page.tsx`
  holds `settingsSection` and renders `SettingsView` (a `next/dynamic` import, so the chat
  never waits for it) in a fixed overlay, while `/settings` stays for deep links and renders
  the same component without an `onClose`. The reason is not layout — this page owns every
  in-flight turn, and unmounting it aborts the fetch, which `/api/chat` reads as the client
  giving up and kills the run. `dataDir` is the one thing a panel cannot render server-side,
  so `GET /api/settings/data-dir` hands it over; closing re-reads settings and providers,
  because either may have changed while it was open. The file holds one object, so every
  write is a read-modify-write and there is more than one writer: the panel
  (`app/settings/use-app-settings`, which owns `providers`, `modelProviders`, `chat`,
  `files`, `editor`, `memory` and `handoff`), `lib/theme/theme-client` (`appearance`) and
  the folder picker through `lib/api-client` (`recentFolders`). They all go through the one
  serialized chain in `lib/settings/client.ts` — without it a save in flight writes another
  writer's subtree back stale.
- Quitting while something is running (`components/quit-hold.tsx`): a turn is not a document
  with unsaved changes, it is a subprocess writing to the user's checkout — and ⌘Q is one key
  from ⌘W. So the quit is *held* for 1.2s (or double-pressed) rather than confirmed: no
  dialog, no setting, and nothing at all when nothing is running. The shell is asked to
  intercept the close only while a turn is in flight (`setQuitHoldArmed`), which is what keeps
  the failure mode benign — a page that never loads leaves the app quitting exactly as it
  always did. macOS delivers ⌘Q only as the shell's `quit-requested` event (once per press and
  per key *repeat*) and every other platform as the keystroke itself, so both paths feed one
  state machine. How many chats are running reaches the overlay through a module store
  (`setRunningChats`), written from `app/hooks/use-attention` in the same effect as the dock
  badge: the overlay is mounted in the root layout, above the chat page and outside every
  provider it owns.
- The PATH the user actually has (`lib/shell-env.ts`, `instrumentation.ts`): every harness is
  found by looking through `process.env.PATH`, and a GUI process on macOS is launched by
  `launchd` with `/usr/bin:/bin:/usr/sbin:/sbin` — so every CLI the user has installed reads
  as "not installed" for no reason anyone can see. `register()` asks the login shell once,
  before the server takes its first request (it is awaited, and harness detection happens on a
  request), and merges the answer — and `HOME`, which a service manager can start a process
  without — into this process, keeping the inherited entries and preferring the shell's order.
  It never fails a boot: every probe is wrapped, a hung shell is a warning on stderr, and
  `AGENT_UI_SKIP_SHELL_ENV=1` turns it off for CI and tests.
- Desktop shell: Tauri v2, frameless; the web app's `AppHeader` IS the window chrome.
  `lib/desktop.ts` talks to the shell only through the injected `window.__TAURI__` global
  (`withGlobalTauri`) — keep it dependency-free and every call a no-op in a browser tab.
  Production spawns the Next standalone server as a Node sidecar on a free port and shows the
  window only when it's ready. That port is chosen by binding `:0` and letting go again, so
  the shell mints a per-launch token, passes it to the sidecar as `AGENT_UI_LAUNCH_TOKEN`,
  and the health probe adopts a listener only when its `x-agent-ui-launch` header carries
  that token (`GET /api/providers` echoes it), never a silent one. The webview's
  permissions follow the same line: `capabilities/default.json` names the dev server alone,
  and `grant_remote_origin` re-reads it at launch to grant the shell's commands to the one
  resolved `http://127.0.0.1:<port>` origin rather than to every loopback port.
  Auto-update rides the same bridge: `tauri-plugin-updater` +
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

AGENT_UI_BUILD_DIR=.next-review npm run build  # same build into .next-review/ instead

npm run desktop:dev                            # Tauri shell; stages the Node sidecar if missing
npm run desktop:build                          # platform installer
```

CI: `ci.yml` (lint + typecheck + test + build) and `desktop.yml` (`cargo check` of src-tauri) run on
every push. `release.yml` builds Win/macOS/Linux installers on `v*` tags.

## Definition of done

`lint`, `typecheck`, `test`, `build` clean — plus `vendor:check` whenever `components/ui/**`
or a shared `lib/` module was touched. Build with `AGENT_UI_BUILD_DIR=.next-review` (it is
`distDir`, and `tests/e2e/server.mjs` reads the same variable) whenever the user's desktop app
is running out of `.next/`: a plain `npm run build` overwrites the server under it. And for
anything user-visible, run the app
(`AGENT_UI_DIR=/tmp/agent-ui-test node .next/standalone/server.js` after a build) and exercise
the flow for real; there is a Playwright-style flow suite precedent in the repo history. If the
UI changed visibly, refresh the screenshots in `.github/screenshots/` and keep `README.md`
accurate.
