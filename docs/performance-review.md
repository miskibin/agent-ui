# Performance investigation

## Comparison with T3 Code

T3 Code's `docs/internals/performance-regressions.md` describes bounded initial
thread snapshots and older-history pages, a separate subscription for live
command output, and tests for transport budgets. Its `MessagesTimeline.tsx`
uses a virtual list. Agent UI loads the entire JSON transcript and its vendored
`MessageList` mounts every row, though offscreen rows use `content-visibility`.
Agent UI already coalesces stream events per animation frame, defers several
derived transcript scans, memoizes rows, and debounces draft persistence.

The startup waterfall was distinct: all provider probes had to finish before
the session index and transcript were applied. The index and transcript now
open independently; provider selection is reconciled against the currently
open chat when the probes finish.

## Measurements

Windows, production Next standalone build, headless installed Chrome, local
mock provider, isolated data directory, 1400 x 900 viewport. The fixture is
200 alternating plain-text messages of roughly 370 characters. Five fresh
browser contexts, each followed by a reload; medians below. The same server
process stays running, so this is a fresh browser profile, not a cold desktop
process launch. Before is commit 9c856ed; after is the bootstrap change.

| Measurement | Before | After |
| --- | ---: | ---: |
| Fresh profile to last saved message visible | 3711.9 ms | 1076.7 ms |
| Reload to last saved message visible | 467.7 ms | 421.3 ms |
| Typing to second animation frame | 13.9 ms | 13.9 ms |
| Enter to user message visible | 59.9 ms | 52.2 ms |
| DOM nodes after reload | 3988 | 3988 |

The typing measurement uses `execCommand` and two animation frames; it is not
hardware keyboard latency or INP. The send measurement ends when the user's
row appears; it excludes first token, provider startup, network and turn
completion. These small samples do not establish a meaningful improvement for
typing, send, or refresh. The startup result depends on local provider probes.

An additional after-only, three-context run with 1,000 messages measured
1,243.1 ms fresh, 868.4 ms reload, 106.1 ms to show the sent row, and 18,780
DOM nodes. These are synthetic workloads, not Tauri WebView or real transcripts.
They expose the growth in mounted DOM but are not a T3 comparison.

The expanded browser benchmark (three 200-message contexts) measured a median
2.0 ms from a Playwright keyboard event to the next animation frame (p95
3.2 ms), 61.6 ms to display the sent message, and 43.3 ms to receive successful
chat response headers. This is a new baseline: there is no comparable
before value, it is not a hardware keyboard or first-token measurement, and
the local mock provider does not represent a real CLI or remote model.

`node --import ./tests/register.mjs scripts/benchmark-store.ts` measured five
batches of four simultaneous upserts into separate synthetic 1,000-message
chats on this machine: median 59.0 ms and maximum 64.2 ms per batch. The
fixture verifies that all messages persist. It does not isolate queue wait from
disk flush time or represent a loaded disk. The shared store lock remains until
measurements and concurrency tests justify changing its ordering guarantees.

Five isolated production Node sidecar starts measured a median 1,855.3 ms to
the first successful settings response (maximum 2,008.1 ms) on this machine.
The timer starts when the process is spawned and excludes build and asset
staging. Readiness is polled every 150 ms. This is not Tauri window startup or
first WebView paint. Run `node scripts/benchmark-server.mjs` after a build.

With `AGENT_UI_BENCH_STREAM=1`, a three-context run with the scripted mock
measured a median 1,281.7 ms from the send gesture to the first nonempty
thinking or text SSE event (maximum 1,289.2 ms). The mock deliberately delays
its output, so this is a repeatable transport baseline, not real-model latency.
The browser fetch clone watches the event stream; it does not measure when the
first text is painted. Each run closes its browser context after the first
event, so the fixture may acquire extra partial turns across samples.

Run `scripts/benchmark-ui.mjs` after a production build with Playwright and
Chromium available as described by `tests/e2e/server.mjs`. Set
`AGENT_UI_BENCH_MESSAGES` and `AGENT_UI_BENCH_SAMPLES` to vary the fixture.
The script creates and removes a separate temporary app data directory.

## Remaining work

Measure desktop process launch and WebView paint, real keyboard events and INP,
first token and sustained streaming, background work and memory, scrolling,
chat switching, and multiple representative transcripts. Capture browser
traces and repeat on comparable T3 fixtures. Explore paged history and list
virtualization in chat-components first, with scroll anchoring, search,
selection, accessibility, and streaming tests. Establish payload budgets and
regression checks before claiming parity with T3 Code.
