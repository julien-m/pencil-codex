# Persistent Pencil

Version 0.7.1 promotes the tested Pen Remote renderer to the Pencil plugin. Canonical source is `src/persistent`; the installed MCP entrypoint is `dist/pencil.mjs` and the separately supervised service is `dist/persistent-service.mjs`. The old panel modules remain only for compatibility tests and historical tooling; the manifest selects the persistent entrypoint.

The core owns sessions, leases, Save and conflict rules. The renderer owns one Chrome context/page per session in its shared browser. Views attach to its pixels and input stream. Closing a view leaves the engine alive. `pencil_close` requires a sole lease, freezes admissions/input, confirms Save, records durable closed intent and releases that context. Unknown disposal outcomes remain quarantined. Automatic view recovery never replays mutations or resurrects intentionally closed sessions.

The service is permanent, supervised and independent of the installed plugin cache. The local installation uses the user’s `Library/Application Support/Pencil/codex`; configuration accepts `PENCIL_CONNECTION`. A stopped service leaves tool discovery available and returns an actionable error.

Before promotion, `archive/pre-persistent-pencil-2026-11-17` preserves the previous main. Existing experiment runtime data is copied opaquely into the stable runtime and archived in full before its worktree is removed. Sources, drafts, baseline hashes and closure markers are preserved; drafts derived from old source paths need the original scope/path mapping for automatic recovery. They are never blindly published over a source.

This plugin is distinct from pen.dev’s official plugin and from the MCP server of the Mac Pen application. It uses the hosted engine; no proprietary engine is redistributed.
