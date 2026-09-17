import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { restoredAgentsFromEntries, type RestoredAgentInit } from "#src/lifecycle/subagent-manager";
import type { ParentSessionInfo, SessionContext } from "#src/types";

/**
 * Session lifecycle event handlers: session_start, session_before_switch, session_shutdown.
 *
 * Extracted from index.ts so each handler can be tested in isolation
 * with mocked narrow interfaces.
 */

/** Narrow manager interface — only the methods lifecycle handlers call. */
export interface LifecycleManager {
  evictTerminalSessions(): Promise<void>;
  restoreAgents(parentSession: ParentSessionInfo, inits: readonly RestoredAgentInit[]): number;
  abortAll(): void;
  dispose(): Promise<void>;
}

/** Narrow session-start context — only what restore reads. */
export interface LifecycleSessionStartCtx {
  sessionManager?: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getEntries(): SessionEntry[];
  };
}

/** Narrow runtime interface — only the methods lifecycle handlers call. */
export interface LifecycleRuntime {
  setSessionContext(ctx: SessionContext): void;
  clearSessionContext(): void;
}

/**
 * Handles session lifecycle events.
 *
 * Constructor deps:
 * - `runtime` — owns session context state
 * - `manager` — manages agent lifecycle (clear, abort, dispose)
 * - `disposeNotifications` — tears down the notification system on shutdown
 * - `unpublishService` — unpublishes the SubagentsService symbol on shutdown
 */
export class SessionLifecycleHandler {
  constructor(
    private readonly runtime: LifecycleRuntime,
    private readonly manager: LifecycleManager,
    private readonly disposeNotifications: () => void,
    private readonly unpublishService: () => void,
  ) {}

  async handleSessionStart(_event: unknown, ctx: unknown): Promise<void> {
    this.runtime.setSessionContext(ctx as SessionContext);
    // The parent JSONL is the durable store; the manager map is a cache.
    // Re-materialize records lost to a backend restart as evicted sessions —
    // the first resume rehydrates the child transcript from disk.
    const sessionManager = (ctx as LifecycleSessionStartCtx | undefined)?.sessionManager;
    if (!sessionManager) return;
    let entries: SessionEntry[] = [];
    try {
      entries = sessionManager.getEntries();
    } catch {
      return;
    }
    const parentSession: ParentSessionInfo = {
      parentSessionId: sessionManager.getSessionId(),
      parentSessionFile: sessionManager.getSessionFile(),
    };
    this.manager.restoreAgents(parentSession, restoredAgentsFromEntries(entries));
  }

  handleSessionBeforeSwitch(): Promise<void> {
    // Drop memory, never durability: records re-materialize on session_start.
    return this.manager.evictTerminalSessions();
  }

  // Cleanup order matters:
  // 1. Unpublish service — prevent new cross-extension calls
  // 2. Clear session context — no more session state
  // 3. Dispose notifications — silence nudges *before* the aborts that would
  //    raise them: no parent run is active at shutdown, so a terminal
  //    transition delivers its nudge synchronously and Pi cannot recall it
  // 4. Abort all agents — stop running and queued work
  // 5. Dispose manager — final cleanup, awaited so each child's extensions get
  //    their `session_shutdown` before Pi tears the parent down (#709)
  handleSessionShutdown(): Promise<void> {
    this.unpublishService();
    this.runtime.clearSessionContext();
    this.disposeNotifications();
    this.manager.abortAll();
    return this.manager.dispose();
  }
}
