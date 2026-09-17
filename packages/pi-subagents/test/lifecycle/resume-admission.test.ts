import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { NotificationManager } from "#src/observation/notification";
import { createSessionFactory } from "#test/helpers/manager-stubs";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

const managers: SubagentManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.dispose(); });
async function fixture() {
  const { factory, stub } = createSessionFactory();
  const resumed = vi.fn(); const settled = vi.fn(); const admission = vi.fn();
  const manager = new SubagentManager({
    createSubagentSession: factory, limiter: new ConcurrencyLimiter(() => 1), baseCwd: "/test",
    registry: new AgentTypeRegistry(() => new Map()), assertAdmission: admission,
    observer: { onSubagentStarted() {}, onSubagentCreated() {}, onSubagentCompleted() {}, onSubagentResuming() {}, onSubagentResumed: resumed, onSubagentCompacted() {}, onSubagentExecutionSettled: settled },
  });
  managers.push(manager);
  const record = await manager.spawnAndWait(STUB_SNAPSHOT, "worker", "initial", { description: "initial" });
  await record.promise;
  resumed.mockClear(); settled.mockClear();
  return { manager, stub, record, resumed, settled, admission };
}
it("ACKs one native resumed turn synchronously, refuses duplicates, and stops the same turn", async () => {
  const { manager, stub, record, resumed, settled } = await fixture();
  let finish!: (value: string) => void;
  stub.resumeTurnLoop.mockImplementation((_prompt, signal) => new Promise<string>((resolve) => {
    finish = resolve;
    signal?.addEventListener("abort", () => resolve("partial"), { once: true });
  }));
  expect(manager.startResume(record.id, "answer").kind).toBe("started");
  expect(record.executionPending).toBe(true);
  expect(resumed).not.toHaveBeenCalled();
  expect(manager.startResume(record.id, "duplicate")).toEqual({ kind: "refused", reason: "still-running" });
  expect(manager.abort(record.id)).toBe(true);
  await record.promise;
  expect(record.status).toBe("stopped");
  expect(record.executionPending).toBe(false);
  expect(resumed).toHaveBeenCalledOnce(); expect(settled).toHaveBeenCalledOnce();
  finish("already settled");
});
it("awaited resume waits for the same native completion and preserves refusals", async () => {
  const { manager, stub, record } = await fixture();
  let finish!: (value: string) => void;
  stub.resumeTurnLoop.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
  const done = vi.fn(); const pending = manager.resume(record.id, "answer").then(done);
  await Promise.resolve(); expect(done).not.toHaveBeenCalled();
  finish("native result"); await pending;
  expect(done).toHaveBeenCalledWith({ kind: "resumed", record });
  expect(record.result).toBe("native result");
  await expect(manager.resume("unknown", "answer")).resolves.toEqual({ kind: "refused", reason: "unknown-agent" });
});
it("fails admission/cancelled requests before executing and owns setup failure cleanup", async () => {
  const { manager, stub, record, admission } = await fixture();
  admission.mockImplementationOnce(() => { throw new Error("Parent replacement pending"); });
  expect(() => manager.startResume(record.id, "late")).toThrow("replacement pending");
  expect(() => manager.startResume(record.id, "cancelled", { signal: AbortSignal.abort() })).toThrow();
  expect(stub.resumeTurnLoop).not.toHaveBeenCalled();
  stub.resumeTurnLoop.mockRejectedValueOnce(new Error("setup failed"));
  expect(manager.startResume(record.id, "fails").kind).toBe("started");
  await record.promise;
  expect(record.status).toBe("error"); expect(record.executionPending).toBe(false);
});
it("keeps interrupted execution and eviction teardown owned until each actually settles", async () => {
  const { manager, stub, record } = await fixture();
  let finish!: (value: string) => void;
  stub.resumeTurnLoop.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
  manager.startResume(record.id, "answer"); manager.abort(record.id);
  await manager.evictTerminalSessions();
  expect(manager.getRecord(record.id)).toBe(record);
  finish("partial"); await record.promise;
  let finishDispose!: () => void;
  stub.dispose.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDispose = resolve; }));
  const evicting = manager.evictTerminalSessions();
  // Durable: eviction drops the session, never the record.
  expect(manager.getRecord(record.id)).toBe(record);
  expect(manager.pendingCleanup).toBe(true);
  const disposed = vi.fn(); const disposal = manager.dispose().then(disposed);
  await Promise.resolve(); expect(disposed).not.toHaveBeenCalled();
  finishDispose(); await evicting; await disposal;
  expect(manager.pendingCleanup).toBe(false);
});

describe("resume outcome ownership", () => {
  it.each([false, undefined])("allows pushed delivery after a foreground run with claimOutcome=%s", async (claimOutcome) => {
    const { manager, stub, record, resumed } = await fixture();
    record.markConsumed();
    expect(record.claimed).toBe(true);
    const sendMessage = vi.fn();
    const notifications = new NotificationManager(sendMessage);
    resumed.mockImplementation((agent) => notifications.sendCompletion(agent));
    stub.resumeTurnLoop.mockResolvedValue("Background answer.");

    try {
      expect(manager.startResume(record.id, "continue", { claimOutcome })).toEqual({ kind: "started", record });
      expect(record.claimed).toBe(false);
      expect(record.consumed).toBe(false);
      await record.promise;

      expect(sendMessage).toHaveBeenCalledOnce();
      // Notification envelope and metrics are owned elsewhere; this pins actual delivery of this run's result.
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("Background answer.") }),
        expect.anything(),
      );
    } finally {
      notifications.dispose();
    }
  });

  it.each([false, true])("preserves an active run's claim=%s when a duplicate admission is refused", async (claimOutcome) => {
    const { manager, stub, record } = await fixture();
    const completion = Promise.withResolvers<string>();
    stub.resumeTurnLoop.mockReturnValue(completion.promise);
    manager.startResume(record.id, "continue", { claimOutcome });

    try {
      expect(manager.startResume(record.id, "duplicate", { claimOutcome: !claimOutcome })).toEqual({
        kind: "refused", reason: "still-running",
      });
      expect(record.claimed).toBe(claimOutcome);
    } finally {
      completion.resolve("Completed");
      await record.promise;
    }
  });
});

it("parent teardown aborts and awaits a resumed turn, then refuses new admission", async () => {
  const { manager, stub, record } = await fixture();
  stub.resumeTurnLoop.mockImplementation((_prompt, signal) => new Promise<string>((resolve) => {
    signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
  }));
  manager.startResume(record.id, "answer");
  await manager.dispose();
  expect(record.executionPending).toBe(false); expect(stub.dispose).toHaveBeenCalled();
  expect(() => manager.startResume(record.id, "late")).toThrow("disposed");
});
