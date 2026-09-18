/**
 * Composition-root tests for `subagentsExtension(pi)`.
 *
 * These assert the wiring contract that unit tests cannot see: what the root's
 * `io.createSession` hands to the SDK. The replay logic itself is covered by
 * `test/session/provider-inheritance.test.ts`, but those tests pass whether or
 * not the root calls it — only this file fails if the wiring is removed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  interface Recorded {
    native: unknown[];
    configured: Array<[string, unknown]>;
  }
  const childRegistrations: Recorded = { native: [], configured: [] };
  const childRuntime = { marker: "child-runtime" };
  return {
    childRegistrations,
    childRuntime,
    createRuntime: vi.fn(async (_paths: { authPath: string; modelsPath: string }): Promise<unknown> => childRuntime),
    createAgentSession: vi.fn(
      async (_options: Record<string, unknown>): Promise<unknown> => ({
        session: { marker: "session" },
      }),
    ),
    // Stands in for `new ModelRegistry(runtime)`; records what the root replays.
    ModelRegistry: vi.fn(function (this: Record<string, unknown>, runtime: unknown) {
      this.runtimeGivenToRegistry = runtime;
      this.registerProvider = (a: unknown, b?: unknown) => {
        if (b === undefined) childRegistrations.native.push(a);
        else childRegistrations.configured.push([a as string, b]);
      };
    }),
  };
});

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual =
    await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
  return {
    ...actual,
    createAgentSession: sdk.createAgentSession,
    ModelRegistry: sdk.ModelRegistry,
    ModelRuntime: { create: sdk.createRuntime },
  };
});

vi.mock("#src/lifecycle/create-subagent-session", async () => {
  const actual = await vi.importActual<typeof import("#src/lifecycle/create-subagent-session")>(
    "#src/lifecycle/create-subagent-session",
  );
  return { ...actual, createSubagentSession: vi.fn() };
});

import subagentsExtension from "#src/index";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { NotificationManager } from "#src/observation/notification";
import { getSubagentsService } from "#src/service/service";
import { registerSubagentHost, requireSubagentHosts } from "#src/service/host";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "./helpers/mock-session";

const shutdowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  shutdowns.push(async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  });
  return {
    pi: {
      getThinkingLevel: vi.fn(() => "medium"),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        const registered = handlers.get(event);
        if (registered) registered.push(handler);
        else handlers.set(event, [handler]);
      }),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      exec: vi.fn(),
    } as any,
    tools,
    handlers,
    /**
     * Invoke every handler registered for `event`, in registration order.
     *
     * Pi fans an event out to all of one extension's handlers for it — "A single
     * extension may register multiple handlers for the same event" (the SDK's
     * `ExtensionRunner`). A fixture keyed one-handler-per-event would keep only the
     * last registration, hiding a second one instead of exercising it.
     */
    fire: async (event: string, ...args: any[]) => {
      for (const handler of handlers.get(event) ?? []) {
        await handler(...args);
      }
    },
  };
}

/** The parent registry the root reads runtime registrations from. */
function makeParentRegistry() {
  const native = { id: "native-bridge" };
  const config = { api: "anthropic-messages", apiKey: "not-used" };
  return {
    native,
    config,
    registry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
      getRegisteredProviderIds: vi.fn(() => ["claude-bridge", "native-bridge"]),
      getRegisteredNativeProvider: vi.fn((id: string) => (id === "native-bridge" ? native : undefined)),
      getRegisteredProviderConfig: vi.fn((id: string) => (id === "claude-bridge" ? config : undefined)),
    } as any,
  };
}

/** A UI context that records what the widget registers on it. */
function makeRecordingUI() {
  return { setStatus: vi.fn(), setWidget: vi.fn() };
}

