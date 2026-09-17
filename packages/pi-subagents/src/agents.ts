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
 * - `resolveSessionModelOverride` / `resolveSessionThinkingOverride` — explicit
 *   user selections at the tool door.
 * - `resolveExposeCallerMaxTurns` — host policy withholding the caller-facing
 *   `max_turns` param from the LLM tool surface.
 *
 * Runtime tuning (`subagents.json`) stays behind the `/subagents:settings`
 * door and the `SettingsManager`; this seam carries no settings ownership.
 */

export { type AgentConfigLookup, AgentTypeRegistry } from "#src/config/agent-types";
export { type LoadCustomAgentsOptions, loadCustomAgents } from "#src/config/custom-agents";
export { DEFAULT_AGENTS } from "#src/config/default-agents";
export {
  type AgentInvocationConfig,
  isLockableField,
  LOCKABLE_FIELDS,
  type LockableField,
  type LockDeclaration,
  resolveAgentInvocationConfig,
} from "#src/config/invocation-config";
export {
  parseThinkingLevel,
  type SubagentThinkingLevel,
  THINKING_LEVELS,
  thinkingLevelError,
} from "#src/config/thinking-level";
export { normalizeModelReference } from "#src/session/model-resolver";
export {
  type SettingsSnapshot as SubagentsSettingsSnapshot,
  SUBAGENTS_SETTING_DEFAULTS,
  SUBAGENTS_SETTING_LIMITS,
  type SubagentsSettings,
  sanitizeSubagentsSettings,
} from "#src/settings";
export {
  resolveExposeCallerMaxTurns,
  resolveSessionModelOverride,
  resolveSessionThinkingOverride,
} from "#src/tools/session-override";
export {
  type ModelInfo,
  type ResolvedSpawnConfig,
  resolveSpawnConfig,
  type SpawnConfigError,
} from "#src/tools/spawn-config";
export type { AgentConfig } from "#src/types";
