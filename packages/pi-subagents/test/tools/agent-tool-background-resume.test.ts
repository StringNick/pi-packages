import { afterEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { type ResumeAdmission, SubagentManager } from "#src/lifecycle/subagent-manager";
import { AgentTool } from "#src/tools/agent-tool";
import { createToolDeps, mockResumeRefusal } from "#test/helpers/make-deps";
import { createSessionFactory } from "#test/helpers/manager-stubs";
import { STUB_CTX, STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

const managers: SubagentManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose();
});

async function createResumableTool(wasBackground = false) {
	const deps = createToolDeps();
	const { factory, stub } = createSessionFactory();
	const manager = new SubagentManager({
		createSubagentSession: factory,
		limiter: new ConcurrencyLimiter(() => 4),
		baseCwd: "/test",
		registry: deps.registry,
	});
	managers.push(manager);
	const options = { description: "Original investigation" };
	const record = wasBackground
		? manager.getRecord(manager.spawn(STUB_SNAPSHOT, "Explore", "Investigate", {
			...options, background: { kind: "explicit", isBackground: true },
		}))
		: await manager.spawnAndWait(STUB_SNAPSHOT, "Explore", "Investigate", options);
	if (!record) throw new Error("Expected the initial agent record");
	await record.promise;
	record.markConsumed();
	const tool = new AgentTool(manager, deps.runtime, deps.settings, deps.registry, deps.agentDir);
	return { tool, manager, record, stub, runtime: deps.runtime };
}

