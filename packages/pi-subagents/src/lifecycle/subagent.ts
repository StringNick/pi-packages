/**
 * subagent.ts — Subagent class: identity, lifecycle status, and per-subagent behavior.
 *
 * Status/stats are delegated to the SubagentState value object; listener
 * lifecycle to RunListeners; workspace prepare/dispose to WorkspaceBracket.
 * Behavior (abort, steer buffering) lives here rather than on SubagentManager.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { debugLog } from "#src/debug";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { RunListeners } from "#src/lifecycle/run-listeners";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import { SubagentState, type SubagentStatus } from "#src/lifecycle/subagent-state";
import { type LifetimeUsage, getSessionTokens } from "#src/lifecycle/usage";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import { WorkspaceBracket } from "#src/lifecycle/workspace-bracket";
import { subscribeSubagentObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import type { CompactionInfo, ParentSessionInfo, SessionMessage, SubagentType, ThinkingLevel } from "#src/types";

/** Live runtime facts for host projections — model identity and context-window
 * usage read from the child session. Momentary values polled per read; they are
 * deliberately kept out of the durable `SubagentRecord` snapshot
 * (docs/decisions/0005-subagent-record-admission-policy). */
export interface SubagentRuntimeStats {
	/** Resolved model identity, retained from the launch after the child session is released. */
	model: Readonly<{ id: string; name: string; provider: string }> | undefined;
	/** Effective thinking level read from the child session, or launch configuration before creation. */
	thinkingLevel?: string;
	/** Resolved model context window in tokens, once the model is known. */
	contextWindow: number | undefined;
	/** Context-window utilization (0–100), or null when unknown (e.g. right after compaction). */
	contextPercent: number | null;
	/** Estimated context tokens in the current window, or null when unknown. */
	contextTokens: number | null;
	/** Current-window token total (input + output + cacheWrite); resets at compaction. */
	sessionTokens: number;
	/** Tool calls currently executing, keyed by tool-call id. */
	activeTools: ReadonlyMap<string, string>;
}

/** Per-subagent lifecycle observer — created by SubagentManager for each spawn. */
export interface SubagentLifecycleObserver {
	/** Fires when the subagent transitions to running (inside run(), after markRunning). */
	onStarted?(agent: Subagent): void;
	/** Fires once the session is created — the subagent's subagentSession is now available. */
	onSessionCreated?(agent: Subagent): void;
	/** Fires once when the run completes or fails (for concurrency drain). */
	onRunFinished?(agent: Subagent): void;
	/** All execution cleanup has settled, including an interrupted run. */
	onExecutionSettled?(agent: Subagent): void;
	/**
	 * Fires once a resumed run is under way — after the record is rewound, so a
	 * subscriber reading it sees the run that just started rather than the
	 * outcome of the one it replaced.
	 */
	onResumeStarted?(agent: Subagent): void;
	/** Fires once when a resumed run reaches a terminal state. */
	onResumeFinished?(agent: Subagent): void;
	/** Fires when the running agent sends its parent a mid-run message. */
	onUpdateSent?(agent: Subagent, message: string): void;
	/**
	 * Fires when a teardown after the agent's result was delivered reported where
	 * its work went. Not fired for a failed run or resume: those reach a terminal
	 * notification of their own, which carries the notice.
	 */
	onWorkspaceNotice?(agent: Subagent, notice: string): void;
	/** Fires on compaction events during the run. */
	onCompacted?(agent: Subagent, info: CompactionInfo): void;
}

export type { SubagentStatus } from "#src/lifecycle/subagent-state";

/**
 * Why a resume of an agent would be refused.
 *
 * Eviction is not a refusal: a terminal record whose heavy session was evicted
 * (idle sweep) or never materialized (backend restart) rehydrates its child
 * transcript from disk on resume. Only a record that never had a session — or
 * whose transcript is gone — reports `no-session`.
 *
 * `still-running` is the one transient member: it is a refusal of *now* rather
 * than of ever, and the carriers word it accordingly.
 */
export type ResumeRefusal =
	| "still-running"
	| "no-session"
	| "workspace-disposed";

/**
 * The result of a steer attempt. `Subagent.steer` owns the inactive-state
 * rejection rule and reports it here, so coordinators switch on the outcome
 * instead of pre-checking status (tell by id, with outcomes).
 */
export type SteerOutcome =
	| { kind: "delivered" }
	| { kind: "buffered" }
	| { kind: "rejected"; status: SubagentStatus };

