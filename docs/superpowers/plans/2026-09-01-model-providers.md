# Model Providers + Grouped Picker + Permission Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "model provider" (OpenAI-compatible endpoint: xAI, Google, DeepSeek, …) a first-class settings concept separate from harness providers, so model choice becomes harness → provider → model; add brand logos, a grouped model picker, and a unified per-chat permission mode.

**Architecture:** New `settings.modelProviders` dict (10 built-in presets + custom entries) consumed by harnesses that can use any OpenAI-compatible endpoint (`pi`, a new direct-chat provider). Model ids become composite `<sourceSlug>/<modelId>`. The vendored `model-picker` gains grouping upstream in `chat-components` and is synced back. Permission mode becomes a `ProviderCapabilities` field + per-session value mapped by each harness onto its native flags.

**Tech Stack:** Next.js 16 / React 19, TypeScript, shadcn idiom, no test runner (verify = `npm run lint && npm run typecheck && npm run build`).

**Spec:** the design summary in this file's header + the interfaces below (this plan is self-contained).

## Global Constraints

- `components/ui/**` and the vendored lib files are byte-identical to `D:\chat-components` — NEVER edit them in agent-ui. Changes go to chat-components first (docs entry + example + registry.json + `npm run registry:build`), then the file is copied over.
- No new runtime npm dependencies in either repo.
- Keep every settings field optional-with-default (`normalizeSettings` deep-merge) so old settings.json files load.
- Strict react-hooks rules: no sync `setState` in effect bodies (use `queueMicrotask`), no per-render closures into message rows.
- Semantic tokens only, `data-slot` attributes, `cn()` with consumer className last, 11–13.5px type scale.
- Errors surface via sonner toasts; providers degrade gracefully (unavailable + reason, never crash).
- Verify in BOTH repos where touched: `npm run lint && npm run typecheck && npm run build`.
- Commit per task with conventional-commit messages; do NOT push (the orchestrator pushes at the end).

---

### Task 1: Settings schema + model-providers lib (agent-ui)

**Files:**
- Modify: `lib/settings/schema.ts`
- Create: `lib/model-providers/presets.ts` (client-safe)
- Create: `lib/model-providers/ids.ts` (client-safe)
- Create: `lib/model-providers/server.ts` (`"server-only"`)
- Modify: `app/settings/use-app-settings.ts` (persist the new subtree in `flush()`)

**Interfaces (Produces):**

```ts
// lib/settings/schema.ts additions
export type ModelProviderEntry = {
  enabled: boolean
  /** Display name in pickers and settings. */
  name: string
  /** OpenAI-compatible base URL ending in the version segment, no trailing slash. */
  baseUrl: string
  apiKey: string
  /** Manual model ids; empty = fetch `${baseUrl}/models`. */
  models: string[]
}
// AppSettings gains: modelProviders: Record<string, ModelProviderEntry>
```

- Slugs validated against `/^[a-z0-9-]{1,32}$/` (they become composite-model-id prefixes and file-safe keys). `ollama` is a **reserved** slug (the local Ollama source is `settings.providers.ollama`); normalization drops a stored `modelProviders.ollama`.
- `DEFAULT_SETTINGS.modelProviders` = the 10 presets below, each `{ enabled: false, apiKey: "", models: [], name, baseUrl }`.
- `normalizeSettings`: mirror the `normalizeAcpAgents` pattern — presets merged over defaults so old files gain new presets; custom entries validated field-by-field; invalid slugs dropped.

```ts
// lib/model-providers/presets.ts
export type ModelProviderPreset = { slug: string; name: string; baseUrl: string }
export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  { slug: "openai",     name: "OpenAI",      baseUrl: "https://api.openai.com/v1" },
  { slug: "anthropic",  name: "Anthropic",   baseUrl: "https://api.anthropic.com/v1" },
  { slug: "xai",        name: "xAI",         baseUrl: "https://api.x.ai/v1" },
  { slug: "google",     name: "Google",      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { slug: "deepseek",   name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1" },
  { slug: "groq",       name: "Groq",        baseUrl: "https://api.groq.com/openai/v1" },
  { slug: "mistral",    name: "Mistral",     baseUrl: "https://api.mistral.ai/v1" },
  { slug: "openrouter", name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1" },
  { slug: "together",   name: "Together AI", baseUrl: "https://api.together.xyz/v1" },
  { slug: "fireworks",  name: "Fireworks",   baseUrl: "https://api.fireworks.ai/inference/v1" },
]
export const MODEL_PROVIDER_SLUG_RE = /^[a-z0-9-]{1,32}$/
export const RESERVED_MODEL_PROVIDER_SLUGS = ["ollama"]
```

