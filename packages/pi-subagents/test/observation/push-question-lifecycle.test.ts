import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { NotificationManager } from "#src/observation/notification";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { createSessionFactory } from "#test/helpers/manager-stubs";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

describe("push questions after actual child settlement", () => {
  it("sends an actionable resume for both initial and resumed runs to an idle parent", async () => {
    const { factory, stub } = createSessionFactory();
    const pendingAtDelivery: boolean[] = [];
    const send = vi.fn<ConstructorParameters<typeof NotificationManager>[0]>(() => {
      pendingAtDelivery.push(manager.listAgents()[0].executionPending);
    });
    const notifications = new NotificationManager(send);
    const manager = new SubagentManager({
      createSubagentSession: factory,
      limiter: new ConcurrencyLimiter(() => 1),
      baseCwd: "/test",
      registry: new AgentTypeRegistry(() => new Map()),
      observer: new SubagentEventsObserver({
        emit: () => {},
        appendEntry: () => {},
        notifications,
      }),
    });
    onTestFinished(async () => {
      notifications.dispose();
      await manager.dispose();
    });
    stub.runTurnLoop.mockImplementation(async () => {
      factory.mock.calls[0][0].askParent?.("Which branch?");
      return { responseText: "Need clarification.", aborted: false, steered: false };
    });
    const id = manager.spawn(STUB_SNAPSHOT, "worker", "investigate", {
      description: "Question child",
      background: { kind: "explicit", isBackground: true },
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].content).toContain(`resume: "${id}", run_in_background: true`);
    expect(send.mock.calls[0][0].content).toContain("Which branch?");
    expect(send.mock.calls[0][0].content).not.toContain("cannot be resumed yet");
    expect(pendingAtDelivery).toEqual([false]);

    stub.resumeTurnLoop.mockImplementation(async () => {
      factory.mock.calls[0][0].askParent?.("Which test target?");
      return "One more clarification.";
    });
    expect(manager.startResume(id, "Use the current branch").kind).toBe("started");
    await record.promise;

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].content).toContain(`resume: "${id}", run_in_background: true`);
    expect(send.mock.calls[1][0].content).toContain("Which test target?");
    expect(pendingAtDelivery).toEqual([false, false]);
  });
});
