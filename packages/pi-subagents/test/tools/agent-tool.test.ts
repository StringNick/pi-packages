import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENTS, DEFAULT_AGENT_NAMES } from "#src/config/default-agents";
import { AgentTool } from "#src/tools/agent-tool";
import {
	createToolDeps,
	createToolDepsWithDisabledBuiltInAgents,
	mockResumeRecord,
	mockResumeRefusal,
} from "#test/helpers/make-deps";
import { createTestSubagent } from "#test/helpers/make-subagent";

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		ui: { fake: true },
		...overrides,
	} as unknown as ExtensionContext;
}

function makeTool(deps: ReturnType<typeof createToolDeps>) {
	return new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir);
}

async function execute(
	deps: ReturnType<typeof createToolDeps>,
	params: Record<string, unknown>,
	ctx?: ReturnType<typeof makeCtx>,
) {
	return makeTool(deps).execute(
		"tc-1",
		params,
		new AbortController().signal,
		vi.fn(),
		ctx ?? makeCtx(),
	);
}

describe("AgentTool", () => {
	it.each([true, false])("refreshes defaults before resolving a background=%s launch", async (background) => {
		for (const next of [12, undefined]) {
			const deps = createToolDeps();
			let turns: number | undefined = 7;
			deps.settings = {
				get defaultMaxTurns() { return turns; },
				maxConcurrent: 4,
				refresh() { turns = next; },
			};
			await execute(deps, {
				prompt: "test", description: "test", subagent_type: "worker",
				run_in_background: background,
			});
			const spawn = background ? deps.manager.spawn : deps.manager.spawnAndWait;
			expect(spawn).toHaveBeenCalledWith(expect.anything(), "worker", "test",
				expect.objectContaining({ maxTurns: next }));
		}
	});
	it("returns tool definition with correct name and label", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.name).toBe("subagent");
		expect(def.label).toBe("Subagent");
	});

	it("includes promptSnippet", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.promptSnippet).toBe(
			"Delegate independent work in background; create with prompt, subagent_type, and description, or continue with resume and prompt.",
		);
	});

	it("advertises async-first delegation without polling in prompt guidelines", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.promptGuidelines).toEqual([
			"Use subagent only when a bounded specialist task or useful parallel work justifies delegation; keep simple work and overall planning in the parent.",
			"Prefer subagent with run_in_background: true for independent delegation, including resumes; results and questions are pushed automatically. Use foreground only when the result is needed before your next step.",
			"Do not use get_subagent_result to poll or reflexively wait for subagent work; reserve it for full output, truncated-output recovery, transcript inspection, or diagnostics.",
		]);
	});

	it("describes background resume and the unchanged foreground defaults", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.description).toContain(
			'{"resume":"<agent ID returned earlier>","prompt":"Continue the investigation and verify the fix.","run_in_background":true}',
		);
		expect(def.description).toContain(
			"On resume, run_in_background: true returns an admission acknowledgement, not an outcome; false or omitted waits for the resumed outcome.",
		);
		expect(def.description).toContain("continue independent work or end your current turn");
		expect(def.parameters.properties.run_in_background.description).toBe(
			"Prefer true for independent delegation, including resumes: return an agent ID immediately, with results and questions pushed automatically. False waits for the outcome. When omitted, new agents use their type's default; resumes stay foreground.",
		);
	});

	it("derives type list from registry — includes default agents in description", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		for (const [name, config] of DEFAULT_AGENTS) {
			expect(def.description).toContain(`- ${name}: ${config.description}`);
		}
		expect(def.description).not.toContain("- Plan:");
		expect(def.parameters.properties.subagent_type.description).toContain(DEFAULT_AGENT_NAMES.join(", "));
	});

	it("lists the built-in agent guidelines in registry order", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		const guidelines = [...DEFAULT_AGENTS.values()].map((config) => config.toolGuideline!);
		for (const line of guidelines) expect(def.description).toContain(line);
		const positions = guidelines.map((line) => def.description.indexOf(line));
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it.for([...DEFAULT_AGENT_NAMES])(
		"omits the type-list entry and guideline for a disabled built-in %s",
		(name) => {
			const def = makeTool(createToolDepsWithDisabledBuiltInAgents(name)).toToolDefinition();
			expect(def.description).not.toContain(`- ${name}:`);
			expect(def.description).not.toContain(DEFAULT_AGENTS.get(name)!.toolGuideline);
		},
	);

	it("states task ownership and evidence-based integration without a mandatory pipeline", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.description).toContain("no mandatory specialist pipeline");
		expect(def.description).toContain("self-contained task");
		expect(def.description).toContain("disjoint write ownership");
		expect(def.description).toContain("Do not repeat delegated investigation");
		expect(def.description).toContain("inspect material evidence or diffs");
	});

	it("calls registry.reload() on each execute", async () => {
		const deps = createToolDeps();
		const reloadSpy = vi.spyOn(deps.registry, "reload");
		await execute(deps, {
			prompt: "test",
			description: "test",
			subagent_type: "worker",
		});
		expect(reloadSpy).toHaveBeenCalledOnce();
		reloadSpy.mockRestore();
	});

});

