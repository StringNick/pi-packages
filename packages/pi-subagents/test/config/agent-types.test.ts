import { describe, expect, it } from "vitest";
import { AgentTypeRegistry, BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";

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

describe("AgentTypeRegistry", () => {
  function makeRegistry(userAgents: Map<string, AgentConfig> = new Map()): AgentTypeRegistry {
    return new AgentTypeRegistry(() => userAgents);
  }

  describe("construction and reload", () => {
    it("loads default agents on construction", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("explore")).toBe(true);
      expect(registry.isValidType("worker")).toBe(true);
      expect(registry.isValidType("reviewer")).toBe(true);
      expect(registry.isValidType("oracle")).toBe(true);
    });

    it("ships no Plan or general-purpose builtin", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("Plan")).toBeUndefined();
      expect(registry.resolveType("general-purpose")).toBeUndefined();
      expect(registry.isValidType("Plan")).toBe(false);
      expect(registry.isValidType("general-purpose")).toBe(false);
      expect(registry.getDefaultAgentNames()).not.toContain("Plan");
      expect(registry.getDefaultAgentNames()).not.toContain("general-purpose");
    });

    it("honors a user-defined Plan", () => {
      const registry = makeRegistry(
        new Map([["Plan", makeAgentConfig({ name: "Plan", description: "Custom planner" })]])
      );
      expect(registry.isValidType("Plan")).toBe(true);
      expect(registry.resolveAgentConfig("Plan").description).toBe("Custom planner");
      expect(registry.getUserAgentNames()).toContain("Plan");
      expect(registry.getDefaultAgentNames()).not.toContain("Plan");
    });

    it("honors a user-defined general-purpose as an ordinary custom agent", () => {
      const registry = makeRegistry(
        new Map([["general-purpose", makeAgentConfig({ name: "general-purpose", description: "Legacy fallback" })]])
      );
      expect(registry.isValidType("general-purpose")).toBe(true);
      expect(registry.resolveAgentConfig("general-purpose").description).toBe("Legacy fallback");
      expect(registry.getUserAgentNames()).toContain("general-purpose");
      expect(registry.getDefaultAgentNames()).not.toContain("general-purpose");
    });

    it("does not call loadUserAgents until construction", () => {
      let callCount = 0;
      const registry = new AgentTypeRegistry(() => {
        callCount++;
        return new Map();
      });
      // constructor calls reload() once
      expect(callCount).toBe(1);
      registry.reload();
      expect(callCount).toBe(2);
    });

    it("reload picks up new agents from loader", () => {
      let userAgents = new Map<string, AgentConfig>();
      const registry = new AgentTypeRegistry(() => userAgents);

      expect(registry.isValidType("auditor")).toBe(false);

      userAgents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registry.reload();

      expect(registry.isValidType("auditor")).toBe(true);
    });

    it("reload clears previous user agents", () => {
      const userAgents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      const registry = new AgentTypeRegistry(() => userAgents);
      expect(registry.isValidType("auditor")).toBe(true);

      userAgents.clear();
      registry.reload();

      expect(registry.isValidType("auditor")).toBe(false);
      expect(registry.isValidType("explore")).toBe(true);
    });
  });

  describe("resolveType", () => {
    it("returns canonical key for exact match", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("explore")).toBe("explore");
      expect(registry.resolveType("worker")).toBe("worker");
    });

    it("returns canonical key for case-insensitive match", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("EXPLORE")).toBe("explore");
      expect(registry.resolveType("Worker")).toBe("worker");
    });

    it("returns undefined for unknown type", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("nonexistent")).toBeUndefined();
    });
  });

  describe("findAgentConfig", () => {
    it("returns the config for a known type", () => {
      const registry = makeRegistry();
      expect(registry.findAgentConfig("explore")?.name).toBe("explore");
    });

    it("resolves case-insensitively", () => {
      const registry = makeRegistry();
      expect(registry.findAgentConfig("ORACLE")?.name).toBe("oracle");
    });

    it("returns the config for a disabled type", () => {
      const registry = makeRegistry(
        new Map([["worker", makeAgentConfig({ name: "worker", enabled: false })]])
      );
      expect(registry.findAgentConfig("worker")?.enabled).toBe(false);
    });

    it("returns undefined for unknown types", () => {
      const registry = makeRegistry();
      expect(registry.findAgentConfig("nonexistent")).toBeUndefined();
      expect(registry.findAgentConfig("Plan")).toBeUndefined();
      expect(registry.findAgentConfig("general-purpose")).toBeUndefined();
      expect(registry.findAgentConfig("")).toBeUndefined();
    });
  });

  describe("resolveAgentConfig", () => {
    it("returns config for a known enabled type", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("explore");
      expect(config.name).toBe("explore");
      expect(config.promptMode).toBe("replace");
    });

    it("performs case-insensitive lookup", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("EXPLORE");
      expect(config.name).toBe("explore");
    });

    it("throws an actionable error for unknown types", () => {
      const registry = makeRegistry();
      expect(() => registry.resolveAgentConfig("nonexistent")).toThrow(
        'Unknown agent type "nonexistent". Available types: explore, worker, reviewer, oracle.'
      );
    });

    it("throws for retired builtin names without a custom overlay", () => {
      const registry = makeRegistry();
      expect(() => registry.resolveAgentConfig("Plan")).toThrow(/Unknown agent type "Plan"/);
      expect(() => registry.resolveAgentConfig("general-purpose")).toThrow(
        /Unknown agent type "general-purpose"/
      );
    });

    it("returns config for disabled type (no fallback for existing disabled)", () => {
      const registry = makeRegistry(
        new Map([["worker", makeAgentConfig({ name: "worker", description: "Disabled", enabled: false })]])
      );
      const config = registry.resolveAgentConfig("worker");
      expect(config.name).toBe("worker");
      expect(config.enabled).toBe(false);
    });

    it("returns user-defined agent config", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor", description: "Security auditor" })]])
      );
      const config = registry.resolveAgentConfig("auditor");
      expect(config.name).toBe("auditor");
      expect(config.description).toBe("Security auditor");
    });
  });

  describe("getAvailableTypes", () => {
    it("includes all enabled defaults", () => {
      const registry = makeRegistry();
      const types = registry.getAvailableTypes();
      expect(types).toContain("explore");
      expect(types).toContain("worker");
      expect(types).toContain("reviewer");
      expect(types).toContain("oracle");
      expect(types).not.toContain("Plan");
      expect(types).not.toContain("general-purpose");
    });

    it("excludes disabled agents", () => {
      const registry = makeRegistry(
        new Map([["worker", makeAgentConfig({ name: "worker", enabled: false })]])
      );
      expect(registry.getAvailableTypes()).not.toContain("worker");
    });

    it("includes user agents", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor" })]])
      );
      expect(registry.getAvailableTypes()).toContain("auditor");
    });
  });

  describe("getAllTypes", () => {
    it("includes disabled agents", () => {
      const registry = makeRegistry(
        new Map([["reviewer", makeAgentConfig({ name: "reviewer", enabled: false })]])
      );
      expect(registry.getAllTypes()).toContain("reviewer");
    });
  });

  describe("getDefaultAgentNames", () => {
    it("returns only default agents", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor" })]])
      );
      const names = registry.getDefaultAgentNames();
      expect(names).toEqual(["explore", "worker", "reviewer", "oracle"]);
      expect(names).not.toContain("Plan");
      expect(names).not.toContain("general-purpose");
      expect(names).not.toContain("auditor");
    });
  });

  describe("getUserAgentNames", () => {
    it("returns only user agents", () => {
      const registry = makeRegistry(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor" })],
          ["sentinel", makeAgentConfig({ name: "sentinel" })],
        ])
      );
      const names = registry.getUserAgentNames();
      expect(names).toEqual(["auditor", "sentinel"]);
      expect(names).not.toContain("explore");
    });
  });

  describe("isValidType", () => {
    it("returns true for enabled defaults", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("explore")).toBe(true);
      expect(registry.isValidType("oracle")).toBe(true);
    });

    it("returns true case-insensitively", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("EXPLORE")).toBe(true);
      expect(registry.isValidType("WORKER")).toBe(true);
    });

    it("returns false for disabled agents", () => {
      const registry = makeRegistry(
        new Map([["worker", makeAgentConfig({ name: "worker", enabled: false })]])
      );
      expect(registry.isValidType("worker")).toBe(false);
    });

    it("returns false for unknown types", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("nonexistent")).toBe(false);
      expect(registry.isValidType("")).toBe(false);
    });
  });

  describe("getToolNamesForType", () => {
    it("returns all built-in tools for worker", () => {
      const registry = makeRegistry();
      expect(registry.getToolNamesForType("worker")).toEqual(BUILTIN_TOOL_NAMES);
    });

    it("returns restricted tools for explore", () => {
      const registry = makeRegistry();
      const names = registry.getToolNamesForType("explore");
      expect(names).toEqual(["read", "bash", "grep", "find", "ls"]);
    });

    it("returns restricted tools for reviewer and oracle", () => {
      const registry = makeRegistry();
      expect(registry.getToolNamesForType("reviewer")).toEqual(["read", "bash", "grep", "find", "ls"]);
      expect(registry.getToolNamesForType("oracle")).toEqual(["read", "bash", "grep", "find", "ls"]);
    });

    it("returns custom tool names for user agent", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor", toolNames: ["read", "grep"] })]])
      );
      expect(registry.getToolNamesForType("auditor")).toEqual(["read", "grep"]);
    });

    it("throws for unknown type", () => {
      const registry = makeRegistry();
      expect(() => registry.getToolNamesForType("nonexistent")).toThrow(
        /Unknown agent type "nonexistent"/
      );
    });

    it("returns an empty list for an agent that declared tools: none", () => {
      const registry = makeRegistry(
        new Map([["silent", makeAgentConfig({ name: "silent", toolNames: [] })]])
      );
      expect(registry.getToolNamesForType("silent")).toEqual([]);
    });

    it("returns the built-ins for a user agent that declared no tools key", () => {
      const registry = makeRegistry(
        new Map([["unrestricted", makeAgentConfig({ name: "unrestricted", toolNames: undefined })]])
      );
      expect(registry.getToolNamesForType("unrestricted")).toEqual(BUILTIN_TOOL_NAMES);
    });

    it("returns a disabled agent's own list rather than the built-ins", () => {
      const registry = makeRegistry(
        new Map([
          ["retired", makeAgentConfig({ name: "retired", toolNames: ["read"], enabled: false })],
        ])
      );
      expect(registry.getToolNamesForType("retired")).toEqual(["read"]);
    });
  });

  describe("DEFAULT_AGENT_NAMES static property", () => {
    it("is defined on the class", () => {
      expect(AgentTypeRegistry.DEFAULT_AGENT_NAMES).toBeDefined();
    });

    it("contains the four built-in default names", () => {
      expect(AgentTypeRegistry.DEFAULT_AGENT_NAMES).toEqual(["explore", "worker", "reviewer", "oracle"]);
    });

    it("is no longer exported from types.ts", async () => {
      // DEFAULT_AGENT_NAMES was moved to AgentTypeRegistry; it must NOT appear
      // as a named export from types.ts anymore.
      const typesModule = await import("#src/types");
      expect((typesModule as Record<string, unknown>).DEFAULT_AGENT_NAMES).toBeUndefined();
    });
  });

  describe("instance isolation", () => {
    it("two registries have independent state", () => {
      const r1 = makeRegistry(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));
      const r2 = makeRegistry();

      expect(r1.isValidType("auditor")).toBe(true);
      expect(r2.isValidType("auditor")).toBe(false);
    });
  });
});
