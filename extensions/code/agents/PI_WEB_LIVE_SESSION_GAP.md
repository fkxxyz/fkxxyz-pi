# Pi Web Sub-Agent Live Session Gap

## Summary

Sub-agent sessions can be materialized early enough for pi-web to discover them in the session list, but pi-web does not currently treat those sessions as live running agents. When a user opens a running sub-agent session from the UI, pi-web loads a static session-file snapshot instead of subscribing to the child `AgentSession` event stream. As a result, the UI shows the parent-written prompt and metadata, then stays stale until the child assistant message is fully persisted and the user manually reloads or switches sessions.

## Observed Behavior

After the sub-agent extension creates a synchronous child agent:

- The child `.jsonl` session file appears early in the session list.
- Opening the child session while it is still running shows only the initial user prompt and metadata.
- The child assistant's streaming output does not render live in that child session view.
- After the child LLM finishes, the complete assistant output exists in the `.jsonl` file.
- The UI shows the completed output only after a manual refresh or after switching away and back.

This is distinct from the parent tool row update path. The parent tool row can receive child progress through the tool `onUpdate` callback, but that does not make the child session itself a pi-web live session.

## Current Working Parts

The sub-agent extension now covers two related but separate behaviors:

1. It bridges child `AgentSession` progress into the parent tool execution through `onUpdate`, allowing the parent session's tool row to update during synchronous child runs.
2. It materializes new child session files immediately after session metadata is written, allowing pi-web's session list scanner to discover the child session before the first assistant response is complete.

These fixes do not solve live child-session viewing because pi-web uses a separate registry for running agents.

## Evidence From Pi Web

pi-web has two separate paths for sessions:

- Historical session loading:
  - `GET /api/sessions/[id]`
  - Opens the session file through `SessionManager.open(...)` and returns a snapshot derived from persisted `.jsonl` entries.

- Live agent streaming:
  - `GET /api/agent/[id]/events`
  - Streams events only for running agents registered in pi-web's in-process running-agent registry.

The running-agent registry is held in a pi-web private global map:

```text
globalThis.__piSessions
```

The running sessions endpoint reports only sessions from that map:

```text
GET /api/agent/running/events
```

The session state endpoint also depends on that registry:

```text
GET /api/sessions/[id]/state
```

If a session id is not registered there, pi-web treats it as non-running even if an `AgentSession` exists elsewhere in the same process.

## Root Cause

The sub-agent extension creates child `AgentSession` instances directly through pi core APIs. These child sessions are live and emit streaming events, but they are not registered in pi-web's private running-agent registry. Therefore pi-web cannot associate the session-list entry with the existing live child session.

The UI can discover the child session file, but it cannot subscribe to the child session's in-memory event stream.

## Responsibility Boundary

This is primarily a pi-web integration gap rather than a pi core streaming failure:

- pi core exposes live session events through `AgentSession.subscribe(...)`.
- the sub-agent extension creates a live child `AgentSession` and can observe its events.
- pi-web only automatically streams sessions it creates or knows through its private running-agent registry.
- there is no stable public API for extensions to register externally created child sessions as live pi-web agents.

## Possible Fix Directions

### Preferred Long-Term Fix

pi-web or pi core should expose a supported API for registering live sessions created by extensions. The API should let an extension provide a live session handle and session metadata, then let pi-web:

- include that session id in running-session updates;
- serve `GET /api/sessions/[id]/state` from the live session;
- serve `GET /api/agent/[id]/events` from the live session's event stream;
- unregister the session when it completes or is destroyed.

This avoids depending on pi-web internals and gives sub-agents, forked sessions, and future extension-owned sessions a common integration path.

### Practical Short-Term Workaround

The sub-agent extension could detect pi-web and register a lightweight adapter in `globalThis.__piSessions`. The adapter would need to emulate the minimum interface pi-web expects from its running-agent wrapper:

- `sessionId`
- `sessionFile`
- `isAlive()`
- `isRunning()`
- `onEvent(handler)`
- `send({ type: "get_state" })`
- `destroy()`

The adapter would forward events from the child `AgentSession.subscribe(...)` stream and expose state from the child session. This would likely make child sessions live-refresh in pi-web, but it depends on private implementation details and should be treated as a compatibility workaround rather than a stable design.

## Open Notes

- Parent tool-row streaming and child session live viewing are separate UI channels.
- Early session-file materialization is necessary for discoverability, but not sufficient for live viewing.
- A file watcher alone would still be weaker than subscribing to the live event stream because partial assistant output may exist only as in-memory `message_update` events before final persistence.
- If a short-term adapter is implemented, it should include regression coverage that verifies a child session is both discoverable in the session list and reported as running while its prompt is active.