describe("AgentTool — resume path", () => {
  it("accepts only a resume id and prompt and keeps retained type and description", async () => {
    const deps = createToolDeps();
    mockResumeRecord(deps, { type: "explore", description: "Original investigation", result: "Resumed." });
    const def = makeTool(deps).toToolDefinition();
    expect(def.parameters.required).not.toContain("subagent_type");
    expect(def.parameters.required).not.toContain("description");
    const result = await execute(deps, { resume: "agent-1", prompt: "continue", model: "unavailable/new-model" });
    expect(result.content[0].text).toContain("Resumed.");
    expect(result.details).toMatchObject({ subagentType: "explore", description: "Original investigation" });
    expect(deps.runtime.buildSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [{ prompt: "new task" }, "subagent_type, description"],
    [{ prompt: "new task", description: "Inspect session startup" }, "subagent_type"],
    [{ prompt: "new task", subagent_type: "explore" }, "description"],
    [{ prompt: "new task", subagent_type: " ", description: "" }, "subagent_type, description"],
    [{ prompt: "new task", subagent_type: null, description: 42 }, "subagent_type, description"],
  ])("rejects invalid new-agent identity before any work: %j", async (params, fields) => {
    const deps = createToolDeps();
    await expect(execute(deps, params)).rejects.toThrow(
      `Agent was not started. Missing, blank, or invalid required fields: ${fields}.`,
    );
    expect(deps.manager.spawnAndWait).not.toHaveBeenCalled();
    expect(deps.manager.spawn).not.toHaveBeenCalled();
    expect(deps.manager.resume).not.toHaveBeenCalled();
    expect(deps.runtime.buildSnapshot).not.toHaveBeenCalled();
  });

  it("provides a valid new-agent example and distinguishes resume in the error", async () => {
    const deps = createToolDeps();
    await expect(execute(deps, { prompt: "new task" })).rejects.toThrow(
      'Example: {"subagent_type":"explore","description":"Locate request validation","prompt":"Locate request validation and report the relevant paths and evidence. Do not edit files.","run_in_background":true}',
    );
    await expect(execute(deps, { prompt: "new task" })).rejects.toThrow(
      "To continue an existing agent, provide resume (an agent ID returned earlier) and prompt.",
    );
  });

	describe("refused", () => {
		it("names an id no record answers to", async () => {
			const deps = createToolDeps();
			mockResumeRefusal(deps, "unknown-agent");
			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "nonexistent",
			});
			expect(result.content[0].text).toBe(
				'Agent not found: "nonexistent". Records are durable for the parent session\'s life, so it ' +
					"may be from another session or its parent was deleted.",
			);
		});

		it("names a missing session without offering a cleanup story it cannot tell", async () => {
			const deps = createToolDeps();
			mockResumeRefusal(deps, "no-session");
			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});
			expect(result.content[0].text).toBe('Agent "agent-1" has no active session to resume.');
		});

		it("tells the parent to wait out a run that has not finished", async () => {
			const deps = createToolDeps();
			mockResumeRefusal(deps, "still-running");

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			expect(result.content[0].text).toBe(
				'Agent "agent-1" is still running; wait for it to finish before resuming. ' +
					"Use steer_subagent to send it a message while it runs.",
			);
		});

		it("names a torn-down workspace as the reason a resume cannot re-enter it", async () => {
			const deps = createToolDeps();
			mockResumeRefusal(deps, "workspace-disposed");

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			expect(result.content[0].text).toBe(
				'Agent "agent-1" ran in an isolated workspace that no longer exists; resume is ' +
					"unavailable because the agent would re-enter a directory that has been removed. " +
					"Spawn a new agent instead — the agent's result records where any work was saved.",
			);
		});
	});

	describe("accepted", () => {
		it("resumes an agent whose run never had a workspace", async () => {
			const deps = createToolDeps();
			const noWorkspace = createTestSubagent();
			await noWorkspace.run();
			deps.manager.getRecord = vi.fn().mockReturnValue(noWorkspace);
			mockResumeRecord(deps, { result: "Resumed output." });

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			expect(deps.manager.resume).toHaveBeenCalledOnce();
			expect(result.content[0].text).toContain("Resumed output.");
		});

		it("returns result text on successful resume", async () => {
			const deps = createToolDeps();
			mockResumeRecord(deps, { result: "Resumed output." });
			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});
			expect(result.content[0].text).toContain("Resumed output.");
		});

		it("surfaces a follow-up question from a resumed child as answerable", async () => {
			const deps = createToolDeps();
			mockResumeRecord(deps, {
				id: "agent-9",
				result: "Thanks.",
				pendingQuestion: "And the fallback?",
				sessionReady: true,
			});

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			expect(result.content[0].text).toContain("This agent is waiting on an answer:");
			expect(result.content[0].text).toContain("And the fallback?");
			expect(result.content[0].text).toContain('resume: "agent-9"');
		});

		it("reports a resumed child's question with a resume call after its session is evicted", async () => {
			const deps = createToolDeps();
			const answered = mockResumeRecord(deps, {
				id: "agent-9",
				result: "Thanks.",
				pendingQuestion: "And the fallback?",
				sessionReady: true,
				outputFile: "/tmp/parent/tasks/child.jsonl",
			});
			await answered.releaseSession();

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			// Eviction is invisible: the transcript stays on disk and resume rehydrates it.
			expect(result.content[0].text).toContain("And the fallback?");
			expect(result.content[0].text).toContain('resume: "agent-9"');
		});

		it("reports the updates a resumed child sent while the parent was blocked", async () => {
			const deps = createToolDeps();
			mockResumeRecord(deps, { id: "agent-9", runUpdates: ["The bug is in the retry wrapper."] });

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			expect(result.content[0].text).toContain("Updates this agent sent while it worked:");
			expect(result.content[0].text).toContain("The bug is in the retry wrapper.");
		});

		it("names where a teardown saved the work of a resumed child", async () => {
			const deps = createToolDeps();
			mockResumeRecord(deps, {
				id: "agent-9",
				status: "error",
				error: "resume exploded",
				workspaceNotice: "\n\n---\nChanges saved to branch `pi-agent-9`.",
			});

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			expect(result.content[0].text).toContain("Changes saved to branch `pi-agent-9`.");
		});

		it("names an abort on the resume return, which previously reported nothing", async () => {
			const deps = createToolDeps();
			mockResumeRecord(deps, { status: "aborted", result: "Half of it" });

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			expect(result.content[0].text).toContain("aborted \u2014 max turns exceeded, output may be incomplete");
			expect(result.content[0].text).toContain("Half of it");
		});

		it("claims the outcome as it resumes, so the resume is never announced", async () => {
			const deps = createToolDeps();
			mockResumeRecord(deps, { result: "Resumed output." });

			await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			// The claim is the manager's to take, at the one edge it can be taken:
			// resetForResume runs synchronously inside Subagent.resume().
			expect(deps.manager.resume).toHaveBeenCalledWith(
				"agent-1",
				"continue",
				expect.objectContaining({ claimOutcome: true }),
			);
		});

		it("reports a resumed run that failed as the error it carries", async () => {
			const deps = createToolDeps();
			mockResumeRecord(deps, { status: "error", error: "resume exploded" });

			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});

			expect(result.content[0].text).toContain("resume exploded");
		});

		it("marks the resumed record consumed (resume-return delivery edge)", async () => {
			const deps = createToolDeps();
			const resumed = mockResumeRecord(deps, { result: "Resumed output." });
			await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});
			expect(resumed.consumed).toBe(true);
		});

		it("names the agent ID in the resumed result text", async () => {
			const deps = createToolDeps();
			mockResumeRecord(deps, { result: "Resumed output." });
			const result = await execute(deps, {
				prompt: "continue",
				description: "resume",
				subagent_type: "worker",
				resume: "agent-1",
			});
			expect(result.content[0].text).toContain("Agent ID: agent-1");
		});
	});
});

