# Adaptive persistent editor validation

This change is prepared on `fix/persistent-editor-viewport`, from `a53fecf`. It is not installed or deployed. The main checkout, installed plugin and existing supervised service are left unchanged.

The integration toolbar is removed. The editor's container determines the same session engine's viewport; canvas zoom and document state are retained. Source Save remains explicit through Cmd+S / Ctrl+S, the Save tool or final close. Read [the view contract](../README.md#views-accessibility-and-diagnostics) and [the source Save contract](../README.md#save-captures-and-exports).

## Checks

All commands run from the isolated worktree, with bounded process lifetimes.

| Command | Observed result |
|---|---|
| `bun run build` | Exit 0; source and distributed MCP/standalone assets rebuilt |
| `bun run test` | Exit 0; 32 Bun and 33 Node tests pass |
| `bun run test:protocol` | Exit 0; MCP opening/resource/CSP/session status pass |
| `bun run test:viewport` | Exit 0; real hosted Pen editor and isolated disposable service/browser/documents |

Read [the viewport regression test](../tests/remote-viewport.test.mjs) and [the hosted acceptance test](../tests/remote-viewport-live.mjs). The regression initially fails because the baseline has no resize operation. An initial parallel suite timed out in the existing MCP startup test at two seconds; serial file scheduling avoids process contention without relaxing its timeout.

The hosted acceptance check verifies:

- Portrait 806×939 and landscape 1440×720: image natural dimensions, image bounds and engine viewport all match the full panel; no integration header/Save button.
- Same renderer identity through resizing, zero-size hiding and closing/reopening the view.
- Cmd+S and Ctrl+S; source-saved state; exact random variable values after Save, engine close and explicit document reopen.
- External source bytes survive a shortcut Save conflict, with a visible error.
- Two distinct agent leases share their document's variable changes. Another session has its own renderer, variables and viewport, unaffected by the first session.
- Background mutation while the panel is hidden survives reopening; no browser page errors.

Captures and a machine-readable receipt are generated under `.runtime/viewport-evidence/`. Disposable services, browsers, documents, drafts and recovery copies are cleaned after the check; evidence is retained.

## Review

One independent read-only review identified two defects, both corrected and checked by the coordinator: rounding above the pixel budget, and losing a resize request during the Save/close freeze. The regression tests now verify the real size calculation stays within the renderer validator and deferred size changes apply after resume. The final build, suite, protocol and hosted acceptance check all passed after these corrections.

## Limits

These checks exercise the real hosted engine and the same view entrypoint as the MCP App, plus the MCP host transport in boundary tests. They do not certify painting or shortcut interception by the native Codex host. Validating that host requires loading the branch in a separate test installation after the active plugin is no longer in use. No native Codex app automation or active service changes were performed.

Simultaneous views of one session intentionally share one viewport: the first visible view owns geometry until it hides or disconnects; mirrors preserve aspect ratio. Maximum dimensions are 4096 per axis and 8 megapixels. This is not a high-density display benchmark or a complete native editor accessibility test.
