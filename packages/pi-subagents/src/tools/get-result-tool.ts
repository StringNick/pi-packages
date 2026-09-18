import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { formatAgentNotFound } from "#src/tools/agent-id-suggest";
import {
	type GetResultDetails,
	PREVIEW_CHARS,
	renderGetResultLines,
} from "#src/tools/get-result-renderer";
import { type AgentReport, formatAgentReport } from "#src/tools/get-result-report";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import type { Subagent } from "#src/types";
import { BoundedLines } from "#src/ui/bounded-lines";
import { formatDuration, getDisplayName, type Theme } from "#src/ui/display";
import { GLYPHS } from "#src/ui/glyphs";

// ---- Deps interfaces ----

export interface GetResultToolManager {
	getRecord(id: string): Subagent | undefined;
	listAgents(): Subagent[];
}

// ---- Class ----

export class GetResultTool {
	constructor(
		private readonly manager: GetResultToolManager,
		private readonly registry: AgentConfigLookup,
	) {}

	async execute(
		_toolCallId: string,
		params: { agent_id: string; wait?: boolean; verbose?: boolean },
		signal: AbortSignal,
		_onUpdate: unknown,
		_ctx: unknown,
	) {
		const record = this.manager.getRecord(params.agent_id);
		if (!record) {
			return textResult<GetResultDetails>(
				formatAgentNotFound(params.agent_id, this.manager.listAgents()),
			);
		}

		// Wait for completion if requested. The record owns the decision of whether
		// it is still awaitable — a queued agent counts, because scheduleVia()
		// captures its limiter promise at spawn. A parent interrupt ends the wait
		// without cancelling the agent, leaving the outcome uncollected below.
		const waited = params.wait === true;
		if (waited) {
			// Waiting commits this call to delivering the outcome, so claim it before
			// the agent can settle and be announced by the nudge instead.
			record.claim();
			await record.waitUntilSettled(signal);
		}

		// Pull-delivery edge: the parent is collecting the settled outcome here, so
		// mark it consumed. An agent still active after a wait means the wait was
		// abandoned, so release the claim this call made and let the nudge announce.
		// Only a wait that claimed may release, so a concurrent carrier's claim is
		// never cleared by this call.
		if (!record.isActive()) {
			record.markConsumed();
		} else if (waited) {
			record.release();
		}

		const verbose = params.verbose === true;
		return textResult<GetResultDetails>(
			formatAgentReport(this.buildReport(record, verbose)),
			this.buildGetResultDetails(record, verbose),
		);
	}

	private buildReport(record: Subagent, verbose?: boolean): AgentReport {
		return {
			id: record.id,
			displayName: getDisplayName(record.type, this.registry),
			status: record.status,
			toolUses: record.toolUses,
			tokens: formatLifetimeTokens(record),
			contextPercent: record.getContextPercent(),
			compactionCount: record.compactionCount,
			duration: formatDuration(record.startedAt, record.completedAt),
			description: record.description,
			result: record.result,
			error: record.error,
			stoppedWhileQueued: record.stoppedWhileQueued,
			conversation: verbose ? record.getConversation() : undefined,
			// Transcript pointer: lets the parent read the full session from disk,
			// and covers verbose after the live session was released (no conversation).
			transcriptPath: record.outputFile,
			runUpdates: record.runUpdates,
			pendingQuestion: record.pendingQuestion,
			resumeRefusal: record.resumeRefusal,
			workspaceNotice: record.workspaceNotice,
		};
	}

	/**
	 * The compact metadata the TUI renders from.
	 *
	 * Named in full because `helpers.ts` exports a module-level `buildDetails`
	 * producing the structurally different `AgentDetails`.
	 */
	private buildGetResultDetails(record: Subagent, verbose: boolean): GetResultDetails {
		return {
			agentId: record.id,
			displayName: getDisplayName(record.type, this.registry),
			status: record.status,
			description: record.description,
			toolUses: record.toolUses,
			tokens: formatLifetimeTokens(record),
			contextPercent: record.getContextPercent(),
			compactionCount: record.compactionCount,
			duration: formatDuration(record.startedAt, record.completedAt),
			preview: buildPreview(record.result),
			error: record.error,
			verbose,
			transcriptPath: record.outputFile,
		};
	}

	toToolDefinition() {
		return defineTool({
			name: "get_subagent_result" as const,
			label: "Get Agent Result",
			promptSnippet:
				"Retrieve full output, transcripts, or diagnostics when pushed subagent results are insufficient.",
			promptGuidelines: [
				"Use get_subagent_result only for full output beyond a pushed result, truncated-output recovery, transcript inspection (verbose: true), or diagnostics. Subagent results and questions are pushed automatically; do not poll or call get_subagent_result just to wait.",
			],
			description:
				"Retrieve full output beyond a pushed result, recover truncated output, inspect a transcript (verbose: true), or diagnose a subagent problem. Results and questions are pushed automatically; do not poll or call this tool just to wait. Use the agent ID returned by subagent. Token counters accumulate provider-reported usage from completed assistant messages; they do not estimate the currently streaming response.",
			parameters: Type.Object({
				agent_id: Type.String({
					description:
						"The agent ID whose output or diagnostics you need. Copy the <task-id> from the subagent notification exactly — do not retype it from memory.",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description:
							"If true, explicitly wait for the agent to complete before returning. Not needed for routine completion: results and questions are pushed automatically. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),
			// ---- Custom rendering: a bounded, Ctrl+O-expandable retrieval row ----

			renderCall(args: { agent_id: string; wait?: boolean; verbose?: boolean }, theme: Theme) {
				const notes = [args.wait === true ? "waiting" : "", args.verbose === true ? "verbose" : ""]
					.filter(Boolean)
					.join(", ");
				return new Text(
					`${GLYPHS.toolCall} ` +
						theme.fg("toolTitle", theme.bold("Get Agent Result")) +
						"  " +
						theme.fg("muted", args.agent_id) +
						(notes ? " " + theme.fg("muted", `(${notes})`) : ""),
					0,
					0,
				);
			},

			renderResult(
				result: AgentToolResult<GetResultDetails | undefined>,
				{ expanded }: ToolRenderResultOptions,
				theme: Theme,
			) {
				const reportText = result.content[0]?.type === "text" ? result.content[0].text : "";
				const details = result.details;
				if (!details) return new Text(reportText, 0, 0);
				return new BoundedLines(renderGetResultLines(details, reportText, expanded, theme));
			},

			execute: (
				toolCallId: string,
				params: { agent_id: string; wait?: boolean; verbose?: boolean },
				signal: AbortSignal,
				onUpdate: unknown,
				ctx: unknown,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}

/** The first non-empty line of a result body, clipped to the preview budget. */
function buildPreview(result: string | undefined): string | undefined {
	const line = result?.split("\n").find((candidate) => candidate.trim())?.trim();
	if (!line) return undefined;
	return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS - 1) + "\u2026" : line;
}