/**
 * The execution machinery a Subagent needs to run. A single mandatory
 * collaborator: production (SubagentManager.spawn) always supplies it, so run()
 * needs no "not configured" guards. The genuinely-optional behavior knobs stay
 * optional; the four inputs run() cannot proceed without are required.
 */
export interface SubagentExecution {
	/** Assembly factory that produces a born-complete SubagentSession. */
	createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
	/** Immutable spawn-time parent snapshot handed to the session factory. */
	snapshot: ParentSnapshot;
	/** Initial prompt for the turn loop. */
	prompt: string;
	/** Parent working directory handed to a workspace provider's prepare(). */
	baseCwd: string;
	observer?: SubagentLifecycleObserver;
	getRunConfig?: () => RunConfig;
	/** Resolves the registered workspace provider (if any) at run-start. */
	getWorkspaceProvider?: () => WorkspaceProvider | undefined;
	model?: Model<any>;
	maxTurns?: number;
	thinkingLevel?: ThinkingLevel;
	parentSession?: ParentSessionInfo;
	signal?: AbortSignal;
}

export interface SubagentInit {
	// Identity
	id: string;
	type: SubagentType;
	description: string;
	/** The mode SubagentManager resolved for this spawn; drives scheduling and announcement. */
	isBackground: boolean;

	/** Execution machinery — always supplied; construct-complete, no test fallbacks. */
	execution: SubagentExecution;

	/** Lifecycle status and metrics. Defaults to a fresh queued state. */
	state?: SubagentState;
}

export class Subagent {
	// Identity — set once at construction
	readonly id: string;
	readonly type: SubagentType;
	readonly description: string;
	/**
	 * Whether this agent runs in the background. Resolved once at the manager
	 * choke point, so a consumer asks the record rather than re-deriving it from
	 * a per-call display snapshot only the tool door ever built (#724).
	 */
	readonly isBackground: boolean;

	// Lifecycle status and metrics — owned by a private value object; getters and
	// mutation methods below delegate to it one line.
	private readonly state: SubagentState;
	get status(): SubagentStatus { return this.state.status; }
	get runVersion(): number { return this.state.runVersion; }
	get result(): string | undefined { return this.state.result; }
	get error(): string | undefined { return this.state.error; }
	get stoppedWhileQueued(): boolean { return this.state.stoppedWhileQueued; }
	get startedAt(): number { return this.state.startedAt; }
	get completedAt(): number | undefined { return this.state.completedAt; }
	get consumedAt(): number | undefined { return this.state.consumedAt; }
	get consumed(): boolean { return this.state.consumed; }
	get claimed(): boolean { return this.state.claimed; }
	get pendingQuestion(): string | undefined { return this.state.pendingQuestion; }
	get runUpdates(): readonly string[] { return this.state.runUpdates; }
	/**
	 * What the workspace reported at a teardown with no result text to fold it
	 * into — the provider's own wording for where the child's work ended up.
	 *
	 * Undefined for a run that completed normally: there the addendum rides the
	 * result, and duplicating it here would have every carrier report it twice.
	 */
	get workspaceNotice(): string | undefined { return this.state.workspaceNotice; }
	get toolUses(): number { return this.state.toolUses; }
	get lifetimeUsage(): Readonly<LifetimeUsage> { return this.state.lifetimeUsage; }
	get compactionCount(): number { return this.state.compactionCount; }
	get turnCount(): number { return this.state.turnCount; }
	get activeTools(): ReadonlyMap<string, string> { return this.state.activeTools; }
	get responseText(): string { return this.state.responseText; }
	isActive(): boolean { return this.state.isActive(); }
	isTerminalError(): boolean { return this.state.isTerminalError(); }
	isRunning(): boolean { return this.state.isRunning(); }
	canBeSteered(): boolean { return this.state.canBeSteered(); }
	get maxTurns(): number | undefined { return this.execution.maxTurns; }
	/**
	 * Model resolved by Pi at launch; requested configuration before creation.
	 */
	get launchModel(): Model<any> | undefined {
		return this.launchAttribution ? this.launchAttribution.model : this.execution.model;
	}
	/**
	 * Thinking resolved by Pi at launch; requested configuration before creation.
	 */
	get launchThinkingLevel(): ThinkingLevel | undefined {
		return this.launchAttribution ? this.launchAttribution.thinkingLevel : this.execution.thinkingLevel;
	}
	private launchAttribution?: { model: Model<any> | undefined; thinkingLevel: ThinkingLevel };