/** The session context Pi hands a `session_start` handler. */
function makeSessionStartCtx(
  parentRegistry: unknown,
  ui: ReturnType<typeof makeRecordingUI>,
  hasUI = false,
) {
  return {
    hasUI,
    ui,
    cwd: "/tmp",
    model: undefined,
    modelRegistry: parentRegistry,
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

/** Run the extension far enough to capture the deps bag the root assembled. */
async function captureSessionFactoryIO(parentRegistry: unknown) {
  vi.mocked(createSubagentSession).mockResolvedValue(
    toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
  );
  const { pi, tools, fire } = makePi();
  subagentsExtension(pi);
  await fire("session_start", {}, makeSessionStartCtx(parentRegistry, makeRecordingUI()));

  await tools.get("subagent").execute(
    "tool-call-1",
    {
      prompt: "hi",
      description: "child",
      subagent_type: "worker",
      run_in_background: true,
    },
    undefined,
    undefined,
  );

  expect(createSubagentSession).toHaveBeenCalled();
  const [, deps] = vi.mocked(createSubagentSession).mock.calls[0];
  return deps;
}

describe("composition root: hosted cwd and trust", () => {
  it("binds each parent's agents/settings, rejects pre-bind work and drops revoked project configuration", async () => {
    vi.mocked(createSubagentSession).mockClear();
    vi.mocked(createSubagentSession).mockResolvedValue(toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")));
    const root = mkdtempSync(join(tmpdir(), "hosted-agent-context-"));
    const agentDir = join(root, "profile");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "custom.md"), "---\ndescription: GLOBAL_AGENT\n---\nGlobal prompt");
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 7, defaultMaxTurns: 11 }));
    const required = requireSubagentHosts(); shutdowns.push(async () => { required(); rmSync(root, { recursive: true, force: true }); });
    const host = (trusted: boolean) => ({ agentDir, allowProjectAgents: trusted, createSessionFactory: async () => { throw new Error("unused IO"); }, admitSession: () => {} });
    const start = async (id: string, cwd: string, trusted: boolean) => {
      const release = registerSubagentHost(id, host(trusted)); shutdowns.push(async () => release());
      const parent = makePi(); subagentsExtension(parent.pi);
      expect(parent.tools.get("subagent").description).not.toContain("GLOBAL_AGENT");
      expect(parent.pi.events.emit.mock.calls.some(([name]: string[]) => name === "subagents:settings_loaded")).toBe(false);
      await expect(parent.tools.get("subagent").execute("prebind", { prompt: "probe", description: "probe", subagent_type: "worker", run_in_background: true }, undefined, undefined)).rejects.toThrow();
      const ctx = makeSessionStartCtx(makeParentRegistry().registry, makeRecordingUI());
      ctx.cwd = cwd; ctx.sessionManager.getSessionId = () => id; ctx.sessionManager.getSessionFile = () => `/sessions/${id}.jsonl`;
      await parent.fire("session_start", {}, ctx);
      return { ...parent, release, service: getSubagentsService(id)! };
    };
    for (const name of ["A", "B"]) {
      mkdirSync(join(root, name, ".zrow", "agents"), { recursive: true });
      writeFileSync(join(root, name, ".zrow", "agents", "custom.md"), `---\ndescription: PROJECT_${name}\n---\nProject ${name}`);
      writeFileSync(join(root, name, ".zrow", "subagents.json"), JSON.stringify({ maxConcurrent: name === "A" ? 2 : 3, allowProjectAgents: true }));
    }
    const a = await start("host-A", join(root, "A"), true);
    const b = await start("host-B", join(root, "B"), true);
    expect(a.tools.get("subagent").description).toContain("PROJECT_A");
    expect(a.tools.get("subagent").description).not.toContain("PROJECT_B");
    expect(b.tools.get("subagent").description).toContain("PROJECT_B");
    for (const [parent, expected] of [[a, 2], [b, 3]] as const) {
      const loaded = parent.pi.events.emit.mock.calls.find(([name]: string[]) => name === "subagents:settings_loaded");
      expect(loaded[1].settings).toMatchObject({ maxConcurrent: expected, defaultMaxTurns: 11 });
    }
    a.release();
    expect(() => a.service.spawn("custom", "cannot use cached project config")).toThrow("retired");
    await a.fire("session_shutdown");
    const downgraded = await start("host-A", join(root, "A"), false);
    expect(downgraded.tools.get("subagent").description).toContain("GLOBAL_AGENT");
    expect(downgraded.tools.get("subagent").description).not.toContain("PROJECT_A");
    expect(downgraded.pi.events.emit.mock.calls.find(([name]: string[]) => name === "subagents:settings_loaded")[1].settings).toMatchObject({ maxConcurrent: 7, defaultMaxTurns: 11 });
    const command = downgraded.pi.registerCommand.mock.calls.find(([name]: string[]) => name === "subagents:settings")[1];
    await expect(command.handler("", { ui: makeRecordingUI() })).rejects.toThrow("project trust");
    downgraded.service.spawn("custom", "global only");
    await vi.waitFor(() => expect(createSubagentSession).toHaveBeenCalled());
    const [params, deps] = vi.mocked(createSubagentSession).mock.calls.at(-1)!;
    expect(params.snapshot.cwd).toBe(join(root, "A"));
    expect(deps.registry.resolveAgentConfig("custom").systemPrompt).toBe("Global prompt");
  });
});

