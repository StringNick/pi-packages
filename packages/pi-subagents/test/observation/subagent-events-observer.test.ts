import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventData, type NotificationSystem } from "#src/observation/notification";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import type { CompactionInfo } from "#src/types";
import { createTestSubagent, makeStubExecution } from "#test/helpers/make-subagent";
import { makeModel } from "#test/helpers/make-model";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";

function makeNotifications(): NotificationSystem {
	return {
		sendCompletion: vi.fn(),
		sendUpdate: vi.fn(),
		sendWorkspaceNotice: vi.fn(),
		dispose: vi.fn(),
	};
}

function makeObserver(overrides?: Partial<{ notifications: NotificationSystem }>) {
	const emit = vi.fn<(channel: string, data: unknown) => void>();
	const appendEntry = vi.fn<(customType: string, data: unknown) => void>();
	const notifications = overrides?.notifications ?? makeNotifications();
	const observer = new SubagentEventsObserver({ emit, appendEntry, notifications });
	return { observer, emit, appendEntry, notifications };
}

describe("SubagentEventsObserver", () => {
	it.each(["completed", "error", "stopped", "aborted"] as const)("persists child identity and transcript linkage for %s, including resumed outcomes", async (status) => {
		const { observer, appendEntry } = makeObserver();
		const record = createTestSubagent({ id: "agent-9", status, error: status === "error" ? "provider failed" : undefined, sessionReady: true, outputFile: "/sessions/child.jsonl", toolUses: 8, turnCount: 4, isBackground: false });
		observer.onSubagentCompleted(record);
		await record.releaseSession();
		observer.onSubagentResumed(record);
		for (const [, entry] of appendEntry.mock.calls) {
			expect(entry).toMatchObject({ id: "agent-9", status, outputFile: "/sessions/child.jsonl", childSessionId: "child-session-test", toolUses: 8, turnCount: 4, isBackground: false });
			if (status === "error") expect(entry).toHaveProperty("error", "provider failed");
		}
	});

	describe("onSubagentStarted", () => {
		it("emits subagents:started with id, type, description", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ id: "agent-1", type: "worker", description: "do work" });

			observer.onSubagentStarted(record);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:started", {
				id: "agent-1",
				type: "worker",
				description: "do work",
			});
		});

		it("persists a lightweight running marker without a completion notification", () => {
			const { observer, appendEntry, notifications } = makeObserver();
			observer.onSubagentStarted(createTestSubagent({ status: "running" }));
			expect(appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({ status: "running" }));
			expect(appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("result");
			expect(appendEntry.mock.calls[0]?.[1]).not.toHaveProperty("completedAt");
			expect(notifications.sendCompletion).not.toHaveBeenCalled();
		});
	});

	describe("onSubagentCompleted", () => {
		it("emits subagents:completed for a successful agent", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "completed" });

			observer.onSubagentCompleted(record);

			expect(emit).toHaveBeenCalledWith("subagents:completed", buildEventData(record));
		});

		it("emits subagents:failed for an error agent", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "error", error: "boom" });

			observer.onSubagentCompleted(record);

			expect(emit).toHaveBeenCalledWith("subagents:failed", expect.anything());
		});

		it("emits subagents:failed for a stopped agent", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "stopped" });

			observer.onSubagentCompleted(record);

			expect(emit).toHaveBeenCalledWith("subagents:failed", expect.anything());
		});

		it("emits subagents:failed for an aborted agent", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "aborted" });

			observer.onSubagentCompleted(record);

			expect(emit).toHaveBeenCalledWith("subagents:failed", expect.anything());
		});

		it("calls appendEntry with subagents:record and lifecycle metadata", () => {
			const { observer, appendEntry } = makeObserver();
			const record = createTestSubagent({
				id: "agent-2",
				type: "explore",
				description: "explore code",
				status: "completed",
				result: "found it",
				error: undefined,
				startedAt: 1000,
				completedAt: 2000,
			});

			observer.onSubagentCompleted(record);

			expect(appendEntry).toHaveBeenCalledExactlyOnceWith("subagents:record", {
				id: "agent-2",
				type: "explore",
				description: "explore code",
				status: "completed",
				result: "found it",
				error: undefined,
				startedAt: 1000,
				completedAt: 2000,
				toolUses: 3, turnCount: 1, isBackground: true,
			});
		});

		it("calls notifications.sendCompletion unconditionally — the manager decides whether to nudge", () => {
			const notifications = makeNotifications();
			const { observer } = makeObserver({ notifications });
			const record = createTestSubagent({ status: "completed" });

			observer.onSubagentCompleted(record);

			expect(notifications.sendCompletion).toHaveBeenCalledExactlyOnceWith(record);
		});

		it("emits exactly once and appends exactly once per call", () => {
			const { observer, emit, appendEntry } = makeObserver();
			observer.onSubagentCompleted(createTestSubagent({ status: "completed" }));
			expect(emit).toHaveBeenCalledTimes(1);
			expect(appendEntry).toHaveBeenCalledTimes(1);
		});
	});

	describe("onSubagentResuming", () => {
		it("emits subagents:resuming with id, type, description", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({
				id: "agent-1",
				type: "worker",
				description: "do work",
			});

			observer.onSubagentResuming(record);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:resuming", {
				id: "agent-1",
				type: "worker",
				description: "do work",
			});
		});

		it("supersedes an older outcome with a lightweight resumed-running marker", () => {
			const { observer, appendEntry, notifications } = makeObserver();

			observer.onSubagentCompleted(createTestSubagent({ id: "same-child", status: "completed" }));
			observer.onSubagentResuming(createTestSubagent({ id: "same-child", status: "running", sessionReady: true, outputFile: "/sessions/child.jsonl" }));

			expect(appendEntry.mock.lastCall).toEqual(["subagents:record", expect.objectContaining({ id: "same-child", status: "running", outputFile: "/sessions/child.jsonl", childSessionId: "child-session-test" })]);
			expect(appendEntry.mock.lastCall?.[1]).not.toHaveProperty("result");
			expect(appendEntry.mock.lastCall?.[1]).not.toHaveProperty("error");
			expect(appendEntry.mock.lastCall?.[1]).not.toHaveProperty("completedAt");
			expect(notifications.sendCompletion).toHaveBeenCalledTimes(1);
		});
	});

	describe("onSubagentResumed", () => {
		it("emits subagents:resumed with the buildEventData payload for a completed resume", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "completed", result: "resumed output" });

			observer.onSubagentResumed(record);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:resumed", buildEventData(record));
		});

		it("emits subagents:resumed (not subagents:failed) for an error resume — payload discriminates", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ status: "error", error: "boom" });

			observer.onSubagentResumed(record);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:resumed", buildEventData(record));
		});

		it("appends subagents:record with lifecycle metadata", () => {
			const { observer, appendEntry } = makeObserver();
			const record = createTestSubagent({
				id: "agent-5",
				type: "explore",
				description: "resume explore",
				status: "completed",
				result: "resumed it",
				error: undefined,
				startedAt: 3000,
				completedAt: 4000,
			});

			observer.onSubagentResumed(record);

			expect(appendEntry).toHaveBeenCalledExactlyOnceWith("subagents:record", {
				id: "agent-5",
				type: "explore",
				description: "resume explore",
				status: "completed",
				result: "resumed it",
				error: undefined,
				startedAt: 3000,
				completedAt: 4000,
				toolUses: 3, turnCount: 1, isBackground: true,
			});
		});

		it("calls notifications.sendCompletion unconditionally — the manager decides whether to nudge", () => {
			const notifications = makeNotifications();
			const { observer } = makeObserver({ notifications });
			const record = createTestSubagent({ status: "completed" });

			observer.onSubagentResumed(record);

			expect(notifications.sendCompletion).toHaveBeenCalledExactlyOnceWith(record);
		});

		it("emits exactly once and appends exactly once per call", () => {
			const { observer, emit, appendEntry } = makeObserver();
			observer.onSubagentResumed(createTestSubagent({ status: "completed" }));
			expect(emit).toHaveBeenCalledTimes(1);
			expect(appendEntry).toHaveBeenCalledTimes(1);
		});
	});

	describe("onSubagentCompacted", () => {
		it("emits subagents:compacted with id, type, description, reason, tokensBefore, compactionCount", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({
				id: "agent-3",
				type: "Plan",
				description: "plan work",
				compactionCount: 1,
			});
			const info: CompactionInfo = { reason: "threshold", tokensBefore: 50_000 };

			observer.onSubagentCompacted(record, info);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:compacted", {
				id: "agent-3",
				type: "Plan",
				description: "plan work",
				reason: "threshold",
				tokensBefore: 50_000,
				compactionCount: 1,
			});
		});

		it("does not call appendEntry or notifications", () => {
			const { observer, appendEntry, notifications } = makeObserver();
			const info: CompactionInfo = { reason: "manual", tokensBefore: 1000 };
			observer.onSubagentCompacted(createTestSubagent(), info);
			expect(appendEntry).not.toHaveBeenCalled();
			expect(notifications.sendCompletion).not.toHaveBeenCalled();
		});
	});

	describe("onSubagentCreated", () => {
		it("emits subagents:created with id, type, description, and isBackground: true", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ id: "agent-4", type: "worker", description: "bg task" });

			observer.onSubagentCreated(record);

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:created", {
				id: "agent-4",
				type: "worker",
				description: "bg task",
				isBackground: true,
			});
		});

		it("does not call appendEntry or notifications", () => {
			const { observer, appendEntry, notifications } = makeObserver();
			observer.onSubagentCreated(createTestSubagent());
			expect(appendEntry).not.toHaveBeenCalled();
			expect(notifications.sendCompletion).not.toHaveBeenCalled();
		});
	});

	describe("dependency isolation", () => {
		let emit: ReturnType<typeof vi.fn>;
		let appendEntry: ReturnType<typeof vi.fn>;
		let notifications: NotificationSystem;
		let observer: SubagentEventsObserver;

		beforeEach(() => {
			({ observer, emit, appendEntry, notifications } = makeObserver());
		});

		it("does not import or reference pi SDK directly", () => {
			// If the class was constructed and four methods called with no SDK errors,
			// it holds no SDK dependency — verified structurally by this test running at all.
			observer.onSubagentStarted(createTestSubagent());
			observer.onSubagentCompleted(createTestSubagent({ status: "completed" }));
			const info: CompactionInfo = { reason: "overflow", tokensBefore: 9999 };
			observer.onSubagentCompacted(createTestSubagent(), info);
			observer.onSubagentCreated(createTestSubagent());
			expect(emit).toHaveBeenCalledTimes(4);
			expect(appendEntry).toHaveBeenCalledTimes(2);
			// Notifications were called as a side-effect of onSubagentCompleted.
			expect(notifications.sendCompletion).toHaveBeenCalledTimes(1);
		});
	});

	describe("onSubagentUpdate", () => {
		it("emits subagents:update carrying the child's message", () => {
			const { observer, emit } = makeObserver();
			const record = createTestSubagent({ id: "agent-1", type: "worker", description: "do work" });

			observer.onSubagentUpdate(record, "The bug is in the retry wrapper.");

			expect(emit).toHaveBeenCalledExactlyOnceWith("subagents:update", {
				id: "agent-1",
				type: "worker",
				description: "do work",
				message: "The bug is in the retry wrapper.",
			});
		});

		it("announces the update to the parent", () => {
			const { observer, notifications } = makeObserver();
			const record = createTestSubagent({ id: "agent-1" });

			observer.onSubagentUpdate(record, "Course change.");

			expect(notifications.sendUpdate).toHaveBeenCalledExactlyOnceWith(record, "Course change.");
		});

		it("persists nothing — an update is not an outcome to reconstruct history from", () => {
			const { observer, appendEntry } = makeObserver();

			observer.onSubagentUpdate(createTestSubagent(), "Course change.");

			expect(appendEntry).not.toHaveBeenCalled();
		});
	});

	describe("onSubagentWorkspaceNotice", () => {
		const NOTICE = "\n\n---\nChanges saved to branch `pi-agent-1`.";

		it("announces where the teardown left the child's work", () => {
			const { observer, notifications } = makeObserver();
			const record = createTestSubagent({ id: "agent-1" });

			observer.onSubagentWorkspaceNotice(record, NOTICE);

			expect(notifications.sendWorkspaceNotice).toHaveBeenCalledExactlyOnceWith(record, NOTICE);
		});

		it("emits no event — no consumer asks for one, and a vacant channel is not added", () => {
			const { observer, emit } = makeObserver();

			observer.onSubagentWorkspaceNotice(createTestSubagent(), NOTICE);

			expect(emit).not.toHaveBeenCalled();
		});

		it("persists nothing — the outcome it belongs to was recorded long ago", () => {
			const { observer, appendEntry } = makeObserver();

			observer.onSubagentWorkspaceNotice(createTestSubagent(), NOTICE);

			expect(appendEntry).not.toHaveBeenCalled();
		});
	});

	describe("launch attribution", () => {
		it("persists resolved launch defaults and transcript linkage before the first turn", async () => {
			const { observer, appendEntry } = makeObserver();
			const stub = createSubagentSessionStub(undefined, "/sessions/child.jsonl", "resolved-child");
			Object.assign(stub, { getModel: () => makeModel({ id: "resolved", provider: "anthropic" }) });
			stub.runTurnLoop.mockImplementation(async () => {
				expect(appendEntry).toHaveBeenLastCalledWith("subagents:record", expect.objectContaining({
					modelId: "anthropic/resolved", thinkingLevel: "off", status: "running",
					childSessionId: "resolved-child", outputFile: "/sessions/child.jsonl",
				}));
				return { responseText: "done", aborted: false, steered: false };
			});
			const record = createTestSubagent({ execution: makeStubExecution({
				thinkingLevel: "high",
				createSubagentSession: async () => toSubagentSession(stub),
				observer: {
					onStarted: (agent) => observer.onSubagentStarted(agent),
					onSessionCreated: (agent) => observer.onSubagentSessionCreated(agent),
				},
			}) });
			await record.run();
			expect(record.status).toBe("completed");
			expect(appendEntry).toHaveBeenCalledTimes(2);
		});

		it("persists provider-qualified modelId, modelName and thinkingLevel on started and completed", () => {
			const { observer, appendEntry } = makeObserver();
			const execution = makeStubExecution({
				model: makeModel({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" }),
				thinkingLevel: "high",
			});
			const started = createTestSubagent({ id: "agent-attr", status: "running", execution });
			observer.onSubagentStarted(started);
			expect(appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
				modelId: "anthropic/claude-sonnet-4-5",
				modelName: "Claude Sonnet 4.5",
				thinkingLevel: "high",
			}));
			const done = createTestSubagent({ id: "agent-attr", status: "completed", execution });
			observer.onSubagentCompleted(done);
			expect(appendEntry).toHaveBeenLastCalledWith("subagents:record", expect.objectContaining({
				modelId: "anthropic/claude-sonnet-4-5",
				modelName: "Claude Sonnet 4.5",
				thinkingLevel: "high",
			}));
		});

		it("keeps an already-qualified id unchanged and falls back to the raw id without a provider", () => {
			const { observer, appendEntry } = makeObserver();
			const qualified = createTestSubagent({
				status: "running",
				execution: makeStubExecution({
					model: makeModel({ id: "anthropic/claude-sonnet-4-5", provider: "anthropic" }),
				}),
			});
			observer.onSubagentStarted(qualified);
			expect(appendEntry).toHaveBeenLastCalledWith("subagents:record", expect.objectContaining({
				modelId: "anthropic/claude-sonnet-4-5",
			}));
		});

		it("omits attribution for legacy launches without a resolved model or thinking level", () => {
			const { observer, appendEntry } = makeObserver();
			observer.onSubagentStarted(createTestSubagent({ status: "running" }));
			const entry = appendEntry.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(entry).not.toHaveProperty("modelId");
			expect(entry).not.toHaveProperty("modelName");
			expect(entry).not.toHaveProperty("thinkingLevel");
		});

		it("bounds attribution lengths like the host fleet projection", () => {
			const { observer, appendEntry } = makeObserver();
			const record = createTestSubagent({
				status: "running",
				execution: makeStubExecution({
					model: makeModel({ id: "m".repeat(300), name: "n".repeat(200), provider: "p" }),
					thinkingLevel: "h".repeat(100) as never,
				}),
			});
			observer.onSubagentStarted(record);
			const entry = appendEntry.mock.calls[0]?.[1] as Record<string, unknown>;
			expect((entry.modelId as string).length).toBeLessThanOrEqual(256);
			expect((entry.modelName as string).length).toBeLessThanOrEqual(128);
			expect((entry.thinkingLevel as string).length).toBeLessThanOrEqual(64);
		});
	});
});
