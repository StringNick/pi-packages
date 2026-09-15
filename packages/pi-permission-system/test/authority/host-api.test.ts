import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostChildPermissionEvaluator, registerHostChildSession, registerHostPermissionFactory } from "#src/host-api";
import { getSubagentSessionRegistry } from "#src/authority/subagent-registry";
import { resolvePermissionForwardingTarget } from "#src/authority/permission-forwarding";
import { subscribeSubagentLifecycle, SUBAGENT_CHILD_SESSION_CREATED } from "#src/authority/subagent-lifecycle-events";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const options = { sessionId: "child", cwd: "/workspace", agentName: "worker", tools: ["bash"], projectTrusted: false };
const call = { toolName: "bash", toolCallId: "call", input: { command: "test" } };

function register(factory: Parameters<typeof registerHostPermissionFactory>[1]) {
  const dispose = registerHostPermissionFactory("parent", factory);
  disposers.push(dispose);
  return dispose;
}

describe("host permission authority", () => {
  it("fails without an activated serving parent", () => {
    expect(() => createHostChildPermissionEvaluator("missing", options)).toThrow("unavailable");
  });

  it("passes trusted host inputs unchanged and fences cancellation after native evaluation", async () => {
    const pending = Promise.withResolvers<{ action: "allow" }>();
    const evaluate = vi.fn(() => pending.promise);
    const factory = vi.fn(() => ({ evaluate, dispose: vi.fn() }));
    register(factory);
    const evaluator = createHostChildPermissionEvaluator("parent", options);
    expect(factory).toHaveBeenCalledWith(options);
    const controller = new AbortController();
    const result = evaluator.evaluate(call, controller.signal);
    expect(evaluate).toHaveBeenCalledWith(call, controller.signal);
    controller.abort(new Error("cancelled"));
    pending.resolve({ action: "allow" });
    await expect(result).rejects.toThrow("cancelled");
    evaluator.dispose();
  });

  it("does not accept a late allow after owner revocation even if the same factory is reinstalled", async () => {
    const pending = Promise.withResolvers<{ action: "allow" }>();
    const factory = () => ({ evaluate: () => pending.promise, dispose: vi.fn() });
    const dispose = register(factory);
    const evaluator = createHostChildPermissionEvaluator("parent", options);
    const result = evaluator.evaluate(call, new AbortController().signal);
    dispose();
    register(factory);
    dispose();
    pending.resolve({ action: "allow" });
    await expect(result).rejects.toThrow("replaced");
    const replacement = createHostChildPermissionEvaluator("parent", options);
    await expect(replacement.evaluate(call, new AbortController().signal)).resolves.toEqual({ action: "allow" });
    replacement.dispose();
    evaluator.dispose();
  });

  it("revokes a disposed evaluator and releases it once", async () => {
    const dispose = vi.fn();
    const evaluate = vi.fn(async () => ({ action: "allow" as const }));
    register(() => ({ evaluate, dispose }));
    const evaluator = createHostChildPermissionEvaluator("parent", options);
    evaluator.dispose();
    evaluator.dispose();
    await expect(evaluator.evaluate(call, new AbortController().signal)).rejects.toThrow("replaced");
    expect(dispose).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("host ancestry", () => {
  it("preserves the serving root across a native child announcement", () => {
    const registry = getSubagentSessionRegistry();
    const release = registerHostChildSession("child", "genealogy", { sessionId: "serving", remote: true });
    disposers.push(release);
    const handlers = new Map<string, (data: unknown) => void>();
    const unsubscribe = subscribeSubagentLifecycle({ on(channel, listener) { handlers.set(channel, listener); return () => { handlers.delete(channel); }; } }, registry, { auditBoundChild: vi.fn() });
    disposers.push(unsubscribe);
    handlers.get(SUBAGENT_CHILD_SESSION_CREATED)?.({ sessionId: "child", parentSessionId: "genealogy" });
    expect(resolvePermissionForwardingTarget({ isSubagent: true, currentSessionId: "child", sessionId: "child", registry, env: {} })).toEqual({ sessionId: "serving", source: "host-remote" });
    release();
    expect(registry.get("child")).toBeUndefined();
  });

  it("a stale ancestry disposer cannot delete a replacement", () => {
    const registry = getSubagentSessionRegistry();
    const release = registerHostChildSession("child", "first");
    release();
    const replacement = registerHostChildSession("child", "second");
    disposers.push(replacement);
    release();
    expect(registry.get("child")).toEqual({ parentSessionId: "second" });
  });
});
