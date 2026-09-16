/**
 * agents.ts — Minimal agent-definition metadata seam for hosts.
 *
 * Re-exports the native parsing, defaults, precedence and validation pieces a
 * host (Zrow Settings) needs to list, create and edit agent definitions
 * without duplicating a second agent authority:
 *
 * - `DEFAULT_AGENTS` — embedded built-in definitions;
 * - `loadCustomAgents` — project/global `.md` discovery with native precedence;
 * - `AgentTypeRegistry` — effective merge of defaults + custom agents;
 * - invocation-config helpers — caller/agent-file precedence and `locked:`;
 * - thinking vocabulary — the exact levels spawn doors accept;
 * - `resolveSpawnConfig` — the pure launch-door resolution (precedence proof);
 * - `resolveSessionModelOverride` — explicit user selection at the tool door.
 *
 * Runtime tuning (`subagents.json`) stays behind the `/subagents:settings`
 * door and the `SettingsManager`; this seam carries no settings ownership.
 */

export { AgentTypeRegistry, type AgentConfigLookup } from "#src/config/agent-types";
export { loadCustomAgents, type LoadCustomAgentsOptions } from "#src/config/custom-agents";
export { DEFAULT_AGENTS } from "#src/config/default-agents";
export {
  isLockableField,
  LOCKABLE_FIELDS,
  resolveAgentInvocationConfig,
  type AgentInvocationConfig,
  type LockableField,
  type LockDeclaration,
} from "#src/config/invocation-config";
export {
  parseThinkingLevel,
  THINKING_LEVELS,
  thinkingLevelError,
  type SubagentThinkingLevel,
} from "#src/config/thinking-level";
export {
  resolveSpawnConfig,
  type ModelInfo,
  type ResolvedSpawnConfig,
  type SpawnConfigError,
} from "#src/tools/spawn-config";
export { resolveSessionModelOverride } from "#src/tools/session-override";
export {
  sanitizeSubagentsSettings,
  SUBAGENTS_SETTING_DEFAULTS,
  SUBAGENTS_SETTING_LIMITS,
  type SettingsSnapshot as SubagentsSettingsSnapshot,
  type SubagentsSettings,
} from "#src/settings";
export type { AgentConfig } from "#src/types";