```ts
// lib/model-providers/ids.ts — composite model ids "<source>/<model>"
export function splitModelId(id: string): { source: string; model: string }
// no "/" → { source: "ollama", model: id } (back-compat with stored sessions)
export function joinModelId(source: string, model: string): string
```

```ts
// lib/model-providers/server.ts ("server-only")
export type ModelSource = { slug: string; name: string; baseUrl: string; apiKey: string; models: string[] }
/** Enabled entries with a non-empty baseUrl, preset order first, then customs alphabetically. */
export function enabledModelSources(settings: AppSettings): ModelSource[]
/** Manual `models` list if non-empty, else GET `${baseUrl}/models` with `Authorization: Bearer <apiKey>` (header omitted when apiKey empty), 5s AbortSignal timeout. Returns [{id, name}] sorted by id; throws Error with a human-readable message on failure. */
export async function listSourceModels(source: ModelSource): Promise<Array<{ id: string; name: string }>>
```

- `use-app-settings.ts` `flush()`: add `modelProviders: next.modelProviders` to the PUT body spread (it currently spreads only `providers/chat/files/memory` — without this the new section never persists).

**Steps:**
- [ ] Add types + defaults + normalization to `lib/settings/schema.ts` (follow the `normalizeAcpAgents` merge pattern exactly)
- [ ] Create the three `lib/model-providers/*` files with the interfaces above
- [ ] Patch `use-app-settings.ts` flush body
- [ ] `npm run lint && npm run typecheck` — clean
- [ ] Commit: `feat(settings): first-class model providers — schema, presets, server catalog`

---

### Task 2: Harnesses consume model providers (agent-ui)

**Files:**
- Modify: `lib/providers/pi.ts`
- Create: `lib/providers/openai-chat.ts`
- Modify: `lib/providers/registry.ts`
- Modify: `app/api/models/route.ts` (pass through optional `groups`)
- Modify: `lib/api-client.ts` (`ModelsResponse` gains `groups?`)

**Interfaces:**
- Consumes: Task 1's `enabledModelSources`, `listSourceModels`, `splitModelId`, `joinModelId`.
- Produces:

```ts
// lib/providers/openai-chat.ts
export const OPENAI_CHAT_PROVIDER_ID = "chat"
export function createOpenAiChatProvider(settings: AppSettings): AgentProvider
```

```ts
// AgentProvider gains an optional method (lib/providers/types.ts):
/** Sections for grouped model pickers: [{ id: sourceSlug, label: sourceName }]. */
listModelGroups?(): Promise<Array<{ id: string; label: string }>>
```

