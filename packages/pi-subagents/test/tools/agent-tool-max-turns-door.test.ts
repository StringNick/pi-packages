import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/agents";
import { registerSubagentHost, requireSubagentHosts, type SubagentHost } from "#src/service/host";
import { AgentTool } from "#src/tools/agent-tool";
import { createToolDeps } from "#test/helpers/make-deps";
import { STUB_CTX } from "#test/helpers/stub-ctx";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

const launchParams = Object.freeze({
  subagent_type: "general-purpose",
  prompt: "Do the work",
  description: "Do work",
});

function makeStandaloneTool() {
  const registry = new AgentTypeRegistry(() => new Map());
  const deps = createToolDeps({ registry });
  const tool = new AgentTool(deps.manager, deps.runtime, deps.settings, registry, deps.agentDir);
  return { ...deps, tool };
}

function makeHostedTool(exposeCallerMaxTurns: boolean | undefined, agentMaxTurns?: number, defaultMaxTurns?: number) {
  const registry = new AgentTypeRegistry(() => new Map(agentMaxTurns === undefined ? [] : [
    ["general-purpose", {
      name: "general-purpose", description: "Agent with a limit", systemPrompt: "",
      promptMode: "append", maxTurns: agentMaxTurns, locked: ["max_turns"],
    }],
  ]));
  const deps = createToolDeps({ registry, settings: { defaultMaxTurns, maxConcurrent: 4 } });
  const host: SubagentHost = {
    createSessionFactory: vi.fn<SubagentHost["createSessionFactory"]>(),
    admitSession: vi.fn<SubagentHost["admitSession"]>(),
    ...(exposeCallerMaxTurns === undefined ? {} : { exposeCallerMaxTurns }),
  };
  disposers.push(registerSubagentHost("session-1", host));
  const tool = new AgentTool(deps.manager, deps.runtime, deps.settings, registry, deps.agentDir);
  return { ...deps, host, tool };
}

describe("AgentTool caller max_turns surface", () => {
  it("exposes max_turns in the schema without a host", () => {
    const { tool } = makeStandaloneTool();
    expect(Object.keys(tool.toToolDefinition().parameters.properties)).toContain("max_turns");
  });

  it("exposes max_turns when the host leaves the flag unset", () => {
    const { tool } = makeHostedTool(undefined);
    expect(Object.keys(tool.toToolDefinition().parameters.properties)).toContain("max_turns");
  });

  it("omits max_turns from the schema when the host withholds it", () => {
    const { tool } = makeHostedTool(false);
    expect(Object.keys(tool.toToolDefinition().parameters.properties)).not.toContain("max_turns");
  });

  it.each([false, true])("discards an undeclared caller max_turns on a background=%s launch", async (background) => {
    const { tool, manager } = makeHostedTool(false);
    await tool.execute(
      "call",
      { ...launchParams, max_turns: 5, run_in_background: background },
      undefined,
      undefined,
      STUB_CTX,
    );
    const spawn = background ? manager.spawn : manager.spawnAndWait;
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "general-purpose",
      launchParams.prompt,
      expect.objectContaining({ maxTurns: undefined }),
    );
  });

  it.each([false, true])("still honors a caller max_turns when the host exposes it", async (background) => {
    const { tool, manager } = makeHostedTool(true);
    await tool.execute(
      "call",
      { ...launchParams, max_turns: 5, run_in_background: background },
      undefined,
      undefined,
      STUB_CTX,
    );
    const spawn = background ? manager.spawn : manager.spawnAndWait;
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "general-purpose",
      launchParams.prompt,
      expect.objectContaining({ maxTurns: 5 }),
    );
  });

  it.each([undefined, 9])("keeps the configured limit %s when callers cannot set max_turns", async (agentMaxTurns) => {
    const { tool, manager } = makeHostedTool(false, agentMaxTurns, 17);
    const params = Object.freeze({ ...launchParams, max_turns: 1 });
    await tool.execute("call", params, undefined, undefined, STUB_CTX);
    expect(manager.spawnAndWait).toHaveBeenCalledWith(
      expect.anything(), "general-purpose", launchParams.prompt,
      expect.objectContaining({ maxTurns: agentMaxTurns ?? 17 }),
    );
    expect(params.max_turns).toBe(1);
  });

  it("keeps the native surface when hosts are required but unbound", () => {
    const release = requireSubagentHosts();
    disposers.push(release);
    const { tool } = makeStandaloneTool();
    // No registered host for the stubbed parent session: the resolver must
    // fall back to exposed rather than throw at schema-build time.
    expect(Object.keys(tool.toToolDefinition().parameters.properties)).toContain("max_turns");
  });
});
