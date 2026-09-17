import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { AgentSpawnConfig, RestoredAgentInit } from "#src/lifecycle/subagent-manager";
import { restoredAgentsFromEntries, SESSION_EVICT_IDLE_MS, SubagentManager, type SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import { NotificationManager } from "#src/observation/notification";
import type { RunConfig } from "#src/runtime";
import type { AgentConfig, Subagent } from "#src/types";
import { makeWorkspace, makeWorkspaceProvider } from "#test/helpers/make-workspace";
import { createBlockingFactory, createSessionFactory } from "#test/helpers/manager-stubs";
import { createMockSession, createSubagentSessionStub, emitResumeUsageAndCompaction, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

/** Default max concurrent background agents (matches production default). */
const DEFAULT_MAX_CONCURRENT = 4;

type SessionFactory = (params: CreateSubagentSessionParams) => Promise<SubagentSession>;

/** Default factory: resolves to a fresh SubagentSession stub on every spawn. */
function defaultFactory(): SessionFactory {
  return vi.fn(async (_params: CreateSubagentSessionParams) => toSubagentSession(createSubagentSessionStub()));
}

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    toolNames: ["read", "grep"],
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    ...overrides,
  };
}

/** Registry with default agents only. */
function defaultRegistry(): AgentTypeRegistry {
  return new AgentTypeRegistry(() => new Map());
}

/** Registry with a single custom agent override, keyed by its canonical name. */
function registryWith(name: string, overrides: Partial<AgentConfig>): AgentTypeRegistry {
  return new AgentTypeRegistry(() => new Map([[name, makeAgentConfig({ name, ...overrides })]]));
}

/** Test helper: construct an SubagentManager with injected stubs. */
function createManager(overrides?: {
  createSubagentSession?: SessionFactory;
  observer?: Partial<SubagentManagerObserver>;
  getMaxConcurrent?: () => number;
  getRunConfig?: () => RunConfig;
  getParentSnapshot?: () => typeof STUB_SNAPSHOT;
  baseCwd?: string;
  registry?: AgentTypeRegistry;
}) {
  const createSubagentSession: SessionFactory = overrides?.createSubagentSession ?? defaultFactory();
  const observer: SubagentManagerObserver | undefined = overrides?.observer
    ? {
        onSubagentStarted: overrides.observer.onSubagentStarted ?? (() => {}),
        onSubagentCompleted: overrides.observer.onSubagentCompleted ?? (() => {}),
        onSubagentResumed: overrides.observer.onSubagentResumed ?? (() => {}),
        onSubagentResuming: overrides.observer.onSubagentResuming ?? (() => {}),
        onSubagentCompacted: overrides.observer.onSubagentCompacted ?? (() => {}),
        onSubagentCreated: overrides.observer.onSubagentCreated ?? (() => {}),
        onSubagentSessionCreated: overrides.observer.onSubagentSessionCreated,
        onSubagentWorkspaceNotice: overrides.observer.onSubagentWorkspaceNotice,
      }
    : undefined;
  const limiter = new ConcurrencyLimiter(overrides?.getMaxConcurrent ?? (() => DEFAULT_MAX_CONCURRENT));
  const mgr = new SubagentManager({
    createSubagentSession,
    observer,
    limiter,
    baseCwd: overrides?.baseCwd ?? "/repo",
    getRunConfig: overrides?.getRunConfig,
    getParentSnapshot: overrides?.getParentSnapshot,
    registry: overrides?.registry ?? defaultRegistry(),
  });
  return { manager: mgr, createSubagentSession, limiter };
}

/** Spawn a background agent using STUB_SNAPSHOT. */
function spawnBg(mgr: SubagentManager, prompt = "test", desc = prompt) {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
    background: { kind: "explicit", isBackground: true },
  });
}

/** Spawn a foreground agent using STUB_SNAPSHOT. */
function spawnFg(mgr: SubagentManager, prompt = "test", desc = prompt) {
  return mgr.spawnAndWait(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
  });
}

/** Spawn a background agent carrying a parentSession.toolCallId (notification path). */
function spawnBgWithToolCall(mgr: SubagentManager, toolCallId: string, prompt = "test", desc = prompt) {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
    background: { kind: "explicit", isBackground: true },
    parentSession: { toolCallId },
  });
}

/** Arrange a manager at limit 1 with two bg agents over a blocking factory: first runs, second queues. */
function arrangeQueuedPair(observer?: Partial<SubagentManagerObserver>) {
  const factory = createBlockingFactory();
  const { manager: mgr } = createManager({ createSubagentSession: factory, getMaxConcurrent: () => 1, observer });
  const running = spawnBg(mgr, "a");
  const queued = spawnBg(mgr, "b");
  return { manager: mgr, factory, running, queued };
}

/**
 * Arrange a manager whose onSubagentCompleted observer forwards to a real
 * NotificationManager (mirroring SubagentEventsObserver's unconditional
 * sendCompletion delegation), with one background agent spawned via a tool
 * call. The act (when the record is marked consumed relative to awaiting)
 * stays in each test.
 */
function seedNotificationScenario() {
  const sendMessage = vi.fn();
  const notifications = new NotificationManager(sendMessage);
  const { manager } = createManager({
    observer: { onSubagentCompleted: (r) => notifications.sendCompletion(r) },
  });
  // The spawning tool call runs inside a parent agent run, so nudges are
  // withheld until it settles.
  notifications.onParentAgentStart();
  const id = spawnBgWithToolCall(manager, "tc-1");
  const record = manager.getRecord(id)!;
  return { manager, record, notifications, sendMessage };
}

/** A foreground spawn whose session creation is held open until openGate(). */
function seedForegroundNotificationScenario() {
  const sendMessage = vi.fn();
  const notifications = new NotificationManager(sendMessage);
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
  const { manager } = createManager({
    observer: { onSubagentCompleted: (r) => notifications.sendCompletion(r) },
    createSubagentSession: vi.fn(async (_params: CreateSubagentSessionParams) => {
      await gate;
      return toSubagentSession(createSubagentSessionStub());
    }),
  });
  notifications.onParentAgentStart();
  const pending = spawnFg(manager);
  return { manager, notifications, sendMessage, pending, openGate };
}

