import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { resolveSpawnConfig } from "#src/tools/spawn-config";
import { makeModel } from "#test/helpers/make-model";

/** Minimal registry with default agents only. */
const testRegistry = new AgentTypeRegistry(() => new Map());

/** Shorthand for building ModelInfo. */
function makeModelInfo(overrides: Partial<Parameters<typeof resolveSpawnConfig>[2]> = {}) {
  return {
    parentModel: makeModel({ id: "claude-sonnet", name: "Claude Sonnet" }),
    modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
    ...overrides,
  };
}

const defaultSettings = { defaultMaxTurns: undefined as number | undefined };

describe("resolveSpawnConfig — type resolution", () => {
  it("resolves a known agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) throw new Error(result.error);
    expect(result.identity.subagentType).toBe("worker");
    expect("fellBack" in result.identity).toBe(false);
  });

  it("resolves case-insensitively to the canonical lowercase name", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "EXPLORE", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.identity.subagentType).toBe("explore");
    expect(result.identity.rawType).toBe("EXPLORE");
  });

  it("returns an actionable error for an unknown agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "unknown-type", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect(result).toEqual({
      error: `Unknown agent type "unknown-type". Available types: ${testRegistry.getAvailableTypes().join(", ")}.`,
    });
  });

  it("returns an actionable error for retired builtins", () => {
    for (const retired of ["general-purpose", "Plan"]) {
      const result = resolveSpawnConfig(
        { subagent_type: retired, prompt: "test", description: "d" },
        testRegistry,
        makeModelInfo(),
        defaultSettings,
      );
      expect(result).toEqual({
        error: `Unknown agent type "${retired}". Available types: ${testRegistry.getAvailableTypes().join(", ")}.`,
      });
    }
  });

  it("sets displayName from registry", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.identity.displayName).toBe("explore");
  });

  it("uses displayName from agent config when available", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    // worker config has displayName: "worker"
    expect(result.identity.displayName).toBe("worker");
  });
});

describe("resolveSpawnConfig — model resolution", () => {
  it("inherits parent model when no model specified", () => {
    const parentModel = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo({ parentModel }),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.model).toBe(parentModel);
    // modelName is undefined when same as parent
    expect(result.presentation.modelName).toBeUndefined();
  });

  it("returns error when user-specified model cannot be resolved", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d", model: "nonexistent-xyz" },
      testRegistry,
      makeModelInfo({ modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] } }),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeTruthy();
  });
});

describe("resolveSpawnConfig — max turns normalization", () => {
  it("normalizes max_turns from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d", max_turns: 10 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.effectiveMaxTurns).toBe(10);
  });

  it("uses settings defaultMaxTurns when no max_turns in params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      { defaultMaxTurns: 25 },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.effectiveMaxTurns).toBe(25);
  });

  it("returns undefined effectiveMaxTurns when neither params nor settings specify", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.effectiveMaxTurns).toBeUndefined();
  });
});

describe("resolveSpawnConfig — invocation fields", () => {
  it("sets runInBackground from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d", run_in_background: true },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.runInBackground).toBe(true);
  });

  it("builds agentInvocation snapshot", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d", thinking: "high" },
      testRegistry,
      makeModelInfo({ parentThinking: "high" }),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.agentInvocation).toEqual({
      modelName: undefined,
      thinking: "high",
      maxTurns: undefined,
      inheritContext: false,
      runInBackground: false,
    });
  });
});

describe("resolveSpawnConfig — detailBase and tags", () => {
  it("builds detailBase with description from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "my task" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.presentation.detailBase.description).toBe("my task");
    expect(result.presentation.detailBase.subagentType).toBe("worker");
    expect(result.presentation.detailBase.displayName).toBe("worker");
  });

  it("includes thinking tag when thinking is set", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d", thinking: "high" },
      testRegistry,
      makeModelInfo({ parentThinking: "high" }),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.presentation.agentTags).toContain("thinking: high");
  });

  it("omits mode label for replace-mode agents", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    // explore has promptMode: "replace" → no mode label, no invocation overrides
    expect(result.presentation.agentTags).toEqual([]);
  });

  it("includes twin tag for an explicit custom append-mode agent", () => {
    const twinRegistry = new AgentTypeRegistry(
      () =>
        new Map([
          [
            "twin",
            {
              name: "twin",
              description: "Custom twin",
              systemPrompt: "",
              promptMode: "append" as const,
            },
          ],
        ]),
    );
    const result = resolveSpawnConfig(
      { subagent_type: "twin", prompt: "test", description: "d" },
      twinRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    // custom append-mode agent → gets "twin" label (no builtin is append anymore)
    expect(result.presentation.agentTags).toContain("twin");
  });

  it("sets tags to undefined on detailBase for replace-mode agents with no invocation overrides", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    // explore has promptMode: "replace" and no invocation overrides → no tags
    expect(result.presentation.detailBase.tags).toBeUndefined();
  });
});

