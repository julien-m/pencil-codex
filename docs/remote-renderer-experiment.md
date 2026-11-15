# Persistent renderer experiment

This opt-in prototype runs one invisible Pen renderer per design session in a shared headless Chrome process. Agents and the interactive view operate on that renderer. There is no second Pen editor in the view and no synchronization between independent document states.

The installed vendor plugin, default plugin configuration and Codex application are unchanged. This is a feasibility implementation on `feat/persistent-session-engine`, not an installed production replacement.

## Ownership and transport

The existing broker owns the session, document path, participation leases and save/conflict rules. Each session gets a separate browser context and page containing the hosted Pen editor. Several agents join the returned `sessionId` with separate leases; different chat scopes use separate documents and renderers. Opening one document under two scopes remains rejected. Callers must share the session ID with collaborating agents; an activity label is not an authenticated identity.

The view receives JPEG frames and forwards validated pointer, keyboard, wheel and plain-text input. Its `rendererId` identifies the engine instance. Closing a view stops its screencast and releases held input, leaving the renderer connected to the broker. Reopening the view attaches to that instance. All views share selection, focus and undo history because they show one editor.

The standalone view uses an authenticated loopback WebSocket. The experimental MCP App uses the existing chunked server-tool relay to carry those same frames and inputs; its resource contains no Pen iframe and declares no external connection domains. Session view grants are returned in app metadata, separate from model-visible tool results. Administrative credentials stay in the private runtime directory.

## Reproduce locally

Install dependencies with `bun install --frozen-lockfile`. Register [the experimental service](../experiments/remote-engine/server.mjs) with Localhost Supervisor, using an explicit free loopback port, an installed Chrome executable, and a private runtime directory. The service command is:

```bash
node experiments/remote-engine/server.mjs <port> <chrome-executable> <private-runtime-directory>
```

Use temporary lifetime, manual autostart and no automatic restart for a diagnostic run. The service writes `connection.json` with mode `0600`; do not publish it. It is not started by the default plugin.

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

Its open/new tools return the remote-view MCP App resource. This adapter requires development dependencies and the separately running service. Do not replace the installed vendor configuration with it as part of a feasibility test.

## Observed validation

On 2026-11-15, the real hosted engine passed these checks:

| Check | Observed result |
| --- | --- |
| Two documents, two participating clients in A and one in B | Concurrent changes are isolated; A clients share one renderer. |
| Close/reopen view | Same renderer identity; agents continue modifying while the view is absent. |
| No view for 310 seconds | The same renderer, with zero viewers before and after, accepts an agent change and saves the document after the wait. |
| Interactive browser view | Pixel-derived click and ArrowRight move the actual node; agent color change appears in the image; view Save updates the source. |
| Experimental MCP App transport | Actual JPEG reconstructed through app-only chunked relay; renderer identity matches the standalone view. |
| Access checks | Invalid admin credential, cross-session lease, reused document under another scope and another session's view grant are rejected. |
| Build and complete tests | `bun run build`, `bun run test`, `bun run test:protocol` pass. |

Independent review found a key-release identity bug when Shift was released before a letter. The view now retains each physical key's original value until release; a regression test checks that another view can subsequently send input.

These clients are scripted test clients, not independent language-model agents. The broker's shared-session behavior is the same participation contract used by agents.

## Remaining limits

- Native MCP App rendering inside the current Codex host has not been observed. The tool transport and browser view were tested separately. A request to open the browser view in Codex returned `queued`, which does not prove that the panel rendered it.
- The remote image lacks a semantic accessibility tree. Clipboard integration, IME/composition, file dialogs, login popups and generation workflows have not been validated. Plain-text insertion is supported; native clipboard parity is not claimed.
- The viewport is fixed at 1280×800. Latency, memory use with many sessions and bandwidth have not been benchmarked. No quality or frame-rate guarantee is made.
- Browser/service crashes end the live engine; drafts remain subject to existing save/recovery rules. Automatic engine restoration, session eviction and service startup at login are not implemented.
- The hosted Pen engine still requires network access. The prototype does not redistribute it or provide offline execution.

Modern Web Guidance guides `drag` and `validate-origins` were applied: pointer capture preserves release events, and the iframe bridge checks the exact sender and normalized origin.