describe("AgentTool — spawn config errors throw", () => {
	it("throws when model resolution fails", async () => {
		const deps = createToolDeps();
		await expect(
			execute(deps, {
				prompt: "test",
				description: "test",
				subagent_type: "worker",
				model: "nonexistent-model-xyz",
			}),
		).rejects.toThrow("nonexistent-model-xyz");
		expect(deps.manager.spawn).not.toHaveBeenCalled();
		expect(deps.manager.spawnAndWait).not.toHaveBeenCalled();
		expect(deps.runtime.buildSnapshot).not.toHaveBeenCalled();
	});

	it("throws an actionable error for an unknown agent type before spawning", async () => {
		const deps = createToolDeps();
		await expect(
			execute(deps, { prompt: "test", description: "test", subagent_type: "unknown-type" }),
		).rejects.toThrow('Unknown agent type "unknown-type". Available types: ');
		expect(deps.manager.spawn).not.toHaveBeenCalled();
		expect(deps.manager.spawnAndWait).not.toHaveBeenCalled();
		expect(deps.runtime.buildSnapshot).not.toHaveBeenCalled();
	});
});

describe("AgentTool — background execution", () => {
	it("returns background launch message with agent ID", async () => {
		const deps = createToolDeps();
		const record = createTestSubagent({ status: "running" });
		deps.manager.getRecord = vi.fn().mockReturnValue(record);
		const result = await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "worker",
			run_in_background: true,
		});
		const text = result.content[0].text;
		expect(text).toContain("background");
		expect(text).toContain("agent-1");
		expect(text).toContain("bg task");
	});

	it("does not emit subagents:created directly — delegated to observer.onSubagentCreated", async () => {
		// The subagents:created event is now emitted by SubagentManagerObserver.onSubagentCreated,
		// called from SubagentManager.spawn(). Tested in subagent-manager.test.ts.
		// This test ensures the tool no longer holds an emitEvent dep for this purpose.
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
		const result = await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "worker",
			run_in_background: true,
		});
		// Background spawn succeeds — no emitEvent dep required
		expect(result.content[0].text).toContain("background");
	});

	it("passes parentSession.toolCallId to manager.spawn", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
		await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "worker",
			run_in_background: true,
		});
		const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
		expect(spawnOpts.parentSession?.toolCallId).toBe("tc-1");
	});
});

describe("AgentTool — foreground execution", () => {
	it("returns completion message with stats", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockResolvedValue(
			createTestSubagent({ result: "Task complete.", toolUses: 5 }),
		);
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "worker",
		});
		const text = result.content[0].text;
		expect(text).toContain("Agent completed");
		expect(text).toContain("Task complete.");
	});

	it("returns error message when agent fails", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockResolvedValue(
			createTestSubagent({ status: "error", error: "Out of context" }),
		);
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "worker",
		});
		expect(result.content[0].text).toContain("Agent failed");
		expect(result.content[0].text).toContain("Out of context");
	});

	it("returns error when spawnAndWait throws", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockRejectedValue(new Error("spawn failure"));
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "worker",
		});
		expect(result.content[0].text).toContain("spawn failure");
	});

	it("names the agent ID in the foreground result text", async () => {
		const deps = createToolDeps();
		deps.manager.spawnAndWait = vi.fn().mockResolvedValue(
			createTestSubagent({ result: "Task complete." }),
		);
		const result = await execute(deps, {
			prompt: "do task",
			description: "fg task",
			subagent_type: "worker",
		});
		expect(result.content[0].text).toContain("Agent ID: agent-1");
	});
});
