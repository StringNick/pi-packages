/**
 * session-override.ts — Explicit user model selection at the tool door.
 *
 * A host (Zrow) may register a per-parent `resolveSessionModelOverride` hook
 * carrying the user's session-scoped model choice for one agent type. The
 * subagent tool consults it before native invocation-config merge and injects
 * the answer as the winning caller param, which yields the enforced priority
 * without a second authority:
 *
 *   native `locked:` restriction > user session selection > tool-call `model`
 *   param > agent definition > parent inherit
 *
 * A locked agent discards the override through the ordinary lock path (with
 * the usual lock note in the result); an unresolvable override surfaces as an
 * error exactly like an unresolvable caller param. Absent host, missing hook,
 * or any throw → undefined, i.e. no behavior change.
 */

import type { AgentTypeRegistry } from "#src/config/agent-types";
import { getSubagentHost } from "#src/service/host";

export function resolveSessionModelOverride(
  parentSessionId: string,
  rawType: unknown,
  registry: AgentTypeRegistry,
): string | undefined {
  let host: ReturnType<typeof getSubagentHost>;
  try {
    host = getSubagentHost(parentSessionId);
  } catch {
    return undefined;
  }
  const resolve = host?.host.resolveSessionModelOverride;
  if (!resolve) return undefined;
  const canonical =
    typeof rawType === "string"
      ? (registry.resolveType(rawType) ?? "general-purpose")
      : "general-purpose";
  let value: string | undefined;
  try {
    value = resolve(canonical);
  } catch {
    return undefined;
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
