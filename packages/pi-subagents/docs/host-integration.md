# In-process host integration

The optional `@gotgenes/pi-subagents/host` entrypoint supplies trusted host inputs
without replacing the native manager or Pi's `AgentSession` execution loop.
Standalone extension use remains supported without a host registration.
A hosted process should hold the disposer returned by `requireSubagentHosts()`
for its runtime lifetime. While any such owner remains, a missing parent host
(including missing parent identity) fails closed instead of selecting standalone
IO. This process policy carries no session identity, credentials or ancestry.

Register one host with `registerSubagentHost(parentSessionId, host)` **before**
the parent's `session_start`. Duplicate owners are rejected. Keep its disposer
with that parent `AgentSession` instance; stale disposers cannot remove a later
registration. Pi also emits `session_shutdown` on extension reload, so that
event alone is not the parent instance's disposal boundary.
The extension captures that exact host generation. Retirement cancels pending
construction and aborts bound child sessions; it never falls back to standalone
construction after a host was captured. The owning native manager must still be
shut down to await work and dispose retained sessions.

Hosted agent discovery and operational settings bind at native `session_start`
from that exact parent's context cwd and host `agentDir`. Before binding, no
ambient project/profile discovery or launch is permitted. `allowProjectAgents`
is the host's immutable, already-admitted project trust input (omission denies);
it also controls reading/writing project operational settings. Global definitions
and settings still load from the admitted profile. Project files cannot enable
this flag. Rebinding resets prior project-derived values, and host retirement
invalidates reads, writes and new work. Both advertised tool descriptions and
launch resolution use this guarded registry. Trusted project symlink behavior
remains the native filesystem behavior; untrusted project directories are not
read, rather than being treated as a containment boundary.

A host supplies:

- `agentDir` and `allowProjectAgents`: profile location and already-admitted
  project trust, not values read from extension/project settings.
- `createSessionFactory(input, signal)`: asynchronous `SessionFactoryIO` inputs
  for the native factory. `input` carries parent ID, native run ID and effective
  cwd. It can inject credentials/model runtime, settings, resource trust, native
  tool operations and canonical session storage. Unless overridden, the native
  loader-settings exclusion policy remains in effect.
- `bindSession(session, identity)`: optional ancestry/lease binding before child
  extension binding; returns cleanup owned by the child lifecycle.
- `admitSession(session, identity)`: mandatory validation after extension binding
  and before prompting. Reject when required policy interceptors are missing.
- `assertAdmission()`: optional synchronous fence used before new/resumed work
  reserves a native record. Hosts can reject a retiring/replacing parent without
  adding another scheduler. The guard must not perform asynchronous work.

`subscribeChildSessionEvents(parentSessionId, listener)` observes native Pi
message/tool/session events with parent, run and child IDs and a per-child
sequence. Subscriptions belong to that exact host generation. Listeners are
isolated from one another. Consumers own authentication, serialization and byte
budgets; this API is not a transcript journal or a transport queue.

The service accessor `getSubagentsService(parentSessionId)` is parent-scoped.
Calling it without an ID resolves only when exactly one service is registered.
The native `startResume(id, prompt, options)` synchronously returns `started` or
`refused`; started means admission, not completion or model consumption. Existing
`resume` delegates to the same admission and waits for the same native promise.
Duplicate admissions while a turn or its cleanup is pending are refused. Native
`abort(id)` reaches resumed turns even after an earlier abort controller was
spent; caller cancellation is joined to that resumed turn's own controller.

`getSubagentWorkload({ sessionId, sessionFile })` and
`subscribeSubagentWorkloads(listener)` expose current native ownership, its
source incarnation and revision. Work includes initial/resumed execution,
queued admission, pending cleanup and pending notification delivery. Retained
completed records or an already-delivered question are not active work. These
snapshots are process-local facts, never inferred from files or PIDs.

There is no detached executor, durable continuation or session fork in this
contract. `inheritContext` retains its native conversation-text semantics. Pi
JSONL remains the canonical transcript.
