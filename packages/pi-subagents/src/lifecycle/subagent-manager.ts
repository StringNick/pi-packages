/**
 * subagent-manager.ts - Tracks subagents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are scheduled on a ConcurrencyLimiter and auto-started as running
 * agents complete. Foreground agents bypass the limiter (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type BackgroundRequest, resolveBackgroundMode } from "#src/config/invocation-config";
import { THINKING_LEVELS } from "#src/config/thinking-level";
import { debugLog } from "#src/debug";
import type { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { type ResumeRefusal, Subagent, type SubagentLifecycleObserver } from "#src/lifecycle/subagent";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import { isActiveStatus, SubagentState, type SubagentStatus } from "#src/lifecycle/subagent-state";
import { resolveModel } from "#src/session/model-resolver";
import { ownsSubagentSessionFile } from "#src/session/session-storage";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";

import type { RunConfig } from "#src/runtime";
import type { AgentConfig, CompactionInfo, ParentSessionInfo, SubagentType, ThinkingLevel } from "#src/types";

/**
 * The agent-registry slice the manager needs to resolve a spawn. Deliberately
 * narrower than AgentConfigLookup, whose slice serves session assembly (ISP).
 */
export interface SpawnTypeResolver {
  resolveType(name: string): string | undefined;
  isValidType(type: string): boolean;
  resolveAgentConfig(type: string): AgentConfig;
}

/**
 * Why a resume was refused, across every front door.
 *
 * Widens the record's own vocabulary by the one refusal that is not a fact
 * about a record: an id no record answers to.
 */
export type ResumeRefusalReason = ResumeRefusal | "unknown-agent";

/**
 * What a resume attempt produced: the record whose run was restarted, or the
 * reason nothing was started.
 *
 * A resumed run that *failed* is still `resumed` — the record carries the
 * error. `refused` means the turn loop never ran.
 */
export type ResumeAdmission =
  | { kind: "started"; record: Subagent }
  | { kind: "refused"; reason: ResumeRefusalReason };

export type ResumeOutcome =
  | { kind: "resumed"; record: Subagent }
  | { kind: "refused"; reason: ResumeRefusalReason };

/** Per-call knobs for a resume; both doors pass their own. */
export interface ResumeCallOptions {
  /** Caller cancellation joins the resumed turn's native stop controller. */
  signal?: AbortSignal;
  /**
   * The caller will deliver this outcome to the parent, so nothing announces
   * it. Omitted, the resumed outcome is announced like any other completion.
   */
  claimOutcome?: boolean;
}

/** A spawn's resolved identity and mode — the invariants every front door shares. */
interface ResolvedSpawn {
  type: SubagentType;
  isBackground: boolean;
}

/**
 * Idle time after which a terminal record's heavy child session is evicted from
 * memory. Hardcoded memory hygiene, not a lifetime: the child transcript stays
 * on disk for the parent's whole life, and resume transparently rehydrates it.
 * There is no user-facing retention setting by design (durable subagents).
 */
export const SESSION_EVICT_IDLE_MS = 10 * 60_000;

/**
 * One durable record to materialize after a backend restart. Mirrors the
 * `subagents:record` custom entries the observer appends to the parent JSONL —
 * the only store; the manager map is a cache.
 */
export interface RestoredAgentInit {
  id: string;
  type: string;
  description: string;
  status: SubagentStatus;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  error?: string;
  pendingQuestion?: string;
  isBackground: boolean;
  /** Provider-qualified model id (`provider/id`), resolved at restore time. */
  modelId?: string;
  thinkingLevel?: string;
  maxTurns?: number;
  /** Child transcript pointers — absent when the run never created a session. */
  outputFile?: string;
  childSessionId?: string;
  toolUses?: number;
  turnCount?: number;
}

const RESTORABLE_STATUSES: readonly SubagentStatus[] = [
  "queued",
  "running",
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
];

function boundedRecordText(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes("\0")
    ? value
    : undefined;
}

function recordCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Parse durable `subagents:record` entries from a parent session branch into
 * restore inputs. Last record per id wins. Corrupt entries are skipped —
 * restore is best-effort; the transcripts stay on disk regardless.
 */
