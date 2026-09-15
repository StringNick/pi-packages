# Hosted permission lifecycle

`@gotgenes/pi-permission-system/host` is a trusted in-process integration seam,
not a containment boundary. Standalone configuration and interactive permission
behavior remain the default when no host policy is installed.

A host may register exact child ancestry with
`registerHostChildSession(childSessionId, parentSessionId, serving)` before child
extension binding. Native lifecycle announcements must agree with that ancestry
and cannot replace its serving-parent identity. Keep the returned disposer with
the child: it removes only the entry it owns, not a replacement registration.

A host-admitted permission extension registers a native evaluator factory for
its session. `createHostChildPermissionEvaluator(servingSessionId, options)`
requires that live registration; absence fails closed. An evaluator checks
cancellation and exact registration ownership before and after asynchronous
approval. Reinstalling the same function does not make an old allow decision
valid. Disposed evaluators cannot authorize later calls.

Hosts retain responsibility for project/resource trust, approval-mode authority,
reusable grant persistence, mandatory interceptor admission and the tool executor.
A pending approval is transient and must be cancelled when its owner retires.
The integration does not introduce another conversation format, execution loop
or persisted approval continuation.

Declaration bundles for this entrypoint are built explicitly by
`rollup.dts.config.mjs`; source and declarations must be updated together.