	readonly abortController: AbortController;
	private _promise?: Promise<void>;
	private _executionPending = false;
	private resumeAbort?: AbortController;
	get executionPending(): boolean { return this._executionPending; }
	private trackExecution(start: () => Promise<void>): Promise<void> {
		this._executionPending = true;
		return start().finally(() => {
			this._executionPending = false;
			this.execution.observer?.onExecutionSettled?.(this);
		});
	}
	/** Handle on the agent's current run — the initial run, or the live resume that replaced it. */
	get promise(): Promise<void> | undefined { return this._promise; }

	private readonly execution: SubagentExecution;
	/** Workspace cwd the run resolved (undefined → parent cwd); reused at rehydrate. */
	private runCwd?: string;
	private readonly listeners = new RunListeners();
	private readonly workspaceBracket: WorkspaceBracket;

	subagentSession?: SubagentSession;

	// Retained after releaseSession() evicts the heavy session, so outputFile
	// (transcript pointer) survives and the resume path can rehydrate the child
	// transcript from disk rather than refuse.
	private _releasedOutputFile?: string;
	private _releasedChildSessionId?: string;
	private _sessionReleased = false;
	private sessionRelease?: Promise<void>;
	/** True once releaseSession() has evicted a live session (rehydratable from disk). */
	get sessionReleased(): boolean { return this._sessionReleased; }

	/**
	 * True once this agent's provider-supplied workspace has been torn down.
	 * False for an agent that never had one, so it names the resume the session
	 * would re-enter a removed directory for — not merely a session with a
	 * workspace provider registered.
	 */
	get workspaceDisposed(): boolean { return this.workspaceBracket.wasDisposed(); }

	// Steer buffer — messages queued before the session is ready
	private _pendingSteers: string[] = [];
	/** Number of steer messages waiting to be delivered. */
	get pendingSteerCount(): number { return this._pendingSteers.length; }

	/**
	 * Path to the agent's session JSONL file, or undefined if not yet available.
	 * Falls back to the path captured at releaseSession() once the live session is gone.
	 */
	get outputFile(): string | undefined {
		return this.subagentSession?.outputFile ?? this._releasedOutputFile;
	}

	/** Canonical Pi child identity, retained together with its transcript path after release. */
	get childSessionId(): string | undefined {
		return this.subagentSession?.sessionId ?? this._releasedChildSessionId;
	}

	/** The tool call ID that spawned this background agent, if any. */
	get toolCallId(): string | undefined {
		return this.execution.parentSession?.toolCallId;
	}

	/** Returns true when a SubagentSession is available (session is ready). */
	isSessionReady(): boolean {
		return this.subagentSession != null;
	}

	/**
	 * Why a resume of this agent would be refused, or undefined when one would be
	 * accepted.
	 *
	 * An evicted session is not a refusal: `resume()` rehydrates it from the
	 * retained transcript pointers. A live run outranks all of them: nothing
	 * about a settled record is decided yet.
	 *
	 * A getter rather than a predicate method because the result carriers read it
	 * as a field: `OutcomeAddenda` and `AgentReport` both declare it, and a live
	 * record satisfies them structurally only if it is a property.
	 */
	get resumeRefusal(): ResumeRefusal | undefined {
		// Before the session check: a run transitions to running before it creates
		// its session, and "still running" describes that record better than "no
		// session" does. A queued agent is not running and keeps the no-session
		// answer, which is the truth about it.
		if (this.isRunning() || (this.status !== "queued" && this.executionPending)) return "still-running";
		if (!this.isSessionReady() && !this.canRehydrate()) return "no-session";
		if (this.workspaceDisposed) return "workspace-disposed";
		return undefined;
	}

	/**
	 * Whether a missing live session can be rebuilt from disk: evicted (idle
	 * sweep) or restored (backend restart) records keep the child transcript
	 * pointers, and the transcript outlives every in-memory session.
	 */
	canRehydrate(): boolean {
		return this.subagentSession == null
			&& this._releasedOutputFile != null
			&& this._releasedChildSessionId != null;
	}

	/**
	 * Adopt evicted transcript pointers without a live session — the state
	 * `releaseSession()` produces, and the state restored records arrive in.
	 * The next resume rehydrates from disk.
	 */
	markSessionEvicted(outputFile: string, childSessionId: string): void {
		this._releasedOutputFile = outputFile;
		this._releasedChildSessionId = childSessionId;
		this._sessionReleased = true;
	}

