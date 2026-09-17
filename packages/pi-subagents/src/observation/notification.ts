import { debugLog } from "#src/debug";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import { getLifetimeTotal } from "#src/lifecycle/usage";
import {
  renderQuestionAffordance,
  renderRunUpdates,
  renderStatusLabel,
  renderWorkspaceNotice,
} from "#src/observation/outcome-delivery";
import type { Subagent } from "#src/types";

// A useful report, rather than a teaser requiring another model/tool round trip.
// Full output remains on the retained record and in the canonical Pi transcript.
const RESULT_MAX_CHARS = 12_000;

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: SubagentStatus;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
}

// ---- Pure helpers (exported for unit testing) ----

/**
 * Escape XML special characters to prevent injection in structured
 * notifications. Quotes are escaped too, so values stay safe if they are ever
 * placed in attribute position, not only element content.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Format a structured <task-notification> XML block for the parent agent to parse. */
export function formatTaskNotification(record: Subagent, resultMaxLen: number): string {
  if (record.stoppedWhileQueued) return formatNeverStartedNotification(record);

  const status = renderStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = record.getContextPercent();
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  const toolCallId = record.toolCallId;
  const outputFile = record.outputFile;
  return joinNotificationLines([
    "<task-notification>",
    `<task-id>${record.id}</task-id>`,
    toolCallId ? `<tool-use-id>${escapeXml(toolCallId)}</tool-use-id>` : null,
    outputFile ? `<output-file>${escapeXml(outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Subagent "${escapeXml(record.description)}" ${record.status}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    "</task-notification>",
  ]);
}

/**
 * Format a `<workspace-notice>` block for what a teardown reported after the
 * child's result had already been delivered.
 *
 * A distinct element from `<task-notification>`: the outcome was reported long
 * ago and has not changed. This says only where the child's work ended up, so
 * the parent's next action is to act on that artifact, never to collect a
 * result it already has.
 */
export function formatWorkspaceNotice(record: Subagent, notice: string): string {
  return joinNotificationLines([
    "<workspace-notice>",
    `<task-id>${record.id}</task-id>`,
    `<summary>Subagent "${escapeXml(record.description)}" left work behind when its workspace was torn down</summary>`,
    `<notice>${escapeXml(notice)}</notice>`,
    "</workspace-notice>",
  ]);
}

/**
 * Format a `<subagent-update>` block for a message a still-running child sent.
 *
 * A distinct element from `<task-notification>`: the child has not finished, so
 * the parent's next action is to steer it or leave it alone, never to collect a
 * result that does not exist yet.
 */
export function formatUpdateNotification(record: Subagent, message: string): string {
  return joinNotificationLines([
    "<subagent-update>",
    `<task-id>${record.id}</task-id>`,
    `<summary>Subagent "${escapeXml(record.description)}" sent an update</summary>`,
    `<message>${escapeXml(message)}</message>`,
    "</subagent-update>",
    `The agent is still running. Steer it with steer_subagent("${record.id}", "...") to redirect it, or let it continue.`,
  ]);
}

/**
 * Format the block for an agent stopped before the limiter admitted it. Such an
 * agent never ran, so it has no result and no usage — reporting either (even as
 * zeroes) would point the parent at work that does not exist.
 */
function formatNeverStartedNotification(record: Subagent): string {
  const toolCallId = record.toolCallId;
  return joinNotificationLines([
    "<task-notification>",
    `<task-id>${record.id}</task-id>`,
    toolCallId ? `<tool-use-id>${escapeXml(toolCallId)}</tool-use-id>` : null,
    "<status>Stopped before starting</status>",
    `<summary>Subagent "${escapeXml(record.description)}" was stopped while queued and never started</summary>`,
    "</task-notification>",
  ]);
}

/** Join notification lines, dropping the ones a conditional element omitted. */
function joinNotificationLines(lines: (string | null)[]): string {
  return lines.filter(Boolean).join("\n");
}

/** Build notification details for the custom message renderer. */
export function buildNotificationDetails(
  record: Subagent,
  resultMaxLen: number,
): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: record.turnCount,
    maxTurns: record.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: buildResultPreview(record, resultMaxLen),
  };
}

/** The renderer's preview text: the (truncated) result, or why there is none. */
function buildResultPreview(record: Subagent, resultMaxLen: number): string {
  if (record.stoppedWhileQueued) return "Never started — stopped while queued.";
  if (!record.result) return "No output.";
  return record.result.length > resultMaxLen
    ? record.result.slice(0, resultMaxLen) + "…"
    : record.result;
}

/** Build event data for lifecycle events from a Subagent. */
export function buildEventData(record: Subagent) {
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  const tokens =
    total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    tokens,
  };
}

// ---- Notification system factory ----

export interface NotificationSystem {
  sendCompletion: (record: Subagent) => void;
  sendUpdate: (record: Subagent, message: string) => void;
  sendWorkspaceNotice: (record: Subagent, notice: string) => void;
  dispose: () => void;
}

/** Details the update renderer reads. */
export interface UpdateDetails {
  id: string;
  description: string;
  message: string;
}

/** Details the workspace-notice renderer reads. */
export interface WorkspaceNoticeDetails {
  id: string;
  description: string;
  notice: string;
}

/**
 * One announcement withheld for the parent's current run.
 *
 * A completion for an agent supersedes an earlier one for that agent; two
 * updates are two distinct facts and both survive.
 */
type PendingAnnouncement =
  | { kind: "completion"; record: Subagent; runVersion: number }
  | { kind: "update"; record: Subagent; runVersion: number; message: string };

export class NotificationManager implements NotificationSystem {
  // Hold until all tools in the current step have returned, then re-check the
  // pull carrier before handing anything to Pi's unrecallable steering queue.
  // agent_settled is the fallback for abort/retry paths with no next step.
  // Ordered rather than record-keyed: a completion for an agent supersedes an
  // earlier one for that agent, but announcements from different agents are
  // distinct facts, and arrival order is the only order the parent can make
  // sense of.
  private pending: PendingAnnouncement[] = [];
  private parentRunActive = false;
  private disposed = false;
  private delivering = false;
  private readonly handedOff = new WeakMap<Subagent, number>();
  // Pi preserves details identity on live custom messages. Weak keys avoid
  // retaining outcomes if Pi discards a queued message on cancellation.
  private readonly deliveries = new WeakMap<object, { record: Subagent; runVersion: number }>();

  get pendingDelivery(): boolean { return this.pending.length > 0 || this.delivering; }

  constructor(
    private sendMessage: (
      msg: { customType: string; content: string; display: boolean; details?: unknown },
      opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ) => void,
    private readonly onWorkloadChanged: () => void = () => {},
  ) {}

  sendCompletion(record: Subagent): void {
    // The session is gone. It is the aborts fired during shutdown that reach
    // here, and with no parent run active a nudge would go straight out as an
    // unrecallable followUp.
    if (this.disposed) return;
    // A carrier has committed to delivering this outcome, so announcing it would
    // duplicate a delivery the parent is already getting. Structural and decided
    // at the parent's request, so unlike the consumption check below it cannot
    // race the turn.
    if (record.claimed) return;
    // A pull may have collected the result since this completion was queued.
    if (record.consumed) return;
    if (this.parentRunActive) {
      this.withholdCompletion(record);
      return;
    }
    this.emitCompletion(record);
  }

  /**
   * Queue a completion for the flush, superseding an earlier one for the same
   * agent in the position that one already holds — a re-completion is the same
   * fact told again, not a later one.
   */
  private withholdCompletion(record: Subagent): void {
    const entry: PendingAnnouncement = { kind: "completion", record, runVersion: record.runVersion };
    const existing = this.pending.findIndex(
      (queued) => queued.kind === "completion" && queued.record.id === record.id,
    );
    if (existing === -1) this.pending.push(entry);
    else this.pending[existing] = entry;
    this.onWorkloadChanged();
  }

  /**
   * Announce a message a still-running child sent its parent.
   *
   * Consumption is not consulted: it records that the child's *outcome* was
   * collected, and an update is a new fact rather than that outcome told again.
   * What is consulted is whether an announcement is still the right channel at
   * all — see `canAnnounceUpdate`. The disposal latch and the parent-run
   * withhold apply as they do to any announcement.
   */
  sendUpdate(record: Subagent, message: string): void {
    if (this.disposed) return;
    if (!this.canAnnounceUpdate(record)) return;
    if (this.parentRunActive) {
      this.pending.push({ kind: "update", record, runVersion: record.runVersion, message });
      this.onWorkloadChanged();
      return;
    }
    this.emitUpdate(record, message);
  }

  /**
   * Whether an announcement is still the right channel for this run's updates.
   *
   * A claimed outcome is one a blocked carrier is already delivering, so an
   * announcement could only arrive after its return. A terminated run has an
   * outcome, and every carrier of an outcome renders what the run still owes —
   * including the completion nudge — so the message arrives with it rather than
   * as a live update the child can no longer act on.
   *
   * Consulted at enqueue and again at emit, because a run withheld for the
   * parent's turn can terminate or be claimed in between. That re-read is what
   * keeps a `<subagent-update>` block's steering affordance true.
   */
  private canAnnounceUpdate(record: Subagent): boolean {
    return !record.claimed && record.isActive();
  }

  /**
   * Announce where a teardown left a child's work, after its result was already
   * delivered.
   *
   * Consults neither the carrier claim nor consumption: both record that the
   * child's *outcome* has an owner, and this is a fact about the workspace
   * rather than that outcome told again. It is not withheld for the parent's
   * run either — the withheld queue exists for the unrecallable `followUp` a
   * mid-run send becomes, and this delivery mode never reaches it. Pi appends
   * it once the current turn ends, or immediately when there is none.
   */
  sendWorkspaceNotice(record: Subagent, notice: string): void {
    if (this.disposed) return;
    const details: WorkspaceNoticeDetails = {
      id: record.id,
      description: record.description,
      notice,
    };
    this.sendMessage(
      {
        customType: "subagent-workspace-notice",
        content: formatWorkspaceNotice(record, notice),
        display: true,
        details,
      },
      { triggerTurn: false },
    );
  }

  /** The parent's agent run became active; delivery waits for a safe boundary. */
  onParentAgentStart(): void {
    this.parentRunActive = true;
  }

  /** All tools in this step returned; Pi can steer before the next model call. */
  onParentTurnEnd(): void {
    if (this.parentRunActive) this.flushPending();
  }

  /** Fallback after the entire run, including retries and error/abort paths. */
  onParentAgentSettled(): void {
    this.parentRunActive = false;
    this.flushPending();
  }

  /**
   * Pi accepted the result into the parent's conversation. Enqueueing is not
   * delivery; an interrupted queue must not count as collected.
   * This is a transport acknowledgement, not proof the model acted on it.
   */
  onParentMessageEnd(message: { role: string; customType?: string; details?: unknown }): void {
    if (this.disposed || message.role !== "custom" || message.customType !== "subagent-notification") return;
    if (!message.details || typeof message.details !== "object") return;
    const delivery = this.deliveries.get(message.details);
    if (!delivery) return;
    this.deliveries.delete(message.details);
    if (delivery.record.runVersion === delivery.runVersion) delivery.record.markConsumed();
  }

  private flushPending(): void {
    if (this.disposed) return;
    this.delivering = true;
    const withheld = this.pending.splice(0);
    for (const entry of withheld) {
      if (entry.record.runVersion !== entry.runVersion) continue;
      try {
        if (entry.kind === "update") this.emitUpdate(entry.record, entry.message);
        else this.emitCompletion(entry.record);
      } catch (err) {
        debugLog("notification render", err);
      }
    }
    this.delivering = false;
    this.onWorkloadChanged();
  }

  /** Terminal: the manager stops announcing anything, now and afterwards. */
  dispose(): void {
    this.disposed = true;
    this.pending.length = 0;
    this.onWorkloadChanged();
  }

  private emitUpdate(record: Subagent, message: string): void {
    if (!this.canAnnounceUpdate(record)) return;
    // This channel is delivering the message, so no outcome carrier may repeat
    // it — the record renders only what is still owed.
    record.markUpdateAnnounced(message);
    const details: UpdateDetails = {
      id: record.id,
      description: record.description,
      message,
    };
    this.sendMessage(
      {
        customType: "subagent-update",
        content: formatUpdateNotification(record, message),
        display: true,
        details,
      },
      { deliverAs: this.parentRunActive ? "steer" : "followUp", triggerTurn: true },
    );
  }

  private emitCompletion(record: Subagent): void {
    if (record.claimed) return;
    if (record.consumed) return;
    if (this.handedOff.get(record) === record.runVersion) return;

    const notification = formatTaskNotification(record, RESULT_MAX_CHARS);
    // A never-started agent has no transcript and nothing to collect.
    const pointerLines = record.stoppedWhileQueued ? "" : this.buildPointerLines(record);

    const details = buildNotificationDetails(record, 500);
    this.deliveries.set(details, { record, runVersion: record.runVersion });
    this.handedOff.set(record, record.runVersion);
    try {
      this.sendMessage(
        {
          customType: "subagent-notification",
          content: notification + pointerLines,
          display: true,
          details,
        },
        { deliverAs: this.parentRunActive ? "steer" : "followUp", triggerTurn: true },
      );
    } catch (error) {
      this.deliveries.delete(details);
      this.handedOff.delete(record);
      throw error;
    }
  }

  /**
   * Full transcript access is optional: the delivered report is already usable.
   */
  private buildPointerLines(record: Subagent): string {
    const outputFile = record.outputFile;
    const transcriptLine = outputFile
      ? `\nFull Pi JSONL transcript available at: ${outputFile}\nRead it in chunks if you need the complete messages and tool calls.`
      : "";
    return (
      // What the child flagged along the way leads — for a run nothing else
      // collected, this nudge is the carrier those updates ride. Then where the
      // work went, so the parent reads it before the pointers.
      renderRunUpdates(record.runUpdates) +
      renderWorkspaceNotice(record.workspaceNotice) +
      transcriptLine +
      renderQuestionAffordance(record.id, record.pendingQuestion, record.resumeRefusal)
    );
  }
}
