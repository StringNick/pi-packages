import { randomUUID } from "node:crypto";
import { debugLog } from "#src/debug";

export interface SubagentWorkload {
  parent: { sessionId: string; sessionFile: string | null };
  sourceId: string;
  revision: number;
  active: boolean;
  queued: number;
  running: number;
  foreground: number;
  pendingDelivery: boolean;
}
export interface SubagentWorkloadEvent {
  kind: "registered" | "changed" | "deregistered";
  snapshot: SubagentWorkload;
}
type Owner = { read: () => Omit<SubagentWorkload, "parent" | "sourceId" | "revision">; parent: SubagentWorkload["parent"]; sourceId: string; revision: number };
const KEY = Symbol.for("@gotgenes/pi-subagents:workload.v1");
function registry() {
  const root = globalThis as Record<symbol, unknown>;
  return (root[KEY] ??= { owners: new Map(), listeners: new Set() }) as { owners: Map<string, Owner>; listeners: Set<(event: SubagentWorkloadEvent) => void> };
}
function snapshot(owner: Owner): SubagentWorkload {
  return { ...owner.read(), parent: { ...owner.parent }, sourceId: owner.sourceId, revision: owner.revision };
}
function emit(kind: SubagentWorkloadEvent["kind"], owner: Owner) {
  const event = { kind, snapshot: snapshot(owner) };
  for (const listener of registry().listeners) {
    try { listener(event); } catch (error) { debugLog("subagent workload listener", error); }
  }
}
/** Synchronous native ownership, not evidence inferred from persisted status rows. */
export function getSubagentWorkload(parent: SubagentWorkload["parent"]): SubagentWorkload | undefined {
  const owner = registry().owners.get(parent.sessionId);
  return owner?.parent.sessionFile === parent.sessionFile ? snapshot(owner) : undefined;
}
export function subscribeSubagentWorkloads(listener: (event: SubagentWorkloadEvent) => void): () => void {
  registry().listeners.add(listener);
  return () => { registry().listeners.delete(listener); };
}
/** @internal The native manager and notifier are the only producers. */
export function registerSubagentWorkload(parent: SubagentWorkload["parent"], read: Owner["read"]) {
  const owners = registry().owners;
  if (owners.has(parent.sessionId)) throw new Error("Subagent workload is already registered");
  const owner = { parent: { ...parent }, read, sourceId: randomUUID(), revision: 0 };
  owners.set(parent.sessionId, owner);
  emit("registered", owner);
  return {
    changed() { if (owners.get(parent.sessionId) === owner) { owner.revision++; emit("changed", owner); } },
    dispose() { if (owners.get(parent.sessionId) === owner) { owners.delete(parent.sessionId); owner.revision++; emit("deregistered", owner); } },
  };
}