	/**
	 * Ensure a live child session, rehydrating an evicted one from its retained
	 * transcript. No-op when the session is already live. Throws when the
	 * transcript cannot be reopened; the caller reports it as a resume failure.
	 */
	async ensureSession(signal?: AbortSignal): Promise<void> {
		// The old writer and its host registrations must finish shutting down
		// before another session can claim the same child identity.
		if (this.sessionRelease) await this.sessionRelease;
		signal?.throwIfAborted();
		if (this.subagentSession) return;
		const outputFile = this._releasedOutputFile;
		const childSessionId = this._releasedChildSessionId;
		if (!outputFile || !childSessionId) {
			throw new Error("Subagent not configured for resume — missing session");
		}
		const runConfig = this.execution.getRunConfig?.();
		this.subagentSession = await this.execution.createSubagentSession({
			runId: this.id,
			// The resume's own signal: the original run's controller is spent
			// (a resume after abort must still rehydrate).
			signal,
			snapshot: this.execution.snapshot,
			type: this.type,
			cwd: this.runCwd,
			parentSession: this.execution.parentSession,
			model: this.execution.model,
			thinkingLevel: this.execution.thinkingLevel,
			askParent: (question) => { this.state.setPendingQuestion(question); },
			notifyParent: this.canSendUpdates(runConfig)
				? (message) => { this.announceUpdate(message); }
				: undefined,
			resumeFrom: { outputFile, childSessionId },
		});
		this.launchAttribution = {
			model: this.subagentSession.getModel(),
			thinkingLevel: this.subagentSession.getThinkingLevel(),
		};
		this._sessionReleased = false;
		this.execution.observer?.onSessionCreated?.(this);
	}



	/**
	 * Steer an active agent, owning the inactive-state rejection rule.
	 * Returns a `rejected` outcome (with the observed status) when the agent is
	 * neither queued nor running, a `buffered` outcome when the session is not yet ready, or a
	 * `delivered` outcome once the message reaches the session.
	 */
	async steer(message: string): Promise<SteerOutcome> {
		if (!this.canBeSteered()) {
			return { kind: "rejected", status: this.status };
		}
		if (!this.subagentSession) {
			this.queueSteer(message);
			return { kind: "buffered" };
		}
		await this.subagentSession.steer(message);
		return { kind: "delivered" };
	}

	/** Return the session conversation as formatted text, or undefined if no session. */
	getConversation(): string | undefined {
		return this.subagentSession?.getConversation();
	}

	/** Return the session context window utilization (0-100), or null if unavailable. */
	getContextPercent(): number | null {
		return this.subagentSession?.getContextPercent() ?? null;
	}

	/** Live runtime facts (model, context-window usage, active tool calls) for host projections. */
	getRuntimeStats(): SubagentRuntimeStats {
		const model = this.subagentSession
			? this.subagentSession.getModel()
			: this.launchAttribution?.model;
		const usage = this.subagentSession?.getContextUsage();
		const thinkingLevel = this.subagentSession?.getThinkingLevel() ?? this.launchThinkingLevel;
		return {
			model: model ? { id: model.id, name: model.name, provider: model.provider } : undefined,
			...(thinkingLevel ? { thinkingLevel } : {}),
			contextWindow: model?.contextWindow,
			contextPercent: usage?.percent ?? null,
			contextTokens: usage?.tokens ?? null,
			sessionTokens: this.subagentSession ? getSessionTokens(this.subagentSession) : 0,
			activeTools: this.activeTools,
		};
	}

	/**
	 * Subscribe to session events for live updates (e.g., conversation viewer).
	 * Returns an unsubscribe function, or undefined if no session is available.
	 */
	subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined {
		return this.subagentSession?.subscribe(fn);
	}

	/** The session's message history, or an empty array if no session. */
	get messages(): readonly unknown[] {
		return this.subagentSession?.messages ?? [];
	}

	/** The session's message history typed for Pi's session-rendering machinery, or empty if no session. */
	get agentMessages(): readonly SessionMessage[] {
		return this.subagentSession?.agentMessages ?? [];
	}

