import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import { buildEventData, type NotificationSystem } from "#src/observation/notification";
import type { CompactionInfo, Subagent } from "#src/types";

/** Emit callback — a subset of `pi.events.emit`. */
export type EventEmit = (channel: string, data: unknown) => void;

/** Append callback — a subset of `pi.appendEntry`. */
export type AppendEntry = (customType: string, data: unknown) => void;

export interface SubagentEventsObserverDeps {
	emit: EventEmit;
	appendEntry: AppendEntry;
	notifications: NotificationSystem;
}

/** Display-only launch attribution bounds, mirroring host fleet-service slicing. */
const MAX_MODEL_ID = 256;
const MAX_MODEL_NAME = 128;
const MAX_THINKING = 64;

function boundedField(value: unknown, max: number): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return undefined;
	const sliced = value.slice(0, max);
	return sliced.length > 0 ? sliced : undefined;
}

/**
 * Launch-time model + reasoning attribution for the durable record.
 * Available at both started (non-terminal) and terminal persists via the
 * launch snapshot, updated when Pi resolves defaults and model capabilities.
 */
function boundedAttribution(record: Subagent): Record<string, string> {
	const out: Record<string, string> = {};
	const model = record.launchModel;
	if (model?.id) {
		const id = model.id;
		const provider = model.provider;
		const qualified =
			typeof provider === "string" && provider.length > 0 && !id.startsWith(`${provider}/`)
				? `${provider}/${id}`
				: id;
		const modelId = boundedField(qualified, MAX_MODEL_ID);
		if (modelId) out.modelId = modelId;
	}
	const modelName = boundedField(model?.name, MAX_MODEL_NAME);
	if (modelName) out.modelName = modelName;
	const thinkingLevel = boundedField(record.launchThinkingLevel, MAX_THINKING);
	if (thinkingLevel) out.thinkingLevel = thinkingLevel;
	return out;
}

/**
 * Receives agent lifecycle notifications from SubagentManager and dispatches
 * them to three concerns: pi.events lifecycle events, session-entry persistence,
 * and completion notifications.
 *
 * Constructed with narrow deps (emit, appendEntry, NotificationSystem) so all
 * three concerns are unit-testable without booting the extension.
 */
export class SubagentEventsObserver implements SubagentManagerObserver {
	private readonly emit: EventEmit;
	private readonly appendEntry: AppendEntry;
	private readonly notifications: NotificationSystem;

	constructor(deps: SubagentEventsObserverDeps) {
		this.emit = deps.emit;
		this.appendEntry = deps.appendEntry;
		this.notifications = deps.notifications;
	}

	onSubagentStarted(record: Subagent): void {
		this.persistRecord(record, false);
		// Emit started event when agent transitions to running (including from queue).
		this.emit("subagents:started", {
			id: record.id,
			type: record.type,
			description: record.description,
		});
	}

	onSubagentSessionCreated(record: Subagent): void {
		// Persist Pi's resolved attribution and transcript pointer before the first
		// turn, so a crash cannot leave only the requested launch configuration.
		this.persistRecord(record, false);
	}

	onSubagentCompleted(record: Subagent): void {
		// Emit lifecycle event based on terminal status.
		const isError = record.isTerminalError();
		const eventData = buildEventData(record);
		if (isError) {
			this.emit("subagents:failed", eventData);
		} else {
			this.emit("subagents:completed", eventData);
		}

		this.persistAndNotify(record);
	}

	/**
	 * A settled agent went back to running. Announced only, and on its own
	 * channel: `subagents:started` reports the first run, and a consumer counting
	 * it once per agent must not see it twice. A lightweight running marker
	 * supersedes the previous outcome in canonical history. After a crash a
	 * reader must report that run as unverified, never replay the older success.
	 */
	onSubagentResuming(record: Subagent): void {
		this.persistRecord(record, false);
		this.emit("subagents:resuming", {
			id: record.id,
			type: record.type,
			description: record.description,
		});
	}

	onSubagentResumed(record: Subagent): void {
		// A resumed run terminates only as completed or error; a single distinct
		// channel carries both — the payload's status/error discriminate. Existing
		// subagents:completed/failed subscribers keep their once-per-run semantics.
		this.emit("subagents:resumed", buildEventData(record));
		this.persistAndNotify(record);
	}

	onSubagentExecutionSettled(record: Subagent): void {
		// Completion callbacks run before trackExecution clears executionPending.
		// Only now can a pushed question truthfully offer immediate resume.
		this.notifications.sendCompletion(record);
	}

	/**
	 * Persist the terminal record for cross-extension history reconstruction and
	 * announce completion. Shared by every terminal-state handler (fresh and
	 * resumed). Whether a nudge is actually owed is the notification manager's
	 * decision — it suppresses itself when a carrier has claimed the outcome or
	 * the parent has already consumed it. Both are domain state on the record,
	 * not owned here.
	 */
	private persistAndNotify(record: Subagent): void {
		this.persistRecord(record, true);
		// Never-started stops need no live execution to settle. Otherwise the
		// settlement event above carries the notification, not the status event.
		if (!record.executionPending || record.stoppedWhileQueued) {
			this.notifications.sendCompletion(record);
		}
	}

	/** Append lifecycle metadata to the owning parent's canonical Pi JSONL only. */
	private persistRecord(record: Subagent, terminal: boolean): void {
		this.appendEntry("subagents:record", {
			id: record.id,
			type: record.type,
			description: record.description,
			status: record.status,
			startedAt: record.startedAt,
			isBackground: record.isBackground,
			toolUses: record.toolUses,
			turnCount: record.turnCount,
			...boundedAttribution(record),
			...(record.outputFile ? { outputFile: record.outputFile } : {}),
			...(record.childSessionId ? { childSessionId: record.childSessionId } : {}),
			// Restored for faithful resume after a backend restart: the pending
			// ask-back question and the per-spawn turn cap are outcome facts.
			...(record.pendingQuestion ? { pendingQuestion: record.pendingQuestion.slice(0, 8_192) } : {}),
			...(record.maxTurns !== undefined ? { maxTurns: record.maxTurns } : {}),
			...(terminal ? {
				result: record.result,
				error: record.error,
				completedAt: record.completedAt,
			} : {}),
		});
	}

	/**
	 * A still-running child sent its parent a message. Announced, never
	 * persisted: the session entry reconstructs terminal outcomes, and this is
	 * not one.
	 */
	onSubagentUpdate(record: Subagent, message: string): void {
		this.emit("subagents:update", {
			id: record.id,
			type: record.type,
			description: record.description,
			message,
		});
		this.notifications.sendUpdate(record, message);
	}

	/**
	 * A teardown after the child's result was delivered reported where its work
	 * went. Announced only: no event channel, because no consumer asks for one,
	 * and nothing is persisted — the outcome this belongs to was recorded when
	 * the run ended.
	 */
	onSubagentWorkspaceNotice(record: Subagent, notice: string): void {
		this.notifications.sendWorkspaceNotice(record, notice);
	}

	onSubagentCompacted(record: Subagent, info: CompactionInfo): void {
		// Emit compacted event when agent's session compacts (preserves count on record).
		this.emit("subagents:compacted", {
			id: record.id,
			type: record.type,
			description: record.description,
			reason: info.reason,
			tokensBefore: info.tokensBefore,
			compactionCount: record.compactionCount,
		});
	}

	onSubagentCreated(record: Subagent): void {
		// Emit created event for background agents (before limiter admission).
		this.emit("subagents:created", {
			id: record.id,
			type: record.type,
			description: record.description,
			isBackground: record.isBackground,
		});
	}
}
