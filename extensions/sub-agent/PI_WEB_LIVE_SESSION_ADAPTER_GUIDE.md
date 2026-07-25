# Pi Web Live Session Adapter Guide

## Context

The sub-agent extension creates child `AgentSession` instances directly through Pi's coding-agent SDK. These child sessions are real live sessions: they can stream events through `AgentSession.subscribe(...)`, persist to JSONL, and complete normally.

Pi Web has a separate live-session path. It lists historical sessions from JSONL files, but it streams only sessions registered in its in-process running-session registry. At the time this adapter was written, that registry is the private `globalThis.__piSessions` map used by `agegr/pi-web`.

Without this adapter, a newly materialized child session can appear in the Pi Web sidebar while it is still running, but opening it shows only the persisted snapshot. The view does not receive the child session's live `message_update` events until the assistant response has been fully persisted and the browser refreshes or reopens the session.

This guide documents the compatibility workaround used by `extensions/sub-agent/sub-agent.ts` and how to maintain it safely.

## Verified Pi Web Version

The adapter shape was checked against:

```text
agegr/pi-web@0d1d0d1a36dd8a4ead77648ad2fc18e2b1291e55
```

The Pi Web clone used for compatibility checks lives at:

```text
/run/media/fkxxyz/wsl/home/fkxxyz/src/agegr/pi-web
```

Run the compatibility test after every Pi Web update:

```bash
cd /run/media/fkxxyz/wsl/home/fkxxyz/src/agegr/pi-web
npm run test:sub-agent-live-compat
```

If this test fails, treat the adapter as unsafe until the failed contract is inspected and the adapter is updated.

## Adapter Goal

The adapter makes extension-owned child sessions visible to Pi Web as live running sessions without changing the sub-agent core execution model.

It should:

- register a child session while `runPrompt(...)` is active;
- let Pi Web report the child session as running;
- let `GET /api/agent/[id]` read live state through `send({ type: "get_state" })`;
- let `GET /api/agent/[id]/events` stream child `AgentSession` events through `onEvent(...)`;
- unregister the child session after completion, error, stop, abort, or parent shutdown;
- fail closed if Pi Web's private registry shape is not recognized.

It should not:

- replace Pi Web's normal `AgentSessionWrapper`;
- start or resume sessions through Pi Web;
- depend on file watching as the primary live path;
- make `globalThis.__piSessions` part of the sub-agent core abstraction;
- keep child sessions registered after they are no longer running.

## Current Private Pi Web Contract

The adapter assumes this private Pi Web shape:

```ts
globalThis.__piSessions: Map<string, LiveWrapper>
globalThis.__piRunningListeners?: Set<(ids: string[]) => void>
```

Each registry value must behave like Pi Web's `AgentSessionWrapper` for the routes the adapter needs:

```ts
type LiveWrapper = {
  sessionId: string;
  sessionFile: string;
  isAlive(): boolean;
  isRunning(): boolean;
  onEvent(listener: (event: unknown) => void): () => void;
  send(command: Record<string, unknown>): Promise<unknown>;
  destroy(): void;
};
```

Important route dependencies:

- `GET /api/agent/[id]` calls `getRpcSession(id)`, checks `isAlive()`, then calls `send({ type: "get_state" })`.
- `GET /api/agent/[id]/events` calls `getRpcSession(id)`, checks `isAlive()`, then forwards events from `onEvent(...)` as SSE.
- running-session updates are derived from registry entries where `isRunning()` returns true.

## Implementation Notes

The adapter is implemented inside `extensions/sub-agent/sub-agent.ts` as a small compatibility layer:

- `registerPiWebLiveSession(run)` creates a wrapper around the child `AgentSession`.
- The wrapper forwards child `AgentSession.subscribe(...)` events to Pi Web listeners.
- `send({ type: "get_state" })` returns the live state fields Pi Web expects.
- `send({ type: "abort" })` forwards to `run.session.abort()`.
- Unsupported commands throw an explicit adapter error instead of silently pretending to support full Pi Web control.
- `notifyPiWebRunningChange()` recomputes running ids from `globalThis.__piSessions` and notifies `globalThis.__piRunningListeners` when available.
- `runPrompt(...)` registers at the start of a child prompt and unregisters in `finally`.
- `session_shutdown` unregisters any remaining child live wrapper before disposing child sessions.

The adapter deliberately stays narrow. It exists only to bridge live viewing for child sessions in Pi Web. If Pi Web or Pi core exposes an official live-session registration API, this adapter should be replaced with that API.

## Failure Policy

The adapter must fail closed.

If `globalThis.__piSessions` exists but is not a `Map`, the adapter logs a warning and does not register the child session:

```text
[sub-agent] pi-web live-session adapter disabled: globalThis.__piSessions is not a Map
```

If another alive wrapper is already registered for the child session id, the adapter logs a warning and skips registration:

```text
[sub-agent] pi-web live-session adapter skipped: session <id> is already registered
```

In both cases, the sub-agent should still run normally. The parent tool row streaming path and persisted JSONL file remain the fallback observability channels.

## Tests

Repository test covering the adapter:

```bash
cd /home/fkxxyz/pi
bun test tests/sub-agent-skills.test.ts --test-name-pattern "Pi Web live registry"
```

Full repository test:

```bash
cd /home/fkxxyz/pi
bun test tests/*.test.ts
```

Pi Web private-contract test:

```bash
cd /run/media/fkxxyz/wsl/home/fkxxyz/src/agegr/pi-web
npm run test:sub-agent-live-compat
```

Use both test sets when updating Pi Web or changing this adapter:

1. Run Pi Web's `test:sub-agent-live-compat` first to check whether the private registry ABI still matches.
2. Run the sub-agent extension tests to verify this repository's wrapper behavior.
3. If either fails, inspect the failure message before editing; do not guess at registry changes.

## Manual Verification

After tests pass, a useful manual check is:

1. Start Pi Web from the verified clone.
2. Start a parent Pi session with this sub-agent extension enabled.
3. Run a background or long-running `sub_agent` call.
4. Confirm the child session appears in the Pi Web sidebar while still running.
5. Open the child session while it is running.
6. Confirm assistant text streams live without refreshing the page.
7. Confirm the running badge disappears after the child completes.
8. Confirm the child output remains readable from the persisted session file after completion.

## When Pi Web Changes

If `npm run test:sub-agent-live-compat` fails after updating Pi Web:

1. Read the failed assertion message. It names the private contract that changed.
2. Inspect Pi Web's `lib/rpc-manager.ts` and `app/api/agent/[id]` routes.
3. Identify the new live-session registry, wrapper methods, running-state broadcaster, or SSE path.
4. Update `registerPiWebLiveSession(...)` to match only the minimum required route contract.
5. Update `lib/sub-agent-live-compat.test.mjs` in the Pi Web clone so future updates catch the new contract.
6. Re-run both Pi Web and repository tests.

Avoid broad rewrites. The safest adapter is a small removable layer around the private Pi Web boundary.

## Long-Term Replacement

This adapter is a compatibility workaround, not the desired architecture.

The preferred long-term direction is an official Pi live-session API, such as an `AgentSessionServer` / `AgentSessionClient` sync layer or a supported `registerLiveSession(...)` API. Once such an API is available, sub-agent live viewing should migrate to it and stop touching `globalThis.__piSessions`.