export function restoredAgentsFromEntries(entries: readonly SessionEntry[]): RestoredAgentInit[] {
  const records = new Map<string, RestoredAgentInit>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "subagents:record") continue;
    const data: unknown = (entry as { data?: unknown }).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const fields = data as Record<string, unknown>;
    const id = boundedRecordText(fields.id, 256);
    const type = boundedRecordText(fields.type, 128);
    const description = boundedRecordText(fields.description, 16_384);
    const statusRaw = boundedRecordText(fields.status, 64);
    if (!id || !type || !description || !statusRaw) continue;
    if (!(RESTORABLE_STATUSES as readonly string[]).includes(statusRaw)) continue;
    const init: RestoredAgentInit = {
      id,
      type,
      description: description.slice(0, 160),
      status: statusRaw as SubagentStatus,
      isBackground: fields.isBackground === true,
    };
    const startedAt = recordCount(fields.startedAt);
    if (startedAt !== undefined) init.startedAt = startedAt;
    const completedAt = recordCount(fields.completedAt);
    if (completedAt !== undefined) init.completedAt = completedAt;
    if (typeof fields.result === "string" && fields.result.length > 0) init.result = fields.result;
    if (typeof fields.error === "string" && fields.error.length > 0) init.error = fields.error;
    const pendingQuestion = boundedRecordText(fields.pendingQuestion, 8_192);
    if (pendingQuestion !== undefined) init.pendingQuestion = pendingQuestion;
    const outputFile = boundedRecordText(fields.outputFile, 8_192);
    if (outputFile !== undefined) init.outputFile = outputFile;
    const childSessionId = boundedRecordText(fields.childSessionId, 256);
    if (childSessionId !== undefined) init.childSessionId = childSessionId;
    const modelId = boundedRecordText(fields.modelId, 256);
    if (modelId !== undefined) init.modelId = modelId;
    const thinkingLevel = boundedRecordText(fields.thinkingLevel, 64);
    if (thinkingLevel !== undefined) init.thinkingLevel = thinkingLevel;
    const maxTurns = recordCount(fields.maxTurns);
    if (maxTurns !== undefined) init.maxTurns = maxTurns;
    const toolUses = recordCount(fields.toolUses);
    if (toolUses !== undefined) init.toolUses = toolUses;
    const turnCount = recordCount(fields.turnCount);
    if (turnCount !== undefined) init.turnCount = turnCount;
    records.delete(id);
    records.set(id, init);
  }
  return [...records.values()];
}

/** Observer interface for agent lifecycle notifications. */
export interface SubagentManagerObserver {
  onSubagentStarted(record: Subagent): void;
  /** Fires after the child session and transcript pointer are available, before its first turn. */
  onSubagentSessionCreated?(record: Subagent): void;
  onSubagentCompleted(record: Subagent): void;
  onSubagentExecutionSettled?(record: Subagent): void;
  onSubagentCleanupChanged?(): void;
  /**
   * Fires when a resume starts, from whichever front door asked for it.
   * Required: a consumer that tracks the widget's live set has to learn that a
   * settled record went back to running, and the only alternative is polling.
   */
  onSubagentResuming(record: Subagent): void;
  /** Fires when a resumed run reaches a terminal state (distinct from a fresh completion). */
  onSubagentResumed(record: Subagent): void;
  /**
   * Fires when a running child sends its parent a mid-run message.
   * Optional: the widget has no use for it, and a hook nobody supplies is a
   * vacant one.
   */
  onSubagentUpdate?(record: Subagent, message: string): void;
  /**
   * Fires when a teardown after the record's result was delivered reported
   * where its work went.
   * Optional for the same reason as `onSubagentUpdate`: the widget has no use
   * for it, and a hook nobody supplies is a vacant one.
   */
  onSubagentWorkspaceNotice?(record: Subagent, notice: string): void;
  onSubagentCompacted(record: Subagent, info: CompactionInfo): void;
  /** Fires synchronously after a background agent record is created (before run). */
  onSubagentCreated(record: Subagent): void;
}

