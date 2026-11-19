# Pencil for Codex

Pencil **0.7.3** opens opaque `.pen` documents in a native Codex view backed by a persistent hosted Pen editor. The implementation is now on `main` under the existing `pencil@pencil` identity. Pen Remote is no longer a separate plugin.

The [Claude Code version](https://github.com/julien-m/pencil-claude) is maintained in its own repository. Both use a persistent renderer; the Claude version additionally exposes its selection and local document catalog tools.

## Installation and service

```bash
codex plugin marketplace add julien-m/pencil-codex
codex plugin add pencil@pencil
```

The installed MCP adapter is `dist/pencil.mjs`, selected by [the MCP manifest](mcp.json). It requires Node.js 22+ and runs without a compiler or development dependencies. Existing chats may retain older plugin processes; start a new client session to load an update.

The persistent service is separate. Install its source dependencies with `bun install --frozen-lockfile`, then register this executable and its arguments with Localhost Supervisor:

```text
node /absolute/path/pencil/dist/persistent-service.mjs <port> <chrome-executable> <private-runtime-directory>
```

It requires Chrome, `playwright-core` and network access to `https://app.pen.dev`. Use `~/Library/Application Support/Pencil/codex` as the normal private runtime directory. The MCP adapter reads its `connection.json` there independently of plugin cache paths; `PENCIL_CONNECTION` overrides the connection file. The service must be supervised as permanent, with autostart and restart on failure. MCP clients do not launch or stop it. Never publish connection tokens or private view URLs.

## Codex CLI

The CLI can use this same persistent Pencil MCP server without displaying a native MCP App. If installing the plugin does not expose its `pencil_*` tools in the CLI, register the canonical built server under a distinct name so it is not confused with the Mac Pen application’s `pencil` server:

```bash
codex mcp add pencil-plugin -- node /absolute/path/pencil/dist/pencil.mjs
```

Use the canonical checkout’s built entrypoint so the path remains stable across versioned plugin cache updates. The CLI tools then have names such as `mcp__pencil_plugin__pencil_open`. A normal `codex` or `codex exec` launch loads this configuration automatically.

Non-interactive runs cannot display approval prompts. Preauthorize only the operations the user has approved, using [per-tool MCP approval settings](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). For the open/edit/close verification performed here, the local configuration uses:

```toml
[mcp_servers.pencil-plugin]
command = "node"
args = ["/absolute/path/pencil/dist/pencil.mjs"]
default_tools_approval_mode = "prompt"
tools.pencil_open = { approval_mode = "approve" }
tools.pencil_begin = { approval_mode = "approve" }
tools.pencil_tools = { approval_mode = "approve" }
tools.pencil_call = { approval_mode = "approve" }
tools.pencil_close = { approval_mode = "approve" }
tools.pencil_status = { approval_mode = "approve" }
```

Other operations keep the server’s prompt policy. These permissions apply only to this server; no global approval or sandbox policy is changed. Finish every disposable CLI test with `pencil_close`, then confirm the session is absent with `pencil_status`.

## Sessions and resource lifetime

The service owns one headless Chrome browser and one isolated context/page per design session. The native view displays the same editor that agents modify; it does not start a second editor.

- Opening a document starts its engine independently of the visible panel. Closing or hiding the panel leaves background work available.
- `pencil_end` releases one participation lease and keeps the editor alive.
- The final participant uses `pencil_close` when the document task is finished. It saves, closes that session’s views and releases its context, cached frame and viewers. Success consumes the lease; do not call `pencil_end` afterward.
- Another participant, pending work, failed Save or uncertain state prevents successful disposal. A failed Save retains the editor; an uncertain disposal is quarantined.
- Automatic recovery never replays edits or resurrects an intentionally closed session. Explicitly opening the same saved document restores its content and node IDs with new session and renderer IDs. Other documents and the shared service remain available.

Read [the lifecycle and migration contract](docs/pencil-persistent.md).

## Usage and collaboration

1. Call `pencil_open` with an existing absolute `.pen` path and a scope unique to this chat, or `pencil_new` with a new absolute path and scope. Both fields are required. There is no implicit MCP-process or `CODEX_THREAD_ID` scope.
2. Keep the returned `sessionId`. Each collaborating agent joins with `pencil_begin` and uses its own non-exclusive participation lease. Share the session ID, not connection credentials. A different scope cannot open a second writer on the same file.
3. Use `pencil_tools` for native schemas and `pencil_call` → `read_skill` before editing; inspect `get_app_state` and derive current node IDs. Documentation/schema reads are coalesced per session and engine generation.
4. Work on separate frames, reread before changes and preserve other agents’ nodes. Shared engine JavaScript globals require distinct variable names. New documents are empty; frame counts, positions and content come from the task.
5. Leave temporary participation with `pencil_end`; finish the whole document with `pencil_close` as its final participant.

Read [the plugin skill](skills/pencil/SKILL.md). `.pen` contents are opaque: edit through the engine, never by parsing or rewriting the file manually. `Generate(...)` asynchronous generation is unsupported. The syntactic guard is not a JavaScript sandbox.

## Save, captures and exports

| Tool | Result |
|---|---|
| `pencil_save` | Flushes and saves the opened source, retaining the previous bytes and checking for external conflicts |
| `pencil_close` | Performs Save, then releases the finished session’s editor |
| `pencil_save_as` | Writes an acknowledged snapshot to a new `.pen` path without switching the active source |
| `pencil_capture` | Writes PNG captures of requested node IDs |
| `pencil_export` | Exports PNG, JPEG, WEBP, PDF, HTML/CSS or HTML/Tailwind |

Destination directories must exist. New documents, Save As, captures and exports never overwrite an existing destination. These operations require the appropriate participation lease. In **Edit** mode, **Cmd+S** or **Ctrl+S** flushes and saves the source. Success appears briefly over the editor and errors remain visible.

On macOS, the **↗ Open in Pencil** button next to the Hand and Edit controls saves the current document, then opens that same source file in the pen.dev desktop app. A failed Save stops the launch. The Codex panel returns to Hand mode and continues showing its own session. The desktop app and Codex maintain independent editor state. Save in one editor at a time and resolve any source conflict before continuing in Codex.

Autosave keeps a separate private draft. An older snapshot cannot acknowledge a later completed mutation. Explicit Save flushes the engine, checks its source baseline and returns `source-saved` after publication. External changes produce `SAVE_CONFLICT`; preserve work with Save As. Older drafts without a baseline also require Save As.

Publication retains the previous source in a hidden `.pencil-save-*` directory beside it. This is not a filesystem compare-and-swap or crash-durable database transaction. After an interrupted Save, inspect recovery copies before deleting them. Avoid another application writing the same source concurrently.

Save requires quiescent operations. Calls arriving during Save wait within a bounded deadline; failure or `SAVE_WAIT_TIMEOUT` rejects them without dispatch. `OUTCOME_UNKNOWN` means never replay a mutation. Confirm recovery and reread before further work. Assets are confined to `images/` and `fonts/`; path traversal, symbolic links and `.pen` asset substitution are rejected. External `.pen` libraries and the vendor dashboard are unsupported.

## Views, accessibility and diagnostics

Each panel opens in **Hand** mode. Drag the canvas or use the arrow keys to pan. Use the **− / +** buttons, pinch on a compatible trackpad, or hold **Cmd/Ctrl** while scrolling to zoom. Hand mode forwards only canvas navigation. Choose **Edit** to interact with objects or use editing shortcuts. Hand navigation and desktop launch require the updated background service. The switch affects your panel and agents can keep working in the shared session.

The embedded editor starts with pen.dev’s analytics cookie choice set to **Decline** in every fresh browser context.

The view transports images, pointer and keyboard input through the MCP Apps host bridge. It declares no direct external connection domain. The same engine adapts to the panel's measured content area, without reloading its document or altering canvas zoom. The first visible view owns its session's size until hidden or disconnected; simultaneous mirrors fit that viewport without competing to resize it. Hidden or zero-size views retain the last valid size when no other view is visible. Dimensions are bounded to 4096 pixels per axis and 8 megapixels; oversized panels are scaled proportionally.

Resize and input share a per-session queue. Stale frame coordinates are rejected and held interactions are released before geometry changes. If Chrome reports a compositor surface with different dimensions, the view captures a correctly sized image at a limited rate. Keyboard focus and an accessible status are provided; connection/errors overlay the editor and normal connected status is visually hidden. Screen-reader access to editor objects is not available through this image-based view.

`pencil_status` reports readiness, renderer identity, participants, active/waiting calls, Save state, cached metadata and bounded request timestamps. Activity is reported through tools; the view does not currently display a per-agent activity list or distinct agent canvas cursors. The core readiness wait defaults to 60 seconds; opening also includes the renderer’s bounded startup checks. An offline service leaves tool discovery available and returns an error without replaying operations.

## Development and validation

```bash
bun install --frozen-lockfile
bun run build
bun run test
bun run test:protocol
bun run test:viewport
```

The build produces `dist/pencil.mjs`, `dist/persistent-service.mjs`, the `dist/persistent/` assets and license notices. Legacy panel/server bundles remain for compatibility tests and historical tooling; the installed manifest does not select them. `bun run preview` is a legacy development harness with its own broker, not the installed persistent service.

The opt-in `test:viewport` acceptance check starts its own ephemeral service, private runtime, browser and temporary documents against the real hosted editor. Set `PENCIL_TEST_CHROME` to the Chrome executable outside the default macOS location. It verifies portrait/landscape sizing, Save shortcuts and conflicts, two agents sharing one document, another isolated document, and panel hide/reopen. It leaves captures and a receipt in `.runtime/viewport-evidence/` (override with `PENCIL_VIEWPORT_EVIDENCE`) and removes its service/documents. It does not install the plugin or exercise the native Codex host. Unit tests run sequentially across Node test files to avoid startup process contention without increasing their two-second timeout.

The installed 0.7.1 adapter and real hosted engine passed modification, close and explicit reopen with exact content/UUID-variable preservation, intentional terminal transport shutdown and another renderer remaining intact. All probe editors were then closed. These checks use the installed MCP adapter and actual image transport; they do not certify fresh native Codex UI rendering of 0.7.1.

Read [historical native panel measurements](docs/installed-validation.md), [the former Pen Remote validation report](docs/remote-renderer-experiment.md) and [the feasibility study](docs/persistent-engine-feasibility.md) for their stated versions and limits. The old main remains on `archive/pre-persistent-pencil-2026-11-17`; the saved Remote code remains on `archive/pen-remote-0.1.5-2026-11-17`.

## References and license

Read [the upstream embed proposal](https://github.com/highagency/pen-embed-demo) and [OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) for their integration contracts. This is an independent integration, not affiliated with or endorsed by Pencil or OpenAI. Read [the MIT license](LICENSE) and [third-party notices](THIRD-PARTY-NOTICES.md). The hosted engine is not redistributed and remains subject to its publisher’s terms. Documents are stored locally but processed by that hosted editor.
