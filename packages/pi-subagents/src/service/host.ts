import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionFactoryIO } from "#src/lifecycle/create-subagent-session";
import { debugLog } from "#src/debug";

export { getSubagentWorkload, subscribeSubagentWorkloads, type SubagentWorkload, type SubagentWorkloadEvent } from "./workload";
export { buildAgentPrompt } from "#src/session/prompts";
export { inheritRegisteredProviders } from "#src/session/provider-inheritance";
export type { SessionFactoryIO, CreateSessionOptions, ResourceLoaderOptions } from "#src/lifecycle/create-subagent-session";
/** Signature for hosts verifying dynamically loaded native factory source. */
export type SubagentSessionFactory = typeof import("#src/lifecycle/create-subagent-session").createSubagentSession;

export interface ChildSessionIdentity {
  parentSessionId: string;
  runId: string;
  childSessionId: string;
}

/** Native events, not record snapshots. Transport consumers own serialization and byte budgets. */
export interface ChildSessionEvent extends ChildSessionIdentity {
  sequence: number;
  event: AgentSessionEvent;
}

/** Trusted process-host inputs. The host owns credentials, resource trust and tool operations. */
export interface SubagentHost {
  /** Immutable host-admitted project-agent trust; hosted omission denies project agents. */
  readonly allowProjectAgents?: boolean;
  /** The admitted Pi profile for global agent definitions. */
  readonly agentDir?: string;
  /** Synchronous Core admission fence before scheduling a new or resumed native run. */
  assertAdmission?(): void;
  createSessionFactory(
    input: { parentSessionId: string; runId: string; cwd: string },
    signal: AbortSignal,
  ): Promise<Omit<SessionFactoryIO, "createLoaderSettingsManager"> & Partial<Pick<SessionFactoryIO, "createLoaderSettingsManager">>>;
  /** Must fail if required interceptors did not activate. Runs after binding, before any prompt. */
  admitSession(session: AgentSession, identity: ChildSessionIdentity): void | Promise<void>;
  /** Install ancestry/tool leases before extension binding; released with the child. */
  bindSession?(session: AgentSession, identity: ChildSessionIdentity): () => void;
}

type HostRegistration = {
  host: SubagentHost;
  controller: AbortController;
  listeners: Set<(event: ChildSessionEvent) => void>;
  subscriptions: Set<() => void>;
};
const HOSTS_KEY = Symbol.for("@gotgenes/pi-subagents:hosts.v1");
const REQUIRED_HOSTS_KEY = Symbol.for("@gotgenes/pi-subagents:required-hosts.v1");
function requiredHosts(): Set<object> {
  const root = globalThis as Record<symbol, unknown>;
  return (root[REQUIRED_HOSTS_KEY] ??= new Set()) as Set<object>;
}
export function subagentHostsRequired(): boolean { return requiredHosts().size > 0; }
/** Hosted processes opt out of standalone fallback without storing global session identity. */
export function requireSubagentHosts(): () => void {
  const owner = {};
  requiredHosts().add(owner);
  return () => { requiredHosts().delete(owner); };
}
function hosts(): Map<string, HostRegistration> {
  const root = globalThis as Record<symbol, unknown>;
  return (root[HOSTS_KEY] ??= new Map()) as Map<string, HostRegistration>;
}

/** Duplicate owners fail. Disposal revokes pending creation and detaches all native event listeners. */
export function registerSubagentHost(parentSessionId: string, host: SubagentHost): () => void {
  if (!parentSessionId.trim()) throw new Error("A parent session id is required");
  const registry = hosts();
  if (registry.has(parentSessionId)) throw new Error("Subagent host is already registered for this parent");
  const registration: HostRegistration = {
    host, controller: new AbortController(), listeners: new Set(), subscriptions: new Set(),
  };
  registry.set(parentSessionId, registration);
  return () => {
    if (registry.get(parentSessionId) !== registration) return;
    registry.delete(parentSessionId);
    registration.controller.abort(new Error("Subagent host was retired"));
    for (const unsubscribe of registration.subscriptions) unsubscribe();
    registration.subscriptions.clear();
    registration.listeners.clear();
  };
}

/** Subscriptions belong to this exact host generation and never attach to a replacement. */
export function subscribeChildSessionEvents(
  parentSessionId: string,
  listener: (event: ChildSessionEvent) => void,
): () => void {
  const registration = hosts().get(parentSessionId);
  if (!registration) throw new Error("Subagent host is unavailable");
  registration.listeners.add(listener);
  return () => { registration.listeners.delete(listener); };
}

/** @internal Captured once before asynchronous child creation; never falls back after revocation. */
export function getSubagentHost(parentSessionId: string | undefined) {
  const registration = parentSessionId ? hosts().get(parentSessionId) : undefined;
  if (!registration) {
    if (subagentHostsRequired()) throw new Error("This process requires a registered subagent host for the parent");
    return undefined;
  }
  const assertActive = () => registration.controller.signal.throwIfAborted();
  return {
    host: registration.host,
    signal: registration.controller.signal,
    assertActive,
    observe(session: AgentSession, identity: ChildSessionIdentity): () => void {
      assertActive();
      let sequence = 0;
      const unsubscribe = session.subscribe((event) => {
        if (registration.controller.signal.aborted) return;
        const envelope = { ...identity, sequence: ++sequence, event };
        for (const listener of registration.listeners) {
          try { listener(envelope); } catch (error) { debugLog("subagent host event listener", error); }
        }
      });
      const dispose = () => {
        registration.subscriptions.delete(dispose);
        unsubscribe();
      };
      registration.subscriptions.add(dispose);
      return dispose;
    },
  };
}
