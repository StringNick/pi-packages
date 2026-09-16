import { describe, expect, it, vi } from "vitest";
import { NotificationManager } from "#src/observation/notification";
import { createTestSubagent } from "#test/helpers/make-subagent";

function harness() {
  const send = vi.fn<ConstructorParameters<typeof NotificationManager>[0]>();
  const manager = new NotificationManager(send);
  const record = createTestSubagent({
    result: "Complete report.\n" + "evidence ".repeat(150),
    sessionReady: true,
    outputFile: "/sessions/child.jsonl",
  });
  const acknowledge = () => manager.onParentMessageEnd({ role: "custom", ...send.mock.calls[0][0] });
  return { send, manager, record, acknowledge };
}

describe("push-first results", () => {
  it("carries the report and canonical transcript pointer without requiring a pull", () => {
    const { send, manager, record } = harness();
    manager.sendCompletion(record);
    const [message, options] = send.mock.calls[0];
    expect(message.content).toContain(record.result);
    expect(message.content).toContain("<output-file>/sessions/child.jsonl</output-file>");
    expect(message.content).not.toContain("Call get_subagent_result");
    expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  it("bounds a long report and explicitly offers full retrieval", () => {
    const { send, manager } = harness();
    const record = createTestSubagent({ result: "x".repeat(30_000) });
    manager.sendCompletion(record);
    const content = send.mock.calls[0][0].content as string;
    expect(content.length).toBeLessThan(20_000);
    expect(content).toContain("truncated");
    expect(content).toContain("get_subagent_result");
  });

  it("consumes only when Pi delivers the custom message, not when it queues it", () => {
    const { manager, record, acknowledge } = harness();
    manager.sendCompletion(record);
    expect(record.consumed).toBe(false);
    acknowledge();
    expect(record.consumed).toBe(true);
  });

  it("does not send a second copy while the first awaits Pi delivery", () => {
    const { send, manager, record, acknowledge } = harness();
    manager.sendCompletion(record);
    manager.sendCompletion(record);
    acknowledge();
    manager.sendCompletion(record);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not consume a resumed run when Pi delivers an older outcome", () => {
    const { manager, record, acknowledge } = harness();
    manager.sendCompletion(record);
    record.resetForResume(record.startedAt);
    record.markCompleted("New report");
    acknowledge();
    expect(record.consumed).toBe(false);
  });

  it("drops an old completion if the child resumed before the boundary", () => {
    const { send, manager, record } = harness();
    manager.onParentAgentStart();
    manager.sendCompletion(record);
    record.resetForResume(record.startedAt);
    manager.onParentTurnEnd();
    manager.onParentAgentSettled();
    expect(send).not.toHaveBeenCalled();
  });

  it("pushes the new run even when the previous run was already delivered", () => {
    const { send, manager, record, acknowledge } = harness();
    manager.sendCompletion(record);
    acknowledge();
    record.resetForResume(record.startedAt);
    record.markCompleted("Second result");
    manager.sendCompletion(record);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].content).toContain("Second result");
  });

  it("does not consume on sender failure and permits a later delivery", () => {
    const { send, manager, record } = harness();
    send.mockImplementationOnce(() => { throw new Error("sender unavailable"); });
    expect(() => manager.sendCompletion(record)).toThrow("sender unavailable");
    expect(record.consumed).toBe(false);
    manager.sendCompletion(record);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("ignores acknowledgements after shutdown", () => {
    const { manager, record, acknowledge } = harness();
    manager.sendCompletion(record);
    manager.dispose();
    acknowledge();
    expect(record.consumed).toBe(false);
  });

  it("does not treat a replayed or lookalike message as a live delivery", () => {
    const { send, manager, record } = harness();
    manager.sendCompletion(record);
    const message = send.mock.calls[0][0];
    manager.onParentMessageEnd({
      ...message,
      role: "custom",
      details: structuredClone(message.details),
    });
    expect(record.consumed).toBe(false);
  });
});

describe("busy parent safe boundaries", () => {
  it("steers a result into the next model step without waiting for agent_settled", () => {
    const { send, manager, record } = harness();
    manager.onParentAgentStart();
    manager.sendCompletion(record);
    expect(send).not.toHaveBeenCalled();
    expect(manager.pendingDelivery).toBe(true);
    manager.onParentTurnEnd();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(manager.pendingDelivery).toBe(false);
    manager.onParentAgentSettled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("suppresses a result pulled by a tool earlier in the same step", () => {
    const { send, manager, record } = harness();
    manager.onParentAgentStart();
    manager.sendCompletion(record);
    record.markConsumed();
    manager.onParentTurnEnd();
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves claimed results with the waiting carrier", () => {
    const { send, manager, record } = harness();
    manager.onParentAgentStart();
    manager.sendCompletion(record);
    record.claim();
    manager.onParentTurnEnd();
    expect(send).not.toHaveBeenCalled();
  });

  it("delivers questions at the next step with the resume affordance", () => {
    const { send, manager } = harness();
    const record = createTestSubagent({ pendingQuestion: "Which branch?", sessionReady: true });
    manager.onParentAgentStart();
    manager.sendCompletion(record);
    manager.onParentTurnEnd();
    expect(send.mock.calls[0][0].content).toContain("Which branch?");
    expect(send.mock.calls[0][0].content).toContain('resume: "agent-1"');
  });

  it("delivers material updates at the next step while the child continues", () => {
    const { send, manager } = harness();
    const record = createTestSubagent({ status: "running", runUpdates: ["Important finding"] });
    manager.onParentAgentStart();
    manager.sendUpdate(record, "Important finding");
    manager.onParentTurnEnd();
    expect(send.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(record.isActive()).toBe(true);
    expect(record.runUpdates).toEqual([]);
  });

  it("drops updates from an earlier run rather than steering its successor", () => {
    const { send, manager } = harness();
    const record = createTestSubagent({ status: "running", runUpdates: ["Old update"] });
    manager.onParentAgentStart();
    manager.sendUpdate(record, "Old update");
    record.markCompleted("Old result");
    record.resetForResume(record.startedAt);
    manager.onParentTurnEnd();
    expect(send).not.toHaveBeenCalled();
  });
});
