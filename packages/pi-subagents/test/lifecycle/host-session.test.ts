import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { getSubagentHost, registerSubagentHost, requireSubagentHosts, subscribeChildSessionEvents, type ChildSessionEvent, type SubagentHost } from "#src/service/host";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createFactorySession, createSubagentSessionDeps, createSubagentSessionIO } from "#test/helpers/subagent-session-io";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function arrange(parent = "parent", child = "child") {
  const deps = createSubagentSessionDeps();
  const io = createSubagentSessionIO();
  const session = createFactorySession();
  io.createSession.mockResolvedValue({ session });
  io.createSessionManager().getSessionId.mockReturnValue(child);
  const release = vi.fn();
  const bindSession = vi.fn(() => release);
  const admitSession = vi.fn<SubagentHost["admitSession"]>(() => undefined);
  const host = { createSessionFactory: vi.fn(async () => io), bindSession, admitSession };
  const dispose = registerSubagentHost(parent, host);
  disposers.push(dispose);
  const params = { snapshot: STUB_SNAPSHOT, type: "Explore", runId: `run-${parent}`, parentSession: { parentSessionId: parent, parentSessionFile: "/sessions/parent.jsonl" } };
  return { deps, io, session, params, host, release, dispose };
}

describe("hosted child assembly", () => {
  it("refuses absent hosts in an explicitly hosted process instead of using standalone IO", async () => {
    const release = requireSubagentHosts(); const other = requireSubagentHosts();
    disposers.push(release, other);
    release(); release();
    const deps = createSubagentSessionDeps();
    await expect(createSubagentSession({ snapshot: STUB_SNAPSHOT, type: "Explore", runId: "run", parentSession: { parentSessionId: "missing" } }, deps)).rejects.toThrow("requires a registered subagent host");
    expect(deps.io.createSession).not.toHaveBeenCalled();
    other();
    expect(getSubagentHost("missing")).toBeUndefined();
  });
  it("uses host trust/settings/tools/session construction, then validates admission before prompting", async () => {
    const fixture = arrange();
    const { deps, io, session, params, host } = fixture;
    const sub = await createSubagentSession(params, deps);
    expect(deps.io.createSession).not.toHaveBeenCalled();
    expect(io.createSettingsManager).toHaveBeenCalledWith(STUB_SNAPSHOT.cwd, "/mock/agent-dir");
    expect(io.createResourceLoader).toHaveBeenCalledOnce();
    expect(io.createSession.mock.calls[0][0].tools).toEqual(["read"]);
    expect(host.bindSession.mock.invocationCallOrder[0]).toBeLessThan(session.bindExtensions.mock.invocationCallOrder[0]);
    expect(host.admitSession).toHaveBeenCalledWith(session, { parentSessionId: "parent", runId: "run-parent", childSessionId: "child" });
    expect(host.admitSession.mock.invocationCallOrder[0]).toBeGreaterThan(session.bindExtensions.mock.invocationCallOrder[0]);
    expect(session.prompt).not.toHaveBeenCalled();
    await sub.dispose();
    await sub.dispose();
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("fails a missing mandatory interceptor and releases the unadmitted child", async () => {
    const { params, deps, host, session, release } = arrange();
    host.admitSession.mockImplementation(() => { throw new Error("Required permission interceptor is missing"); });
    await expect(createSubagentSession(params, deps)).rejects.toThrow("Required permission interceptor");
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(deps.lifecycle.bound).not.toHaveBeenCalled();
  });

  it("fences host retirement during asynchronous construction and never falls back to ambient IO", async () => {
    const { params, deps, io, session, dispose } = arrange();
    const pending = Promise.withResolvers<{ session: typeof session }>();
    io.createSession.mockReturnValue(pending.promise);
    const captured = getSubagentHost("parent");
    const started = Promise.withResolvers<void>();
    io.createSession.mockImplementation(() => { started.resolve(); return pending.promise; });
    const creation = createSubagentSession(params, { ...deps, host: captured });
    await started.promise;
    dispose();
    pending.resolve({ session });
    await expect(creation).rejects.toThrow("retired");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(session.bindExtensions).not.toHaveBeenCalled();
    await expect(createSubagentSession(params, { ...deps, host: captured })).rejects.toThrow("retired");
    expect(deps.io.createSession).not.toHaveBeenCalled();
  });

  it("rejects an already-cancelled launch before discovery", async () => {
    const { params, deps } = arrange();
    await expect(createSubagentSession({ ...params, signal: AbortSignal.abort() }, deps)).rejects.toThrow();
    expect(deps.io.detectEnv).not.toHaveBeenCalled();
  });
});

describe("native child event ownership", () => {
  it("correlates real message/tool events for two parents and cleans up on child or host disposal", async () => {
    const first = arrange("first", "child-1");
    const second = arrange("second", "child-2");
    const firstEvents: ChildSessionEvent[] = [];
    const secondEvents: ChildSessionEvent[] = [];
    subscribeChildSessionEvents("first", (event) => firstEvents.push(event));
    subscribeChildSessionEvents("second", (event) => secondEvents.push(event));
    const a = await createSubagentSession(first.params, first.deps);
    const b = await createSubagentSession(second.params, second.deps);
    const tool: AgentSessionEvent = { type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "file" } };
    first.session.emit(tool);
    const message: AgentSessionEvent = { type: "message_start", message: { role: "user", content: "native content", timestamp: 1 } };
    second.session.emit(message);
    expect(firstEvents).toEqual([{ parentSessionId: "first", runId: "run-first", childSessionId: "child-1", sequence: 1, event: tool }]);
    expect(secondEvents).toEqual([{ parentSessionId: "second", runId: "run-second", childSessionId: "child-2", sequence: 1, event: message }]);
    await a.dispose();
    first.session.emit(tool);
    second.dispose();
    expect(second.session.abort).toHaveBeenCalledOnce();
    second.session.emit(message);
    expect(firstEvents).toHaveLength(1);
    expect(secondEvents).toHaveLength(1);
    await b.dispose();
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
  });

  it("keeps stale disposal and subscription handles off a replacement owner", () => {
    const first = arrange();
    expect(() => registerSubagentHost("parent", first.host)).toThrow("already registered");
    first.dispose();
    const second = arrange();
    first.dispose();
    expect(getSubagentHost("parent")?.host).toBe(second.host);
  });
});