describe("resolveSpawnConfig — thinking level", () => {
  it.each([
    [undefined, undefined, undefined, "medium"],
    ["high", undefined, undefined, "medium"],
    ["max", undefined, undefined, "medium"],
    ["low", undefined, undefined, "medium"],
    ["off", undefined, undefined, "medium"],
    ["turbo", undefined, undefined, "medium"],
    [undefined, "high", undefined, "high"],
    ["max", "high", undefined, "high"],
    ["low", undefined, "high", "high"],
    ["max", undefined, "off", "off"],
  ] as const)("ignores caller %s and resolves agent %s and session %s to %s", (thinking, agentThinking, sessionThinking, expected) => {
    const registry = new AgentTypeRegistry(() => new Map([
      ["custom", {
        name: "custom",
        description: "Custom",
        systemPrompt: "",
        promptMode: "append" as const,
        thinking: agentThinking,
      }],
    ]));
    const result = resolveSpawnConfig(
      { subagent_type: "custom", prompt: "test", description: "d", thinking },
      registry,
      makeModelInfo({ parentThinking: "medium" }),
      defaultSettings,
      { thinking: sessionThinking },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.thinking).toBe(expected);
    expect(result.execution.agentInvocation.thinking).toBe(expected);
    expect(result.presentation.agentTags).toContain(`thinking: ${expected}`);
  });

  it("does not raise an off parent without a configured override", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "worker", prompt: "test", description: "d", thinking: "max" },
      testRegistry,
      makeModelInfo({ parentThinking: "off" }),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.thinking).toBe("off");
  });

  it("returns an error naming valid levels for an invalid user session selection", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "explore", prompt: "test", description: "d", thinking: "turbo" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
      { thinking: "turbo" },
    );
    expect(result).toEqual({
      error:
        'Invalid thinking level "turbo". Valid levels: off, minimal, low, medium, high, xhigh, max.',
    });
  });

  it("resolves an explicit user session selection", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "explore", prompt: "test", description: "d", thinking: "xhigh" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
      { thinking: "xhigh" },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.thinking).toBe("xhigh");
  });
});

describe("resolveSpawnConfig — notes", () => {
  it("carries no note for a known agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([]);
  });

  it("carries a lock note naming the discarded parameters", () => {
    const lockedRegistry = new AgentTypeRegistry(
      () =>
        new Map([
          [
            "pinned",
            {
              name: "pinned",
              description: "Pinned",
              systemPrompt: "",
              promptMode: "append" as const,
              model: "provider/pinned",
              maxTurns: 7,
              locked: true as const,
            },
          ],
        ]),
    );
    const result = resolveSpawnConfig(
      {
        subagent_type: "pinned",
        prompt: "test",
        description: "d",
        model: "other",
        max_turns: 3,
      },
      lockedRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([
      'Note: agent "pinned" locks model, max_turns, so those parameters were ignored.',
    ]);
  });

  it("names a single discarded parameter in the singular", () => {
    const lockedRegistry = new AgentTypeRegistry(
      () =>
        new Map([
          [
            "pinned",
            {
              name: "pinned",
              description: "Pinned",
              systemPrompt: "",
              promptMode: "append" as const,
              model: "provider/pinned",
              locked: ["model"] as const,
            },
          ],
        ]),
    );
    const result = resolveSpawnConfig(
      { subagent_type: "pinned", prompt: "test", description: "d", model: "other" },
      lockedRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([
      'Note: agent "pinned" locks model, so the model parameter was ignored.',
    ]);
  });
});

describe("resolveSpawnConfig — prompt and rawType passthrough", () => {
  it("passes through prompt and rawType", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "explore", prompt: "search for bugs", description: "bug search" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.prompt).toBe("search for bugs");
    expect(result.identity.rawType).toBe("explore");
  });

  it("preserves the caller's casing in rawType", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "EXPLORE", prompt: "search for bugs", description: "bug search" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.identity.subagentType).toBe("explore");
    expect(result.identity.rawType).toBe("EXPLORE");
  });
});
