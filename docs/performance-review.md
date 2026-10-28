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
