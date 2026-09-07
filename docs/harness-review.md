# Harness review — 2026-09-06

Scope: economical review of Agent UI, with two Luna subtasks and short live
DeepSeek Flash calls using the existing provider configuration. No credentials
are included in this report.

## Verified and repaired

- Pi (`deepseek/deepseek-v4-flash`) and DeepSeek Harness
  (`deepseek-official/deepseek-v4-flash`) both returned text, session metadata,
  and running/completed read-tool events in live tests against `package.json`.
- Hosted DeepSeek remains available when the optional Ollama endpoint is down.
  The fallback is restricted to dsh; unrelated ACP agents cannot borrow it.
- Pending structured questions stay above the composer. The transcript keeps
  the original tool, displays its summary after answering, and has only one
  active form. Browser coverage checks scrolling, mobile width, 200% zoom,
  and the persisted answer.
- Dropdown available height now compensates for UI zoom. Browser checks at
  80% and 125% confirmed viewport containment. The shared change lives in
  chat-components and the dropdown copy is identical here.
- ACP approvals are interactive. With `providers.acp.agents.dsh.permissionMode`
  set to `ask` and the dsh sandbox at `read-only`, a live turn asked to create a
  file was denied by the sandbox, retried with `sandbox_permissions:
  workspace-write`, and raised `session/request_permission`. The stream carried
  a running `permission` tool row before blocking; `POST /api/chat/respond`
  answered it (200, and 404 on a second attempt); the same row settled `done`;
  the write completed and the file appeared. The refusal path selected the
  agent's own `reject_once` option, settled the row `error`, and the turn
  finished explaining that it could not write. Both were also driven through
  the browser — see `.github/screenshots/chat-permission.png`.
- dsh does not take images. Its `initialize` answers
  `promptCapabilities: { image: false, audio: false, embeddedContext: false }`,
  so `capabilities.vision` stays false for it rather than being asserted from
  the Vision Exp catalog entry.

## Remaining parity work

These are review findings, not claims of complete CLI parity:

| Capability | Pi in Agent UI | DeepSeek Harness in Agent UI |
| --- | --- | --- |
| Tool output | Read verified; write/edit/bash exposed | ACP read verified; tool events exposed |
| Resume | Session IDs supported | ACP session resume supported |
| Effort | CLI thinking setting mapped | ACP reasoning effort mapped |
| Context | Standing and turn context injected | Standing and turn context injected |
| Permissions | No enforced permission modes advertised | Read-only/edits/full mapped; an `ask` policy now puts every `session/request_permission` to the user and the blocked turn continues on the answer |
| Questions | `--mode rpc` plus a generated `ask-user` extension; `request_user_input` blocks the turn, the answer returns through `askUser` and a `question` row | Structured ask tools render; ACP approvals have an interactive round trip (`lib/turn-requests`, `POST /api/chat/respond`) |
| Images | Vision advertised per model: `/api/show` for local tags, the id for hosted ones, and `input` written into the catalog. Verified end to end on `deepseek-v4-flash-vision-exp` | Vision read from `promptCapabilities` rather than assumed; dsh 0.0.1 answers `image: false`, so it stays off. The transport is implemented and covered by tests for an agent that says yes |

Do not enable capability flags without implementing and testing their transport
and enforcement. A model appearing in a catalog does not establish image support.

The two Pi rows above were closed on 2026-09-07 against pi-coding-agent 0.84.4.
Both were tested live rather than reasoned about: the question row was watched
on the SSE stream of the standalone server going running then done around the
wait, and the image run was confirmed by a model naming the two halves of a
generated 8x8 PNG. The same image sent to a catalog entry left at the default
`input: ["text"]` was dropped silently and the token count showed it, which is
why `input` is written per model rather than left out. Local `gemma4:e4b` takes
the image over the OpenAI shim — the token count says it arrives — but answers
that it cannot see one; unresolved, and the reason the local half of vision is
reported as transported rather than as working on every model.

## Verification environment

Use `AGENT_UI_BUILD_DIR=.next-review` for an isolated production build while the
desktop app is using `.next/standalone`. The E2E server helper accepts the same
variable and uses a throwaway data directory.

During the review `vendor:check` reported 13 drifts (change-summary, chat-input,
chat-sidebar, file-preview, folder-picker, message-list, message-markdown,
message-parts, message, sidebar-item, cursor-agent-types, cursor-agent,
cursor-stream). Every one of them was a stale local checkout on both sides: after
both repositories were brought to their `origin/main` and the dropdown fix was
synced, the vendored tree matches upstream byte for byte.

## Cursor Agent — 2026-09-07

Scope: the `cursorAgent` provider against the real CLI (`2026.08.11-e8db854`,
which auto-updated to `2026.09.02-c22c1a3` mid-session) on Windows, driven
through the standalone build's own API and, for the plan flow, a browser.
Eleven short runs against a throwaway git repo under `%TEMP%`, model `auto`.

### Verified

- **Binary resolution.** `resolveWindowsBundle` is what actually spawns:
  `%LOCALAPPDATA%\cursor-agent\versions\<version>\node.exe index.js`. The
  `.ps1`/`.cmd` shims on PATH are never touched, which is right — Node cannot
  spawn either without a shell.
