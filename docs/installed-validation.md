# Installed startup validation

Version 0.5.1 validation is in progress. The earlier native-panel result below covers 0.5.0; it does not yet establish the new chunked transport, multi-megabyte transfer or hidden-panel behavior.

Validation performed on 2026-10-20 with Node.js and the real hosted Pencil engine.

The startup comparison below covers version 0.4.1. Version 0.5.0 was subsequently tested in the real native Codex panel, as recorded here; the earlier browser measurements do not measure that path.

## Native-panel test — version 0.5.0

On 2026-10-20, after Codex restarted and exposed the installed plugin tools:

- A real `pencil_new` call automatically opened the Pencil MCP App in the side panel. The native MCP Apps surface was observed through its dedicated UI backend; no browser preview was opened.
- Status recorded `openedAt = 1792510874481` and `readyAt = 1792510880384`: a 5.903-second interval to the hosted engine handshake in this single run. This is an observation, not a performance guarantee.
- The engine reported an empty document, returned its schemas and instructions, and created a frame through `pencil_call` / `execute`. The native panel's layer list showed the new frame.
- Clicking **Enregistrer** in that native panel produced the visible confirmation “Modifications enregistrées dans le fichier .pen”. Status reported `source-saved`; an independent disk read found the new frame in the saved document (2260 bytes).
- A capture of the created component also succeeded through the installed plugin. This is a design-render capture, not a screenshot of the Codex window: the MCP Apps UI backend does not support screenshots containing embedded frames.
- The transport used the standard host bridge and the app-only `pencil_editor_bridge` tool. The native UI resource declared an empty direct-network `connectDomains` list.

The existing automated suite passed 34 tests and the MCP protocol test, including a run against the installed bundle. This live test validates automatic opening, editing and panel-button saving in the tested host. It does not add a native multi-agent benchmark or establish behavior for every Codex host.

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
