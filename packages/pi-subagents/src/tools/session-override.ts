/**
 * session-override.ts — Explicit user model and reasoning selection at the tool door.
 *
 * A host may register per-parent model and thinking override hooks carrying
 * the user's session-scoped choices for one agent type. The subagent tool
 * consults them before native invocation-config merge and injects
 * the answer as the winning caller param, which yields the enforced priority
 * without a second authority:
 *
 *   native `locked:` restriction > user session selection > tool-call
 *   param > agent definition > parent inherit
 *
 * Reasoning has no model-facing tool parameter: user session selection >
 * agent definition > parent inherit, subject to native locks. The explicit
 * user selection is passed separately to spawn-config; caller thinking is ignored.
 *
 * A locked agent discards the override through the ordinary lock path (with
 * the usual lock note in the result); an unresolvable override surfaces as an
 * error exactly like an unresolvable caller param. Absent host, missing hook,
 * or any throw → undefined, i.e. no behavior change.
 *
 * The same door also carries `exposeCallerMaxTurns`: a host policy for the
 * caller-facing `max_turns` param (schema omission + discard), keeping turn
 * limits owned by agent definitions and runtime settings.
 */

import type { AgentTypeRegistry } from "#src/config/agent-types";
import { getSubagentHost } from "#src/service/host";

export function resolveSessionModelOverride(
  parentSessionId: string,
  rawType: unknown,
  registry: AgentTypeRegistry,
): string | undefined {
  return resolveSessionOverride(parentSessionId, rawType, registry, "resolveSessionModelOverride");
}

/**
 * Explicit user reasoning selection for one agent type. Same door, same
 * precedence as the model hook: merged as the winning caller value, so
 * native `locked:` restrictions still discard it and unrecognized values
 * still surface through the ordinary spawn-config error path.
 */
export function resolveSessionThinkingOverride(
  parentSessionId: string,
  rawType: unknown,
  registry: AgentTypeRegistry,
): string | undefined {
  return resolveSessionOverride(parentSessionId, rawType, registry, "resolveSessionThinkingOverride");
}

/**
 * Host policy for the caller-facing `max_turns` param: false withholds the
 * property from the tool schema and discards an undeclared caller value at
 * execute time. Absent host, missing flag, or any throw → true (native
 * surface unchanged). Consulted where the tool is (re)registered and at the
 * door, so schema and behavior cannot drift apart.
 */
export function resolveExposeCallerMaxTurns(parentSessionId: string): boolean {
  try {
    const host = getSubagentHost(parentSessionId)?.host;
    if (!host) return true;
    return host.exposeCallerMaxTurns !== false;
  } catch {
    return true;
  }
}

function resolveSessionOverride(
  parentSessionId: string,
  rawType: unknown,
  registry: AgentTypeRegistry,
  hook: "resolveSessionModelOverride" | "resolveSessionThinkingOverride",
): string | undefined {
  try {
    const host = getSubagentHost(parentSessionId)?.host;
    if (!host) return undefined;
    const canonical =
      typeof rawType === "string"
        ? registry.resolveType(rawType)
        : undefined;
    if (canonical === undefined) return undefined;
    // Keep the receiver for stateful hosts. Native spawn-config, not this
    // optional lookup, owns validation of a nonblank explicit selection.
    const value = host[hook]?.(canonical)?.trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}
