import type { AgentConfigLookup } from "#src/config/agent-types";
import { getLifetimeTotal, type LifetimeUsage } from "#src/lifecycle/usage";
import { type AgentDetails, formatTokens } from "#src/ui/display";

/** Next steps shared by background launch and resume acknowledgements. */
export const BACKGROUND_ACK_GUIDANCE =
  "Continue independent work, or end your current turn if nothing else needs doing. Ending the turn does not mean the delegated task is complete.\n" +
  "Results and questions will be pushed automatically; do not poll or call get_subagent_result just to wait.\n" +
  "Use get_subagent_result only for full output beyond the pushed result, truncated-output recovery, a transcript (verbose: true), or diagnostics. Use steer_subagent for mid-run messages.\n" +
  "Do not duplicate this agent's work.";

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number;
    status: string;
    error?: string;
    id?: string;
    lifetimeUsage: LifetimeUsage;
    /** Live-activity counters — exposed as getters on Subagent (Phase 18 Step 2). */
    turnCount?: number;
    maxTurns?: number;
  },
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    turnCount: record.turnCount,
    maxTurns: record.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Render a spawn's advisories as the prefix a result's leading line follows, or "" when there are none. */
export function renderSpawnNotes(notes: readonly string[]): string {
  return notes.length > 0 ? `${notes.join("\n")}\n\n` : "";
}

/**
 * Tool execute return value for a text response.
 *
 * Generic over the details payload so a tool with its own presentation metadata
 * can attach it; defaults to `AgentDetails`, which is what every subagent-tool
 * call site passes.
 */
export function textResult<T = AgentDetails>(msg: string, details?: T) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Narrow registry interface needed by buildTypeListText.
 * Extends AgentConfigLookup with the two name-listing methods.
 */
export interface TypeListRegistry extends AgentConfigLookup {
  getDefaultAgentNames(): string[];
  getUserAgentNames(): string[];
}

/**
 * Build the full agent-type list text for the Agent tool description.
 * Extracted from index.ts so it can be called inside createAgentTool.
 */
export function buildTypeListText(registry: TypeListRegistry, agentDir: string): string {
  const defaultNames = registry.getDefaultAgentNames().filter((name) => isEnabledAgent(registry, name));
  const userNames = registry.getUserAgentNames().filter((name) => isEnabledAgent(registry, name));

  const defaultDescs = defaultNames.map((name) => {
    const cfg = registry.resolveAgentConfig(name);
    const modelSuffix = cfg.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
    return `- ${name}: ${cfg.description}${modelSuffix}`;
  });

  const customDescs = userNames.map((name) => {
    const cfg = registry.resolveAgentConfig(name);
    return `- ${name}: ${cfg.description}`;
  });

  return [
    ...(defaultDescs.length > 0 ? ["Default agents:", ...defaultDescs] : []),
    ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
    "",
    `Custom agents can be defined in .pi/agents/<name>.md (project) or ${agentDir}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.`,
  ].join("\n");
}

/** True when an agent config is present and not explicitly disabled. */
function isEnabledAgent(registry: AgentConfigLookup, name: string): boolean {
  return registry.resolveAgentConfig(name).enabled !== false;
}

/**
 * Collect the per-agent usage guidelines for the subagent tool's Guidelines: block.
 * Include enabled builtin, custom, and overridden roles in catalog order.
 * Attribute plain-text guidance to its role instead of requiring users to
 * embed the name or Markdown framing in their settings.
 */
export function buildAgentGuidelines(registry: TypeListRegistry): string[] {
  return [...registry.getDefaultAgentNames(), ...registry.getUserAgentNames()]
    .flatMap((name) => {
      const config = registry.resolveAgentConfig(name);
      const guideline = config.toolGuideline?.trim();
      if (config.enabled === false || !guideline) return [];
      return [`- ${name}: ${guideline.replace(/\r?\n/g, "\n  ")}`];
    });
}

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.includes("/") ? model.split("/").pop()! : model;
  // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  return name.replace(/-\d{8}$/, "");
}