describe("SubagentManager", () => {
  describe("spawn", () => {
    let manager: SubagentManager;

    afterEach(() => {
      manager.abortAll();
    });

    describe("type resolution", () => {
      it("stores the canonical type for case-variant input", () => {
        ({ manager } = createManager());

        const id = manager.spawn(STUB_SNAPSHOT, "explore", "test", {
          description: "d",
          background: { kind: "explicit", isBackground: true },
        });

        expect(manager.getRecord(id)!.type).toBe("Explore");
      });

      it("falls back to general-purpose for an unknown type", () => {
        ({ manager } = createManager());

        const id = manager.spawn(STUB_SNAPSHOT, "no-such-agent", "test", {
          description: "d",
          background: { kind: "explicit", isBackground: true },
        });

        expect(manager.getRecord(id)!.type).toBe("general-purpose");
      });

      it("throws for a known-but-disabled type", () => {
        ({ manager } = createManager({ registry: registryWith("Plan", { enabled: false }) }));

        expect(() =>
          manager.spawn(STUB_SNAPSHOT, "Plan", "test", {
            description: "d",
            background: { kind: "explicit", isBackground: true },
          }),
        ).toThrow('Agent type "Plan" is disabled');
      });

      it("reports the canonical casing in the disabled-agent error for case-insensitive input", () => {
        ({ manager } = createManager({ registry: registryWith("Plan", { enabled: false }) }));

        expect(() =>
          manager.spawn(STUB_SNAPSHOT, "plan", "test", {
            description: "d",
            background: { kind: "explicit", isBackground: true },
          }),
        ).toThrow('Agent type "Plan" is disabled');
      });

      it("does not create a record for a rejected spawn", () => {
        ({ manager } = createManager({ registry: registryWith("Plan", { enabled: false }) }));

        expect(() =>
          manager.spawn(STUB_SNAPSHOT, "Plan", "test", {
            description: "d",
            background: { kind: "explicit", isBackground: true },
          }),
        ).toThrow();

        expect(manager.listAgents()).toEqual([]);
      });
    });

    /**
     * onSubagentCreated fires only for a background agent, so it is the
     * discriminator here. Record status cannot serve: under the default
     * concurrency limit a background agent is admitted immediately and reaches
     * "running" too, so asserting on it passes whichever mode resolves.
     */
    describe("background-mode resolution", () => {
      let onCreated: Mock<(record: Subagent) => void>;

      function spawnExplore(background: AgentSpawnConfig["background"], runInBackground: boolean) {
        onCreated = vi.fn();
        ({ manager } = createManager({
          registry: registryWith("Explore", { runInBackground }),
          observer: { onSubagentCreated: onCreated },
        }));
        return manager.spawn(STUB_SNAPSHOT, "Explore", "test", { description: "d", background });
      }

      it("defers to frontmatter declaring background when the request is a default", () => {
        spawnExplore({ kind: "default", isBackground: false }, true);

        expect(onCreated).toHaveBeenCalledOnce();
      });

      it("defers to frontmatter declaring foreground when the request is a default", () => {
        spawnExplore({ kind: "default", isBackground: true }, false);

        expect(onCreated).not.toHaveBeenCalled();
      });

      it("ignores frontmatter declaring foreground when the request is explicit", () => {
        spawnExplore({ kind: "explicit", isBackground: true }, false);

        expect(onCreated).toHaveBeenCalledOnce();
      });

      it("ignores frontmatter declaring background when the request is explicit", () => {
        spawnExplore({ kind: "explicit", isBackground: false }, true);

        expect(onCreated).not.toHaveBeenCalled();
      });

      it("stamps the resolved mode on the record when it resolves to background", () => {
        const id = spawnExplore({ kind: "default", isBackground: false }, true);

        expect(manager.getRecord(id)!.isBackground).toBe(true);
      });

      it("stamps the resolved mode on the record when it resolves to foreground", () => {
        const id = spawnExplore({ kind: "default", isBackground: true }, false);

        expect(manager.getRecord(id)!.isBackground).toBe(false);
      });

      it("queues a resolved-background agent behind a full concurrency limit", () => {
        onCreated = vi.fn();
        ({ manager } = createManager({
          registry: registryWith("Explore", { runInBackground: true }),
          getMaxConcurrent: () => 1,
          createSubagentSession: createBlockingFactory(),
        }));
        spawnBg(manager, "occupies-the-only-slot");

        const id = manager.spawn(STUB_SNAPSHOT, "Explore", "test", {
          description: "d",
          background: { kind: "default", isBackground: false },
        });

        expect(manager.getRecord(id)!.status).toBe("queued");
      });
    });
  });

  describe("spawnAndWait", () => {
    let manager: SubagentManager;

    afterEach(() => {
      manager.abortAll();
    });

    describe("type resolution", () => {
      it("stores the canonical type for case-variant input", async () => {
        ({ manager } = createManager());

        const record = await manager.spawnAndWait(STUB_SNAPSHOT, "explore", "test", { description: "d" });

        expect(record.type).toBe("Explore");
      });

      it("rejects for a known-but-disabled type", async () => {
        ({ manager } = createManager({ registry: registryWith("Plan", { enabled: false }) }));

        await expect(
          manager.spawnAndWait(STUB_SNAPSHOT, "Plan", "test", { description: "d" }),
        ).rejects.toThrow('Agent type "Plan" is disabled');
      });
    });

    describe("foreground commitment", () => {
      it("stamps isBackground false on the record", async () => {
        ({ manager } = createManager({ registry: registryWith("Explore", { runInBackground: true }) }));

        const record = await manager.spawnAndWait(STUB_SNAPSHOT, "Explore", "test", { description: "d" });

        expect(record.isBackground).toBe(false);
      });

      it("stays foreground for an agent whose frontmatter declares runInBackground: true", async () => {
        const onCreated = vi.fn();
        ({ manager } = createManager({
          registry: registryWith("Explore", { runInBackground: true }),
          observer: { onSubagentCreated: onCreated },
        }));

        const record = await manager.spawnAndWait(STUB_SNAPSHOT, "Explore", "test", { description: "d" });

        // The caller holds the result promise, so the frontmatter must not route
        // it through the limiter or announce it as a background agent.
        expect(record.status).toBe("completed");
        expect(onCreated).not.toHaveBeenCalled();
      });

      it("claims the outcome before the run can terminate", async () => {
        // Hold session creation open so the claim is observable while the run is
        // still in flight — the window in which the nudge would otherwise fire.
        const { promise: gate, resolve: openGate } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
        ({ manager } = createManager({
          createSubagentSession: vi.fn(async (_params: CreateSubagentSessionParams) => {
            await gate;
            return toSubagentSession(createSubagentSessionStub());
          }),
        }));

        const pending = manager.spawnAndWait(STUB_SNAPSHOT, "Explore", "test", { description: "d" });

        expect(manager.listAgents()[0]?.claimed).toBe(true);

        openGate();
        const record = await pending;
        expect(record.claimed).toBe(true);
      });

      it("runs immediately rather than queueing behind a full concurrency limit", async () => {
        // Only the first session creation blocks, so the background agent holds
        // the single limiter slot open while the foreground agent runs.
        let creations = 0;
        const factory = vi.fn((_params: CreateSubagentSessionParams) => {
          creations += 1;
          return creations === 1
            ? createBlockingFactory()(_params)
            : Promise.resolve(toSubagentSession(createSubagentSessionStub()));
        });
        ({ manager } = createManager({
          registry: registryWith("Explore", { runInBackground: true }),
          getMaxConcurrent: () => 1,
          createSubagentSession: factory,
        }));
        spawnBg(manager, "occupies-the-only-slot");

        // Were this routed through the limiter, the await would never settle.
        const record = await manager.spawnAndWait(STUB_SNAPSHOT, "Explore", "test", { description: "d" });

        expect(record.status).toBe("completed");
      });
    });
  });

  describe("concurrency", () => {
    describe("queueing with injected stubs", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("queues excess background agents and drains them in order", async () => {
        const startOrder: string[] = [];
        const { promise: gate1, resolve: resolve1 } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
        const { promise: gate2, resolve: resolve2 } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

        let callCount = 0;
        const factory: SessionFactory = vi.fn(async () => {
          callCount++;
          const n = callCount;
          startOrder.push(`start-${n}`);
          const stub = createSubagentSessionStub();
          stub.runTurnLoop.mockImplementation(async () => {
            if (n === 1) await gate1;
            if (n === 2) await gate2;
            return { responseText: `result-${n}`, aborted: false, steered: false };
          });
          return toSubagentSession(stub);
        });
        ({ manager } = createManager({ createSubagentSession: factory, getMaxConcurrent: () => 1 }));

        // Spawn two background agents — first runs, second queues
        const id1 = spawnBg(manager, "test1", "first");
        const id2 = spawnBg(manager, "test2", "second");

        expect(manager.getRecord(id1)!.status).toBe("running");
        expect(manager.getRecord(id2)!.status).toBe("queued");

        // Complete first agent — second should start
        resolve1();
        await manager.getRecord(id1)!.promise;

        // Wait for the second to start
        await vi.waitFor(() => expect(manager.getRecord(id2)!.status).toBe("running"));

        resolve2();
        await manager.getRecord(id2)!.promise;

        expect(startOrder).toEqual(["start-1", "start-2"]);
        expect(manager.getRecord(id1)!.result).toBe("result-1");
        expect(manager.getRecord(id2)!.result).toBe("result-2");
      });

      it("gives a queued agent an awaitable promise at spawn (before its slot opens)", () => {
        const { manager: mgr, running, queued } = arrangeQueuedPair();
        manager = mgr;

        // A still-queued agent must already expose a settle-on-completion promise,
        // so waitForAll can await it without relying on a re-poll. (Regression
        // guard: #374 made the promise lazy; the limiter handle is captured eagerly.)
        expect(manager.getRecord(queued)!.status).toBe("queued");
        expect(manager.getRecord(queued)!.promise).toBeInstanceOf(Promise);

        manager.abort(running);
        manager.abort(queued);
      });

      it("abort removes a queued agent without ever running it", () => {
        const { manager: mgr, factory, running, queued } = arrangeQueuedPair();
        manager = mgr;

        expect(manager.getRecord(queued)!.status).toBe("queued");

        // Abort the queued agent
        expect(manager.abort(queued)).toBe(true);
        expect(manager.getRecord(queued)!.status).toBe("stopped");

        // factory was called once (for the first agent), never for the aborted one
        expect(factory).toHaveBeenCalledOnce();

        manager.abort(running);
      });

      it("onStart fires when agent transitions from queued to running", async () => {
        const startedIds: string[] = [];
        const { promise: gate, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

        let callCount = 0;
        const factory: SessionFactory = vi.fn(async () => {
          callCount++;
          const n = callCount;
          const stub = createSubagentSessionStub();
          stub.runTurnLoop.mockImplementation(async () => {
            if (n === 1) await gate;
            return { responseText: "ok", aborted: false, steered: false };
          });
          return toSubagentSession(stub);
        });
        ({ manager } = createManager({
          createSubagentSession: factory,
          getMaxConcurrent: () => 1,
          observer: { onSubagentStarted: (record) => { startedIds.push(record.id); } },
        }));

        const id1 = spawnBg(manager, "a");
        const id2 = spawnBg(manager, "b");

        // First agent started immediately
        expect(startedIds).toEqual([id1]);

        // Complete first — second should start and fire onStart
        resolve();
        await manager.getRecord(id1)!.promise;
        await vi.waitFor(() => expect(startedIds).toHaveLength(2));

        expect(startedIds).toEqual([id1, id2]);

        await manager.getRecord(id2)!.promise;
      });
    });

    // Diagnosis, boundary, and these three cases contributed by @daoguademeng in #665.
    describe("stopping a queued agent", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("abort() on a queued agent notifies onSubagentCompleted", () => {
        const completed: Subagent[] = [];
        const { manager: mgr, running, queued } = arrangeQueuedPair({
          onSubagentCompleted: (record) => completed.push(record),
        });
        manager = mgr;

        expect(manager.abort(queued)).toBe(true);

        expect(completed).toHaveLength(1);
        expect(completed[0]).toBe(manager.getRecord(queued));
        expect(manager.getRecord(queued)!.status).toBe("stopped");
        expect(manager.getRecord(queued)!.stoppedWhileQueued).toBe(true);

        manager.abort(running);
      });

      it("abortAll() notifies onSubagentCompleted for queued agents", () => {
        const completed: Subagent[] = [];
        const { manager: mgr, queued } = arrangeQueuedPair({
          onSubagentCompleted: (record) => completed.push(record),
        });
        manager = mgr;

        expect(manager.abortAll()).toBe(2);

        // Only the queued agent notifies here: the running one's session creation
        // never resolves, so its run never reaches completeRun/failRun.
        expect(completed).toHaveLength(1);
        expect(completed[0]).toBe(manager.getRecord(queued));
        expect(manager.getRecord(queued)!.stoppedWhileQueued).toBe(true);
      });

      it("notifies exactly once, even after the stopped agent's slot frees", async () => {
        const completed: Subagent[] = [];
        const { promise: gate, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

        let callCount = 0;
        const factory: SessionFactory = vi.fn(async () => {
          callCount++;
          const n = callCount;
          const stub = createSubagentSessionStub();
          stub.runTurnLoop.mockImplementation(async () => {
            if (n === 1) await gate;
            return { responseText: `result-${n}`, aborted: false, steered: false };
          });
          return toSubagentSession(stub);
        });
        ({ manager } = createManager({
          createSubagentSession: factory,
          getMaxConcurrent: () => 1,
          observer: { onSubagentCompleted: (record) => completed.push(record) },
        }));

        const running = spawnBg(manager, "a");
        const queued = spawnBg(manager, "b");
        expect(manager.getRecord(queued)!.status).toBe("queued");

        manager.abort(queued);
        const notificationsFor = (id: string) => completed.filter((record) => record.id === id);
        expect(notificationsFor(queued)).toHaveLength(1);

        // Free the slot. The limiter runs the stopped agent's thunk, which must
        // no-op on guardedRun()'s active guard rather than run and notify again.
        resolve();
        await manager.getRecord(running)!.promise;
        await manager.getRecord(queued)!.promise;

        expect(notificationsFor(queued)).toHaveLength(1);
        expect(factory).toHaveBeenCalledOnce();
      });
    });
  });

  describe("observer notifications", () => {
    describe("completion callbacks", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("does not let onComplete errors turn a completed agent into a failed run", async () => {
        ({ manager } = createManager({ observer: { onSubagentCompleted: () => {
          throw new Error("stale extension context");
        } } }));

        const id = spawnBg(manager);
        await expect(manager.getRecord(id)!.promise).resolves.toBeUndefined();

        expect(manager.getRecord(id)!.status).toBe("completed");
      });
    });

    describe("onSubagentCreated", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("fires onSubagentCreated when a background agent is spawned", () => {
        const onCreated = vi.fn();
        ({ manager } = createManager({ observer: { onSubagentCreated: onCreated } }));

        const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "test agent",
          background: { kind: "explicit", isBackground: true },
        });

        expect(onCreated).toHaveBeenCalledOnce();
        expect(onCreated).toHaveBeenCalledWith(manager.getRecord(id));

        manager.abort(id);
      });

      it("does not fire onSubagentCreated for foreground agents", async () => {
        const onCreated = vi.fn();
        ({ manager } = createManager({ observer: { onSubagentCreated: onCreated } }));

        await manager.spawnAndWait(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "foreground agent",
        });

        expect(onCreated).not.toHaveBeenCalled();
      });

      it("fires onSubagentCreated before onSubagentStarted for background agents", async () => {
        const callOrder: string[] = [];
        ({ manager } = createManager({
          observer: {
            onSubagentCreated: () => { callOrder.push("created"); },
            onSubagentStarted: () => { callOrder.push("started"); },
          },
        }));

        const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "bg agent",
          background: { kind: "explicit", isBackground: true },
        });
        await manager.getRecord(id)!.promise;

        expect(callOrder).toEqual(["created", "started"]);
      });
    });

    describe("lifecycle observer forwarding", () => {
      let manager: SubagentManager;

      beforeEach(() => {
        const { factory } = createSessionFactory(createMockSession());
        ({ manager } = createManager({ createSubagentSession: factory }));
      });

      afterEach(async () => {
        await manager.dispose();
      });

      it("forwards onSessionCreated from spawn options observer to Agent", async () => {
        const received: { agent: Subagent | undefined } = { agent: undefined };

        const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "test",
          background: { kind: "explicit", isBackground: true },
          observer: {
            onSessionCreated: (agent) => {
              received.agent = agent;
            },
          },
        });
        await manager.getRecord(id)!.promise;

        expect(received.agent).toBe(manager.getRecord(id));
        expect(received.agent!.id).toBe(id);
      });

      it("forwards onSessionCreated for foreground agents", async () => {
        const received: { agent: Subagent | undefined } = { agent: undefined };

        await manager.spawnAndWait(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "fg",
          observer: {
            onSessionCreated: (agent) => {
              received.agent = agent;
            },
          },
        });

        expect(received.agent).toBeDefined();
        expect(received.agent!.type).toBe("general-purpose");
      });
    });

    describe("toolCallId notification wiring", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("wires toolCallId on spawn when provided", () => {
        ({ manager } = createManager());

        const id = spawnBgWithToolCall(manager, "tc-42", "test", "bg");
        const record = manager.getRecord(id)!;

        expect(record.toolCallId).toBe("tc-42");
        manager.abort(id);
      });

      it("toolCallId is undefined when absent", () => {
        ({ manager } = createManager());

        const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "bg",
          background: { kind: "explicit", isBackground: true },
        });
        const record = manager.getRecord(id)!;

        expect(record.toolCallId).toBeUndefined();
        manager.abort(id);
      });
    });

    describe("consumed state versus onComplete ordering", () => {
      let manager: SubagentManager;

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(async () => {
        await manager.dispose();
        vi.useRealTimers();
      });

      it("marking consumed after awaiting still suppresses the nudge (flush-time re-check)", async () => {
        const seeded = seedNotificationScenario();
        manager = seeded.manager;
        const { record, sendMessage } = seeded;

        // onSubagentCompleted already withheld the nudge by the time this await
        // resumes (it fires synchronously inside record.promise's resolution
        // chain). The parent pulls the result (markConsumed) later in the same
        // run; the notification manager re-reads record.consumed when the run
        // settles and drops the nudge — no separate cancel call needed.
        await record.promise;
        record.markConsumed();

        seeded.notifications.onParentAgentSettled();
        expect(sendMessage).not.toHaveBeenCalled();
      });

      it("marking consumed before await suppresses the nudge (schedule-time guard)", async () => {
        const seeded = seedNotificationScenario();
        manager = seeded.manager;
        const { record, sendMessage } = seeded;

        // The parent already holds the result: sendCompletion sees record.consumed
        // at enqueue time and never withholds a nudge to flush.
        record.markConsumed();
        await record.promise;

        seeded.notifications.onParentAgentSettled();
        expect(sendMessage).not.toHaveBeenCalled();
      });

      it("onComplete is called for foreground agents", async () => {
        let onCompleteCalled = false;
        ({ manager } = createManager({ observer: { onSubagentCompleted: () => {
          onCompleteCalled = true;
        } } }));

        await spawnFg(manager);

        // The lifecycle event and the session-history record are facts about the
        // run, owed for every agent; only the nudge is conditional.
        expect(onCompleteCalled).toBe(true);
      });

      it("sends no nudge for a foreground completion", async () => {
        const seeded = seedForegroundNotificationScenario();
        manager = seeded.manager;

        seeded.openGate();
        await seeded.pending;
        seeded.notifications.onParentAgentSettled();

        expect(seeded.sendMessage).not.toHaveBeenCalled();
      });

      it("sends no nudge when the parent turn is interrupted before a foreground agent terminates", async () => {
        const seeded = seedForegroundNotificationScenario();
        manager = seeded.manager;

        // The parent's turn ends while the child is still running, so the flush
        // finds nothing pending and stops withholding. The agent then terminates
        // with no run active — the window the consumption re-check cannot cover,
        // because markConsumed has not run yet either.
        seeded.notifications.onParentAgentSettled();
        seeded.openGate();
        await seeded.pending;

        expect(seeded.sendMessage).not.toHaveBeenCalled();
      });
    });
  });

  describe("session retention and teardown", () => {
    describe("cleanup timer", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("does not keep the process alive on its own", () => {
        ({ manager } = createManager());

        expect((manager as any).sweepInterval.hasRef()).toBe(false);
      });
    });

    describe("evictTerminalSessions", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("evictTerminalSessions keeps completed records but evicts their sessions", async () => {
        ({ manager } = createManager());

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        expect(manager.listAgents()).toHaveLength(1);
        await manager.evictTerminalSessions();
        // Durable: the record survives, only the heavy session is gone.
        expect(manager.listAgents()).toHaveLength(1);
        expect(manager.getRecord(id)!.isSessionReady()).toBe(false);
      });

      it("evictTerminalSessions does not touch running or queued agents", async () => {
        // Use maxConcurrent=1 to keep second agent queued; factory never resolves
        ({ manager } = createManager({ getMaxConcurrent: () => 1, createSubagentSession: createBlockingFactory() }));

        const id1 = spawnBg(manager, "test1", "running agent");
        // Second agent should be queued (limit=1)
        const id2 = spawnBg(manager, "test2", "queued agent");

        expect(manager.getRecord(id1)!.status).toBe("running");
        expect(manager.getRecord(id2)!.status).toBe("queued");

        await manager.evictTerminalSessions();

        // Both should still be present
        expect(manager.getRecord(id1)).toBeDefined();
        expect(manager.getRecord(id2)).toBeDefined();

        // Abort to allow cleanup
        manager.abort(id1);
        manager.abort(id2);
      });

      it("evictTerminalSessions calls dispose on evicted sessions", async () => {
        const disposeSpy = vi.fn();
        const sess = createMockSession({ dispose: disposeSpy });
        const { factory } = createSessionFactory(sess);
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        await manager.evictTerminalSessions();

        expect(disposeSpy).toHaveBeenCalledOnce();
      });

      it("evictTerminalSessions evicts error and stopped records but keeps them", async () => {
        const { factory, stub } = createSessionFactory();
        stub.runTurnLoop.mockRejectedValue(new Error("boom"));
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        expect(manager.getRecord(id)!.status).toBe("error");

        await manager.evictTerminalSessions();
        expect(manager.getRecord(id)).toBeDefined();
        expect(manager.getRecord(id)!.isSessionReady()).toBe(false);
      });
    });

    describe("teardown awaits each child's shutdown", () => {
      let manager: SubagentManager;

      /** A manager holding one completed agent whose teardown the test controls. */
      async function seedGatedTeardown() {
        const { factory, stub } = createSessionFactory();
        const teardown = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
        stub.dispose = vi.fn((): Promise<void> => teardown.promise);
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        return { id, teardown, stub };
      }

      it("evictTerminalSessions resolves only after the evicted record's teardown settles", async () => {
        const { teardown } = await seedGatedTeardown();

        let settled = false;
        const pending = manager.evictTerminalSessions().then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        teardown.resolve();
        await pending;
        expect(settled).toBe(true);
      });

      it("evictTerminalSessions keeps the record while its teardown settles", async () => {
        const { id, teardown } = await seedGatedTeardown();

        const pending = manager.evictTerminalSessions();
        expect(manager.getRecord(id)).toBeDefined();

        teardown.resolve();
        await pending;
      });

      it("dispose resolves only after every record's teardown settles", async () => {
        const { teardown } = await seedGatedTeardown();

        let settled = false;
        const pending = manager.dispose().then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        teardown.resolve();
        await pending;
        expect(settled).toBe(true);
      });

      it("dispose tears down every record even when one teardown rejects", async () => {
        const failing = createSessionFactory();
        failing.stub.dispose = vi.fn((): Promise<void> => Promise.reject(new Error("teardown failed")));
        const healthy = createSessionFactory();
        const factories = [failing.factory, healthy.factory];
        ({ manager } = createManager({
          createSubagentSession: vi.fn(async (params: CreateSubagentSessionParams) =>
            (factories.shift() ?? healthy.factory)(params),
          ),
        }));

        const first = spawnBg(manager, "test1", "first");
        const second = spawnBg(manager, "test2", "second");
        await manager.getRecord(first)!.promise;
        await manager.getRecord(second)!.promise;

        await expect(manager.dispose()).resolves.toBeUndefined();
        expect(failing.stub.dispose).toHaveBeenCalledOnce();
        expect(healthy.stub.dispose).toHaveBeenCalledOnce();
        expect(manager.listAgents()).toHaveLength(0);
      });
    });

    describe("idle session eviction sweep", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        vi.restoreAllMocks();
        await manager.dispose();
      });

      /** Spawn a background agent over a session factory and await its completion. */
      async function spawnCompleted(
        outputFile: string | undefined = "/tasks/agent.jsonl",
      ): Promise<string> {
        const { factory } = createSessionFactory(createMockSession(), outputFile);
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager, "test", "investigate the bug");
        await manager.getRecord(id)!.promise;
        return id;
      }

      it("holds a fresh terminal session and evicts it after the idle window", async () => {
        const id = await spawnCompleted("/tasks/agent.jsonl");
        const completedAt = manager.getRecord(id)!.completedAt!;

        manager.evictIdleSessions(completedAt + SESSION_EVICT_IDLE_MS - 1);
        expect(manager.getRecord(id)!.isSessionReady()).toBe(true);

        manager.evictIdleSessions(completedAt + SESSION_EVICT_IDLE_MS);
        const evicted = manager.getRecord(id)!;
        expect(evicted).toBeDefined();
        expect(evicted.isSessionReady()).toBe(false);
        expect(evicted.outputFile).toBe("/tasks/agent.jsonl");
      });

      it("evicts regardless of consumption — eviction is memory hygiene, not lifetime", async () => {
        const id = await spawnCompleted("/tasks/agent.jsonl");
        const record = manager.getRecord(id)!;
        const completedAt = record.completedAt!;
        record.markConsumed(completedAt);

        manager.evictIdleSessions(completedAt + SESSION_EVICT_IDLE_MS);
        expect(manager.getRecord(id)!.isSessionReady()).toBe(false);
        // The record (and its result) survives eviction.
        expect(manager.getRecord(id)!.result).toBe(record.result);
      });

      it("never evicts a running or queued agent's session", async () => {
        ({ manager } = createManager({ getMaxConcurrent: () => 1, createSubagentSession: createBlockingFactory() }));
        const runningId = spawnBg(manager, "t1");
        const queuedId = spawnBg(manager, "t2");
        expect(manager.getRecord(runningId)!.status).toBe("running");
        expect(manager.getRecord(queuedId)!.status).toBe("queued");
        const runRelease = vi.spyOn(manager.getRecord(runningId)!, "releaseSession");
        const queueRelease = vi.spyOn(manager.getRecord(queuedId)!, "releaseSession");

        manager.evictIdleSessions(Date.now() + 10_000 * 60_000);

        expect(runRelease).not.toHaveBeenCalled();
        expect(queueRelease).not.toHaveBeenCalled();
        manager.abort(runningId);
        manager.abort(queuedId);
      });

      it("leaves records in place after eviction (getRecord still resolves them)", async () => {
        const id = await spawnCompleted("/tasks/agent.jsonl");
        const completedAt = manager.getRecord(id)!.completedAt!;
        manager.evictIdleSessions(completedAt + SESSION_EVICT_IDLE_MS);
        expect(manager.listAgents()).toHaveLength(1);
        expect(manager.getRecord(id)).toBeDefined();
      });
    });

    describe("subagent session state", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("sets record.subagentSession with session and outputFile after session creation", async () => {
        const session = createMockSession();
        const { factory } = createSessionFactory(session, "/tmp/session.jsonl");
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        const record = manager.getRecord(id)!;
        expect(record.subagentSession).toBeDefined();
        expect(record.subagentSession!.session).toBe(session);
        expect(record.subagentSession!.outputFile).toBe("/tmp/session.jsonl");
      });

      it("record.subagentSession is undefined before the session is created", () => {
        ({ manager } = createManager({ createSubagentSession: createBlockingFactory() }));

        const id = spawnBg(manager);
        const record = manager.getRecord(id)!;
        expect(record.subagentSession).toBeUndefined();
        manager.abort(id);
      });
    });
  });

  describe("record initialization", () => {
    // Eager init removes the optional/required asymmetry that previously required
    // `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
    describe("lifetime usage and compaction count are eagerly initialized", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
        // Factory never resolves — we just want to inspect the record at spawn time.
        ({ manager } = createManager({ createSubagentSession: createBlockingFactory() }));

        const id = spawnBg(manager);
        const record = manager.getRecord(id)!;

        expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
        expect(record.compactionCount).toBe(0);

        manager.abort(id);
      });

      it("record observer accumulates assistant usage into record.lifetimeUsage", async () => {
        // The record observer subscribes to session events via the wired subagentSession.
        // Emitting message_end events from runTurnLoop drives stats.
        const session = createMockSession();
        const { factory, stub } = createSessionFactory(session);
        stub.runTurnLoop.mockImplementation(async () => {
          session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } } });
          session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } } });
          return { responseText: "done", aborted: false, steered: false };
        });
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
          input: 300, output: 130, cacheWrite: 30,
        });
      });

      it("record observer increments compactionCount on compaction_end events", async () => {
        const compactSeen: any[] = [];

        const session = createMockSession();
        const { factory, stub } = createSessionFactory(session);
        stub.runTurnLoop.mockImplementation(async () => {
          // Compaction fires while the agent is still running — the record passed to
          // onCompact should reflect the just-incremented count.
          session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 12345 }, reason: "threshold" });
          session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 22222 }, reason: "manual" });
          return { responseText: "done", aborted: false, steered: false };
        });

        ({ manager } = createManager({ createSubagentSession: factory, observer: { onSubagentCompacted: (record, info) => {
          compactSeen.push({ count: record.compactionCount, reason: info.reason });
        } } }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        expect(compactSeen).toEqual([
          { count: 1, reason: "threshold" },
          { count: 2, reason: "manual" },
        ]);
        expect(manager.getRecord(id)!.compactionCount).toBe(2);
      });

      it("resume() also accumulates usage and increments compactions on the same record", async () => {
        // Spawn with a subscribable session that resume can latch onto.
        const session = createMockSession();
        const { factory, stub } = createSessionFactory(session);
        stub.resumeTurnLoop.mockImplementation(async () => {
          // Emit events through the session — the record observer subscribed by
          // SubagentManager.resume() will pick them up.
          emitResumeUsageAndCompaction(session);
          return "second";
        });
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        // Pre-resume: lifetimeUsage from spawn was zero (run did not emit usage events)
        expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
        expect(manager.getRecord(id)!.compactionCount).toBe(0);

        await manager.resume(id, "more");

        expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
        expect(manager.getRecord(id)!.compactionCount).toBe(1);
      });
    });

    describe("getRunConfig threads defaultMaxTurns and graceTurns into the turn loop", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("passes defaultMaxTurns and graceTurns from getRunConfig to runTurnLoop", async () => {
        const getRunConfig = vi.fn(() => ({ defaultMaxTurns: 10, graceTurns: 3, midRunUpdates: true }));
        const { factory, stub } = createSessionFactory();
        ({ manager } = createManager({ getRunConfig, createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        const turnOpts = stub.runTurnLoop.mock.calls[0][1];
        expect(turnOpts.defaultMaxTurns).toBe(10);
        expect(turnOpts.graceTurns).toBe(3);
      });

      it("omits defaultMaxTurns and graceTurns from runTurnLoop when no getRunConfig is provided", async () => {
        const { factory, stub } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));

        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        const turnOpts = stub.runTurnLoop.mock.calls[0][1];
        expect(turnOpts.defaultMaxTurns).toBeUndefined();
        expect(turnOpts.graceTurns).toBeUndefined();
      });
    });

    describe("parent session threading", () => {
      let manager: SubagentManager;

      afterEach(async () => {
        await manager.dispose();
      });

      it("threads parentSession from AgentSpawnConfig to the factory params", async () => {
        const { factory } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));

        manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
          description: "test",
          background: { kind: "explicit", isBackground: true },
          parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "parent-session-123" },
        });

        await vi.waitFor(() => expect(factory).toHaveBeenCalled());

        const params = vi.mocked(factory).mock.calls[0][0];
        expect(params.parentSession?.parentSessionFile).toBe("/sessions/parent.jsonl");
        expect(params.parentSession?.parentSessionId).toBe("parent-session-123");
      });
    });
  });

  describe("dependency injection via options bag", () => {
    let manager: SubagentManager;

    afterEach(async () => {
      await manager.dispose();
    });

    it("calls the injected factory when spawning an agent", async () => {
      const { factory } = createSessionFactory();
      ({ manager } = createManager({ createSubagentSession: factory }));

      const id = spawnBg(manager);
      await manager.getRecord(id)!.promise;

      expect(factory).toHaveBeenCalledOnce();
      expect(manager.getRecord(id)!.result).toBe("done");
    });

    it("calls resumeTurnLoop on the SubagentSession when resuming an agent", async () => {
      const { factory, stub } = createSessionFactory();
      stub.resumeTurnLoop.mockResolvedValue("second");
      ({ manager } = createManager({ createSubagentSession: factory }));

      const id = spawnBg(manager);
      await manager.getRecord(id)!.promise;

      await manager.resume(id, "continue");

      expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
      expect(manager.getRecord(id)!.result).toBe("second");
    });

    it("fires onSubagentResumed when a background agent is resumed", async () => {
      const onSubagentResumed = vi.fn();
      const { factory, stub } = createSessionFactory();
      stub.resumeTurnLoop.mockResolvedValue("second");
      ({ manager } = createManager({ createSubagentSession: factory, observer: { onSubagentResumed } }));

      const id = spawnBg(manager);
      await manager.getRecord(id)!.promise;
      await manager.resume(id, "continue");

      expect(onSubagentResumed).toHaveBeenCalledExactlyOnceWith(manager.getRecord(id));
    });

    it("fires onSubagentResumed when a foreground agent is resumed", async () => {
      const onSubagentResumed = vi.fn();
      const { factory, stub } = createSessionFactory();
      stub.resumeTurnLoop.mockResolvedValue("second");
      ({ manager } = createManager({ createSubagentSession: factory, observer: { onSubagentResumed } }));

      const record = await spawnFg(manager);
      await manager.resume(record.id, "continue");

      // A resumed foreground run is a terminal transition like any other; whether
      // the parent is told is the notification layer's call, not this seam's.
      expect(onSubagentResumed).toHaveBeenCalledExactlyOnceWith(record);
    });

  });

  describe("registerWorkspaceProvider", () => {
    let manager: SubagentManager;

    afterEach(async () => {
      await manager.dispose();
    });

    function makeProvider(): WorkspaceProvider {
      return { prepare: vi.fn(async () => undefined) };
    }

    it("returns a disposer and exposes the registered provider via getter", () => {
      ({ manager } = createManager());
      const provider = makeProvider();

      const dispose = manager.registerWorkspaceProvider(provider);

      expect(typeof dispose).toBe("function");
      expect(manager.workspaceProvider).toBe(provider);
    });

    it("throws when a provider is already registered", () => {
      ({ manager } = createManager());
      manager.registerWorkspaceProvider(makeProvider());

      expect(() => manager.registerWorkspaceProvider(makeProvider())).toThrow(
        /already registered/i,
      );
    });

    it("disposer clears the slot, allowing re-registration", () => {
      ({ manager } = createManager());
      const first = makeProvider();
      const dispose = manager.registerWorkspaceProvider(first);

      dispose();

      expect(manager.workspaceProvider).toBeUndefined();
      const second = makeProvider();
      manager.registerWorkspaceProvider(second);
      expect(manager.workspaceProvider).toBe(second);
    });

    it("relays a held workspace's notice to the manager observer when the session is released", async () => {
      const onSubagentWorkspaceNotice = vi.fn<(record: Subagent, notice: string) => void>();
      const notice = "\n\n---\nChanges saved to branch `pi-agent-1`.";
      const stub = createSubagentSessionStub();
      let askParent: ((question: string) => void) | undefined;
      stub.runTurnLoop.mockImplementation(() => {
        askParent?.("Which config?");
        return Promise.resolve({ responseText: "Mapped them.", aborted: false, steered: false });
      });
      ({ manager } = createManager({
        createSubagentSession: vi.fn(async (params: CreateSubagentSessionParams) => {
          askParent = params.askParent;
          return toSubagentSession(stub);
        }),
        observer: { onSubagentWorkspaceNotice },
      }));
      manager.registerWorkspaceProvider({
        prepare: vi.fn(async () => ({
          cwd: "/ws/dir",
          dispose: vi.fn(() => ({ resultAddendum: notice })),
        })),
      });

      const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
        description: "held agent",
        background: { kind: "explicit", isBackground: true },
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      await record.releaseSession();

      expect(onSubagentWorkspaceNotice).toHaveBeenCalledExactlyOnceWith(record, notice);
    });

    it("stale disposer does not evict a later provider", () => {
      ({ manager } = createManager());
      const first = makeProvider();
      const disposeFirst = manager.registerWorkspaceProvider(first);
      disposeFirst();
      const second = makeProvider();
      manager.registerWorkspaceProvider(second);

      // Calling the first disposer again must not clear the second provider.
      disposeFirst();

      expect(manager.workspaceProvider).toBe(second);
    });
  });

  describe("resume", () => {
    let manager: SubagentManager;

    afterEach(async () => {
      await manager.dispose();
    });

    describe("refused", () => {
      it("reports an id no record answers to", async () => {
        ({ manager } = createManager());

        expect(await manager.resume("nope", "continue")).toEqual({
          kind: "refused",
          reason: "unknown-agent",
        });
      });

      it("reports a run that has not settled", async () => {
        ({ manager } = createManager({ createSubagentSession: createBlockingFactory() }));
        const id = spawnBg(manager);

        await vi.waitFor(() => expect(manager.getRecord(id)!.status).toBe("running"));

        expect(await manager.resume(id, "continue")).toEqual({
          kind: "refused",
          reason: "still-running",
        });
      });

      it("rehydrates an evicted session and resumes it", async () => {
        const { factory, stub } = createSessionFactory(
          createMockSession(),
          "/tasks/agent.jsonl",
        );
        stub.resumeTurnLoop.mockResolvedValue("second");
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        await manager.getRecord(id)!.releaseSession();
        expect(manager.getRecord(id)!.isSessionReady()).toBe(false);

        const outcome = await manager.resume(id, "continue");

        expect(outcome.kind).toBe("resumed");
        expect(manager.getRecord(id)!.isSessionReady()).toBe(true);
        expect(stub.resumeTurnLoop).toHaveBeenCalledWith("continue", expect.any(AbortSignal));
      });

      it("observes an evicted resume once and releases its observer on settlement", async () => {
        const { factory } = createSessionFactory(createMockSession(), "/tasks/agent.jsonl");
        const onSubagentCompacted = vi.fn();
        ({ manager } = createManager({ createSubagentSession: factory, observer: { onSubagentCompacted } }));
        const id = spawnBg(manager);
        const record = manager.getRecord(id)!;
        await record.promise;
        await record.releaseSession();

        const session = createMockSession();
        const resumed = createSubagentSessionStub(session, "/tasks/agent.jsonl");
        factory.mockResolvedValue(toSubagentSession(resumed));
        const emitProgress = () => {
          session.emit({ type: "tool_execution_end", toolName: "read" });
          session.emit({ type: "turn_end" });
          emitResumeUsageAndCompaction(session);
        };
        resumed.resumeTurnLoop.mockImplementation(async () => {
          emitProgress();
          return "done";
        });

        await manager.resume(id, "continue");

        expect(session.subscribe).toHaveBeenCalledOnce();
        // Turn count starts at one; the single turn_end advances it once.
        expect([record.toolUses, record.turnCount, record.compactionCount]).toEqual([1, 2, 1]);
        expect(record.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
        expect(onSubagentCompacted).toHaveBeenCalledOnce();

        emitProgress();
        expect([record.toolUses, record.turnCount, record.compactionCount]).toEqual([1, 2, 1]);
        expect(record.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
        expect(onSubagentCompacted).toHaveBeenCalledOnce();
      });

      it("waits for eviction teardown before reopening the same child", async () => {
        const { factory, stub } = createSessionFactory(createMockSession(), "/tasks/agent.jsonl");
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        const record = manager.getRecord(id)!;
        await record.promise;
        const teardown = Promise.withResolvers<void>();
        stub.dispose.mockReturnValueOnce(teardown.promise);
        const eviction = record.releaseSession();
        const resumed = manager.resume(id, "continue");
        try {
          await Promise.resolve();
          expect(factory).toHaveBeenCalledTimes(1);
          expect(stub.resumeTurnLoop).not.toHaveBeenCalled();
        } finally {
          teardown.resolve();
          await eviction;
          await resumed;
        }
        expect(factory).toHaveBeenCalledTimes(2);
      });

      it("rehydrates after the run controller was spent, without poisoning resume", async () => {
        const { factory, stub } = createSessionFactory(createMockSession(), "/tasks/agent.jsonl");
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        const record = manager.getRecord(id)!;
        record.abortController.abort(); // spend the original controller post-completion
        await record.releaseSession();
        factory.mockImplementation(async (params) => {
          expect(params.signal?.aborted).toBe(false);
          return toSubagentSession(stub);
        });
        stub.resumeTurnLoop.mockResolvedValue("second");

        expect(await manager.resume(id, "continue")).toEqual({ kind: "resumed", record });
        expect(record.status).toBe("completed");
      });

      it("reports a resumed run that failed to rehydrate as resumed, carrying the error", async () => {
        const { factory } = createSessionFactory(createMockSession(), "/tasks/agent.jsonl");
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        const record = manager.getRecord(id)!;
        await record.releaseSession();
        // Simulate a lost transcript: pointers reference nothing reopenable.
        record.markSessionEvicted("/tasks/gone.jsonl", "missing-child");
        factory.mockRejectedValueOnce(new Error("transcript gone"));

        const outcome = await manager.resume(id, "continue");

        expect(outcome.kind).toBe("resumed");
        expect(manager.getRecord(id)!.status).toBe("error");
      });

      it("reports a workspace torn down at run end, which the old guard let through", async () => {
        const { factory } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));
        manager.registerWorkspaceProvider(makeWorkspaceProvider(makeWorkspace("/ws/dir")));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        expect(await manager.resume(id, "continue")).toEqual({
          kind: "refused",
          reason: "workspace-disposed",
        });
      });

      it("starts no turn loop for a refused resume", async () => {
        // No outputFile on the stub: eviction leaves no transcript pointers,
        // so there is nothing to rehydrate and the refusal stands.
        const { factory, stub } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        await manager.getRecord(id)!.releaseSession();

        expect(await manager.resume(id, "continue")).toEqual({
          kind: "refused",
          reason: "no-session",
        });
        expect(stub.resumeTurnLoop).not.toHaveBeenCalled();
      });
    });

    describe("accepted", () => {
      it("returns the resumed record", async () => {
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockResolvedValue("second");
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        expect(await manager.resume(id, "continue")).toEqual({
          kind: "resumed",
          record: manager.getRecord(id),
        });
      });

      it("reports a resumed run that failed as resumed, carrying the error", async () => {
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockRejectedValue(new Error("resume exploded"));
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        const outcome = await manager.resume(id, "continue");

        expect(outcome.kind).toBe("resumed");
        expect(manager.getRecord(id)!.status).toBe("error");
      });

      it("leaves the outcome unclaimed by default", async () => {
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockResolvedValue("second");
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        await manager.resume(id, "continue");

        expect(manager.getRecord(id)!.claimed).toBe(false);
      });

      it("claims the outcome before the turn loop starts when the caller asks", async () => {
        const { factory, stub } = createSessionFactory();
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        const record = manager.getRecord(id)!;
        // resetForResume runs synchronously inside Subagent.resume(), so a claim
        // taken after the await would miss the terminal edge entirely.
        const { promise, resolve } = Promise.withResolvers<string>();
        stub.resumeTurnLoop.mockReturnValue(promise);

        const resumed = manager.resume(id, "continue", { claimOutcome: true });
        await vi.waitFor(() => expect(stub.resumeTurnLoop).toHaveBeenCalled());

        expect(record.claimed).toBe(true);
        resolve("second");
        await resumed;
      });

      it("tells the observer a resume started, before it reports one finished", async () => {
        const calls: string[] = [];
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockResolvedValue("second");
        ({ manager } = createManager({
          createSubagentSession: factory,
          observer: {
            onSubagentResuming: () => calls.push("resuming"),
            onSubagentResumed: () => calls.push("resumed"),
          },
        }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;

        await manager.resume(id, "continue");

        expect(calls).toEqual(["resuming", "resumed"]);
      });

      it("forwards the caller's signal to the resumed turn loop", async () => {
        const { factory, stub } = createSessionFactory();
        stub.resumeTurnLoop.mockResolvedValue("second");
        ({ manager } = createManager({ createSubagentSession: factory }));
        const id = spawnBg(manager);
        await manager.getRecord(id)!.promise;
        const signal = new AbortController().signal;

        await manager.resume(id, "continue", { signal });

        expect(stub.resumeTurnLoop).toHaveBeenCalledWith("continue", expect.any(AbortSignal));
        expect(stub.resumeTurnLoop.mock.calls[0][1]?.aborted).toBe(signal.aborted);
      });
    });
  });
});