export interface SubagentManagerOptions {
  /** Assembly factory that produces a born-complete SubagentSession per spawn. */
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  /** Concurrency limiter — schedules background run thunks FIFO against the limit. */
  limiter: ConcurrencyLimiter;
  /** Base working directory handed to a workspace provider (the parent cwd). */
  baseCwd: string | (() => string);
  getRunConfig?: () => RunConfig;
  /**
   * Fresh parent snapshot for executions built after a backend restart.
   * Absent → restore is skipped (rehydration needs the live parent registry).
   */
  getParentSnapshot?: () => ParentSnapshot | undefined;
  observer?: SubagentManagerObserver;
  assertAdmission?(): void;
  /** Agent registry, consulted to canonicalize a spawn's type and resolve its config. */
  registry: SpawnTypeResolver;
}

export interface AgentSpawnConfig {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Whether this door has committed to a background mode or is offering a
   * default the agent's frontmatter may override. Required so a new front door
   * cannot silently inherit another's policy.
   */
  background: BackgroundRequest;
  /**
   * Skip the maxConcurrent queue check for this spawn - start immediately even
   * if the configured concurrency limit would otherwise queue it. Useful for
   * callers (e.g. cross-extension RPC) that must not be deferred by the queue.
   */
  bypassQueue?: boolean;
  /** Parent abort signal - when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Per-subagent lifecycle observer — replaces onSessionCreated callback. */
  observer?: SubagentLifecycleObserver;
  /** Parent session identity - grouped fields that travel together from the tool boundary. */
  parentSession?: ParentSessionInfo;
}

export class SubagentManager {
  private agents = new Map<string, Subagent>();
  private disposed = false;
  private cleanupCount = 0;
  private readonly cleanupPromises = new Set<Promise<void>>();
  get pendingCleanup(): boolean { return this.cleanupCount > 0; }
  private notifyCleanupChanged(): void {
    try { this.observer?.onSubagentCleanupChanged?.(); } catch (error) { debugLog("subagent cleanup observer", error); }
  }
  private async trackCleanup(task: () => Promise<void>): Promise<void> {
    this.cleanupCount++;
    this.notifyCleanupChanged();
    let pending: Promise<void> | undefined;
    try {
      pending = task();
      this.cleanupPromises.add(pending);
      await pending;
    } finally {
      if (pending) this.cleanupPromises.delete(pending);
      this.cleanupCount--;
      this.notifyCleanupChanged();
    }
  }
  private sweepInterval: ReturnType<typeof setInterval>;
  private readonly observer?: SubagentManagerObserver;
  private readonly assertAdmission?: () => void;
  private readonly createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  private readonly limiter: ConcurrencyLimiter;
  private readonly baseCwd: string | (() => string);
  private getRunConfig?: () => RunConfig;
  private getParentSnapshot?: () => ParentSnapshot | undefined;
  private readonly registry: SpawnTypeResolver;
  private _workspaceProvider?: WorkspaceProvider;

  /** The registered workspace provider, or undefined when none is registered. */
  get workspaceProvider(): WorkspaceProvider | undefined {
    return this._workspaceProvider;
  }

  constructor(options: SubagentManagerOptions) {
    this.createSubagentSession = options.createSubagentSession;
    this.limiter = options.limiter;
    this.baseCwd = options.baseCwd;
    this.observer = options.observer;
    this.assertAdmission = options.assertAdmission;
    this.getRunConfig = options.getRunConfig;
    this.getParentSnapshot = options.getParentSnapshot;
    this.registry = options.registry;
    // Periodically evict the heavy session of idle terminal agents. Records and
    // transcripts are durable (parent JSONL + tasks/ files); resume rehydrates.
    this.sweepInterval = setInterval(() => this.evictIdleSessions(), 60_000);
    this.sweepInterval.unref();
  }

  /**
   * Register the single workspace provider. Throws if one is already
   * registered (chaining is out of scope — see ADR 0002). Returns a disposer
   * that clears the slot only if this provider is still the active one.
   */
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void {
    if (this._workspaceProvider) {
      throw new Error(
        "A WorkspaceProvider is already registered; only one is supported.",
      );
    }
    this._workspaceProvider = provider;
    return () => {
      if (this._workspaceProvider === provider) this._workspaceProvider = undefined;
    };
  }