- **Providers and models.** `cursorAgent` is available with
  `permissionModes: [read-only, plan, full]`, `defaultPermissionMode: full`,
  `resume: true`; `agent models` lists the eight headline ids in ~1.5s.
- **`read-only` → `--mode ask`.** Answers with Glob/Grep/Read rows and no
  writes.
- **`full` (no `--mode`).** Read/Edit rows, the completed edit's `diffString`
  folded into the row's arguments as a real diff, a `1 File Changed` card
  (`README.md +2`), and the file panel opening it from the row.
- **Resume.** A second turn in the same chat spawns with
  `--resume <chatId>` and answers from the first turn's context.
- **Plan mode.** `createPlanToolCall` arrives with `plan`, `overview`, `name`
  and `todos`, so the row renders as a plan card with its checklist and Build.
  Build switches the composer to full access and sends the follow-up turn.
- **Abort.** Stopping mid-run kills the bundle's `node.exe`; no orphan was left
  behind in `Get-CimInstance Win32_Process` afterwards.
- **Unknown model.** `--model definitely-not-a-model-xyz` fails in ~2.5s with
  the CLI's own message; the run is correctly *not* counted as started, so the
  handoff cursor does not move.
- **No double-printed answer.** With `--stream-partial-output` the CLI closes a
  turn with a full-text message; `assistantText`'s timestamp rule drops it and
  `repeatsWholeTurn` is the backstop. Nothing was printed twice in any run.
- **Stages and thinking.** `connecting` from the provider, then
  thinking/searching/responding from the events themselves; `thinking` deltas
  render as the turn's reasoning blocks.

### Repaired

| Problem | Fix |
| --- | --- |
| `result.usage` was dropped, so no cursor turn ever reported tokens and the header spend control never appeared | `readUsage` in `lib/cursor-agent.ts` (chat-components); cache reads/writes excluded, as in `claude-code-protocol` |
| A shell tool's published `exitCode` never reached the `tool` event, so the handoff journal could not tell a failed command from a broken tool | `exitCodeFrom` in `lib/cursor-agent.ts`; structural only, never inferred |
| A shell row's body was the raw result payload instead of what the command printed | `formatToolResult` renders stdout/stderr, falling back to `exit <n>` |
| `parseToolPayload` named `Object.keys(tool_call)[0]`, which is only the call by luck — `hookAdditionalContexts` sits beside it | the `*ToolCall` key is preferred, first key as fallback |
| `resolveWindowsBundle` sorted versions as strings, so an unpadded `2026.9.2` would win over `2026.10.1`, and a half-downloaded newest directory hid every working one | numeric comparison plus newest-first walk over complete bundles |
| Switching a chat from `read-only` to `full` did nothing: `--resume` cannot take a cursor session out of ask mode, so the agent answered "I'm in Ask mode, switch to Agent mode" for the rest of the chat | `capabilities.permissionModePerSession` (app-local); the mode joins the folder in a stored session's identity, so a mode change starts a fresh backend session |

`tests/cursor-protocol.test.ts` covers the two pure translators and the version
ordering from fixtures; `tests/handoff-cursor.test.ts` covers the mode rule.

### Remaining

- A mode change costs the backend conversation. `prepareTurn` only builds a
  handoff block from *other* providers' journal events, so the fresh session
  starts blank. The same is already true of a folder change; feeding the
  journal to a same-provider restart would fix both.
- `providerSessionHints` still answers `resumes: true` on a stored id whose
  mode no longer matches. The badge is cosmetic — the turn does the right
  thing — but it is one round of plumbing away from being honest.
- Relative markdown links render as the label followed by a grey `[blocked]`
  (`<span title="Blocked URL: …">`). This is Streamdown's bundled link
  hardening rejecting a relative href with no `defaultOrigin`, not anything
  cursor-specific — every harness that writes `[CHANGELOG.md](CHANGELOG.md)`
  hits it. The lever is the `harden` entry `message-markdown.tsx` already
  rebuilds in `withDataImages()`, and the right rendering (chip, plain text, or
  a resolved link) is a registry decision.
- An unknown model id produces a readable but very long error — the CLI lists
  every available model — which makes for an unwieldy toast. Left as the
  backend sent it rather than truncated.
- The composer's stop button carries no `data-slot`, so a test has to find it
  by `title="Stop generating"`.
- `vendor:check` now reports 39 drifts that are not drifts. chat-components
  gained `.gitattributes` (`* text=auto eol=lf`), so its working tree is LF
  while this repo — which has none, under `core.autocrlf=true` — checks out
  CRLF. The committed blobs are identical (`git show HEAD:<file>` hashes match
  across both repos for every vendored file); only the bytes on disk differ,
  and `check-vendored.mjs` compares bytes on disk. The two files this change
  touched match exactly, because they were copied in rather than checked out —
  which is also why they will "drift" again after the next `git checkout`.
  Giving this repo the same `.gitattributes` is the fix, and is a repo-wide
  decision rather than part of a cursor change.
- `npm run build` (Turbopack) cannot run in a worktree whose `node_modules` is
  a junction to another checkout: *"Symlink [project]/node_modules is invalid,
  it points out of the filesystem root"*. `next build --webpack` with
  `AGENT_UI_BUILD_DIR=.next-review` is the way round it and is what this review
  used.
