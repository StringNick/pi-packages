/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .zrow/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { DEFAULT_AGENT_NAMES, DEFAULT_AGENTS } from "#src/config/default-agents";
import type { AgentConfig } from "#src/types";

// ── AgentConfigLookup interface ──────────────────────────────────────────────

/**
 * Narrow registry interface for consumers that only need config resolution.
 * Prefer this over the full `AgentTypeRegistry` in function signatures (ISP).
 */
export interface AgentConfigLookup {
  /**
   * Non-throwing lookup, case-insensitive. Returns undefined for unregistered
   * types — for historical UI names (e.g. labels from older sessions) that no
   * longer resolve. Callers that need a config must use `resolveAgentConfig`.
   */
  findAgentConfig(type: string): AgentConfig | undefined;
  resolveAgentConfig(type: string): AgentConfig;
  getToolNamesForType(type: string): string[];
}

// ── AgentTypeRegistry class ──────────────────────────────────────────────────

/**
 * Injectable registry of all agent configurations (defaults + user-defined).
 *
 * Replaces the module-scoped `agents` Map and its companion free functions.
 * The constructor accepts a `loadUserAgents` callback to defer disk I/O to the
 * call site, keeping this class side-effect-free and easy to test.
 */
export class AgentTypeRegistry implements AgentConfigLookup {
  private agents = new Map<string, AgentConfig>();

  /** The embedded default agent names — single-sourced from default-agents. */
  static readonly DEFAULT_AGENT_NAMES = DEFAULT_AGENT_NAMES;

  constructor(private loadUserAgents: () => Map<string, AgentConfig>) {
    this.reload();
  }

  /**
   * Re-scan user agents and rebuild the registry.
   * Starts with DEFAULT_AGENTS, then overlays whatever `loadUserAgents()` returns.
   */
  reload(): void {
    this.agents.clear();
    for (const [name, config] of DEFAULT_AGENTS) {
      this.agents.set(name, config);
    }
    for (const [name, config] of this.loadUserAgents()) {
      this.agents.set(name, config);
    }
  }

  /** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
  resolveType(name: string): string | undefined {
    return this.resolveKey(name);
  }

  /** Get all enabled type names (for spawning and tool descriptions). */
  getAvailableTypes(): string[] {
    return [...this.agents.entries()]
      .filter(([_, config]) => config.enabled !== false)
      .map(([name]) => name);
  }

  /** Get all type names including disabled (for UI listing). */
  getAllTypes(): string[] {
    return [...this.agents.keys()];
  }

  /** Get names of default agents currently in the registry. */
  getDefaultAgentNames(): string[] {
    return [...this.agents.entries()]
      .filter(([_, config]) => config.isDefault === true)
      .map(([name]) => name);
  }

  /** Get names of user-defined agents (non-defaults) currently in the registry. */
  getUserAgentNames(): string[] {
    return [...this.agents.entries()]
      .filter(([_, config]) => config.isDefault !== true)
      .map(([name]) => name);
  }

  /** Check if a type is valid and enabled (case-insensitive). */
  isValidType(type: string): boolean {
    const key = this.resolveKey(type);
    if (!key) return false;
    return this.agents.get(key)?.enabled !== false;
  }

  /**
   * Get the capability tool names for a type (case-insensitive).
   *
   * An agent that declares no `tools:` key gets the built-ins; one that declares
   * `tools: none` gets nothing. Resolution goes through `resolveAgentConfig` so
   * the two cannot disagree about which config a type names.
   */
  getToolNamesForType(type: string): string[] {
    return this.resolveAgentConfig(type).toolNames ?? [...BUILTIN_TOOL_NAMES];
  }

  /**
   * Non-throwing lookup, case-insensitive. Returns the config when `type` names
   * a registered agent (disabled included) — undefined otherwise.
   */
  findAgentConfig(type: string): AgentConfig | undefined {
    const key = this.resolveKey(type);
    return key ? this.agents.get(key) : undefined;
  }

  /**
   * Resolve agent config, case-insensitive. Throws an actionable error for
   * unknown types — there is no builtin fallback. A user-defined agent may
   * reuse a retired name (e.g. Plan); that resolves here as an ordinary entry.
   */
  resolveAgentConfig(type: string): AgentConfig {
    const config = this.findAgentConfig(type);
    if (config) return config;
    const available = this.getAvailableTypes();
    throw new Error(
      `Unknown agent type "${type}". Available types: ${available.join(", ") || "(none)"}.`
    );
  }

  private resolveKey(name: string): string | undefined {
    if (this.agents.has(name)) return name;
    const lower = name.toLowerCase();
    for (const key of this.agents.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    return undefined;
  }
}

/** All known built-in tool names. */
export const BUILTIN_TOOL_NAMES: string[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