	/** Resolve a registered tool definition by name, or undefined if no session. */
	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.subagentSession?.getToolDefinition(name);
	}

	constructor(init: SubagentInit) {
		// Identity
		this.id = init.id;
		this.type = init.type;
		this.description = init.description;
		this.isBackground = init.isBackground;

		// Lifecycle status and metrics — fresh queued state unless one is supplied
		this.state = init.state ?? new SubagentState();

		// Abort controller — always created, never injected
		this.abortController = new AbortController();

		// Execution machinery — a single mandatory collaborator
		this.execution = init.execution;

		// Per-run lifecycle collaborators
		this.workspaceBracket = new WorkspaceBracket(
			this.execution.getWorkspaceProvider ?? (() => undefined),
		);
	}

	/**
	 * Execute the full agent lifecycle: workspace preparation, session creation
	 * via the factory, observer wiring, the turn loop, workspace disposal, and
	 * status transitions.
	 *
	 * Execution is supplied at construction (mandatory), so run() needs no
	 * "not configured" guards. The returned promise always resolves (errors are
	 * captured internally).
	 */
	async run(): Promise<void> {
		this.markRunning(Date.now());
		this.execution.observer?.onStarted?.(this);
		this.listeners.wireSignal(this.execution.signal, () => this.abort());

		// Guard the await so the no-provider path stays synchronous, preserving
		// the original run() timing: the factory is called in the same turn as
		// spawn() when no workspace provider is registered.
		let cwd: string | undefined;
		if (this.workspaceBracket.hasProvider()) {
			try {
				cwd = await this.workspaceBracket.prepare({
					agentId: this.id,
					agentType: this.type,
					baseCwd: this.execution.baseCwd,
				});
			} catch (err) {
				this.markError(err);
				this.listeners.release();
				this.execution.observer?.onRunFinished?.(this);
				return;
			}
		}

		const runConfig = this.execution.getRunConfig?.();
		try {
			this.subagentSession = await this.execution.createSubagentSession({
				runId: this.id,
				signal: this.abortController.signal,
				snapshot: this.execution.snapshot,
				type: this.type,
				cwd,
				parentSession: this.execution.parentSession,
				model: this.execution.model,
				thinkingLevel: this.execution.thinkingLevel,
				askParent: (question) => { this.state.setPendingQuestion(question); },
				notifyParent: this.canSendUpdates(runConfig)
					? (message) => { this.announceUpdate(message); }
					: undefined,
			});
		} catch (err) {
			// The factory disposed its own session on a post-creation failure.
			this.failRun(err);
			return;
		}
		this.runCwd = cwd;

		this.launchAttribution = {
			model: this.subagentSession.getModel(),
			thinkingLevel: this.subagentSession.getThinkingLevel(),
		};
		this.listeners.attachObserver(subscribeSubagentObserver(this.subagentSession, this.state, {
			onCompact: (info) => this.execution.observer?.onCompacted?.(this, info),
		}));
		this.execution.observer?.onSessionCreated?.(this);

		try {
			await this.flushPendingSteers();
			const result = await this.subagentSession.runTurnLoop(this.execution.prompt, {
				maxTurns: this.execution.maxTurns,
				defaultMaxTurns: runConfig?.defaultMaxTurns,
				graceTurns: runConfig?.graceTurns,
				signal: this.abortController.signal,
			});
			this.completeRun(result);
		} catch (err) {
			this.failRun(err);
		}
	}

	/**
	 * Whether this run gets the mid-run update channel.
	 *
	 * The operator's setting is the whole gate: where an update lands is decided
	 * per message by announceUpdate(), not per child at session creation, so no
	 * child has to be refused the tool for a condition that can change mid-run.
	 * Defaults to on when no run config is supplied, matching the setting.
	 */
	private canSendUpdates(runConfig: RunConfig | undefined): boolean {
		return runConfig?.midRunUpdates ?? true;
	}

	/**
	 * Record an update the child sent, then offer it to the announcement channel.
	 *
	 * Every update joins the run's ledger, whoever ends up delivering it: this
	 * side cannot know whether an announcement will reach the parent in time, or
	 * at all, so it records unconditionally and lets the channel that delivers
	 * mark what it took. What the ledger still owes is what an outcome carrier
	 * renders alongside the result.
	 *
	 * The observer is told either way: an update is a fact about the run, like
	 * the terminal transitions, so the lifecycle event fires regardless of which
	 * carrier delivers it.
	 */
	private announceUpdate(message: string): void {
		this.state.recordUpdate(message);
		this.execution.observer?.onUpdateSent?.(this, message);
	}

	/**
	 * Start execution immediately (foreground / bypassQueue paths).
	 * Stores the run promise so it is awaitable via the `promise` getter.
	 */
	start(): void {
		this._promise = this.trackExecution(() => this.guardedRun());
	}

	/**
	 * Schedule execution through an external concurrency scheduler (the limiter).
	 * Captures the scheduler's promise eagerly, so a still-queued agent is
	 * awaitable via the `promise` getter from spawn — not only once its slot opens.
	 * The guard in guardedRun() makes an abort-while-queued run a no-op when the
	 * slot finally frees.
	 */
	scheduleVia(schedule: (thunk: () => Promise<void>) => Promise<void>): void {
		this._promise = this.trackExecution(() => schedule(() => this.guardedRun()));
	}

	/**
	 * Run unless the agent left the active set before its slot opened
	 * (e.g. abort-while-queued): a non-queued, non-running status resolves
	 * immediately without running.
	 */
	private guardedRun(): Promise<void> {
		if (!this.isActive()) return Promise.resolve();
		return this.run();
	}

	/**
	 * Wait until this agent's current run settles.
	 * Resolves immediately when the agent is no longer active or has no run
	 * handle. A queued agent is awaitable because scheduleVia() captures the
	 * limiter promise at spawn, so the wait spans both the queue slot and the
	 * run that follows it.
	 *
	 * When `signal` fires the wait ends early and the agent keeps running: this
	 * is a query, so interrupting it must not cancel the work. Cancelling the
	 * work on a parent interrupt is InterruptHandler's separate decision.
	 */
	async waitUntilSettled(signal: AbortSignal): Promise<void> {
		const run = this._promise;
		if (!run || !this.isActive()) return;
		await settleOrAbort(run, signal);
	}

	/**
	 * Resume an existing session with a new prompt, managing the observer
	 * subscription lifecycle internally (same wiring as run()).
	 *
	 * An evicted session is rehydrated from its retained transcript first.
	 * The returned promise always resolves (errors are captured internally) and is
	 * published as the `promise` getter, so waiters track the resume rather than
	 * the settled handle of the original run.
	 * Each resumed turn has its own abort controller, joined to the caller signal;
	 * stopping a resumed turn does not depend on the initial run's spent controller.
	 */
	resume(prompt: string, signal?: AbortSignal): Promise<void> {
		const controller = new AbortController();
		this.resumeAbort = controller;
		this._promise = this.trackExecution(() => this.runResume(prompt,
			signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		)).finally(() => { if (this.resumeAbort === controller) this.resumeAbort = undefined; });
		return this._promise;
	}

	/** The resume body. Always resolves — errors terminate through failResume(). */
	private async runResume(prompt: string, signal?: AbortSignal): Promise<void> {
		this.resetForResume(Date.now());
		// Live sessions keep the historical synchronous timing (reset, observer
		// wiring, and turn-loop entry all happen in this turn); only an evicted
		// session yields to rehydrate from disk first.
		if (!this.subagentSession) {
			try {
				await this.ensureSession(signal);
			} catch (err) {
				if (signal?.aborted) this.stopResume();
				else this.failResume(err);
				return;
			}
			if (!this.subagentSession) {
				if (signal?.aborted) this.stopResume();
				else this.failResume(new Error("Subagent not configured for resume — missing session"));
				return;
			}
		}
		const subagentSession = this.subagentSession;
		try {
			this.execution.observer?.onResumeStarted?.(this);
			this.listeners.attachObserver(subscribeSubagentObserver(subagentSession, this.state, {
				onCompact: (info) => this.execution.observer?.onCompacted?.(this, info),
			}));
			if (this._pendingSteers.length > 0) await this.flushPendingSteers();
			const result = await subagentSession.resumeTurnLoop(prompt, signal);
			if (signal?.aborted) this.stopResume();
			else this.completeResume(result);
		} catch (err) {
			if (signal?.aborted) this.stopResume();
			else this.failResume(err);
		}
	}

	private stopResume(): void {
		this.markStopped();
		this.clearPendingQuestion();
		this.listeners.release();
		this.disposeWorkspaceQuietly("stopped");
		this.execution.observer?.onResumeFinished?.(this);
	}

	/** Terminate a resume as completed: mark, dispose or hold the workspace, release listeners, notify observer. */
	completeResume(result: string): void {
		// A child answering one question may need to ask another, which holds the
		// workspace for the next resume the same way the original run did.
		const finalResult = this.pendingQuestion !== undefined
			? result
			: result + this.workspaceBracket.dispose({ status: "completed", description: this.description });
		this.markCompleted(finalResult);
		this.listeners.release();
		this.execution.observer?.onResumeFinished?.(this);
	}

	/** Terminate a resume as errored: mark, release listeners, best-effort workspace dispose, notify observer. */
	failResume(err: unknown): void {
		this.markError(err);
		this.clearPendingQuestion();
		this.listeners.release();
		this.disposeWorkspaceQuietly("error");
		this.execution.observer?.onResumeFinished?.(this);
	}

	/** Transition to running state. Sets status and startedAt. */
	markRunning(startedAt: number): void {
		this.state.markRunning(startedAt);
	}

	/**
	 * Transition to completed state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markCompleted(result: string, completedAt?: number): void {
		this.state.markCompleted(result, completedAt);
	}

	/**
	 * Transition to aborted state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markAborted(result: string, completedAt?: number): void {
		this.state.markAborted(result, completedAt);
	}

	/**
	 * Transition to steered state.
	 * Always sets result and completedAt (??=). Only changes status if not stopped.
	 */
	markSteered(result: string, completedAt?: number): void {
		this.state.markSteered(result, completedAt);
	}

	/**
	 * Transition to error state.
	 * Always sets error (formatted) and completedAt (??=). Only changes status if not stopped.
	 */
	markError(error: unknown, completedAt?: number): void {
		this.state.markError(error, completedAt);
	}

	/** Transition to stopped state. Always valid — no guard. */
	markStopped(completedAt?: number): void {
		this.state.markStopped(completedAt);
	}

	/** Record the parent collected this agent's outcome. Idempotent. */
	markConsumed(at?: number): void {
		this.state.markConsumed(at);
	}

	/** The announcement channel delivered this update; no outcome carrier repeats it. */
	markUpdateAnnounced(message: string): void {
		this.state.markUpdateAnnounced(message);
	}

	/** A carrier has committed to delivering this outcome; nothing else announces it. */
	claim(): void {
		this.state.claim();
	}

	/** The carrier abandoned its commitment; announcing is owed again. */
	// Called on the `Subagent` returned by `getRecord()` from get-result-tool.ts
	// and agent-tool.ts, both of which declare it through their own structural
	// interface — fallow cannot trace through interfaces, and reaches this only
	// through the release-then-announce test.
	release(): void {
		this.state.release();
	}

	/**
	 * Stop an agent that never started, then notify like every other terminal
	 * transition. No listener release: nothing is wired before run().
	 * The record leaves the active set here, so the thunk the limiter runs when
	 * the slot finally frees no-ops on guardedRun()'s guard — one notification.
	 */
	stopQueued(): void {
		this.state.stopQueued();
		this.execution.observer?.onRunFinished?.(this);
	}

	/**
	 * Abort a running agent: fire AbortController and transition to stopped.
	 * Returns false if the agent is not running.
	 * A still-queued agent is stopped via stopQueued(); its scheduled thunk
	 * then no-ops on the queued-status guard.
	 */
	abort(): boolean {
		if (!this.isRunning()) return false;
		this.abortController.abort();
		this.resumeAbort?.abort();
		this.markStopped();
		return true;
	}

	/**
	 * Buffer a steer message for delivery once the session is ready.
	 * Called internally from steer() before the session is ready.
	 */
	private queueSteer(message: string): void {
		this._pendingSteers.push(message);
	}

	/**
	 * Flush all buffered steer messages to the session and clear the buffer.
	 * Called once the session is available (inside run()).
	 */
	private async flushPendingSteers(): Promise<void> {
		const session = this.subagentSession;
		if (!session) return;
		while (this._pendingSteers.length > 0) {
			const message = this._pendingSteers.shift();
			if (message !== undefined) await session.steer(message);
		}
	}

	/** Reset for resume: running status, new startedAt, clear completedAt/result/error/consumedAt/listeners. */
	resetForResume(startedAt: number): void {
		this.state.resetForResume(startedAt);
		this.listeners.release();
	}

	/** Complete a run: release listeners, dispose the workspace, status transition, notify observer. */
	completeRun(result: TurnLoopResult): void {
		this.listeners.release();

		const finalStatus: SubagentStatus = result.aborted
			? "aborted"
			: result.steered
				? "steered"
				: "completed";
		// A completed child that declared a question is inviting a resume, so its
		// workspace stays live for the resume to re-enter. Every other outcome ends
		// the run for good and tears it down here. The question was recorded by
		// ask_parent during the run, so it is already on the record here.
		const holdForResume = finalStatus === "completed" && this.pendingQuestion !== undefined;
		const finalResult = holdForResume
			? result.responseText
			: result.responseText +
				this.workspaceBracket.dispose({ status: finalStatus, description: this.description });

		if (result.aborted) this.markAborted(finalResult);
		else if (result.steered) this.markSteered(finalResult);
		else this.markCompleted(finalResult);

		this.execution.observer?.onRunFinished?.(this);
	}

	/**
	 * Dispose the wrapped session, firing the `disposed` lifecycle event.
	 * Resolves once the child's extensions have shut down; a failing teardown is
	 * swallowed so the caller's remaining cleanup still runs.
	 */
	async disposeSession(): Promise<void> {
		this.disposeHeldWorkspace();
		await disposeQuietly(this.subagentSession, "child session dispose");
	}

	/**
	 * Evict the heavy session while keeping the record: capture the transcript
	 * pointer, dispose the session (firing `disposed`), clear it, and mark evicted.
	 * A no-op once the session is gone — the eviction sweep may call it repeatedly.
	 * Resume transparently rehydrates from the retained pointers.
	 *
	 * The record's own state is updated before the teardown is awaited, so a sweep
	 * tick arriving mid-teardown sees an evicted record rather than starting a
	 * second one.
	 */
	async releaseSession(): Promise<void> {
		const session = this.subagentSession;
		if (!session) return;
		this.disposeHeldWorkspace();
		this._releasedOutputFile = session.outputFile;
		this._releasedChildSessionId = session.sessionId;
		this.subagentSession = undefined;
		this._sessionReleased = true;
		this.sessionRelease = disposeQuietly(session, "child session release");
		await this.sessionRelease;
	}

	/** Fail a run: mark error, release listeners, best-effort workspace dispose, notify observer. */
	failRun(err: unknown): void {
		this.markError(err);
		this.clearPendingQuestion();
		this.listeners.release();
		this.disposeWorkspaceQuietly("error");
		this.execution.observer?.onRunFinished?.(this);
	}

	/**
	 * Drop a question the child recorded before the run failed.
	 *
	 * Every carrier renders a pending question as "answer by resuming me", which
	 * is not the right next action after a failure — and the failure text already
	 * tells the parent to look. An aborted or steered run keeps its question:
	 * those reached a terminal transition with an outcome to report.
	 */
	private clearPendingQuestion(): void {
		this.state.setPendingQuestion(undefined);
	}

	/**
	 * Tear down a workspace still held once the agent's run is over — the child
	 * asked a question nobody answered, and its session is now going away.
	 *
	 * A no-op while the agent is active: an in-flight run's own terminal
	 * transition owns disposal, and pulling the directory out from under a live
	 * child is not this path's business.
	 */
	private disposeHeldWorkspace(): void {
		if (this.isActive()) return;
		// Announce what *this* disposal produced, not what the record holds: both
		// release and teardown reach here, and the second finds nothing to dispose.
		const notice = this.disposeWorkspaceQuietly(this.status);
		if (notice) this.execution.observer?.onWorkspaceNotice?.(this, notice);
	}

	/**
	 * Dispose the workspace without letting a provider failure escape, recording
	 * what it reported and handing that back.
	 *
	 * These are the paths with no result text left to fold the addendum into, so
	 * it is kept on the record for the carriers to report instead. The value is
	 * returned as well as stored, so a caller can tell an addendum this call
	 * produced from one an earlier disposal already recorded.
	 */
	private disposeWorkspaceQuietly(status: SubagentStatus): string {
		try {
			const notice = this.workspaceBracket.dispose({ status, description: this.description });
			if (notice) this.state.setWorkspaceNotice(notice);
			return notice;
		} catch (err) { debugLog(`workspace dispose (${status})`, err); return ""; }
	}
}

/**
 * Tear a child session down without letting its failure escape.
 * Both teardown paths are cleanup: a child that will not shut down cleanly must
 * not stop the caller from finishing the rest of its own cleanup.
 */
async function disposeQuietly(
	session: SubagentSession | undefined,
	context: string,
): Promise<void> {
	try {
		await session?.dispose();
	} catch (err) {
		debugLog(context, err);
	}
}

/**
 * Settle with `run`, or early when `signal` fires — whichever comes first.
 * The inner controller is the listener-cleanup channel: it detaches the abort
 * listener whichever branch wins, so repeated waits within one parent turn do
 * not accumulate listeners on that turn's signal.
 */
function settleOrAbort(run: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	const detach = new AbortController();
	const interrupted = new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => { resolve(); }, { once: true, signal: detach.signal });
	});
	return Promise.race([run, interrupted]).finally(() => { detach.abort(); });
}