describe("restoredAgentsFromEntries", () => {
  const recordEntry = (data: Record<string, unknown>, id = "e1") => ({
    type: "custom" as const,
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "subagents:record" as const,
    data,
  });

  it("parses a terminal record with transcript pointers and attribution", () => {
    const inits = restoredAgentsFromEntries([
      recordEntry({
        id: "a1",
        type: "general-purpose",
        description: "old work",
        status: "completed",
        startedAt: 1000,
        completedAt: 2000,
        result: "done",
        isBackground: true,
        modelId: "test/model",
        thinkingLevel: "high",
        maxTurns: 10,
        outputFile: "/tasks/a.jsonl",
        childSessionId: "child-1",
        toolUses: 3,
        turnCount: 5,
      }),
    ]);
    expect(inits).toEqual([
      {
        id: "a1",
        type: "general-purpose",
        description: "old work",
        status: "completed",
        isBackground: true,
        startedAt: 1000,
        completedAt: 2000,
        result: "done",
        modelId: "test/model",
        thinkingLevel: "high",
        maxTurns: 10,
        outputFile: "/tasks/a.jsonl",
        childSessionId: "child-1",
        toolUses: 3,
        turnCount: 5,
      },
    ]);
  });

  it("lets the last record per id win", () => {
    const inits = restoredAgentsFromEntries([
      recordEntry({ id: "a1", type: "general-purpose", description: "old", status: "running" }, "e1"),
      recordEntry({ id: "a1", type: "general-purpose", description: "new", status: "completed", result: "done" }, "e2"),
    ]);
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({ id: "a1", description: "new", status: "completed" });
  });

  it("skips corrupt entries, unknown statuses, and other custom types", () => {
    const inits = restoredAgentsFromEntries([
      recordEntry({ id: "a1", type: "general-purpose", description: "ok", status: "completed" }),
      recordEntry({ id: "", type: "general-purpose", description: "no id", status: "completed" }, "e2"),
      recordEntry({ id: "a3", type: "general-purpose", description: "bogus", status: "teleporting" }, "e3"),
      {
        type: "custom" as const,
        id: "e4",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "other:thing" as const,
        data: { id: "a4" },
      },
    ]);
    expect(inits.map((init) => init.id)).toEqual(["a1"]);
  });
});

