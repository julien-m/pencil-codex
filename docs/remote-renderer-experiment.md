# Persistent renderer experiment

This opt-in prototype runs one invisible Pen renderer per design session in a shared headless Chrome process. Agents and the interactive view operate on that renderer. There is no second Pen editor in the view and no synchronization between independent document states.

The installed vendor plugin, default plugin configuration and Codex application are unchanged. This is a feasibility implementation on `feat/persistent-session-engine`, not an installed production replacement.

## Ownership and transport

The existing broker owns the session, document path, participation leases and save/conflict rules. Each session gets a separate browser context and page containing the hosted Pen editor. Several agents join the returned `sessionId` with separate leases; different chat scopes use separate documents and renderers. Opening one document under two scopes remains rejected. Callers must share the session ID with collaborating agents; an activity label is not an authenticated identity.

The view receives JPEG frames and forwards validated pointer, keyboard, wheel and plain-text input. Its `rendererId` identifies the engine instance. Closing a view stops its screencast and releases held input, leaving the renderer connected to the broker. Reopening the view attaches to that instance. All views share selection, focus and undo history because they show one editor.

The experimental MCP adapter requires an explicit nonempty `scope` on open/new. Use the current chat ID or a unique scope allocated once for that chat, then pass the returned session ID to its agents. A global MCP process and its startup environment cannot reliably identify the current chat. The adapter therefore has no process-wide default scope. Scopes and leases coordinate trusted clients; they are not authenticated user/chat identities supplied by Codex.

The standalone view uses an authenticated loopback WebSocket. The experimental MCP App uses the existing chunked server-tool relay to carry those same frames and inputs; its resource contains no Pen iframe and declares no external connection domains. Session view grants are returned in app metadata, separate from model-visible tool results. Administrative credentials stay in the private runtime directory.

## Reproduce locally

Install dependencies with `bun install --frozen-lockfile`. Register [the experimental service](../experiments/remote-engine/server.mjs) with Localhost Supervisor, using an explicit free loopback port, an installed Chrome executable, and a private runtime directory. The service command is:

```bash
node experiments/remote-engine/server.mjs <port> <chrome-executable> <private-runtime-directory>
```

Use temporary lifetime, manual autostart and no automatic restart for a one-off diagnostic run. Once an installed Pen Remote plugin points to this service for continued use, manage it as a persistent service: supervisor autostart, restart on failure and no expiration. The service writes `connection.json` with mode `0600`; do not publish it. It is not started by the default plugin.

Run the isolated two-document probe, then the transport/security checks:

```bash
node experiments/remote-engine/live-probe.mjs <runtime>/connection.json <live-receipt.json>
node tests/remote-mcp-live.mjs <runtime> <mcp-receipt.json>
node tests/remote-security-live.mjs <runtime> <security-receipt.json>
node experiments/remote-engine/hidden-probe.mjs <runtime> <hidden-receipt.json> 310
```

The first probe creates disposable files and private view links in `<runtime>/probe.json`. Keep its B view closed during the hidden probe. Its 310-second quiet period tests operation beyond typical view inactivity windows; the exact command has a 360-second deadline. It is a functional observation, not a capacity benchmark or proof of macOS sleep resilience.

For interactive verification, open A's private `viewURL` in an agent-owned browser. Import `runUIProbe` from [the UI probe](../experiments/remote-engine/ui-probe.mjs) and pass its page, parsed connection/probe objects and a receipt path. It derives a click target from rendered pixels, nudges the selected object, verifies the changed engine coordinate, changes its color through an agent call, waits for that color in the image and saves through the view.

The opt-in stdio MCP entrypoint is [the experimental adapter](../experiments/remote-engine/mcp.mjs):

```bash
PENCIL_REMOTE_CONNECTION=<absolute-runtime>/connection.json node experiments/remote-engine/mcp.mjs
```

Its open/new tools return the remote-view MCP App resource. Source mode requires development dependencies and the separately running service. Do not replace the installed vendor configuration with it as part of a feasibility test.

## Separate local Codex plugin

Build a separate package, with the service already running and an empty destination:

