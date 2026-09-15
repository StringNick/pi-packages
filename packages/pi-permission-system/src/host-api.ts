import { getSubagentSessionRegistry } from "./authority/subagent-registry";

export interface HostChildPermissionOptions {
  sessionId: string;
  cwd: string;
  agentName: string;
  tools: string[];
  projectTrusted: boolean;
}
export interface HostChildPermissionEvaluator {
  evaluate(call: { toolName: string; toolCallId: string; input: unknown }, signal: AbortSignal): Promise<{ action: "allow" } | { action: "block"; reason: string }>;
  dispose(): void;
}
type HostFactory = (options: HostChildPermissionOptions) => HostChildPermissionEvaluator;
const factoryKey = Symbol.for("@gotgenes/pi-permission-system:host-evaluators.v1");
type FactoryOwner = { factory: HostFactory };
function factories(): Map<string, FactoryOwner> {
  const root = globalThis as typeof globalThis & { [factoryKey]?: Map<string, FactoryOwner> };
  return (root[factoryKey] ??= new Map());
}
/** Only a live, Core-admitted native extension publishes an evaluator factory. */
export function registerHostPermissionFactory(sessionId: string, factory: HostFactory): () => void {
  if (factories().has(sessionId)) throw new Error("Permission host is already registered");
  const owner = { factory };
  factories().set(sessionId, owner);
  return () => { if (factories().get(sessionId) === owner) factories().delete(sessionId); };
}
export function createHostChildPermissionEvaluator(servingSessionId: string, options: HostChildPermissionOptions): HostChildPermissionEvaluator {
  const owner = factories().get(servingSessionId);
  if (!owner) throw new Error("Native permission host is unavailable");
  const evaluator = owner.factory(options);
  let disposed = false;
  return {
    async evaluate(call, signal) {
      signal.throwIfAborted();
      if (disposed || factories().get(servingSessionId) !== owner) throw new Error("Native permission host was replaced");
      const result = await evaluator.evaluate(call, signal);
      signal.throwIfAborted();
      if (disposed || factories().get(servingSessionId) !== owner) throw new Error("Native permission host was replaced");
      return result;
    },
    dispose: () => { if (!disposed) { disposed = true; evaluator.dispose(); } },
  };
}

/** Register exact child ancestry before its native session_start handlers run. */
export function registerHostChildSession(childSessionId: string, parentSessionId: string, serving?: { sessionId: string; remote: boolean }): () => void {
  const registry = getSubagentSessionRegistry();
  if (registry.get(childSessionId)) throw new Error("Pi permission child session is already registered");
  const owner = { parentSessionId, ...(serving ? { servingSessionId: serving.sessionId, servingRemote: serving.remote } : {}) };
  registry.register(childSessionId, owner);
  return () => { if (registry.get(childSessionId) === owner) registry.unregister(childSessionId); };
}
