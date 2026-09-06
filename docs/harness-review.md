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

## Remaining parity work

These are review findings, not claims of complete CLI parity:

| Capability | Pi in Agent UI | DeepSeek Harness in Agent UI |
| --- | --- | --- |
| Tool output | Read verified; write/edit/bash exposed | ACP read verified; tool events exposed |
| Resume | Session IDs supported | ACP session resume supported |
| Effort | CLI thinking setting mapped | ACP reasoning effort mapped |
| Context | Standing and turn context injected | Standing and turn context injected |
| Permissions | No enforced permission modes advertised | Read-only/edits/full mapped; no interactive approval round trip |
| Questions | Launch uses `--no-extensions`; native question integration needs work | Structured ask tools render; ACP approvals need an interactive round trip |
| Images | Vision not advertised | Vision not advertised despite a Vision Exp catalog entry; transport/support needs verification |

Do not enable capability flags without implementing and testing their transport
and enforcement. A model appearing in a catalog does not establish image support.

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