describe("AgentTool background resume", () => {
	it.each([false, true])("ACKs a previously background=%s child without waiting, claiming, or consuming", async (wasBackground) => {
		const { tool, manager, record, stub, runtime } = await createResumableTool(wasBackground);
		const completion = Promise.withResolvers<string>();
		stub.resumeTurnLoop.mockReturnValue(completion.promise);
		const admission = vi.spyOn(manager, "startResume");
		const blockingResume = vi.spyOn(manager, "resume");
		const controller = new AbortController();
		const pending = tool.execute("tc-resume", {
			resume: record.id, prompt: "continue", run_in_background: true,
			model: "unavailable/new-model", subagent_type: "general-purpose", description: "Changed description",
		}, controller.signal, undefined, STUB_CTX);

		try {
			expect(blockingResume).not.toHaveBeenCalled();
			expect(admission).toHaveBeenCalledExactlyOnceWith(record.id, "continue", { claimOutcome: false });
			const ack = await pending;
			expect(ack.content[0].text).toBe(
				"Agent resume accepted in background.\n" +
				`Agent ID: ${record.id}\n` +
				"Type: Explore\n" +
				"Description: Original investigation\n\n" +
				"Continue independent work, or end your current turn if nothing else needs doing. Ending the turn does not mean the delegated task is complete.\n" +
				"Results and questions will be pushed automatically; do not poll or call get_subagent_result just to wait.\n" +
				"Use get_subagent_result only for full output beyond the pushed result, truncated-output recovery, a transcript (verbose: true), or diagnostics. Use steer_subagent for mid-run messages.\n" +
				"Do not duplicate this agent's work.",
			);
			expect(ack.details).toEqual({
				displayName: "Explore", subagentType: "Explore", description: "Original investigation",
				toolUses: 0, tokens: "", durationMs: 0, status: "background", agentId: record.id,
			});
			expect(record.executionPending).toBe(true);
			expect(record.claimed).toBe(false);
			expect(record.consumed).toBe(false);
			expect(runtime.buildSnapshot).not.toHaveBeenCalled();
			expect(runtime.getModelInfo).not.toHaveBeenCalled();

			// Ending/cancelling this tool's turn must not cancel admitted background work.
			controller.abort();
			expect(record.status).toBe("running");
			completion.resolve("Resumed output.");
			await record.promise;
			expect(record.result).toBe("Resumed output.");
			expect(record.claimed).toBe(false);
			expect(record.consumed).toBe(false);
		} finally {
			completion.resolve("Resumed output.");
			await pending;
			await record.promise;
		}
	});

	it("does not turn an immediately settled run into an outcome-bearing ACK", async () => {
		const { tool, record, stub } = await createResumableTool();
		stub.resumeTurnLoop.mockResolvedValue("Quick resumed result.");

		const ack = await tool.execute("tc-resume", {
			resume: record.id, prompt: "continue", run_in_background: true,
		}, undefined, undefined, STUB_CTX);
		await record.promise;

		expect(ack.content[0].text.split("\n")[0]).toBe("Agent resume accepted in background.");
		expect(ack.content[0].text).not.toContain("Quick resumed result.");
		expect(ack.details?.status).toBe("background");
		expect(record.consumed).toBe(false);
	});

	it("leaves a later resume failure available for pushed delivery", async () => {
		const { tool, manager, record, stub } = await createResumableTool();
		const completion = Promise.withResolvers<string>();
		stub.resumeTurnLoop.mockReturnValue(completion.promise);
		const blockingResume = vi.spyOn(manager, "resume");
		const pending = tool.execute("tc-resume", {
			resume: record.id, prompt: "continue", run_in_background: true,
		}, undefined, undefined, STUB_CTX);

		try {
			expect(blockingResume).not.toHaveBeenCalled();
			const ack = await pending;
			expect(ack.details?.status).toBe("background");
			completion.reject(new Error("Resume failed later"));
			await record.promise;
			expect(record.status).toBe("error");
			expect(record.error).toBe("Resume failed later");
			expect(record.claimed).toBe(false);
			expect(record.consumed).toBe(false);
		} finally {
			completion.resolve("Cleanup");
			await pending;
			await record.promise;
		}
	});

	it("refuses an already-cancelled tool call before native admission", async () => {
		const { tool, manager, record, stub } = await createResumableTool();
		const admission = vi.spyOn(manager, "startResume");

		await expect(tool.execute("tc-resume", {
			resume: record.id, prompt: "continue", run_in_background: true,
		}, AbortSignal.abort(new Error("Cancelled")), undefined, STUB_CTX)).rejects.toThrow("Cancelled");

		expect(admission).not.toHaveBeenCalled();
		expect(stub.resumeTurnLoop).not.toHaveBeenCalled();
	});

	describe("refused admission", () => {
		it.each(["unknown-agent", "still-running", "no-session", "workspace-disposed"] as const)(
			"uses the same refusal wording as foreground for %s", async (reason) => {
				const deps = createToolDeps();
				mockResumeRefusal(deps, reason);
				const admission = vi.fn((): ResumeAdmission => ({ kind: "refused", reason }));
				const tool = new AgentTool({ ...deps.manager, startResume: admission }, deps.runtime, deps.settings, deps.registry, deps.agentDir);
				const params = { resume: "agent-1", prompt: "continue" };

				const foreground = await tool.execute("tc-fg", params, undefined, undefined, STUB_CTX);
				const background = await tool.execute("tc-bg", { ...params, run_in_background: true }, undefined, undefined, STUB_CTX);

				expect(background).toEqual(foreground);
				expect(admission).toHaveBeenCalledExactlyOnceWith("agent-1", "continue", { claimOutcome: false });
				expect(deps.manager.resume).toHaveBeenCalledTimes(1);
			},
		);
	});
});

describe("AgentTool foreground resume", () => {
	it.each([false, undefined])("keeps run_in_background=%s on the awaited outcome path", async (background) => {
		const { tool, manager, record, stub } = await createResumableTool(true);
		const completion = Promise.withResolvers<string>();
		stub.resumeTurnLoop.mockReturnValue(completion.promise);
		const blockingResume = vi.spyOn(manager, "resume");
		const controller = new AbortController();
		const pending = tool.execute("tc-resume", {
			resume: record.id, prompt: "continue", run_in_background: background,
		}, controller.signal, undefined, STUB_CTX);

		try {
			expect(blockingResume).toHaveBeenCalledExactlyOnceWith(record.id, "continue", {
				signal: controller.signal, claimOutcome: true,
			});
			expect(record.executionPending).toBe(true);
			expect(record.claimed).toBe(true);
			completion.resolve("Foreground resumed result.");
			const result = await pending;
			expect(result.content[0].text).toBe(`Agent ID: ${record.id}\n\nForeground resumed result.`);
			expect(record.consumed).toBe(true);
		} finally {
			completion.resolve("Foreground resumed result.");
			await pending;
			await record.promise;
		}
	});
});
