# Engine host

`createEngineHost(engine, transport, options)` serves the engine protocol (`@dawg/protocol`) to
one client over one transport. The desktop app runs one per window against a shared engine; the
command-line tool runs one in-process over a memory transport, and `dawg serve` one over stdio.

```ts
import { createEngine, createEngineHost } from "@dawg/engine";
import { createMemoryTransportPair, createClient } from "@dawg/protocol";

const [clientEnd, engineEnd] = createMemoryTransportPair();
const host = createEngineHost(engine, engineEnd, { homeDir, settingsFlags, detachGraceMs: 0 });
const client = createClient(clientEnd);
```

| Option | Meaning |
| --- | --- |
| `engineInfo` | `{ name, version }` reported by `initialize` |
| `commands` | A `CommandRegistry`; default the built-in commands |
| `homeDir`, `settingsFlags` | What the engine was created with, for `/permissions` and `/init` |
| `describeEndpoint(session)` | `{ kind, url }` for `/status` and `/model` |
| `detachGraceMs` | See "When the connection closes"; default 10 minutes |
| `maxMessageLength` | Reported by `initialize` |
| `onProblem` | Failures worth logging (handler crashes, events that could not be sent) |

## Mapping

Every method maps to one engine or runtime call (`runtime/README.md`). Session snapshots get
their `commands` list from the registry. `session.command` runs the command; a command that
starts a turn returns its `turnId`, one that opens a session (`/clear`, `/resume`) returns the
new session's snapshot and that session is open on this connection from then on. An unknown
command or a bad argument is `InvalidParams` and never reaches the model.

`session.delete` works whether or not the session is open, on this connection or another. Every
connection that had it open receives `session.deleted` (after the interrupted turn's events, if
one was running) and drops it from its open sessions; later requests on it are
`SessionNotFound`. A session another process has open (a `dawg` run in a terminal) is
`InvalidState`.

`initialize` capabilities are given to every session the connection opens. When several
connections hold one session, it gets the union: if any of them can answer a permission prompt,
prompts are raised.

## Events

The host subscribes once to the engine and forwards the events of sessions open on this
connection (created, resumed or forked here), unchanged and in `seq` order. A session is open
from the moment its snapshot is taken, so a client that applies the snapshot and then every event
with a greater `seq` misses nothing. `session.replay` works on any stored session, open or not.

## Errors

Runtime errors keep their protocol code (`SessionNotFound`, `SessionBusy`, `InvalidState`,
`RequestNotFound`). A session id that is stored but not open here is `InvalidState`; an unknown
one is `SessionNotFound`. Model and storage failures become `InternalError` with a sentence a
person can read; anything else becomes `InternalError` "The engine could not complete <method>",
with the details sent to `onProblem` only. Messages keep their first line, and absolute paths
outside the working directories of the connection's sessions are replaced with `[path]`.

## When the connection closes

For each session the connection had open (a deleted session is no longer among them):

- **Another connection still holds it:** nothing stops; that connection now answers alone.
- **Idle:** it is closed at once (the transcript is flushed and its lock released). It can be
  resumed later from any connection.
- **A turn or compaction is running:** the turn goes on for up to `detachGraceMs`. A connection
  that resumes the session in that time takes it over, pending questions included (they are in
  the snapshot's `pending`). When the turn ends with nobody attached the session is closed; when
  the time runs out first, the turn is interrupted (its calls get "interrupted" results) and the
  session closed.
- With `detachGraceMs: 0` a running turn is interrupted and the session closed at once. `dawg
  serve` and the command-line tool use this, so a headless run whose parent dies leaves nothing
  running.

`host.close()` closes the transport and resolves once this is done; `host.done` resolves when the
client closed the connection and the same has happened. The engine itself stays open: it may be
serving other connections.
