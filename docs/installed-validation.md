# Installed startup validation

Validation performed on 2026-10-20 with Node.js and the real hosted Pencil engine.

This report covers version 0.4.1. Version 0.5.0 changes the native transport to the MCP Apps host bridge. Its automated transport checks pass, but a real native-panel opening and editing test is still pending; the browser measurements below do not certify that path.

## Installation and execution

- Baseline: version 0.3.1 after reverting the scenario-specific launcher.
- Corrected runtime: version 0.4.1, commit `70da983`.
- Each version came from a clean clone with no `node_modules`, installed through the Codex plugin marketplace commands. The system under test ran the installed `dist/server.mjs`, `dist/daemon.mjs` and bundled editor HTML. Installed bundles matched the clone.
- An external test client supplied MCP transport and displayed the installed UI resource in a local browser. This does **not** validate the native Codex panel: its loopback connection remains unavailable in the tested host.
- Three actual model sub-agents joined the same session, read the engine instructions and chose their own content during their turns. Each created its frame in its first `execute`; no coordinator-created frames or prewritten scenario scripts were used. Each tool invocation was sent once, without an `EDITOR_OFFLINE` retry loop.
- The corrected runtime opened a newly created document with `children: []`. The hosted engine reported an empty document before any agent mutation. All three new frames were subsequently inspected, the document was saved (`source-saved`), and a whole-document PNG was captured.

## Observed channel requests

| Three model agents | Baseline 0.3.1 | Corrected 0.4.1 |
|---|---:|---:|
| Native tool-schema requests | 3 | 1 |
| Native `read_skill` requests for the same path | 3 | 1 |

These counts come from observed engine-channel messages. The corrected status also reported two metadata requests and four cache hits. Automated tests cover six agents and a separately parameterized count (nine by default), different skill paths and fresh reads after reconnecting.

## Observed opening-to-first-modification times

| Model agent | Baseline 0.3.1 | Corrected 0.4.1 |
|---|---:|---:|
| A | 56.009 s | 42.246 s |
| B | 64.671 s | 46.667 s |
| C | 69.417 s | 39.841 s |

Corrected timings use `pencil_status.openedAt` and the first agent `execute` completion in `recentCalls`. The older status lacks these call timestamps, so baseline timings use the test client's opening and response timestamps.

**This is not a controlled performance benchmark.** Generated designs differed, the baseline required manual readiness coordination, and model preparation and browser/network caching affect these totals. These samples establish successful installed execution and fewer metadata round trips; they do not establish a general wall-clock speedup or a causal percentage improvement. The corrected hosted engine handshake took 7.626 s in this run. Hosted engine loading and model thinking are not shortened by the plugin cache.

## Behavioral checks

`pencil_begin` responds immediately without a view. Only engine-dependent calls wait, using one absolute readiness deadline. The service advertises its effective deadline to MCP clients; a differing client environment cannot shorten it. At expiration the call returns `EDITOR_OFFLINE` without dispatching a mutation.

The automated suite passed 26 Bun tests and five Node tests, plus the MCP protocol check against both the checkout and installed bundle. Tests cover immediate offline joining, a call succeeding when the editor arrives, timeout without a late mutation, transport attachment before engine readiness, deadline preservation across connection races, cache isolation and reconnect invalidation.

The scripts in `tests/fixtures/agent-*-validation.mjs` replay predefined scenarios for mechanical checks. They are not model agents and are not the source of the model-agent measurements above. Local raw receipts contain private session metadata and are intentionally excluded from this public repository.
