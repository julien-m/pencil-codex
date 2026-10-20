---
name: pencil
description: Open and edit Pencil documents through this plugin, including concurrent agents sharing one design session.
---

- Open or create the requested document with `pencil_open` or `pencil_new`. Share the returned `sessionId` with all collaborating agents; another design session cannot open the same file.
- Launch agents while the view opens. `pencil_begin` joins immediately without an editor. Only engine calls (`pencil_call` and schema discovery) wait for engine readiness; `PENCIL_EDITOR_WAIT_MS` configures this wait (default 60000 ms). `EDITOR_OFFLINE` means the wait expired without sending the operation.
- Each agent joins with its own `pencil_begin` participation token. Call `pencil_tools` and load `read_skill` through `pencil_call`, following the returned native schemas. Metadata is coalesced and cached per session and engine generation; reconnection invalidates it.
- Each agent creates its own screen frame in its first `execute`, at the position assigned by the orchestrator or selected with `FindEmptySpace`. Never expect pre-created frames, persistent IDs from an earlier run, or a fixed number of agents.
- Derive screen count, names, dimensions, colors, content and destinations from the caller, configuration, open document or the agent's task decisions. Keep demonstration content in examples or test fixtures; production code must never import it.
- Preserve Document → Screen Frame → Section Frame → Components. Use frame layout, gap, alignment and padding; avoid concurrent edits to another agent's nodes.
- Use `pencil_status` for readiness, metadata counters and recent call timestamps. `openedAt`, `dispatchedAt` and `completedAt` permit measuring startup separately from agent preparation and hosted engine loading.
- End participation after calls finish. Explicit Save requires quiescent operations; calls arriving during Save wait within its bounded deadline. A mutation with `OUTCOME_UNKNOWN` must never be replayed.

- Engine JavaScript globals are shared by all agents in a session. Prefix every persistent variable and helper with the agent identifier (for example `agent3_screen`); never reuse another agent's globals.
- Use the engine's supported outline format: `stroke: {type: 'color', color: '#RRGGBB'}` with `strokeWidth` as a separate property. Do not put `align` or `thickness` inside `stroke`.
- Status distinguishes `activeCalls` (sent to the engine) from `waitingCalls` (waiting for readiness, Save or a shared metadata response). Cached reads each have their own history entry with `cacheHit`, a request timestamp and no dispatch timestamp.
