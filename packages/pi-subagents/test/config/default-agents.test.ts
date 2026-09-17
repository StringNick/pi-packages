import { describe, expect, it } from "vitest";
import { AgentTypeRegistry, BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import { DEFAULT_AGENT_NAMES, DEFAULT_AGENTS } from "#src/config/default-agents";
import { resolveAgentInvocationConfig } from "#src/config/invocation-config";
import type { AgentConfig } from "#src/types";

const EXPECTED_ROSTER = ["explore", "worker", "reviewer", "oracle"] as const;
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
const READ_ORIENTED = ["explore", "reviewer", "oracle"] as const;

function makeRegistry(userAgents: Map<string, AgentConfig> = new Map()): AgentTypeRegistry {
  return new AgentTypeRegistry(() => userAgents);
}

function makeCustomAgent(name: string, description: string): AgentConfig {
  return { name, description, systemPrompt: "Custom.", promptMode: "replace" };
}

describe("DEFAULT_AGENTS roster", () => {
  it("contains exactly the agreed builtin roster in routing order", () => {
    expect([...DEFAULT_AGENTS.keys()]).toEqual([...EXPECTED_ROSTER]);
  });

  it("keeps builtin names single-source with the registry", () => {
    expect([...DEFAULT_AGENT_NAMES]).toEqual([...EXPECTED_ROSTER]);
    expect([...AgentTypeRegistry.DEFAULT_AGENT_NAMES]).toEqual([...EXPECTED_ROSTER]);
  });

  it("uses exact lowercase names and display names", () => {
    for (const [name, config] of DEFAULT_AGENTS) {
      expect(name, "key").toBe(name.toLowerCase());
      expect(config.name, name).toBe(name.toLowerCase());
      expect(config.displayName, name).toBe(name.toLowerCase());
    }
  });

  it("marks every builtin as a default and leaves it enabled", () => {
    for (const [name, config] of DEFAULT_AGENTS) {
      expect(config.isDefault, name).toBe(true);
      expect(config.enabled, name).not.toBe(false);
    }
  });

  it("ships no Plan or general-purpose builtin", () => {
    expect(DEFAULT_AGENTS.has("Plan")).toBe(false);
    expect(DEFAULT_AGENTS.has("general-purpose")).toBe(false);
  });

  it("throws an actionable error for retired names without a custom overlay", () => {
    const registry = makeRegistry();
    for (const retired of ["Plan", "general-purpose"]) {
      expect(() => registry.resolveAgentConfig(retired)).toThrow(
        `Unknown agent type "${retired}". Available types: explore, worker, reviewer, oracle.`
      );
      expect(registry.findAgentConfig(retired)).toBeUndefined();
    }
  });

  it("honors user-defined Plan and general-purpose as ordinary custom agents", () => {
    const registry = makeRegistry(
      new Map([
        ["Plan", makeCustomAgent("Plan", "Custom planner")],
        ["general-purpose", makeCustomAgent("general-purpose", "Legacy fallback")],
      ])
    );
    for (const [name, description] of [
      ["Plan", "Custom planner"],
      ["general-purpose", "Legacy fallback"],
    ] as const) {
      expect(registry.isValidType(name)).toBe(true);
      expect(registry.resolveAgentConfig(name).description).toBe(description);
      expect(registry.getUserAgentNames()).toContain(name);
      expect(registry.getDefaultAgentNames()).not.toContain(name);
    }
  });

  it("leaves model/thinking to inherit and locks nothing", () => {
    for (const [name, config] of DEFAULT_AGENTS) {
      expect(config.model, name).toBeUndefined();
      expect(config.thinking, name).toBeUndefined();
      expect(config.locked, name).toBeUndefined();
    }
  });

  it("leaves context/background unset so fresh context is the default", () => {
    for (const [name, config] of DEFAULT_AGENTS) {
      expect(config.inheritContext, name).toBeUndefined();
      expect(config.runInBackground, name).toBeUndefined();
      expect(resolveAgentInvocationConfig(config, {}).inheritContext, name).toBe(false);
    }
  });

  it("lets a caller request history even for oracle (never forced)", () => {
    const oracle = DEFAULT_AGENTS.get("oracle")!;
    expect(resolveAgentInvocationConfig(oracle, { inherit_context: true }).inheritContext).toBe(true);
  });

  it("gives worker the normal builtin tools", () => {
    expect(DEFAULT_AGENTS.get("worker")!.toolNames).toBeUndefined();
    expect(makeRegistry().getToolNamesForType("worker")).toEqual(BUILTIN_TOOL_NAMES);
  });

  it("restricts read-oriented roles to the read-only allowlist", () => {
    for (const name of READ_ORIENTED) {
      expect(DEFAULT_AGENTS.get(name)!.toolNames).toEqual(READ_ONLY_TOOLS);
    }
  });

  it("runs every builtin in replace mode with a non-empty prompt", () => {
    for (const [name, config] of DEFAULT_AGENTS) {
      expect(config.promptMode, name).toBe("replace");
      expect(config.systemPrompt.trim().length, name).toBeGreaterThan(0);
    }
  });

  it("gives every builtin a routing guideline that keeps planning with the parent", () => {
    for (const [name, config] of DEFAULT_AGENTS) {
      expect(config.toolGuideline, name).toBeTruthy();
      expect(config.toolGuideline, name).toMatch(/parent/i);
    }
  });

  it("gives specialists compact result contracts with host file conventions", () => {
    for (const [name, config] of DEFAULT_AGENTS) {
      expect(config.systemPrompt, name).toContain("# Result");
      expect(config.systemPrompt, name).toContain("workspace-relative");
      expect(config.systemPrompt, name).not.toContain("absolute");
    }
  });

  it("marks read-oriented prompts as behavioral read-only, not a sandbox", () => {
    for (const name of READ_ORIENTED) {
      const prompt = DEFAULT_AGENTS.get(name)!.systemPrompt;
      expect(prompt, name).toContain("READ-ONLY");
      expect(prompt, name).toMatch(/behavioral/);
    }
  });
});