```bash
bun scripts/build-remote-plugin.ts <absolute-runtime> <absolute-package-destination>
codex plugin marketplace add <absolute-package-destination> --json
codex plugin add pen-remote@pen-remote-local --json
```

The generated **Pen Remote** plugin contains a bundled Node MCP server and prebuilt MCP App HTML. Its installed process does not require development dependencies. Local manifest paths reference the supervised runtime; connection tokens and documents are not copied into the package. The service remains separate and must be available. A temporary service's expiration also ends the experiment's availability.

Version 0.1.1 keeps MCP discovery available even when the supervised engine is stopped or its connection file is absent. Engine calls report unavailability without terminating MCP. Each new call reads and validates the current connection, allowing recovery after the service starts or rotates its credential. This does not replay failed operations or restore live document sessions after a crash.

Activate Pen Remote in the target chat. The currently running agent may not expose newly installed tools until another turn or host reload. Installation alone proves neither activation nor native view rendering. The existing pen.dev plugin remains installed separately.

The installed-package transport probe uses the actual cache directory:

```bash
node tests/remote-mcp-live.mjs <absolute-runtime> <receipt.json> <installed-package-directory>
```

Add `--delayed-connection` after the package directory to verify offline initialization followed by a successful connection to the real engine in the same MCP process. The ordinary suite also checks missing and subsequently invalid connection configuration without requiring a live engine.

It verifies required scope rejection, same-renderer attachment, the generated resource and an actual JPEG through MCP. It is a scripted stdio client, not a native Codex rendering test. For native acceptance, open one document with this chat's scope, verify the rendered view, record its renderer ID, switch to another chat, modify the first session through its agents while hidden, and return to verify the same renderer and updated content. The other chat must use its own scope and document. Do not count browser-panel opening as plugin-view acceptance.

## Observed validation

On 2026-11-15, the real hosted engine passed these checks:

| Check | Observed result |
| --- | --- |
| Two documents, two participating clients in A and one in B | Concurrent changes are isolated; A clients share one renderer. |
| Close/reopen view | Same renderer identity; agents continue modifying while the view is absent. |
| No view for 310 seconds | The same renderer, with zero viewers before and after, accepts an agent change and saves the document after the wait. |
| Interactive browser view | Pixel-derived click and ArrowRight move the actual node; agent color change appears in the image; view Save updates the source. |
| Experimental MCP App transport | Actual JPEG reconstructed through app-only chunked relay; renderer identity matches the standalone view. |
| Native Codex MCP App, 2026-11-17 | Connected editor pixels inspected through the exposed web MCP App surface; UI Save reports Document saved and source-saved. |
| Native chat hide/return, 2026-11-17 | A unique text change made while another chat was displayed appears on return without reopening the document; same renderer identity and generation. The view remained attached while hidden. |
| Native engine restart with 0.1.3, 2026-11-17 | A fresh Codex chat loaded the v3 resource. Its existing native view recovered a new session and renderer after a real supervised service restart, without open/new/reload or restarting Codex. Engine nodes/variables matched the baseline, the UUID remained visible, and UI Save reported Document saved plus source-saved. Recovery latency was not directly measured. |
| Native panel reopen with 0.1.3, 2026-11-17 | After the user reported closing the panel, one explicit open preserved session, renderer, generation, all nodes/variables and source-saved after UI Save. The host still listed one app/viewer before reopening, and final capture plus handle recovery timed out. Complete panel/transport teardown and fresh pixels for this phase remain unverified. |
| Two actual model agents, 2026-11-17 | Distinct participation leases, separate frames in one shared document, cross-agent readback and one final Save; zero viewers at every sampled before/during/after status. |
| Access checks | Invalid admin credential, cross-session lease, reused document under another scope and another session's view grant are rejected. |
| Build and complete tests | `bun run build`, `bun run test`, `bun run test:protocol` pass. |

Independent review found a key-release identity bug when Shift was released before a letter. The view now retains each physical key's original value until release; a regression test checks that another view can subsequently send input.

The original transport probes use scripted clients. The 2026-11-17 orchestration additionally used two actual model agents in a dedicated test chat. Two test chats and a separate coordinator control document had distinct scopes/renderers; the agents' markers stayed out of the other documents. Native chat navigation used the dedicated platform tool; native application Computer Use was not used.

