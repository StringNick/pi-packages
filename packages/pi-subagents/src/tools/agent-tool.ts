import type { AgentToolResult, ExtensionContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type {
	AgentSpawnConfig,
	ResumeAdmission,
	ResumeCallOptions,
	ResumeOutcome,
	ResumeRefusalReason,
} from "#src/lifecycle/subagent-manager";
import {
	renderOutcomeAddenda,
	renderOutcomeBody,
	renderStatusNote,
} from "#src/observation/outcome-delivery";
import { spawnBackground } from "#src/tools/background-spawner";
import { runForeground } from "#src/tools/foreground-runner";
import { BACKGROUND_ACK_GUIDANCE, buildAgentGuidelines, buildDetails, buildTypeListText, textResult } from "#src/tools/helpers";
import { renderAgentResult } from "#src/tools/result-renderer";
import { resolveExposeCallerMaxTurns, resolveSessionModelOverride, resolveSessionThinkingOverride } from "#src/tools/session-override";
import { type ModelInfo, resolveSpawnConfig } from "#src/tools/spawn-config";
import type { ParentSessionInfo, Subagent } from "#src/types";
import { type AgentDetails, getDisplayName, type Theme } from "#src/ui/display";
import { GLYPHS } from "#src/ui/glyphs";

const NEW_AGENT_EXAMPLE = '{"subagent_type":"explore","description":"Locate request validation","prompt":"Locate request validation and report the relevant paths and evidence. Do not edit files.","run_in_background":true}';

// ---- Deps interfaces ----

/** Narrow manager interface — only the methods the Agent tool calls. */
export interface AgentToolManager {
	spawn: (snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig) => string;
	spawnAndWait: (snapshot: ParentSnapshot, type: string, prompt: string, opts: Omit<AgentSpawnConfig, "background">) => Promise<Subagent>;
	startResume: (id: string, prompt: string, options: ResumeCallOptions) => ResumeAdmission;
	resume: (id: string, prompt: string, options: ResumeCallOptions) => Promise<ResumeOutcome>;
	getRecord: (id: string) => Subagent | undefined;
}

/** Narrow runtime interface — the Agent tool's slice of SubagentRuntime. */
export interface AgentToolRuntime {
	buildSnapshot(inheritContext: boolean): ParentSnapshot;
	getModelInfo(): ModelInfo;
	getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

/** Narrow settings accessor — only the fields the Agent tool reads. */
export type AgentToolSettings = {
	refresh?(): void;
	readonly defaultMaxTurns: number | undefined;
	readonly maxConcurrent: number;
};

// ---- Class ----

export class AgentTool {
	private readonly typeListText: string;
	private readonly availableTypesText: string;
	private readonly agentGuidelines: string[];

	constructor(
		private readonly manager: AgentToolManager,
		private readonly runtime: AgentToolRuntime,
		private readonly settings: AgentToolSettings,
		private readonly registry: AgentTypeRegistry,
		private readonly agentDir: string,
	) {
		this.typeListText = buildTypeListText(registry, agentDir);
		this.availableTypesText = registry.getAvailableTypes().join(", ");
		this.agentGuidelines = buildAgentGuidelines(registry);
	}

	async execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
		_ctx: ExtensionContext,
	) {
		// Resume uses the retained native session and its original identity. New
		// agent defaults and session model overrides cannot change that session.
		if (params.resume) {
			if (params.run_in_background === true) {
				return this.resumeInBackground(params.resume as string, params.prompt as string, signal);
			}
			return this.resumeExisting(params.resume as string, params.prompt as string, signal);
		}
		const invalidFields = ["subagent_type", "description"].filter((field) => {
			const value = params[field];
			return typeof value !== "string" || !value.trim();
		});
		if (invalidFields.length > 0) {
			// Pi marks thrown tool errors as isError; a text result is a success.
			throw new Error(
				`Agent was not started. Missing, blank, or invalid required fields: ${invalidFields.join(", ")}. ` +
				"For a new agent, provide prompt, subagent_type, and description as non-empty strings. " +
				`Example: ${NEW_AGENT_EXAMPLE}\n` +
				"To continue an existing agent, provide resume (an agent ID returned earlier) and prompt.",
			);
		}
		this.settings.refresh?.();
		// Reload custom agents so new .pi/agents/*.md files are picked up without restart
		this.registry.reload();

		// User choices win over tool arguments while still respecting locks.
		// Reasoning keeps its provenance so only explicit user configuration
		// may raise the parent's effort baseline.
		const sessionModel = resolveSessionModelOverride(
			this.runtime.getSessionInfo().parentSessionId,
			params.subagent_type,
			this.registry,
		);
		const sessionThinking = resolveSessionThinkingOverride(
			this.runtime.getSessionInfo().parentSessionId,
			params.subagent_type,
			this.registry,
		);
		// Hosts may withhold the caller-facing `max_turns` param: the schema omits
		// it, and an undeclared caller value is discarded here so turn limits stay
		// owned by agent definitions and runtime settings.
		const exposeCallerMaxTurns = resolveExposeCallerMaxTurns(
			this.runtime.getSessionInfo().parentSessionId,
		);
		const overrideParams =
			sessionModel !== undefined
				? { ...params, model: sessionModel }
				: params;
		const effectiveParams =
			!exposeCallerMaxTurns && params.max_turns !== undefined
				? { ...overrideParams, max_turns: undefined }
				: overrideParams;

		// ---- Config resolution (pure) ----
		const config = resolveSpawnConfig(
			effectiveParams,
			this.registry,
			this.runtime.getModelInfo(),
			this.settings,
			{ thinking: sessionThinking },
		);
		if ("error" in config) throw new Error(config.error);

		// ---- Boundary extraction (after config so inheritContext is resolved) ----
		const snapshot = this.runtime.buildSnapshot(config.execution.inheritContext);
		const { parentSessionFile, parentSessionId } = this.runtime.getSessionInfo();
		const parentSession: ParentSessionInfo = { parentSessionFile, parentSessionId, toolCallId };

		// ---- Background execution ----
		if (config.execution.runInBackground) {
			return spawnBackground(
				this.manager,
				{ config, snapshot, parentSession, settings: this.settings },
			);
		}

		// ---- Foreground execution — stream progress via onUpdate ----
		return runForeground(
			this.manager,
			{ config, snapshot, parentSession },
			signal,
			onUpdate,
		);
	}

	private resumeInBackground(id: string, prompt: string, signal: AbortSignal | undefined) {
		signal?.throwIfAborted();
		// Like a background spawn, admitted work outlives this tool call's signal.
		// The native manager owns execution and completion delivery; this is only an ACK.
		const admission = this.manager.startResume(id, prompt, { claimOutcome: false });
		if (admission.kind === "refused") {
			return textResult(resumeRefusalMessage(admission.reason, id));
		}
		const record = admission.record;
		const displayName = getDisplayName(record.type, this.registry);
		const details: AgentDetails = {
			displayName,
			subagentType: record.type,
			description: record.description,
			toolUses: 0,
			tokens: "",
			durationMs: 0,
			status: "background",
			agentId: record.id,
		};
		return textResult(
			"Agent resume accepted in background.\n" +
				`Agent ID: ${record.id}\n` +
				`Type: ${displayName}\n` +
				`Description: ${record.description}\n\n` +
				BACKGROUND_ACK_GUIDANCE,
			details,
		);
	}

	/**
	 * Continue an existing agent's session with a new prompt, returning its
	 * resumed outcome directly to the parent.
	 */
	private async resumeExisting(
		id: string,
		prompt: string,
		signal: AbortSignal | undefined,
	) {
		// The manager owns whether a resume happens; this door owns only how the
		// answer is worded. Resuming commits this call to delivering the outcome,
		// so it claims it — nothing else announces what is already being returned.
		const outcome = await this.manager.resume(id, prompt, {
			signal: signal ?? new AbortController().signal,
			claimOutcome: true,
		});
		if (outcome.kind === "refused") {
			return textResult(resumeRefusalMessage(outcome.reason, id));
		}
		const record = outcome.record;
		// Resume-return delivery edge: the resumed outcome is returned directly.
		record.markConsumed();
		return textResult(
			`Agent ID: ${record.id}${renderStatusNote(record.status)}\n\n` +
				renderOutcomeBody(record) +
				renderOutcomeAddenda(record),
			buildDetails({
				displayName: getDisplayName(record.type, this.registry),
				subagentType: record.type,
				description: record.description,
			}, record),
		);
	}

	toToolDefinition() {
		const typeListText = this.typeListText;
		const availableTypesText = this.availableTypesText;
		const agentDir = this.agentDir;
		const registry = this.registry;

		const guidelines = [
			"- Keep simple lookups and small changes local when delegation costs more than it saves. The parent owns planning, integration, and the final answer; there is no mandatory specialist pipeline.",
			"- Prefer run_in_background: true for independent delegation, including resumes. Use foreground only when the result is needed before your next step.",
			...this.agentGuidelines,
			"- Give each agent a self-contained task: objective, relevant paths and evidence, constraints, owned scope, success checks, and a concise expected output. Check that its tools can do the task. Include a stopping condition for open-ended investigation.",
			"- Assign disjoint write ownership to parallel agents, preserve existing edits, and coordinate shared files; a prompt is not workspace isolation. Read-only roles are behavioral contracts, not shell sandboxes.",
			"- Do not repeat delegated investigation while it runs. On completion, inspect material evidence or diffs and verify integration proportional to risk; a confident report is not proof. Resolve conflicts and summarize verified results and gaps for the user.",
			"- After background launch or resume, continue independent work or end your current turn. Ending the turn does not mean the delegated task is complete. Results and questions are pushed automatically; do not poll or reflexively wait.",
			"- Use get_subagent_result only for full output beyond the pushed result, truncated-output recovery, transcript inspection (verbose: true), or diagnostics.",
			"- Use resume with an agent ID and prompt to continue a previous agent's work, or answer its question. Type and description are retained; model, thinking, and other spawn configuration do not change a resumed session.",
			"- Use steer_subagent to send mid-run messages to a running background agent.",
			'- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").',
			"- Reasoning inherits the agent's configured thinking level, or the parent's current level when unset; it cannot be overridden through this tool.",
			"- Unknown or disabled agent types are rejected. Choose an enabled type from the catalog; there is no fallback agent.",
			"- Use inherit_context to copy parent conversation text; tool calls, tool results, and images are not copied.",
		].join("\n");

		return defineTool({
			name: "subagent" as const,
			label: "Subagent",
			promptSnippet: "Delegate independent work in background; create with prompt, subagent_type, and description, or continue with resume and prompt.",
			promptGuidelines: [
				"Use subagent only when a bounded specialist task or useful parallel work justifies delegation; keep simple work and overall planning in the parent.",
				"Prefer subagent with run_in_background: true for independent delegation, including resumes; results and questions are pushed automatically. Use foreground only when the result is needed before your next step.",
				"Do not use get_subagent_result to poll or reflexively wait for subagent work; reserve it for full output, truncated-output recovery, transcript inspection, or diagnostics.",
			],
			description: `Launch a new agent or continue an existing agent's work. Prefer background delegation for independent work.

New agent: provide prompt, subagent_type, and description as non-empty strings. Omit resume.
Example: ${NEW_AGENT_EXAMPLE}

Existing agent: provide resume (an agent ID returned earlier) and prompt. Type and description are retained.
Example: {"resume":"<agent ID returned earlier>","prompt":"Continue the investigation and verify the fix.","run_in_background":true}
On resume, run_in_background: true returns an admission acknowledgement, not an outcome; false or omitted waits for the resumed outcome.

Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
${guidelines}
`,
			parameters: Type.Object({
				prompt: Type.String({
					description: "Required for both new and resumed agents. The task or follow-up instruction; prompt alone cannot create an agent.",
				}),
				description: Type.Optional(Type.String({
					description: "A short (3-5 word) description of the task (shown in UI). Required for new agents; omitted on resume.",
				})),
				subagent_type: Type.Optional(Type.String({
					description: `Required for new agents; omitted on resume, which keeps the original type. Unknown or disabled types are rejected. Available types: ${availableTypesText}. Custom agents from .pi/agents/<name>.md (project) or ${agentDir}/agents/<name>.md (global) are also available.`,
				})),
				model: Type.Optional(
					Type.String({
						description:
							'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default. A user session selection for this agent type wins over this parameter. An agent that locks this field keeps its own model and says so in the result.',
					}),
				),
				...(resolveExposeCallerMaxTurns(this.runtime.getSessionInfo().parentSessionId)
					? {
							max_turns: Type.Optional(
								Type.Number({
									description:
											"Maximum number of agentic turns before stopping. Omit to use the agent's own limit, or unlimited when it declares none.",
										minimum: 1,
									}),
								),
							}
					: {}),
				run_in_background: Type.Optional(
					Type.Boolean({
						description:
							"Prefer true for independent delegation, including resumes: return an agent ID immediately, with results and questions pushed automatically. False waits for the outcome. When omitted, new agents use their type's default; resumes stay foreground.",
					}),
				),
				resume: Type.Optional(
					Type.String({
						description: "Optional agent ID to resume from. Requires only prompt; keeps its existing session, model, type, and description.",
					}),
				),
				inherit_context: Type.Optional(
					Type.Boolean({
						description:
							"If true, copy parent conversation text into the agent (no tool calls, tool results, or images). Omit to use the agent's own default, which is fresh context unless it declares otherwise.",
					}),
				),
			}),

			// ---- Custom rendering: inline subagent results ----

			renderCall(args: Record<string, unknown>, theme: Theme) {
				const displayName = args.subagent_type
					? getDisplayName(args.subagent_type as string, registry)
					: "Subagent";
				const desc = (args.description as string | undefined) ?? "";
				return new Text(
					`${GLYPHS.toolCall} ` +
						theme.fg("toolTitle", theme.bold(displayName)) +
						(desc ? "  " + theme.fg("muted", desc) : ""),
					0,
					0,
				);
			},

			renderResult(
				result: AgentToolResult<AgentDetails | undefined>,
				{ expanded, isPartial }: ToolRenderResultOptions,
				theme: Theme,
			) {
				const details = result.details;
				if (!details) {
					const text = result.content[0]?.type === "text" ? result.content[0].text : "";
					return new Text(text, 0, 0);
				}
				const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(
					renderAgentResult(details, resultText, expanded, isPartial, theme),
					0,
					0,
				);
			},

			execute: (
				toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal | undefined,
				onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
				ctx: ExtensionContext,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}

/**
 * The operator-facing sentence for each reason a resume is refused.
 *
 * Exhaustive over `ResumeRefusalReason`, so a reason added later fails to
 * compile here rather than falling through to an attempted resume.
 */
function resumeRefusalMessage(refusal: ResumeRefusalReason, id: string): string {
	switch (refusal) {
		case "unknown-agent":
			return `Agent not found: "${id}". Records are durable for the parent session's life, so it may be from another session or its parent was deleted.`;
		case "still-running":
			return (
				`Agent "${id}" is still running; wait for it to finish before resuming. ` +
				"Use steer_subagent to send it a message while it runs."
			);
		case "no-session":
			return `Agent "${id}" has no active session to resume.`;
		case "workspace-disposed":
			return (
				`Agent "${id}" ran in an isolated workspace that no longer ` +
				"exists; resume is unavailable because the agent would re-enter a directory that " +
				"has been removed. Spawn a new agent instead — the agent's result records where " +
				"any work was saved."
			);
	}
}