describe("composition root: io.createSession", () => {
  it("gives the child its own model runtime carrying the parent's runtime-registered providers", async () => {
    sdk.childRegistrations.native.length = 0;
    sdk.childRegistrations.configured.length = 0;
    sdk.createAgentSession.mockClear();
    const { registry, native, config } = makeParentRegistry();

    const io = (await captureSessionFactoryIO(registry)).io;
    await io.createSession({
      cwd: "/tmp/child",
      agentDir: "/mock/agent-dir",
      sessionManager: {} as any,
      settingsManager: {} as any,
      modelRegistry: registry,
      tools: [],
      resourceLoader: {} as any,
    });

    // The child is handed a runtime, not the registry the SDK now ignores.
    expect(sdk.createAgentSession).toHaveBeenCalledTimes(1);
    const [options] = sdk.createAgentSession.mock.calls[0];
    expect(options.modelRuntime).toBe(sdk.childRuntime);
    expect(options).not.toHaveProperty("modelRegistry");

    // Both registration forms are replayed onto the child's own registry.
    expect(sdk.childRegistrations.native).toEqual([native]);
    expect(sdk.childRegistrations.configured).toEqual([["claude-bridge", config]]);
  });

  it("derives the child runtime's auth and models paths from the session's agent dir", async () => {
    sdk.createRuntime.mockClear();
    const { registry } = makeParentRegistry();

    const io = (await captureSessionFactoryIO(registry)).io;
    await io.createSession({
      cwd: "/tmp/child",
      agentDir: "/mock/agent-dir",
      sessionManager: {} as any,
      settingsManager: {} as any,
      modelRegistry: registry,
      tools: [],
      resourceLoader: {} as any,
    });

    expect(sdk.createRuntime).toHaveBeenCalledWith({
      authPath: "/mock/agent-dir/auth.json",
      modelsPath: "/mock/agent-dir/models.json",
    });
  });
});

describe("composition root: message renderers", () => {
  it("registers a renderer for every custom message type the extension sends", () => {
    const { pi } = makePi();
    subagentsExtension(pi);

    const registered = vi
      .mocked(pi.registerMessageRenderer)
      .mock.calls.map((call: unknown[]) => call[0] as string);

    expect(registered).toEqual([
      "subagent-notification",
      "subagent-update",
      "subagent-workspace-notice",
    ]);
  });
});

describe("composition root: push delivery boundaries", () => {
  it("flushes successful steps, leaves abort/error to settlement, and acknowledges delivered messages", async () => {
    const boundary = vi.spyOn(NotificationManager.prototype, "onParentTurnEnd");
    const settled = vi.spyOn(NotificationManager.prototype, "onParentAgentSettled");
    const delivered = vi.spyOn(NotificationManager.prototype, "onParentMessageEnd");
    try {
      const { pi, fire } = makePi();
      subagentsExtension(pi);
      await fire("agent_start");
      await fire("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
      expect(boundary).toHaveBeenCalledTimes(1);
      await fire("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
      await fire("turn_end", { message: { role: "assistant", stopReason: "error" } });
      expect(boundary).toHaveBeenCalledTimes(1);
      const message = { role: "custom", customType: "subagent-notification", details: {} };
      await fire("message_end", { message });
      expect(delivered).toHaveBeenCalledWith(message);
      await fire("agent_settled");
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      boundary.mockRestore();
      settled.mockRestore();
      delivered.mockRestore();
    }
  });
});

describe("composition root: widget activation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the widget for an agent spawned with no model tool call", async () => {
    vi.mocked(createSubagentSession).mockResolvedValue(
      toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
    );
    const { pi, fire } = makePi();
    subagentsExtension(pi);

    const ui = makeRecordingUI();
    await fire("session_start", {}, makeSessionStartCtx(makeParentRegistry().registry, ui, true));

    // The reported path: a command handler spawning through the published
    // service, so nothing in the parent loop ever emits a tool call.
    getSubagentsService()!.spawn("worker", "hi", { description: "child" });

    expect(ui.setWidget).toHaveBeenCalled();

    await fire("session_shutdown", {}, {});
  });

  it("ages a finished agent out of the widget on the parent's next turn", async () => {
    vi.mocked(createSubagentSession).mockResolvedValue(
      toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
    );
    const { pi, fire } = makePi();
    subagentsExtension(pi);

    const ui = makeRecordingUI();
    await fire("session_start", {}, makeSessionStartCtx(makeParentRegistry().registry, ui, true));

    getSubagentsService()!.spawn("worker", "hi", { description: "child" });
    await vi.advanceTimersByTimeAsync(300);

    // The run finished within this turn, so the row is seeded at age 0 and still shown.
    expect(ui.setWidget).toHaveBeenLastCalledWith("agents", expect.any(Function), expect.anything());

    await fire("turn_start", {}, { signal: undefined });

    expect(ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);

    await fire("session_shutdown", {}, {});
  });

  it("no longer subscribes to tool_execution_start", () => {
    const { pi, handlers } = makePi();

    subagentsExtension(pi);

    expect(handlers.has("tool_execution_start")).toBe(false);
  });
});

