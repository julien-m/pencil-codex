# Persistent engine feasibility

The requested adaptation is **not validated**. This branch contains diagnostic probes, not a production engine adapter. No installed plugin or Codex application file was replaced.

## Preserved baseline

- Baseline: `e22e8f4`, the historical Pencil plugin (`0.5.1`), on `main`.
- Backup branch: `backup/before-persistent-engine-2026-11-15`.
- Experiment: `feat/persistent-session-engine`, in a separate worktree.
- The installed vendor plugin `pen-dev` (`0.1.3`) is a different implementation; its executable and editor were not changed.

## Required behavior

```gherkin
Scenario: Independent chats share one background host
  Given chats A and B own different documents
  And multiple agents participate in chat A
  When the agents modify both documents while their chats are hidden
  Then A's agents observe the same changes
  And neither document receives the other chat's changes
  And each embedded editor displays its own current document
  And no additional visible Pen application is required per chat
```

## Observed results on 2026-11-15

| Probe | Result | Scope |
| --- | --- | --- |
| Native MCP, two files and three clients | Passed | Two clients share A; B remains isolated; concurrent A/B mutations and saves succeed. These are scripted clients, not model agents. |
| Native application process | One existing Pen application | No per-session application was launched. The probes opened temporary background document tabs, which were closed afterward. |
| Two public embedded editors with the same URI and backing snapshots | Failed live synchronization in both directions | Updating the backing snapshot does not update an already loaded editor. Both editors can execute commands and save their own state. |
| Existing build, unit/integration and MCP protocol checks | Passed | 29 Bun tests, 13 Node tests and the separate stdio protocol probe. This does not certify the requested adaptation. |

The native probe uses explicit document URIs. It does not prove native enforcement of chat ownership; a production adapter must retain the existing session/lease checks and bind the URI on the server, rather than accepting another file from the caller.

Read [the native probe](../tests/native-engine-feasibility.mjs) for the transport and isolation checks. Read [the embed fixture](../tests/embed-engine-probe.mjs) and [the embed runner](../tests/run-embed-feasibility.mjs) for the bidirectional live-state check.

## Public embed boundary

The hosted editor inspected at `https://app.pen.dev/new?embed` accepts `pen:connect` with a document URI and a transferred `MessagePort`. Its request dispatch exposes `get-mcp-schema`, `mcp-tool-call`, `save`, and `browser-import`. Its host-to-editor notification allowlist contains `color-theme-changed`. Storage requests load and save opaque document snapshots; they do not subscribe the editor to the native socket's document state.

This is evidence about the inspected implementation, not a claim that every possible adapter is impossible. The missing integration is a supported way to attach the embedded view to the same live document engine. Repeated reloads or two independent snapshot writers have not been accepted as substitutes.

## Reproduce

Run `node tests/native-engine-feasibility.mjs <installed-native-mcp-binary> <receipt.json>` with Pen already running. The native tool protocol must assign its client ID before the probe sends a tool call. Each call has a ten-second deadline; the command has a 120-second deadline. The generated test documents are listed in the receipt so their tabs can be closed before removing them.

For the hosted-editor probe, use an agent-owned Ego TaskSpace and import `runEmbedFeasibility` from [the runner](../tests/run-embed-feasibility.mjs). Call it with that TaskSpace and an absolute receipt path. It returns `requirementPassed` and both directions. A successful diagnostic execution with `requirementPassed: false` is a failed product acceptance criterion. Close the TaskSpace after the result; no credentials or shared cloud documents are needed.

An initial navigation encountered a transient DNS error. A separate explicit-reload diagnostic timed out before the embed client was installed and was discarded. The final bidirectional result comes from two freshly initialized, ready editors; neither transport errors nor a missing editor were counted as synchronization failures.

## Next integration requirement

A complete implementation needs either a Pen-supported live document/view transport or a design that presents the very same persistent renderer inside Codex. The latter has not been implemented or assessed for interaction latency, clipboard handling, accessibility or resource usage here. A global MCP connection alone satisfies neither requirement.

Modern Web Guidance was searched for preserving embedded document state. No guide was applied: the changes are protocol probes, and no product interface was changed.