describe("restoreAgents", () => {
  let manager: SubagentManager;

  afterEach(async () => {
    await manager.dispose();
  });

  function managerWithSnapshot() {
    return createManager({ getParentSnapshot: () => STUB_SNAPSHOT });
  }

  const parent = { parentSessionId: "parent-1", parentSessionFile: "/sessions/parent.jsonl" };

  function terminalInit(overrides: Partial<RestoredAgentInit> = {}): RestoredAgentInit {
    return {
      id: "a1",
      type: "general-purpose",
      description: "old work",
      status: "completed",
      isBackground: true,
      startedAt: 1000,
      completedAt: 2000,
      result: "done",
      outputFile: "/sessions/parent/tasks/a.jsonl",
      childSessionId: "child-1",
      ...overrides,
    };
  }

  it("materializes a terminal record evicted, with result and pointers", () => {
    ({ manager } = managerWithSnapshot());
    expect(manager.restoreAgents(parent, [terminalInit()])).toBe(1);
    const record = manager.getRecord("a1")!;
    expect(record.status).toBe("completed");
    expect(record.result).toBe("done");
    expect(record.isSessionReady()).toBe(false);
    expect(record.canRehydrate()).toBe(true);
    expect(record.outputFile).toBe("/sessions/parent/tasks/a.jsonl");
    expect(record.childSessionId).toBe("child-1");
  });

  it.each([
    "/sessions/original/tasks/a.jsonl",
    "/sessions/parent/tasks/../../original/tasks/a.jsonl",
    "relative.jsonl",
  ])("does not resume copied metadata pointing outside this parent's storage: %s", async (outputFile) => {
    ({ manager } = managerWithSnapshot());
    expect(manager.restoreAgents(parent, [terminalInit({ outputFile })])).toBe(1);
    const record = manager.getRecord("a1")!;
    expect(record.result).toBe("done");
    expect(record.canRehydrate()).toBe(false);
    expect(await manager.resume("a1", "continue")).toEqual({ kind: "refused", reason: "no-session" });
  });

  it("restores the pending ask-back question", () => {
    ({ manager } = managerWithSnapshot());
    manager.restoreAgents(parent, [terminalInit({ pendingQuestion: "Which config?" })]);
    expect(manager.getRecord("a1")!.pendingQuestion).toBe("Which config?");
  });

  it("converts a saved running record with pointers into an interrupted error", () => {
    ({ manager } = managerWithSnapshot());
    manager.restoreAgents(parent, [terminalInit({ status: "running", result: undefined })]);
    const record = manager.getRecord("a1")!;
    expect(record.status).toBe("error");
    expect(record.error).toContain("interrupted");
    expect(record.canRehydrate()).toBe(true);
  });

  it("skips a saved running record with nothing to rehydrate", () => {
    ({ manager } = managerWithSnapshot());
    expect(
      manager.restoreAgents(parent, [terminalInit({ status: "queued", outputFile: undefined, childSessionId: undefined })]),
    ).toBe(0);
    expect(manager.getRecord("a1")).toBeUndefined();
  });

  it("never replaces a live record", async () => {
    ({ manager } = managerWithSnapshot());
    const liveId = spawnBg(manager, "live");
    const live = manager.getRecord(liveId)!;
    expect(
      manager.restoreAgents(parent, [terminalInit({ id: liveId, description: "stale" })]),
    ).toBe(0);
    expect(manager.getRecord(liveId)).toBe(live);
    manager.abort(liveId);
  });

  it("restores nothing without a parent snapshot", () => {
    ({ manager } = createManager());
    expect(manager.restoreAgents(parent, [terminalInit()])).toBe(0);
    expect(manager.getRecord("a1")).toBeUndefined();
  });
});

it("announces the transcript pointer while the child is still running", async () => {
  const { factory, stub } = createSessionFactory(
    createMockSession(),
    "/sessions/parent/tasks/child.jsonl",
  );
  const gate = Promise.withResolvers<void>();
  stub.runTurnLoop.mockImplementation(async () => {
    await gate.promise;
    return { responseText: "done", aborted: false, steered: false };
  });
  const ready = vi.fn((agent: Subagent) => {
    expect(agent.outputFile).toBe("/sessions/parent/tasks/child.jsonl");
    expect(agent.status).toBe("running");
  });
  const { manager } = createManager({
    createSubagentSession: factory,
    observer: { onSubagentSessionCreated: ready },
  });
  try {
    const id = spawnBg(manager);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    expect(manager.getRecord(id)?.status).toBe("running");
  } finally {
    gate.resolve();
    await manager.waitForAll();
    await manager.dispose();
  }
});