  /** Compose a per-agent lifecycle observer from manager and spawn-config concerns. */
  private buildObserver(options: AgentSpawnConfig): SubagentLifecycleObserver {
    return {
      onStarted: (agent) => {
        this.observer?.onSubagentStarted(agent);
      },
      onSessionCreated: (agent) => {
        try {
          this.observer?.onSubagentSessionCreated?.(agent);
        } catch (err) {
          debugLog("onSubagentSessionCreated observer", err);
        }
        options.observer?.onSessionCreated?.(agent);
      },
      // Terminal transitions are reported for every agent. Whether the parent
      // needs telling is the notification layer's decision, made from the
      // carrier claim; suppressing the observer here would also suppress the
      // lifecycle event and the session-history record, which are facts about
      // the run rather than announcements.
      onRunFinished: (agent) => {
        try { this.observer?.onSubagentCompleted(agent); } catch (err) { debugLog("onSubagentCompleted observer", err); }
      },
      onExecutionSettled: (agent) => {
        try { this.observer?.onSubagentExecutionSettled?.(agent); } catch (err) { debugLog("onSubagentExecutionSettled observer", err); }
      },
      onResumeStarted: (agent) => {
        try { this.observer?.onSubagentResuming(agent); } catch (err) { debugLog("onSubagentResuming observer", err); }
      },
      onResumeFinished: (agent) => {
        try { this.observer?.onSubagentResumed(agent); } catch (err) { debugLog("onSubagentResumed observer", err); }
      },
      onUpdateSent: (agent, message) => {
        this.observer?.onSubagentUpdate?.(agent, message);
      },
      onWorkspaceNotice: (agent, notice) => {
        this.observer?.onSubagentWorkspaceNotice?.(agent, notice);
      },
      onCompacted: (agent, info) => {
        this.observer?.onSubagentCompacted(agent, info);
      },
    };
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   *
   * Throws when the named agent type is disabled.
   */
  spawn(
    snapshot: ParentSnapshot,
    type: SubagentType,
    prompt: string,
    options: AgentSpawnConfig,
  ): string {
    return this.create(snapshot, this.resolveSpawn(type, options.background), prompt, options);
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   *
   * The caller holds the result, which is a delivery commitment: the agent must
   * not be queued and must not be announced, whatever its frontmatter declares.
   *
   * Rejects when the named agent type is disabled.
   */
  async spawnAndWait(
    snapshot: ParentSnapshot,
    type: SubagentType,
    prompt: string,
    options: Omit<AgentSpawnConfig, "background">,
  ): Promise<Subagent> {
    const foreground: BackgroundRequest = { kind: "explicit", isBackground: false };
    const id = this.create(snapshot, this.resolveSpawn(type, foreground), prompt, {
      ...options,
      background: foreground,
    });
    const record = this.agents.get(id)!;
    // The caller holds the result, so this call is the carrier: claim the outcome
    // before awaiting it, so nothing announces what is already being delivered.
    record.claim();
    await record.promise;
    return record;
  }

  /**
   * Stamp the invariants every front door shares: a canonical agent type, a
   * rejection for a disabled one, and the effective background mode.
   */
  private resolveSpawn(type: string, background: BackgroundRequest): ResolvedSpawn {
    const canonical = this.registry.resolveType(type);
    if (canonical === undefined) {
      throw new Error(`Unknown agent type "${type}". Choose an enabled agent type from the catalog.`);
    }
    if (!this.registry.isValidType(canonical)) {
      throw new Error(`Agent type "${canonical}" is disabled`);
    }
    const agentConfig = this.registry.resolveAgentConfig(canonical);
    return { type: canonical, isBackground: resolveBackgroundMode(agentConfig, background) };
  }

  /** Create, register, and start (or queue) a record for an already-resolved spawn. */
  private create(
    snapshot: ParentSnapshot,
    resolved: ResolvedSpawn,
    prompt: string,
    options: AgentSpawnConfig,
  ): string {
    if (this.disposed) throw new Error("Subagent manager is disposed");
    this.assertAdmission?.();
    const { type, isBackground } = resolved;
    const id = randomUUID().slice(0, 17);
    const record = new Subagent({
      id,
      type,
      description: options.description,
      isBackground,
      state: new SubagentState({
        status: isBackground ? "queued" : "running",
        startedAt: Date.now(),
      }),
      execution: {
        createSubagentSession: this.createSubagentSession,
        snapshot,
        prompt,
        baseCwd: typeof this.baseCwd === "function" ? this.baseCwd() : this.baseCwd,
        observer: this.buildObserver(options),
        getRunConfig: this.getRunConfig,
        getWorkspaceProvider: () => this._workspaceProvider,
        model: options.model,
        maxTurns: options.maxTurns,
        thinkingLevel: options.thinkingLevel,
        parentSession: options.parentSession,
        signal: options.signal,
      },
    });
    this.agents.set(id, record);

    if (isBackground) {
      this.observer?.onSubagentCreated(record);
    }

    if (isBackground && !options.bypassQueue) {
      // Schedule on the limiter — scheduleVia captures the limiter promise
      // eagerly, so a queued agent is awaitable from spawn; guardedRun guards
      // against abort-while-queued when the slot frees.
      record.scheduleVia((thunk) => this.limiter.schedule(thunk));
      return id;
    }

    record.start();
    return id;
  }

  /**
   * Resume an existing agent session with a new prompt.
   *
   * The refusal policy lives here rather than in a caller, so every front door
   * declines the same resumes for the same reasons; a door owns only how it
   * words the answer. Delegates to Subagent.resume(), which owns the observer
   * subscription lifecycle.
   */
  startResume(id: string, prompt: string, options: ResumeCallOptions = {}): ResumeAdmission {
    if (this.disposed) throw new Error("Subagent manager is disposed");
    options.signal?.throwIfAborted();
    this.assertAdmission?.();
    const agent = this.agents.get(id);
    if (!agent) return { kind: "refused", reason: "unknown-agent" };
    const refusal = agent.resumeRefusal;
    if (refusal) return { kind: "refused", reason: refusal };
    // A claim belongs to this resumed run, not to a previous foreground/pull
    // carrier. Refused admissions above leave the current carrier untouched.
    // resetForResume preserves this choice and reserves the record synchronously.
    if (options.claimOutcome) agent.claim();
    else agent.release();
    void agent.resume(prompt, options.signal).catch((error) => { debugLog("resume lifecycle failed", error); });
    return { kind: "started", record: agent };
  }

  async resume(id: string, prompt: string, options: ResumeCallOptions = {}): Promise<ResumeOutcome> {
    const admission = this.startResume(id, prompt, options);
    if (admission.kind === "refused") return admission;
    await admission.record.promise;
    return { kind: "resumed", record: admission.record };
  }

  getRecord(id: string): Subagent | undefined {
    return this.agents.get(id);
  }

  listAgents(): Subagent[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // A queued agent has not started; stop it through the same terminal funnel
    // a running agent's stop uses. Its scheduled thunk becomes a no-op (status
    // guard) when its slot finally opens.
    if (record.status === "queued") {
      record.stopQueued();
      return true;
    }

    return record.abort();
  }

  /**
   * Evict the heavy session of idle terminal agents. Records and transcripts
   * stay durable; resume rehydrates from disk. Runs on an interval with no one
   * to await it — fire-and-forget, and releaseSession() already swallows a
   * failing teardown.
   */
  evictIdleSessions(now: number = Date.now()): void {
    for (const record of this.agents.values()) {
      if (record.isActive() || record.executionPending) continue;
      if (!record.isSessionReady()) continue; // already evicted, or never had a session
      const completedAt = record.completedAt ?? 0;
      if (now - completedAt >= SESSION_EVICT_IDLE_MS) {
        void this.trackCleanup(() => record.releaseSession()).catch(error => debugLog("session eviction cleanup", error));
      }
    }
  }

  /**
   * Evict every terminal record's heavy session now, keeping the records.
   * Session-switch hygiene: drop memory, never durability.
   */
  async evictTerminalSessions(): Promise<void> {
    const teardowns: Promise<void>[] = [];
    for (const record of this.agents.values()) {
      if (record.isActive() || record.executionPending) continue;
      if (!record.isSessionReady()) continue;
      teardowns.push(this.trackCleanup(() => record.releaseSession()));
    }
    await Promise.all(teardowns);
  }

  /**
   * Materialize durable records after a backend restart from the parent JSONL
   * `subagents:record` entries. Records arrive evicted (no live session); the
   * first resume rehydrates the child transcript from disk. Existing ids win —
   * restore never replaces a live record. Returns how many were materialized.
   *
   * A saved non-terminal status means the backend died mid-run: the transcript
   * holds every committed turn, so the record returns as an interrupted error
   * that resume can continue. Entries without transcript pointers and without a
   * terminal state are skipped — there is nothing to rehydrate or display.
   */
  restoreAgents(parentSession: ParentSessionInfo, inits: readonly RestoredAgentInit[]): number {
    const snapshot = this.getParentSnapshot?.();
    if (!snapshot) {
      debugLog("subagent restore skipped", "no parent snapshot");
      return 0;
    }
    let restored = 0;
    for (const init of inits) {
      if (!init.id || !init.type || !init.description) continue;
      if (this.agents.has(init.id)) continue;
      const pointers = init.outputFile && init.childSessionId
        && ownsSubagentSessionFile(parentSession.parentSessionFile, init.outputFile)
        ? { outputFile: init.outputFile, childSessionId: init.childSessionId }
        : undefined;
      let status = init.status;
      let error = init.error;
      if (isActiveStatus(status)) {
        if (!pointers) continue;
        status = "error";
        error = "Run was interrupted by a backend restart; resume to continue it.";
      }
      const thinkingLevel = init.thinkingLevel && (THINKING_LEVELS as readonly string[]).includes(init.thinkingLevel)
        ? (init.thinkingLevel as ThinkingLevel)
        : undefined;
      let model: Model<any> | undefined;
      if (init.modelId) {
        try {
          const resolved = resolveModel(init.modelId, snapshot.modelRegistry);
          model = typeof resolved === "string" ? undefined : resolved;
        } catch {
          model = undefined;
        }
      }
      const record = new Subagent({
        id: init.id,
        type: init.type,
        description: init.description,
        isBackground: init.isBackground,
        state: new SubagentState({
          status,
          result: init.result,
          error,
          pendingQuestion: init.pendingQuestion,
          startedAt: init.startedAt,
          completedAt: init.completedAt,
          toolUses: init.toolUses,
          turnCount: init.turnCount,
        }),
        execution: {
          createSubagentSession: this.createSubagentSession,
          snapshot,
          prompt: "",
          baseCwd: snapshot.cwd,
          observer: this.buildObserver({
            description: init.description,
            background: { kind: "explicit", isBackground: init.isBackground },
          }),
          getRunConfig: this.getRunConfig,
          model,
          maxTurns: init.maxTurns,
          thinkingLevel,
          parentSession,
        },
      });
      if (pointers) record.markSessionEvicted(pointers.outputFile, pointers.childSessionId);
      this.agents.set(init.id, record);
      restored++;
    }
    return restored;
  }

  /** Whether any agents are still running or queued. */
  // fallow-ignore-next-line unused-class-member
  hasRunning(): boolean {
    return [...this.agents.values()].some(r => r.isActive());
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (record.status === "queued") {
        record.stopQueued();
        count++;
      } else if (record.abort()) {
        count++;
      }
    }
    // Drop pending thunks (their promises resolve).
    this.limiter.clear();
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  // fallow-ignore-next-line unused-class-member
  async waitForAll(): Promise<void> {
    // Every spawned agent has a settled-on-completion promise (the limiter starts
    // queued ones as slots free), so a single allSettled covers the queued case.
    // The loop only catches agents spawned during the wait.
    let pending = this.pendingPromises();
    while (pending.length > 0) {
      await Promise.allSettled(pending);
      pending = this.pendingPromises();
    }
  }

  /** Promises of all running/queued agents that have one. */
  private pendingPromises(): Promise<void>[] {
    return [...this.agents.values()]
      .filter(r => r.isActive() || r.executionPending)
      .map(r => r.promise)
      .filter((p): p is Promise<void> => p != null);
  }

  /**
   * Tear down every record, resolving once each child's extensions have shut
   * down. The registry is emptied before the teardowns are awaited, so nothing
   * can reach a dying record; `allSettled` keeps one failing child from
   * abandoning its siblings.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.sweepInterval);
    this.abortAll();
    this.limiter.clear();
    const records = [...this.agents.values()];
    this.agents.clear();
    // Include setup/resume promises: a session constructed late must be torn down too.
    await Promise.allSettled(records.map(record => record.promise));
    await Promise.allSettled([...this.cleanupPromises]);
    await Promise.allSettled(records.map(record => record.disposeSession()));
  }
}
