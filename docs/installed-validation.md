# Installed startup validation

## Native-panel validation — version 0.5.1

Performed on 2026-10-21 in the real Codex MCP Apps side panel, using code commit `655d986`. The plugin was installed from a clean clone without `node_modules`; the installed server, daemon and editor bundles matched the clone and the source checkout byte for byte. No browser preview or development server supplied the editor for this run.

### Actual model agents and timing

Two independently running model sub-agents were launched before the coordinator called `pencil_open` on an empty document. Both received the returned session ID, joined with their own participation tokens, read engine instructions, chose their own designs and created their own frames in their first `execute`. No frames or mutation snippets were prepared for them. Their designs were “Sillage — Carnet sonore” and “HALTE — carnet de randonnée”. Their engine globals used separate agent prefixes.

The engine handshake took **1.093 s** from session opening. This does not measure language-model preparation, and is not a cold-start guarantee.

| First frame creation | Agent 1 | Agent 2 |
|---|---:|---:|
| Agent preparation start to first mutation request | 45.909 s | 33.814 s |
| Model tool invocation to response | 118 ms | 181 ms |
| Engine snippet, from its printed clock readings | 7 ms | 15 ms |
| Native dispatch to response, from `recentCalls` | 23 ms | 79 ms |
| Native path outside the measured snippet | 16 ms | 64 ms |
| Session opening to first frame response | 37.830 s | 36.291 s |

Preparation includes instruction discovery, any session handoff wait and model thinking; its intervals overlap engine loading and must not be added to loading time. Subsequent Agent 1 execute calls took 511/94/93 ms at the model tool boundary, including snippets of 10/1/1 ms. Their native dispatch-to-response intervals were 420/16/17 ms.

These measurements separate snippet execution from the remaining MCP/serialization/bridge/host path. **They do not isolate pure host CPU overhead.** For example, Agent 1's first 118-ms invocation contains 111 ms outside its 7-ms snippet; only 16 ms of that lies inside the native dispatch/response interval. Three coordinator clock probes measured native round trips of 42/35/33 ms, with 0-ms snippets at millisecond clock resolution; their complete tool invocations took 140/117/118 ms. No general time improvement is inferred from these samples.

Both frames were inspected and saved; a document capture succeeded. The two model turns ran concurrently, while their observed mutation intervals did not overlap. Automated transport tests separately prove that the plugin can dispatch concurrent calls before either response arrives; synchronous engine JavaScript still runs on its event loop.

### Quiet bridge rate

With agents idle and no engine calls or saves during the measurement window, the native relay recorded **six receive exchanges in 30.396 s**, or **0.1974 exchanges/s**, and zero send calls. This matches the five-second quiet long poll. Active responses and Save requests use an independent send path and do not wait for a quiet receive poll to expire. Counts are per view; additional open views have their own polls. This is a measured steady-state rate, not a measured before/after speedup.

### Persistent multi-megabyte document

A **3,145,728-character ASCII string variable** was added to the actual two-frame document as a synthetic transport load. It remained in the serialized file: **3,181,151 bytes**, then **3,181,342 bytes** after a later round-trip marker was added. This exercises large persistent reads/writes; it is not a dense-vector, large-layer-count or image-asset rendering benchmark.

- Adding the payload and explicitly saving took 767 ms and 121 ms respectively at the model tool boundary. These are operation times, not an isolated network-throughput measurement.
- A saved copy was opened through `pencil_open` in a fresh native session. An engine read verified the payload length and both frame IDs, without returning the payload to the model.
- A second fresh copy was opened and immediately queried in one pipelined invocation to remove model preparation between opening and verification. The request waited **845 ms** before dispatch, the engine handshake occurred **1.023 s** after session opening, and the verified read completed **1.129 s** after session opening (**1.305 s** for the entire coordinator open/join/read invocation).
- The reloaded document was modified, then saved with the native panel's **Enregistrer** button. Status reported `source-saved`; an independent disk read verified the round-trip marker, the full payload length and both frames. Capturing the reloaded document also succeeded.

Messages crossed the installed app-only bridge as ordered chunks of at most 32768 JavaScript string characters and at most four chunks per exchange. Missing/reordered chunks fail closed rather than replaying operations. A review found that drained chunks initially retained their queue-byte charge; this was corrected and covered by a regression test before installation.

### Masked panel

The user switched away from Pencil without closing its tab. After a **30.559-s** measured window, status still reported connected and ready, with **six additional receive exchanges**. An engine read while masked returned the complete payload length in **158 ms** at the tool boundary.

