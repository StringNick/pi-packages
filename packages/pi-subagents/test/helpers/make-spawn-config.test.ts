import { describe, expect, it } from "vitest";
import { createResolvedSpawnConfig } from "#test/helpers/make-spawn-config";

describe("createResolvedSpawnConfig", () => {
  it("produces a foreground-shaped config by default", () => {
    expect(createResolvedSpawnConfig()).toEqual({
      identity: {
        subagentType: "worker",
        rawType: "worker",
        displayName: "worker",
      },
      notes: [],
      execution: {
        prompt: "do the task",
        description: "task",
        model: undefined,
        effectiveMaxTurns: undefined,
        thinking: undefined,
        inheritContext: false,
        runInBackground: false,
        agentInvocation: {
          modelName: undefined,
          thinking: undefined,
          maxTurns: undefined,
          inheritContext: false,
          runInBackground: false,
        },
      },
      presentation: {
        modelName: undefined,
        agentTags: [],
        detailBase: {
          displayName: "worker",
          description: "task",
          subagentType: "worker",
          modelName: undefined,
          tags: undefined,
        },
      },
    });
  });

  it("applies the scalar overrides", () => {
    const config = createResolvedSpawnConfig({
      displayName: "Worker",
      prompt: "do something",
      description: "bg task",
      runInBackground: true,
    });
    expect(config.identity.displayName).toBe("Worker");
    expect(config.execution.prompt).toBe("do something");
    expect(config.execution.description).toBe("bg task");
  });

  it("mirrors runInBackground into agentInvocation", () => {
    const config = createResolvedSpawnConfig({ runInBackground: true });
    expect(config.execution.runInBackground).toBe(true);
    expect(config.execution.agentInvocation.runInBackground).toBe(true);
  });

  it("defaults rawType to subagentType but keeps an explicit rawType", () => {
    expect(createResolvedSpawnConfig().identity.rawType).toBe("worker");
    const config = createResolvedSpawnConfig({ subagentType: "explore", rawType: "EXPLORE" });
    expect(config.identity.subagentType).toBe("explore");
    expect(config.identity.rawType).toBe("EXPLORE");
  });

  it("carries explicit notes verbatim", () => {
    const notes = ['Note: agent "worker" locks model, so the model parameter was ignored.'];
    expect(createResolvedSpawnConfig({ notes }).notes).toEqual(notes);
    expect(createResolvedSpawnConfig().notes).toEqual([]);
  });

  it("mirrors displayName, description, subagentType, and model into presentation.detailBase", () => {
    const config = createResolvedSpawnConfig({
      subagentType: "explore",
      displayName: "explore",
      description: "scan repo",
      model: "haiku",
    });
    expect(config.presentation.modelName).toBe("haiku");
    expect(config.presentation.detailBase).toEqual({
      displayName: "explore",
      description: "scan repo",
      subagentType: "explore",
      modelName: "haiku",
      tags: undefined,
    });
  });
});
