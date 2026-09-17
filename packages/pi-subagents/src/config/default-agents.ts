/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 * A user-defined agent may use any name, including a retired one like "Plan" or
 * "general-purpose", which then lives on as an ordinary custom agent.
 */

import { EXPLORE_SYSTEM_PROMPT, ORACLE_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT, WORKER_SYSTEM_PROMPT } from "#src/config/role-prompts";
import type { AgentConfig } from "#src/types";

/**
 * Canonical names of the embedded default agents, in registry (routing) order.
 * Single source: DEFAULT_AGENTS is built from this tuple so the two cannot drift.
 * Names are exact lowercase; a user file matching one case-insensitively
 * (e.g. a legacy Explore.md) overrides the canonical builtin (see custom-agents).
 */
export const DEFAULT_AGENT_NAMES = ["explore", "worker", "reviewer", "oracle"] as const;

/** One of the embedded default agent names. */
export type DefaultAgentName = (typeof DEFAULT_AGENT_NAMES)[number];

/** Tools for read-oriented roles: inspect code, never change it. */
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

// No built-in sets model / thinking (every built-in inherits the parent's), declares
// `locked` (a caller that knows better may override anything), or sets
// inheritContext / runInBackground (strategy fields, callers decide per-call).
const DEFINITIONS: Record<DefaultAgentName, AgentConfig> = {
  explore: {
    name: "explore",
    displayName: "explore",
    description: "Fast codebase exploration agent (read-only)",
    toolGuideline:
      "Use explore for codebase discovery and tracing behavior; avoid implementation and review verdicts. The parent owns planning.",
    toolNames: READ_ONLY_TOOLS,
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    promptMode: "replace",
    isDefault: true,
  },
  worker: {
    name: "worker",
    displayName: "worker",
    description: "Implementation worker for a parent-approved change",
    toolGuideline:
      "Use worker for a bounded implementation or fix, including local investigation and checks; avoid open-ended architecture decisions. The parent sets scope.",
    // toolNames omitted — a worker needs the normal built-in tools.
    systemPrompt: WORKER_SYSTEM_PROMPT,
    promptMode: "replace",
    isDefault: true,
  },
  reviewer: {
    name: "reviewer",
    displayName: "reviewer",
    description: "Code reviewer for evidence-backed findings (read-only)",
    toolGuideline:
      "Use reviewer for an evidence-backed review of a change; avoid fixes and planning, which remain with the parent — it reports findings only.",
    toolNames: READ_ONLY_TOOLS,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    promptMode: "replace",
    isDefault: true,
  },
  oracle: {
    name: "oracle",
    displayName: "oracle",
    description: "Architecture oracle for root-cause and tradeoff questions (read-only)",
    toolGuideline:
      "Use oracle for difficult architecture, root-cause, or tradeoff questions; avoid routine lookup, code review, and implementation. The parent owns the final decision and plan.",
    toolNames: READ_ONLY_TOOLS,
    // inheritContext deliberately omitted: history is available when the caller
    // requests it, never forced.
    systemPrompt: ORACLE_SYSTEM_PROMPT,
    promptMode: "replace",
    isDefault: true,
  },
};

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map(
  DEFAULT_AGENT_NAMES.map((name): [string, AgentConfig] => [name, DEFINITIONS[name]]),
);