The host continued to report `document.visibilityState = "visible"` even though the panel was visually masked. **This does not validate a minimized window, a genuinely suspended webview, an OS sleep, or a host that tears the view down.** The relay's inactivity expiry is configured to 120 s; continuous background polls keep it alive, whereas an actual teardown closes the channel. Do not infer suspended-page recovery or mutation replay from this test.

### Automated and installation checks

- Full suite: **29 Bun + 13 Node tests passed**; MCP protocol checks passed against the checkout and the installed `dist/server.mjs`.
- Six and nine agents are tested before readiness: one waiting call per agent, zero active calls; readiness moves calls to active, and expiration leaves `EDITOR_OFFLINE` history entries with no dispatch timestamp. Save-wait and warm-cache history checks also pass.
- The actual installed service advertised **60000 ms** for readiness and **82000 ms** for the RPC budget. Joining remains immediate.
- Bundles were compared byte for byte across checkout, clean clone and installation. Neither clone nor installed plugin contained `node_modules`.
- Captures are engine-rendered design images. The native UI inspection backend does not support screenshots containing embedded frames, so no design capture is presented as a screenshot of the Codex window.

Local raw receipts contain environment-specific paths and stay outside this public repository. Test values and demonstration content are not imported by production code.

## Earlier observations

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

## Historical browser comparison — version 0.4.1

### Installation and execution

- Baseline: version 0.3.1 after reverting the scenario-specific launcher.
- Corrected runtime: version 0.4.1, commit `70da983`.
- Each version came from a clean clone with no `node_modules`, installed through the Codex plugin marketplace commands. The system under test ran the installed `dist/server.mjs`, `dist/daemon.mjs` and bundled editor HTML. Installed bundles matched the clone.
- An external test client supplied MCP transport and displayed the installed UI resource in a local browser. This does **not** validate the native Codex panel: that version's direct loopback connection was unavailable in the tested host.
- Three actual model sub-agents joined the same session, read the engine instructions and chose their own content during their turns. Each created its frame in its first `execute`; no coordinator-created frames or prewritten scenario scripts were used. Each tool invocation was sent once, without an `EDITOR_OFFLINE` retry loop.
- The corrected runtime opened a newly created document with `children: []`. The hosted engine reported an empty document before any agent mutation. All three new frames were subsequently inspected, the document was saved (`source-saved`), and a whole-document PNG was captured.

### Observed channel requests

| Three model agents | Baseline 0.3.1 | Corrected 0.4.1 |
|---|---:|---:|
| Native tool-schema requests | 3 | 1 |
| Native `read_skill` requests for the same path | 3 | 1 |

These counts come from observed engine-channel messages. The corrected status also reported two metadata requests and four cache hits. Automated tests cover six agents and a separately parameterized count (nine by default), different skill paths and fresh reads after reconnecting.

### Observed opening-to-first-modification times

| Model agent | Baseline 0.3.1 | Corrected 0.4.1 |
|---|---:|---:|
| A | 56.009 s | 42.246 s |
| B | 64.671 s | 46.667 s |
| C | 69.417 s | 39.841 s |

Corrected timings use `pencil_status.openedAt` and the first agent `execute` completion in `recentCalls`. The older status lacks these call timestamps, so baseline timings use the test client's opening and response timestamps.

**This is not a controlled performance benchmark.** Generated designs differed, the baseline required manual readiness coordination, and model preparation and browser/network caching affect these totals. These samples establish successful installed execution and fewer metadata round trips; they do not establish a general wall-clock speedup or a causal percentage improvement. The corrected hosted engine handshake took 7.626 s in this run. Hosted engine loading and model thinking are not shortened by the plugin cache.

### Behavioral checks

`pencil_begin` responds immediately without a view. Only engine-dependent calls wait, using one absolute readiness deadline. The service advertises its effective deadline to MCP clients; a differing client environment cannot shorten it. At expiration the call returns `EDITOR_OFFLINE` without dispatching a mutation.

The automated suite passed 26 Bun tests and five Node tests, plus the MCP protocol check against both the checkout and installed bundle. Tests cover immediate offline joining, a call succeeding when the editor arrives, timeout without a late mutation, transport attachment before engine readiness, deadline preservation across connection races, cache isolation and reconnect invalidation.

The scripts in `tests/fixtures/agent-*-validation.mjs` replay predefined scenarios for mechanical checks. They are not model agents and are not the source of the model-agent measurements above. Local raw receipts contain private session metadata and are intentionally excluded from this public repository.