describe("composition root: widget teardown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Run the extension and drive one background agent to completion, leaving the
   * widget registered and its interval live.
   *
   * The agent must be **terminal** before the shutdown. An agent still running
   * at shutdown is aborted by the lifecycle handler, and the notification that
   * abort settles lands after `manager.dispose()` has emptied the registry — so
   * `update()` takes its idle path into `clearWidget()` and tears the widget
   * down incidentally, whether or not anything called `dispose()`. A completed
   * agent produces no such notification (`disposeSession()` notifies no
   * observer), so the teardown is observable only if it was actually wired.
   */
  async function completeAgentIntoWidget() {
    vi.mocked(createSubagentSession).mockResolvedValue(
      toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
    );
    const { pi, fire } = makePi();
    subagentsExtension(pi);

    const ui = makeRecordingUI();
    await fire("session_start", {}, makeSessionStartCtx(makeParentRegistry().registry, ui, true));
    getSubagentsService()!.spawn("worker", "hi", { description: "child" });
    await vi.advanceTimersByTimeAsync(300);

    // The run finished within this turn, so the row lingers and the widget stays up.
    expect(ui.setWidget).toHaveBeenLastCalledWith("agents", expect.any(Function), expect.anything());
    return { ui, fire };
  }

  it("stops the widget's update interval on session_shutdown", async () => {
    const { fire } = await completeAgentIntoWidget();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await fire("session_shutdown", {}, {});

    expect(vi.getTimerCount()).toBe(0);
  });

  it("unregisters the widget and status entry on session_shutdown", async () => {
    const { ui, fire } = await completeAgentIntoWidget();

    await fire("session_shutdown", {}, {});

    expect(ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);
    expect(ui.setStatus).toHaveBeenLastCalledWith("subagents", undefined);
  });
});

describe("composition root: prompt-inheritance wiring", () => {
  /**
   * Run the extension through one parent turn and one spawn, and return what
   * the root handed `createSubagentSession`.
   *
   * Only this file fails if the `before_agent_start` capture or the resolver
   * entry is dropped from the deps bag — the unit tests for each half pass
   * whether or not the root wires them together.
   */
  async function spawnAfterParentTurn(systemPromptOptions?: unknown) {
    // The module mock is shared across this file, so drop earlier tests' calls
    // before reading back the one this spawn makes.
    vi.mocked(createSubagentSession).mockClear();
    vi.mocked(createSubagentSession).mockResolvedValue(
      toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
    );
    const { pi, tools, fire } = makePi();
    subagentsExtension(pi);
    await fire("session_start", {}, makeSessionStartCtx(makeParentRegistry().registry, makeRecordingUI()));
    if (systemPromptOptions !== undefined) {
      await fire("before_agent_start", { systemPromptOptions });
    }

    await tools.get("subagent").execute(
      "tool-call-1",
      {
        prompt: "hi",
        description: "child",
        subagent_type: "worker",
        run_in_background: true,
      },
      undefined,
      undefined,
    );

    return vi.mocked(createSubagentSession).mock.calls[0];
  }

  it("captures the parent's prompt options and renders them into the spawn snapshot", async () => {
    const [params] = await spawnAfterParentTurn({
      contextFiles: [{ path: "/repo/AGENTS.md", content: "Repo rules." }],
    });

    expect(params.snapshot.portablePrompt).toContain('<project_instructions path="/repo/AGENTS.md">');
  });

  it("leaves the snapshot's portable parts absent when the parent has run no turn", async () => {
    const [params] = await spawnAfterParentTurn();

    expect(params.snapshot.portablePrompt).toBeUndefined();
  });

  describe("the session factory's inheritance resolver", () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "pi-root-inherit-"));
      mkdirSync(join(projectDir, ".zrow"), { recursive: true });
      writeFileSync(
        join(projectDir, ".zrow", "subagents.json"),
        JSON.stringify({ promptInheritance: { "claude-bridge": "portable" } }),
      );
      // The root reads settings from process.cwd(), so point it at the fixture.
      vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    });

    afterEach(() => {
      vi.mocked(process.cwd).mockRestore();
      rmSync(projectDir, { recursive: true, force: true });
    });

    it("answers portable for a provider the operator configured", async () => {
      const [, deps] = await spawnAfterParentTurn();

      expect(deps.resolvePromptInheritance("claude-bridge")).toBe("portable");
    });

    it("answers full for a provider the operator did not configure", async () => {
      const [, deps] = await spawnAfterParentTurn();

      expect(deps.resolvePromptInheritance("anthropic")).toBe("full");
    });
  });
});