The first native panel failed initialization. Its bundled SDK contains literal replacement sequences such as `$&`; inserting that bundle through a replacement string changed its bytes and broke JavaScript syntax. Version 0.1.2 uses a replacement callback, preserves closing-script escaping and serves `editor-v2.html`. Tests now parse emitted inline scripts from both source and installed resources. Existing MCP/resource caches can retain the old version until the host reloads that chat's connection.

## Native view recovery

Version 0.1.3 serves `editor-v3.html`. The MCP process retains one opaque recovery grant per canonical document path and scope that it has already opened. The app-only bridge accepts that grant, never a browser-supplied path, to reopen the same document after an engine restart. Concurrent recoveries for that document share one reopen operation. The grants live only as long as their MCP process; stopping that process requires an explicit document open again.

The view makes at most three recovery attempts, spaced one second apart, with each host request bounded to ten seconds. Receiving a replacement frame resets this outage budget. Exhaustion leaves an unavailable status; another explicit open can retry. Recovery discards queued input and Save chunks, clears incomplete frame decoding, closes the old channel and ignores late replies from it. It never repeats an uncertain mutation. New open results replace the old channel even when the host reuses the same MCP App instance. Save stays disabled until a current frame is decoded.

The fresh native test also exposed an unchanged-Save status defect: after a read-only execute, an engine-confirmed flush without a draft returned success but left `check-required`. The broker now sets `source-saved` after verifying that the original still matches its recorded digest. The no-draft path retains its source conflict rejection. Closing a side panel may leave its inline MCP App and viewer attached; panel closure alone does not prove complete transport teardown.

Read [the view lifecycle regression](../tests/remote-view.test.mjs), [the transport recovery checks](../tests/ui-relay.test.mjs) and [the scoped grant checks](../tests/view-recovery.test.mjs) for executable contracts. Their fake host/DOM boundaries prove lifecycle behavior; native Codex acceptance still requires observing the installed resource after a real service restart.

## Remaining limits

- Native MCP App rendering and the Save button were observed in the tested host. Native pointer/keyboard forwarding through the image was not retested there: the exposed web MCP App automation surface supported DOM interactions only. The earlier standalone browser interaction check remains separate evidence.
- The remote image lacks a semantic accessibility tree. Clipboard integration, IME/composition, file dialogs, login popups and generation workflows have not been validated. Plain-text insertion is supported; native clipboard parity is not claimed.
- The viewport is fixed at 1280×800. Latency, memory use with many sessions and bandwidth have not been benchmarked. No quality or frame-rate guarantee is made.
- Browser/service crashes end the old live sessions and participation leases; drafts remain subject to existing save/recovery rules. A connected 0.1.3 native view can reopen its granted document into a new session/renderer through its surviving MCP process. Global session restoration, recovery after that MCP process terminates, and eviction are not implemented. Localhost Supervisor can restart the service and start it at login.
- The hosted Pen engine still requires network access. The prototype does not redistribute it or provide offline execution.

Modern Web Guidance guides `drag` and `validate-origins` were applied: pointer capture preserves release events, and the iframe bridge checks the exact sender and normalized origin.

## Explicit session completion

Version 0.1.5 exposes `pencil_close({sessionId, lease})`. Use it when the document task is finished; success consumes the final lease. It freezes admissions and view input, confirms Save, persists a closure marker, then releases only that renderer context, cached frame and viewers. Another participant, pending operation, uncertain state or failed Save prevents disposal. A disposal failure keeps the session quarantined rather than claiming success.

The private draft directory retains a `.closed` sidecar per document/scope. Automatic recovery and older implicit open calls cannot remove that marker, including after service restart. Only a new explicit open can resume the saved document. The MCP adapter also revokes the old recovery grant. The view treats the terminal closure message as intentional and stops its transport. `pencil_end` remains a participation release, preserving background work.

Read [the closure and conflict tests](../tests/artifacts.test.mjs), [the terminal transport tests](../tests/ui-relay.test.mjs) and [the context disposal test](../tests/remote-input.test.mjs) for the lifecycle guarantees.