**pi changes** (`lib/providers/pi.ts`):
- `createPiProvider(settings, ollamaBaseUrl)` → `createPiProvider(settings, ollamaBaseUrl, appSettings)` (registry passes the whole `AppSettings`; keep the old two params too if simpler — registry already has `settings`).
- `listModels()`: union of (a) Ollama models with ids `joinModelId("ollama", m.id)`, badge/meta as today, and (b) for each `enabledModelSources(settings)`: `listSourceModels(source)` mapped to `{ id: joinModelId(source.slug, m.id), name: m.name }`. A source that throws is skipped (log via the models route's existing degrade path — do not fail the whole list). Every option sets `group` = source slug (`"ollama"` for Ollama) — the `group` field lands on `ModelOption` in Task 4; until that sync happens, stage the change but expect typecheck to pass only after Task 4's sync (coordinate: Task 2 runs after Task 4's sync in execution order).
- `listModelGroups()`: `[{id:"ollama", label:"Ollama"}, ...sources.map(s => ({id: s.slug, label: s.name}))]`.
- `writeModelsConfig`: one `providers` entry per source: `{ baseUrl: source.baseUrl, api: "openai-completions", apiKey: source.apiKey || "placeholder", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models }` — keep the existing `ollama` entry as-is. Same content-compare-before-write behavior.
- `run()`: `options.model` is composite: `splitModelId(options.model)` → pass `` `${source}/${model}` `` to pi (pi's own catalog uses the same `<provider>/<model>` addressing). Bare ids (old sessions) resolve to `ollama/<id>` via `splitModelId`'s fallback.

**Direct chat provider** (`lib/providers/openai-chat.ts`) — modeled on `lib/providers/ollama.ts`'s structure:
- `info()`: id `"chat"`, name `"Chat (direct)"`, description `"Direct chat with your configured model providers — no tools."`, capabilities `{ tools: false, resume: false, effort: false, vision: false }`. `available` = at least one enabled model source; else `unavailableReason: "No model providers configured — add one in Settings → Model providers."`.
- `listModels()` / `listModelGroups()`: same union pattern as pi but WITHOUT Ollama (the existing `ollama` provider covers direct Ollama chat).
- `run()`: resolve source via `splitModelId(options.model)`; POST `${baseUrl}/chat/completions` with `{ model, stream: true, stream_options: { include_usage: true }, messages }` where messages = `[{role:"system", content: options.system}?]` + `options.history` replay + the user prompt. Parse the SSE stream line-by-line (`data: {json}` frames, `[DONE]` terminator): `choices[0].delta.content` → `{type:"text", text}` events; `choices[0].delta.reasoning_content` (DeepSeek/xAI style) → `{type:"thinking", text}` events; final `usage` → the `done` event's token usage (mirror how `ollama.ts` shapes its `done` event). `Authorization: Bearer` header only when apiKey non-empty. Abort via `options.signal`. HTTP errors → one `{type:"error", message}` event with status + body excerpt.
- `stream_options` rejection: some compat servers 400 on `stream_options` — on a 400, retry once without it.

**Registry** (`lib/providers/registry.ts`): add `OPENAI_CHAT_PROVIDER_ID` to `PROVIDER_IDS` (after `pi`), `build()` case `createOpenAiChatProvider(settings)`, `isEnabled()` = any `settings.modelProviders[*].enabled`. Pass `settings` into `createPiProvider` for the sources.

**Models route + api-client:** `/api/models` response gains `groups?: Array<{id: string; label: string}>` from `provider.listModelGroups?.()`; `ModelsResponse` type updated to match.

**Steps:**
- [ ] `lib/providers/types.ts`: add `listModelGroups?` to `AgentProvider`
- [ ] Implement pi changes; `lib/providers/openai-chat.ts`; registry wiring
- [ ] Models route + `ModelsResponse.groups`
- [ ] `npm run lint && npm run typecheck` — clean
- [ ] Commit: `feat(providers): model-provider sources — pi multi-endpoint catalog, direct chat provider`

---

### Task 3: Settings UI — "Model providers" section (agent-ui)

**Files:**
- Modify: `app/settings/settings-view.tsx` (new `SectionId` `"models"`, entry in `SECTION_GROUPS` under "Agents" right after `providers`, render line)
- Create: `app/settings/model-providers-section.tsx`
- Create: `app/api/model-providers/probe/route.ts`
- Modify: `lib/api-client.ts` (add `probeModelProvider`)

**Interfaces:**
- Consumes: Task 1 (`ModelProviderEntry`, `MODEL_PROVIDER_PRESETS`, `MODEL_PROVIDER_SLUG_RE`, `RESERVED_MODEL_PROVIDER_SLUGS`, `listSourceModels` server-side), Task 5's `ProviderLogo` (import from `@/components/provider-logo`; if Task 5 isn't merged yet, render the logo slot behind the component anyway — it exists by execution order).
- Produces:

```ts
// app/settings/model-providers-section.tsx
export function ModelProvidersSection({ settings, loaded, update }: AppSettingsApi)
```

```ts
// app/api/model-providers/probe/route.ts — POST { slug } → 200 { ok: true, count: number } | 200 { ok: false, error: string }
// Reads settings server-side, runs listSourceModels for that slug. Never 500s on unreachable endpoints.
// lib/api-client.ts:
export function probeModelProvider(slug: string): Promise<{ ok: boolean; count?: number; error?: string }>
```

**UI (copy the `providers-section.tsx` + `acp-agents.tsx` idiom):**
- One `SettingsRow` per entry, preset order first then customs. Title = `ProviderLogo` (size ~16px) + name. Control = enabled `Switch`.
- Row body (children): `baseUrl` Input (prefilled from preset), `apiKey` Input `type="password"` with placeholder `"API key"`, a small ghost "Test" Button → `probeModelProvider(slug)` → inline result text (`"{count} models"` in `text-muted-foreground` or the error in `text-destructive`), and for custom entries a remove (Trash) icon button. Preset rows are not removable.
- "Add custom provider" ghost button at the bottom: inline mini-form (slug, name, base URL) with slug validated against `MODEL_PROVIDER_SLUG_RE` minus reserved; duplicate slug rejected with a toast.
- All writes via `update((current) => ({...current, modelProviders: {...}}))` — the section never talks to the API directly except the probe.
- Section description: "OpenAI-compatible endpoints that supply models to harnesses like pi and direct chat. Keys are stored locally in settings.json."

**Steps:**
- [ ] Probe route + api-client function
- [ ] Section component + settings-view wiring (SectionId union, group entry with a lucide icon e.g. `Boxes`, keywords `["models","providers","api key","openai","endpoint"]`)
- [ ] `npm run lint && npm run typecheck` — clean
- [ ] Commit: `feat(settings): Model providers section — presets, keys, probe, custom entries`

---

### Task 4: Grouped model picker upstream (chat-components) + sync

**Files (in `D:\chat-components`):**
- Modify: `components/ui/model-picker.tsx`
- Modify: `components/docs/component-docs/controls.tsx` (props table + example entry)
- Create: `components/examples/model-picker-groups-example.tsx`
- Modify: `registry.json` description if needed; run `npm run registry:build`
- Then copy `components/ui/model-picker.tsx` → `D:\agent-ui\components\ui\model-picker.tsx` (byte-identical)

**Interfaces (Produces — this is the public API, exact):**

```ts
export type ModelPickerGroup = {
  id: string
  label: string
  /** Small leading icon for the group heading, e.g. a brand logo. */
  icon?: React.ReactNode
}
// ModelOption gains:
//   /** Id of the ModelPickerGroup this model belongs to. */
//   group?: string
// ModelPickerProps gains:
//   /** Section definitions; order defines section order. Options with an unknown or absent group render first, ungrouped. */
//   groups?: ModelPickerGroup[]
```

**Behavior:**
- No `groups` prop (or empty) → rendering identical to today (flat list) — zero behavior change for existing consumers.
- With `groups`: both render branches section the list. cmdk branch: one `CommandGroup heading={...}` per group (mirror `folder-picker.tsx`'s `CommandGroup` usage), heading content = optional icon + label; groups with zero (post-filter) options are omitted. Plain branch (≤ searchThreshold): `DropdownMenuLabel`-style heading (an inline div with the same classes as cmdk's group heading: `px-2 py-1.5 text-xs font-medium text-muted-foreground`, plus the icon) between item runs.
- Search filter additionally matches the group label.
- New data-slots: `model-picker-group`, `model-picker-group-heading`.
- Follow repo idiom: memoization, no per-render closures in rows, `data-slot` everywhere, semantic tokens.

**Steps:**
- [ ] Implement in `components/ui/model-picker.tsx`
- [ ] Example `ModelPickerGroupsExample` (3 groups × 2–3 models, one group icon via an inline SVG circle) + docs entry (props rows for `groups`, `ModelPickerGroup`, `ModelOption.group`; `examples` block "Grouped by provider"; add the two new dataSlots)
- [ ] `npm run registry:build`
- [ ] `npm run lint && npm run typecheck && npm run build` in chat-components — clean
- [ ] Commit in chat-components: `feat(model-picker): section groups with headings and icons`
- [ ] Copy the file byte-identical into `D:\agent-ui\components\ui\model-picker.tsx`; `npm run typecheck` in agent-ui still clean
- [ ] Commit in agent-ui: `chore(ui): sync model-picker with grouping from chat-components`

---

### Task 5: Provider logos (agent-ui, app-local)

**Files:**
- Create: `components/provider-logo.tsx`

**Interfaces (Produces):**

```tsx
/** Brand mark for a model-provider or harness slug; null when unknown (caller falls back to text). */
export function ProviderLogo({ slug, className }: { slug: string; className?: string }): React.ReactElement | null
/** True when a mark exists for the slug. */
export function hasProviderLogo(slug: string): boolean
```

**Content:** inline `<svg viewBox="0 0 24 24" fill="currentColor">` paths for: `openai`, `anthropic`, `xai`, `google` (use the Google Gemini mark), `deepseek`, `groq`, `mistral`, `openrouter`, `together`, `fireworks`, `ollama`, `cursor`. Monochrome `currentColor` only (theme-safe). **Source the real path data — do not invent it:** download each from `https://cdn.simpleicons.org/<iconslug>` (e.g. `openai`, `anthropic`, `x` is NOT xai — check `xai`; `googlegemini`, `deepseek`, `mistralai`, `ollama`, …) with curl into the scratchpad, verify each downloaded file is a plausible SVG (contains `<path`), and inline the `d` attributes. Where simple-icons lacks a mark (verify by HTTP status), fall back to a lucide icon rendered inside the same component (e.g. `Flame` for fireworks if missing) — never an empty box. Default size `size-4`, overridable via `className` (`cn("size-4 shrink-0", className)`). `aria-hidden`.

**Steps:**
- [ ] Download + inline the SVG paths; build the component with a `Record<string, ReactElement | LucideIcon>` map
- [ ] `npm run lint && npm run typecheck` — clean
- [ ] Commit: `feat(ui): provider brand logos`

---

### Task 6: Wire grouped picker + logos into the app (agent-ui)

**Files:**
- Modify: `app/page.tsx`
- Modify: `components/provider-picker.tsx` (app-local — editable)

**Interfaces:**
- Consumes: `ModelsResponse.groups` (Task 2), `ModelPickerGroup`/`groups` prop (Task 4), `ProviderLogo`/`hasProviderLogo` (Task 5), `MODEL_PROVIDER_PRESETS` (Task 1).

**Changes:**
- `app/page.tsx`: new state `modelGroups: Array<{id: string; label: string}>` set from `fetchModels` response alongside `models`/`capabilities` (same effect, same reset semantics on provider switch). Build the picker prop with icons memoized: `const pickerGroups = React.useMemo<ModelPickerGroup[]>(() => modelGroups.map(g => ({...g, icon: <ProviderLogo slug={g.id} className="size-3.5" />})), [modelGroups])`. Pass `groups={pickerGroups.length > 1 ? pickerGroups : undefined}` to `<ModelPicker/>` (single-group lists stay flat).
- `components/provider-picker.tsx`: render `ProviderLogo` for harness rows where a mark exists (`cursor`, `ollama`, ACP dsh → `deepseek`), falling back to the current text-only row; the trigger button shows the logo + name, with the name hidden below `sm` (`hidden sm:inline`) so narrow composers show just the mark. Keep memoization (`React.memo`) intact.
- Chat (direct) provider (`"chat"`) has no brand mark — give `ProviderLogo` a `MessageSquare`-style lucide fallback for slugs `chat`, `pi`, `mock` in Task 5's map (coordinate: Task 5 already ships lucide fallbacks; extend there if missing).

**Steps:**
- [ ] Wire groups state + memoized `pickerGroups` + ModelPicker `groups` prop
- [ ] Provider picker logos (rows + trigger)
- [ ] `npm run lint && npm run typecheck && npm run build` — clean
- [ ] Commit: `feat(app): grouped model picker with provider logos`

---

### Task 7: Unified permission modes (agent-ui)

**Files:**
- Modify: `lib/providers/types.ts`, `lib/providers/acp.ts`, `lib/providers/cursor.ts`, `lib/providers/pi.ts`, `lib/providers/ollama.ts`, `lib/providers/mock.ts`, `lib/providers/openai-chat.ts` (capabilities field)
- Modify: `lib/store/types.ts` (+ `lib/store/sessions.ts` if patch fields are whitelisted there), `app/api/sessions/[id]/route.ts` (if it validates patch keys)
- Modify: `app/api/chat/route.ts`, `lib/api-client.ts` (`ChatRequest`)
- Modify: `app/page.tsx` (composer control + per-session persistence)

**Interfaces (Produces):**

```ts
// lib/providers/types.ts
export type PermissionMode = "read-only" | "edits" | "full"
// ProviderCapabilities gains:
//   /** Permission modes the harness can enforce; empty = no user choice (fixed policy). */
//   permissionModes: PermissionMode[]
// AgentRunOptions gains:
//   /** Per-chat override of the harness's configured permission policy. */
//   permissionMode?: PermissionMode
```

- Capability values: ACP generic agents `["read-only", "full"]`; dsh `["read-only", "edits", "full"]`; `pi`, `cursorAgent`, `ollama`, `chat`, `mock` → `[]` (pi and cursor run trusted by design today; direct-chat/ollama/mock have no tools).
- Mapping at run time in `lib/providers/acp.ts`: `permissionMode` override → ACP decide policy: `"read-only"` → `auto-approve-reads`, `"full"` → `auto-approve`, `"edits"` (dsh only) → `auto-approve` + dsh sandbox `workspace-write`; additionally for dsh, `"read-only"` → sandbox `read-only`, `"full"` → sandbox `danger-full-access` via the existing `DSH_PERMISSION_MODE` env. Absent override → today's settings-driven behavior, unchanged.
- `SessionMeta`/`SessionPatch`/`CreateSessionInput` gain `permissionMode?: string`. `/api/chat` body gains `permissionMode?`, forwarded to `provider.run` only when `info.capabilities.permissionModes.includes(mode)` (same gating pattern as effort at `app/api/chat/route.ts:179`).
- UI in `app/page.tsx`: when `capabilities.permissionModes.length > 0`, render the vendored `ModePicker` (`components/ui/mode-picker.tsx` — read its props first and use it as-is; if its API cannot express this, use a small `DropdownMenu` in app-local code instead — do NOT edit the vendored file) next to `ModelPicker` with options labeled `Read-only` / `Edits` / `Full access`, default `"full"` for dsh/ACP (matches today's `auto-approve` default). Selection persists via `persistAgent({ permissionMode })` and is included in `send()`/`handleRegenerate`/`handleAskAnswer` bodies gated by capability, exactly like `effort`.

**Steps:**
- [ ] Types + capability values on every provider
- [ ] Store + routes + api-client threading
- [ ] ACP/dsh runtime mapping
- [ ] Composer control + persistence
- [ ] `npm run lint && npm run typecheck && npm run build` — clean
- [ ] Commit: `feat(permissions): unified per-chat permission modes mapped per harness`

---

### Task 8: Docs + final verification (agent-ui)

**Files:**
- Modify: `README.md` (providers section: model providers concept, new settings section, permission modes), `CLAUDE.md` + `AGENTS.md` (mirror rule: apply identical edits to both — add `lib/model-providers/`, `components/provider-logo.tsx`, `app/settings/model-providers-section.tsx` to the app-local list; one paragraph on the modelProviders concept)

**Steps:**
- [ ] Update docs
- [ ] `npm run lint && npm run typecheck && npm run build` in agent-ui — clean
- [ ] Smoke: `$env:AGENT_UI_DIR="$env:TEMP\agent-ui-test"; node .next\standalone\server.js`, open Settings → Model providers, add a key-less custom entry pointing at Ollama's `http://localhost:11434/v1`, verify probe + grouped picker
- [ ] Commit: `docs: model providers, logos, permission modes`
