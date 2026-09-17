import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentTypeRegistry,
  type LockDeclaration,
  resolveSessionModelOverride,
  resolveSessionThinkingOverride,
} from "#src/agents";
import { registerSubagentHost, requireSubagentHosts, type SubagentHost } from "#src/service/host";
import { AgentTool } from "#src/tools/agent-tool";
import { createToolDeps } from "#test/helpers/make-deps";
import { makeModel } from "#test/helpers/make-model";
import { STUB_CTX, STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

const callerModel = makeModel({ id: "caller" });
const agentModel = makeModel({ id: "agent" });
const selectedModel = makeModel({ id: "selected" });
const models = [callerModel, agentModel, selectedModel];
const launchParams = Object.freeze({
  subagent_type: "reviewer",
  prompt: "Review the change",
  description: "Review change",
  model: "anthropic/caller",
  thinking: "low",
});

function makeHostedTool(locked?: LockDeclaration) {
  const registry = new AgentTypeRegistry(() => new Map([
    ["reviewer", {
      name: "reviewer",
      description: "Reviewer",
      systemPrompt: "",
      promptMode: "append",
      model: "anthropic/agent",
      thinking: "medium",
      locked,
    }],
  ]));
  const deps = createToolDeps({ registry });
  deps.runtime.getModelInfo = () => ({
    parentModel: callerModel,
    parentThinking: "medium",
    modelRegistry: {
      find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
      getAll: () => models,
      getAvailable: () => models,
    },
  });
  const host = {
    createSessionFactory: vi.fn<SubagentHost["createSessionFactory"]>(),
    admitSession: vi.fn<SubagentHost["admitSession"]>(),
    resolveSessionModelOverride: vi.fn((_name: string): string | undefined => undefined),
    resolveSessionThinkingOverride: vi.fn((_name: string): string | undefined => undefined),
  };
  disposers.push(registerSubagentHost("session-1", host));
  const tool = new AgentTool(deps.manager, deps.runtime, deps.settings, registry, deps.agentDir);
  return { ...deps, host, tool };
}

describe("AgentTool session selections", () => {
  it("does not advertise a thinking parameter or instruct the model to pass it", () => {
    const { tool } = makeHostedTool();
    const definition = tool.toToolDefinition();
    expect(definition.parameters.properties).not.toHaveProperty("thinking");
    expect(definition.description).not.toContain("Use thinking to");
  });

  describe.each([false, true])("background=%s", (background) => {
    it.each([undefined, "high", "max", "low", "off", "turbo"])("inherits medium instead of caller %s without a type setting", async (thinking) => {
      const { tool, manager } = makeHostedTool();
      await tool.execute("call", {
        ...launchParams, subagent_type: "general-purpose", model: undefined,
        thinking, run_in_background: background,
      }, undefined, undefined, STUB_CTX);
      // Runner-specific bookkeeping is tested separately above.
      expect(background ? manager.spawn : manager.spawnAndWait).toHaveBeenCalledWith(
        STUB_SNAPSHOT, "general-purpose", launchParams.prompt,
        expect.objectContaining({ model: callerModel, thinkingLevel: "medium" }),
      );
    });

    it.each(["off", "high", "max"])("applies the user's model and %s reasoning over caller and agent defaults", async (thinking) => {
      const { tool, manager, host } = makeHostedTool();
      host.resolveSessionModelOverride.mockReturnValue("  anthropic/selected  ");
      host.resolveSessionThinkingOverride.mockReturnValue(` ${thinking} `);
      const params = Object.freeze({ ...launchParams, subagent_type: "REVIEWER", run_in_background: background });

      await tool.execute("call", params, undefined, undefined, STUB_CTX);

      expect(host.resolveSessionModelOverride).toHaveBeenCalledExactlyOnceWith("reviewer");
      expect(host.resolveSessionThinkingOverride).toHaveBeenCalledExactlyOnceWith("reviewer");
      const spawn = background ? manager.spawn : manager.spawnAndWait;
      expect(spawn).toHaveBeenCalledExactlyOnceWith(STUB_SNAPSHOT, "reviewer", launchParams.prompt, {
        description: launchParams.description,
        model: selectedModel,
        thinkingLevel: thinking,
        maxTurns: undefined,
        inheritContext: false,
        parentSession: { parentSessionId: "session-1", parentSessionFile: "/sessions/parent.jsonl", toolCallId: "call" },
        ...(background
          ? { background: { kind: "explicit", isBackground: true } }
          : { signal: undefined, observer: { onSessionCreated: expect.any(Function) } }),
      });
      expect(params.model).toBe("anthropic/caller");
      expect(params.thinking).toBe("low");
    });

    it.each([
      { kind: "blanket", locked: true },
      { kind: "field-list", locked: ["model", "thinking"] },
    ] satisfies Array<{ kind: string; locked: LockDeclaration }>)("keeps $kind native locks and reports their discarded overrides", async ({ locked }) => {
      const { tool, manager, host } = makeHostedTool(locked);
      host.resolveSessionModelOverride.mockReturnValue("anthropic/selected");
      host.resolveSessionThinkingOverride.mockReturnValue("high");

      const result = await tool.execute("call", { ...launchParams, run_in_background: background }, undefined, undefined, STUB_CTX);

      // Runner bookkeeping differs; assert just the config controlled by native locks.
      expect(background ? manager.spawn : manager.spawnAndWait).toHaveBeenCalledWith(
        STUB_SNAPSHOT, "reviewer", launchParams.prompt,
        expect.objectContaining({ model: agentModel, thinkingLevel: "medium" }),
      );
      expect(result.content[0].text.startsWith(
        'Note: agent "reviewer" locks model, thinking, so those parameters were ignored.\n',
      )).toBe(true);
    });

    it("reports an invalid session thinking value instead of launching with the caller's value", async () => {
      const { tool, manager, host, runtime } = makeHostedTool();
      host.resolveSessionThinkingOverride.mockReturnValue("ultra");

      const result = await tool.execute("call", { ...launchParams, run_in_background: background }, undefined, undefined, STUB_CTX);

      expect(result.content).toEqual([{
        type: "text",
        text: 'Invalid thinking level "ultra". Valid levels: off, minimal, low, medium, high, xhigh, max.',
      }]);
      expect(runtime.buildSnapshot).not.toHaveBeenCalled();
      expect(manager.spawn).not.toHaveBeenCalled();
      expect(manager.spawnAndWait).not.toHaveBeenCalled();
    });

    it("does not consult new-launch selections on resume", async () => {
      const { tool, manager, host } = makeHostedTool();
      host.resolveSessionModelOverride.mockReturnValue("missing/model");
      host.resolveSessionThinkingOverride.mockReturnValue("ultra");

      await tool.execute("call", { resume: "agent-1", prompt: "continue", run_in_background: background }, undefined, undefined, STUB_CTX);

      expect(host.resolveSessionModelOverride).not.toHaveBeenCalled();
      expect(host.resolveSessionThinkingOverride).not.toHaveBeenCalled();
      expect(background ? manager.startResume : manager.resume).toHaveBeenCalledExactlyOnceWith(
        "agent-1", "continue",
        background ? { claimOutcome: false } : { claimOutcome: true, signal: expect.any(AbortSignal) },
      );
      expect(manager.spawn).not.toHaveBeenCalled();
      expect(manager.spawnAndWait).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["model", selectedModel, "medium"],
    ["thinking", callerModel, "high"],
  ] as const)("a %s-only selection leaves the other caller option intact", async (field, model, thinking) => {
    const { tool, manager, host } = makeHostedTool();
    if (field === "model") host.resolveSessionModelOverride.mockReturnValue("anthropic/selected");
    else host.resolveSessionThinkingOverride.mockReturnValue("high");

    await tool.execute("call", launchParams, undefined, undefined, STUB_CTX);

    // Only the independent model/reasoning merge is under test, not runner bookkeeping.
    expect(manager.spawnAndWait).toHaveBeenCalledWith(STUB_SNAPSHOT, "reviewer", launchParams.prompt,
      expect.objectContaining({ model, thinkingLevel: thinking }));
  });

  it("consults the fallback agent's selections for unknown types", async () => {
    const { tool, manager, host } = makeHostedTool();
    host.resolveSessionThinkingOverride.mockImplementation((name) => name === "general-purpose" ? "high" : undefined);

    await tool.execute("call", { ...launchParams, subagent_type: "unknown" }, undefined, undefined, STUB_CTX);

    expect(host.resolveSessionThinkingOverride).toHaveBeenCalledExactlyOnceWith("general-purpose");
    // The fallback's other spawn options are covered by the existing spawn-config tests.
    expect(manager.spawnAndWait).toHaveBeenCalledWith(STUB_SNAPSHOT, "general-purpose", launchParams.prompt,
      expect.objectContaining({ thinkingLevel: "high" }));
  });
});

describe.each([
  ["model", "resolveSessionModelOverride", resolveSessionModelOverride],
  ["thinking", "resolveSessionThinkingOverride", resolveSessionThinkingOverride],
] as const)("session %s lookup", (_field, hook, resolve) => {
  it("keeps host methods bound to their owning object", () => {
    const registry = new AgentTypeRegistry(() => new Map());
    const host = {
      selected: "high",
      createSessionFactory: vi.fn<SubagentHost["createSessionFactory"]>(),
      admitSession: vi.fn<SubagentHost["admitSession"]>(),
      [hook]() { return this.selected; },
    };
    disposers.push(registerSubagentHost("method-parent", host));

    expect(resolve("method-parent", "Explore", registry)).toBe("high");
  });

  it.each([undefined, "", "  "])("treats %j as no selection", (value) => {
    const { registry, host } = makeHostedTool();
    host[hook].mockReturnValue(value);
    expect(resolve("session-1", "reviewer", registry)).toBeUndefined();
  });

  it("ignores a throwing hook", () => {
    const { registry, host } = makeHostedTool();
    host[hook].mockImplementation(() => { throw new Error("unavailable"); });
    expect(resolve("session-1", "reviewer", registry)).toBeUndefined();
  });

  it("does not require an override hook even in a hosted process", () => {
    const registry = new AgentTypeRegistry(() => new Map());
    disposers.push(requireSubagentHosts());
    disposers.push(registerSubagentHost("without-hooks", {
      createSessionFactory: vi.fn<SubagentHost["createSessionFactory"]>(),
      admitSession: vi.fn<SubagentHost["admitSession"]>(),
    }));
    expect(resolve("without-hooks", "Explore", registry)).toBeUndefined();
    expect(resolve("missing-parent", "Explore", registry)).toBeUndefined();
  });
});
