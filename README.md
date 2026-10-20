# Pencil

A Codex plugin that opens `.pen` design documents in an embedded Pencil editor, without adding another chat interface. A local Node.js service maintains one channel per design session. Multiple agents share a `sessionId` and reserve the document for short editing sequences.

## Repository and platform

This repository, **pencil-codex**, contains one independently installable Codex plugin. Its display name is **Pencil**, and its plugin identifier is `pencil`. A future Claude-specific implementation would live in a separate `pencil-claude` repository; that implementation is not included here.

Read [the plugin manifest](plugin.json) for its identity, [the MCP configuration](mcp.json) for the stdio server, [the server](src/server.mjs) for tool-driven opening, [the session manager](src/sessions.mjs) for reservations, and [the editor view](web/editor.mjs) for the Pencil bridge.

## Status and requirements

**The native Codex panel is not fully working in the host tested so far.** The MCP App opens, but its WebSocket connection to the local service fails with “Canal local inaccessible dans cet hôte”. Installing the plugin and passing its protocol tests do not establish that the native panel works in your host.

The local browser preview has been exercised against the real hosted editor: two independent agents edited the same session in sequence, the second agent read and preserved the first agent's work, and the resulting document and PNG export were saved. The reservation mechanism also rejected a competing writer.

Requirements:

- Codex with plugin and MCP Apps support.
- Node.js 22 or later.
- Network access to the hosted Pencil editor at `https://app.pen.dev/new?embed`.
- A host that permits the embedded pen.dev frame and connections to the loopback service.
- Bun for development and tests only.

The plugin does not redistribute the proprietary Pencil engine and does not work offline.

## Installation

```bash
codex plugin marketplace add julien-m/pencil-codex
codex plugin add pencil@pencil
```

The installable bundles are included in Git, so installation does not require a compiler or a local `node_modules` directory. Reload plugins or start a new conversation if the tools are not available in an existing conversation. Keep the native-panel limitation above in mind.

## Development and validation

```bash
git clone https://github.com/julien-m/pencil-codex.git
cd pencil-codex
bun install --frozen-lockfile
bun run build
bun run test
bun run test:protocol
```

To install from a local checkout:

```bash
codex plugin marketplace add "$PWD"
codex plugin add pencil@pencil
```

To inspect a disposable design in the standalone local browser preview:

```bash
bun run preview /absolute/path/to/example.pen
```

Open the local URL printed by that command. The preview is a development harness with its own broker; it does not automatically join the broker used by the installed MCP server. Its diagnostic output contains local connection credentials: do not publish it.

The build generates `dist/server.mjs`, `dist/daemon.mjs`, `dist/editor.html` and third-party license notices. Keep these files current when changing the source. Unit tests use Bun; the real HTTP/WebSocket transport and MCP stdio tests use Node.js, matching the installed runtime.

## Usage

1. Ask the agent to use the installed Pencil plugin. Call `pencil_open` with an absolute file path and an explicit design-session `scope`, or call `pencil_new` to create a document. The tool returns its UI resource; rendering and connecting that resource depend on the host.
2. Wait for the editor to connect. Call `pencil_tools` to discover the native schemas, then load the native instructions through `pencil_call` with `read_skill`.
3. Call `pencil_begin` before a short read/edit/verify sequence, use `pencil_call` for native operations, and release the reservation with `pencil_end`.
4. Give every agent collaborating on that document the same returned `sessionId`. Do not open the same file under another `scope` to create a second writer.

Implicit scopes use `CODEX_THREAD_ID` when available, otherwise the MCP process identity. This is not a guaranteed native conversation identifier: agents must explicitly share the returned `sessionId`. The `agent` field is an activity label, not an authenticated identity.

The plugin opens documents only through `pencil_open` or `pencil_new`. It does not register an automatic `.pen` file association.

## Captures, exports and Save As

| Tool | Result |
|---|---|
| `pencil_new` | Creates a `.pen` file at the selected absolute path and returns its editor view |
| `pencil_capture` | Captures component/screen IDs, or `["document"]` for the whole design, as PNG files in the selected directory |
| `pencil_export` | Exports PNG, JPEG, WEBP, PDF, HTML/CSS or HTML/Tailwind and returns the files actually written |
| `pencil_save_as` | Copies the last acknowledged snapshot into a new `.pen` file at the selected path |

Destination directories must already exist. These tools never overwrite an existing destination. Captures and exports require a session reservation. Documents remain opaque to the plugin: the Pencil engine manages their contents, while the plugin transports and stores their bytes.

Native screenshots may be optimized previews; use raster export when a higher-resolution image is needed. Captures, all six export formats, document creation and Save As have been exercised on disposable test designs.

## Navigation and agent activity

The embedded view contains the real Pencil editor. Selection tools, zoom, Layers and component navigation remain available. Sign In, Goodies and settings remain as provided by Pencil; the plugin does not hide them using CSS, DOM injection or overlays.

The plugin's header shows the agent currently holding the document reservation and updates over the session channel. The plugin does not currently assign distinct native canvas cursors or object labels to individual agents. Its header badge is separate from any presence features provided by Pencil.

## Persistence and safeguards

Edits are saved to a separate draft in the plugin's data directory. The service never replaces the original document, avoiding the lost-update window of a hash check followed by file replacement. `pencil_status` reports the draft path, which can be opened in Pencil. Use `pencil_save_as` to save the acknowledged draft to a new destination; this version has no command for overwriting the original file.

Assets are limited to `images/` and `fonts/` beside the document. Traversal paths, symbolic links and `.pen` documents used as assets are rejected. External `.pen` libraries are not supported by this initial storage implementation. The editor's document-library/dashboard requests, including `documents-list`, are not implemented either; use the plugin tools to open or create documents.

Reservations protect agent calls, not manual edits in the editor. Do not run automated mutations while someone is editing manually. A timed-out operation blocks subsequent mutations; never replay an insertion with an unknown outcome. Asynchronous generation is unsupported. The syntactic rejection of `Generate(...)` is a usage guard, not a JavaScript sandbox.

## Local data and service lifecycle

When supplied by the host, `PLUGIN_DATA` stores private connection metadata and drafts. Otherwise, the plugin uses its own `.runtime/` directory. The service listens only on loopback and requires a private token. Each editor view receives a token restricted to its session.

The service survives an MCP client disconnect. To stop it explicitly, read its PID from the data directory's `connection.json` and send SIGTERM. Preserve any drafts you still need. After an interrupted startup, a stale `starting` directory may need to be removed after checking that its service is no longer running.

No API key is bundled. Session tokens are generated at runtime. Documents and drafts are stored locally, but their contents are processed by the hosted web editor. Review pen.dev's terms and network behavior before using sensitive documents.

## References and license

Read [the upstream embed proposal](https://github.com/highagency/pen-embed-demo) for the bridge and [the OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins) for the package format.

This is an independent integration, not affiliated with or endorsed by Pencil or OpenAI. Read [the MIT license](LICENSE) for this integration and [the third-party notices](THIRD-PARTY-NOTICES.md) for libraries included in the bundles. The hosted Pencil engine remains subject to its publisher's terms.
