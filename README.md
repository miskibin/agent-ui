# Agent UI

A fast, local-first **desktop app** for coding agents. One interface, swappable backends: the local `cursor-agent` CLI, any model served by [Ollama](https://ollama.com) — as plain chat or as a full agentic run through the [`pi`](https://pi.dev) harness — or a scripted mock — with Claude Code and OpenCode adapters on the roadmap. Built entirely on [miskibin/chat-components](https://github.com/miskibin/chat-components), the shadcn/ui registry of agent-grade chat primitives, wrapped in a frameless Tauri shell with its own window chrome.

[![CI](https://github.com/miskibin/agent-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/miskibin/agent-ui/actions/workflows/ci.yml) [![Desktop](https://github.com/miskibin/agent-ui/actions/workflows/desktop.yml/badge.svg)](https://github.com/miskibin/agent-ui/actions/workflows/desktop.yml)

![Agent UI — streaming agent run](.github/screenshots/chat-run.png)

Reasoning streams, tool calls with live status (including failures), Shiki code, tables, KaTeX and Mermaid, a files-changed summary with per-file diff stats — every turn is rendered from the shared `AgentStreamEvent` protocol, whatever backend produced it.

Every file the agent touches is one click from the transcript. An edit headline, a row in the files-changed card or a `path.ts` chip in the answer's own text opens a **side-by-side file panel** — the diff, or the whole file with the edited lines marked, syntax-highlighted and scrolled to the first change. Material-style file icons mark the file everywhere it is named. The panel reads the file through `GET /api/file`, which is confined to the active provider's workspace (and never the app's own data directory), and falls back to the diff alone when there is nothing to read.

| Dark mode (Ocean theme) | ⌘K command palette |
| --- | --- |
| ![Dark mode](.github/screenshots/chat-dark.png) | ![Command palette](.github/screenshots/palette.png) |

![Settings](.github/screenshots/settings.png)

## Providers

| Provider | Tools | Resume | How it connects |
| --- | :-: | :-: | --- |
| **Cursor Agent** | ✅ | ✅ | Spawns the local `agent` CLI; full agentic runs in your workspace |
| **Ollama** | — | replayed | Direct `/api/chat` streaming with `thinking` support (deepseek-r1, qwen3…); stateless, so the app replays the stored transcript |
| **pi (Ollama)** | ✅ | ✅ | Spawns the [`pi`](https://pi.dev) CLI in `--mode json` — read/write/edit/bash over your local models, sessions on disk |
| **Mock** | ✅ | — | Scripted runs that exercise every UI part; no binary, no network |

Providers are detected at runtime and surfaced in the picker with availability badges. The `AgentProvider` interface (`lib/providers/types.ts`) is ~30 lines — a new backend is one file plus a registry entry.

### The pi harness

Ollama on its own answers questions; `pi` turns the same models into an agent that reads and edits files and runs commands. It is the smallest harness that does this well — four tools, ~7k tokens of cold-start context, so a 4–8B model still has room to think:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # provides `pi`
ollama pull qwen3:8b                                             # or qwen2.5-coder:7b
```

Then pick **pi (Ollama)** in the composer. The app writes a `models.json` pointing pi at your Ollama server, so no manual `~/.pi` setup is needed, and `PI_CODING_AGENT_DIR` keeps it separate from a personal pi install.

Two things worth knowing:

- **pi has no sandbox.** It edits files and runs shell commands in its workspace with your permissions and no approval prompt. Set **Providers → pi → workspace** to the directory you want it loose in; it defaults to the app's own cwd.
- **Set `num_ctx` explicitly.** Ollama's default context silently truncates an agent prompt after a few tool calls; give the model a Modelfile with as much context as your VRAM allows.
- **On Windows**, `npm i -g` installs pi as a `pi.cmd` shim, and Node refuses to spawn `.cmd` files directly. The app looks past the shim for pi's own entry point automatically; if your install is laid out unusually, point **Providers → pi** at a `pi.exe` or at the `…\dist\bundle\cli.js` the shim wraps — a `.js` path is run with the app's own Node.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000 in the browser
```

### Desktop app

The Tauri shell is frameless — the header you see **is** the window chrome: drag region, double-click to maximize, min/max/close controls (native traffic lights on macOS), the ⌘K palette, settings and theme toggle.

```bash
node scripts/prepare-desktop.mjs --skip-next   # once after cloning (stages sidecar deps)
npm run desktop:dev                            # dev shell against localhost:3000
npm run desktop:build                          # installer for your platform
```

A production bundle ships the Next standalone server as a Node sidecar: the shell picks a free port, boots the server (~0.6 s), and only then shows the window — no white flash, dark splash if startup is slow. Releases build a Windows (x64) installer via GitHub Actions — push a `v*` tag, or run the Release workflow from the Actions tab with the tag to cut. `npm run desktop:build` still produces an installer for whichever platform you are on.

### Web / server

Production without the shell is the same self-contained standalone server — fast cold start, no `node_modules` on the target machine:

```bash
npm run build
node .next/standalone/server.js
```

## Where your data lives

Everything is local JSON under `~/.agent-ui` (override with `AGENT_UI_DIR`):

- `settings.json` — appearance, providers, chat behavior
- `sessions/index.json` — sidebar metadata (titles, pins, order, provider/model, timestamps)
- `sessions/<id>.json` — full transcripts (reasoning, tool calls, markdown)

- `pi/models.json` — generated: points pi at your Ollama server's OpenAI-compatible endpoint
- `pi/sessions/*.jsonl` — pi's own transcripts, kept out of your personal `~/.pi/agent`

The agent backends keep their own conversation context (Cursor and pi sessions resume by id); this store owns what they don't — your rendered transcripts and sidebar state.

## Settings

`/settings` applies everything instantly and persists to `settings.json`:

- **Appearance** — six hand-tuned shadcn theme presets (Default, Clay, Ocean, Forest, Rose, Violet) with separate light/dark palettes, light/dark/system mode, and a corner-radius slider. A tiny inline bootstrap script applies the stored theme before first paint — no flash.
- **Providers** — enable/disable each backend, Ollama base URL, `cursor-agent` and `pi` binary paths, the pi workspace directory, default provider, with live reachability badges.
- **Chat** — default reasoning effort, prompt suggestions, auto-titling.
- **Data** — data directory and a clear-all-chats action.

## Architecture

```
app/page.tsx ── SSE ──► POST /api/chat ──► AgentProvider.run()
                              │                 ├── mock      (scripted)
                 persists     ▼                 ├── cursor    (spawns CLI)
                        lib/store/*.json        ├── ollama    (HTTP stream)
                                                └── pi        (spawns CLI → Ollama)
```

- One streaming protocol (`AgentStreamEvent`: `session · thinking · tool · text · done · error`) between every backend and the UI.
- The chat surface is a pure client page: nothing on the critical path waits for the server, the sidebar seeds from a localStorage snapshot before the network answers, and message rows keep the memoization guarantees of the component family during streaming.
- UI comes from the chat-components registry — themed by shadcn tokens, customizable through `data-slot` attributes without forking.
- `GET /api/file` backs the file panel: it resolves a path against the running provider's workspace (`cursor-agent` and the mock use the app's cwd, pi its configured workspace), refuses anything outside it or inside the app's data directory, and caps a read at 1.5 MB.

## Development

```bash
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run build       # next build (standalone output)
```

## License

MIT
