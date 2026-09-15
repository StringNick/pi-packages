import type { AccessPath } from "#src/access-intent/access-path";
import { getPiPermissionHostPolicy } from "#src/host-policy";
import { PATH_BEARING_TOOLS } from "#src/access-intent/path-surfaces";
import { getPathBearingToolPath } from "#src/access-intent/tool-input-path";
import {
  classifyToolKind,
  type ShellInvocation,
} from "#src/access-intent/tool-kind";
import {
  suggestBashPattern,
  suggestPathSessionPattern,
  suggestSessionPattern,
} from "#src/presentation/pattern-suggest";
import { buildToolAskPayload } from "#src/presentation/tool-ask-payload";
import { SessionApproval } from "#src/session/session-approval";
import type { ToolPreviewFormatter } from "#src/tool-input/tool-preview-formatter";
import type { PermissionCheckResult } from "#src/types";
import type { GateDescriptor } from "./descriptor";
import {
  accessFactsFromPath,
  accessFactsFromValue,
  deriveDecisionValue,
} from "./helpers";
import type { ToolCallContext } from "./types";

/**
 * A path-bearing tool call's resolved path, paired with the session scope
 * approving it would grant.
 *
 * The pattern is derived by the pipeline's `PathNormalizer`, which owns the
 * session's `PathFlavor`, rather than re-derived here from `path.value()` — so
 * the gate carries the platform's separator semantics without holding them
 * (#655).
 */
export interface ToolPathAccess {
  readonly path: AccessPath;
  readonly approvalPattern: string;
}

/**
 * Derive the value used for session-approval pattern suggestions.
 *
 * Bash → command string; MCP → qualified target; everything else → catch-all
 * wildcard. A path-bearing tool that resolved a path never reaches here — its
 * suggestion comes from the already-derived {@link ToolPathAccess} pattern.
 */
function deriveSuggestionValue(
  toolName: string,
  check: PermissionCheckResult,
): string {
  switch (classifyToolKind(toolName)) {
    case "bash":
      return check.command ?? "";
    case "mcp":
      return check.target ?? "mcp";
    default:
      return "*";
  }
}

function exactBashApprovalPatterns(check: PermissionCheckResult): string[] | null {
  if (!check.commandUnits || check.commandUnits.some((unit) => unit.wrapperKind)) return null;
  const patterns = [
    ...new Set(
      check.commandUnits
        .filter((unit) => unit.state === "ask")
        .map((unit) => unit.text.trim())
        .filter(
          (unit) => unit.length > 0 && !/^(?:cd|pushd|popd)(?:\s|$)/u.test(unit),
        ),
    ),
  ];
  return patterns.length > 0 ? patterns : null;
}

/**
 * Build a pure descriptor for the normal tool permission gate.
 *
 * Takes a pre-computed PermissionCheckResult (from checkPermission) and
 * returns a GateDescriptor that the runner can execute. No side effects.
 */
export function describeToolGate(
  tcc: ToolCallContext,
  check: PermissionCheckResult,
  formatter: ToolPreviewFormatter,
  pathAccess?: ToolPathAccess | readonly ToolPathAccess[],
  shell?: ShellInvocation | null,
): GateDescriptor {
  const pathAccesses = pathAccess
    ? Array.isArray(pathAccess)
      ? pathAccess
      : [pathAccess]
    : [];
  const firstPathAccess = pathAccesses[0];
  // A shell invocation (native `bash` or an aliased shell tool) is gated on the
  // `bash` surface — its session rule, decision value, and suggestion are
  // bash-shaped — while the invoked tool name is preserved in the prompt and
  // review log so a user sees which tool actually ran (#574).
  const gateSurface = shell ? "bash" : tcc.toolName;

  const permissionLogContext = formatter.getPermissionLogContext(
    check,
    tcc.input,
    PATH_BEARING_TOOLS,
  );

  // Compute session approval suggestion for the "for this session" option.
  const suggestion = firstPathAccess
    ? suggestPathSessionPattern(gateSurface, firstPathAccess.approvalPattern)
    : suggestSessionPattern(
        gateSurface,
        deriveSuggestionValue(gateSurface, check),
      );

  const payload = buildToolAskPayload({
    check,
    agentName: tcc.agentName,
    surface: gateSurface,
    invokedToolName: tcc.toolName,
    input: tcc.input,
    formatter,
    accessPaths: pathAccesses.map(({ path }) => path.value()),
  });

  const decisionValue = deriveDecisionValue(
    gateSurface,
    check,
    firstPathAccess?.path.value() ?? getPathBearingToolPath(tcc.toolName, tcc.input) ?? undefined,
  );

  // A path-bearing tool carries the AccessPath's alias set; every other surface
  // (bash command, MCP target, plain tool) carries its already-portable value.
  const accessIntent = firstPathAccess && pathAccesses.length === 1
    ? accessFactsFromPath(gateSurface, firstPathAccess.path)
    : accessFactsFromValue(gateSurface, decisionValue);

  const pathSuggestedPatterns = pathAccesses.map(({ approvalPattern }) => approvalPattern);
  const pathExactPatterns = pathAccesses.map(({ path }) => path.value());
  const reusableChoices =
    check.reusableApprovalChoices ??
    (pathAccesses.length > 0
      ? getPiPermissionHostPolicy()?.getReusableApprovalChoices?.({
          cwd: tcc.cwd,
          surface: gateSurface,
          toolName: tcc.toolName,
          paths: pathExactPatterns,
          exactPatterns: pathExactPatterns,
          suggestedPatterns: pathSuggestedPatterns,
        })
      : undefined);
  const rawBashPatterns = shell ? exactBashApprovalPatterns(check) : null;
  const literalBashPatterns = rawBashPatterns?.map((pattern) =>
    /[?*]/u.test(pattern) ? `literal-v1:${JSON.stringify(pattern)}` : pattern,
  );
  const exactBashPatterns = literalBashPatterns
    ? getPiPermissionHostPolicy()?.scopeShellApprovalPatterns?.(gateSurface, literalBashPatterns) ?? literalBashPatterns
    : null;
  // Suggested bash rules are per-unit prefix wildcards, so one saved rule can
  // cover a command's future arguments without ever covering sibling
  // commands — the native matcher still evaluates every unit separately.
  const suggestedBashPatterns = rawBashPatterns
    ? getPiPermissionHostPolicy()?.scopeShellApprovalPatterns?.(
        gateSurface,
        rawBashPatterns
          .map((pattern) => suggestBashPattern(pattern))
          .filter((pattern) => pattern.trim().length > 0),
      ) ?? exactBashPatterns
    : null;
  return {
    surface: gateSurface,
    input: tcc.input,
    payload,
    sessionApproval: pathAccesses.length > 0
      ? SessionApproval.multiple(
          gateSurface,
          pathSuggestedPatterns,
          pathExactPatterns,
          reusableChoices,
        )
      : exactBashPatterns
      ? SessionApproval.multiple(
          gateSurface,
          suggestedBashPatterns ?? exactBashPatterns,
          exactBashPatterns,
        )
      : shell && getPiPermissionHostPolicy()
        ? undefined
        : reusableChoices
          ? SessionApproval.multiple(
              suggestion.surface,
              [suggestion.pattern],
              [firstPathAccess ? firstPathAccess.path.value() : decisionValue],
              reusableChoices,
            )
          : SessionApproval.single(
              suggestion.surface,
              suggestion.pattern,
              firstPathAccess ? firstPathAccess.path.value() : decisionValue,
            ),
    promptDetails: {
      source: "tool_call",
      agentName: tcc.agentName,
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      sessionLabel: suggestion.label,
      ...(pathAccesses.length <= 1 ? { accessIntent } : {}),
      ...permissionLogContext,
    },
    logContext: {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      ...permissionLogContext,
      ...floorExemptionFact(check),
    },
    decision: {
      surface: gateSurface,
      value: decisionValue,
    },
  };
}

/**
 * Why a bash wrapper's floor did not apply, when one did not (#803).
 *
 * The blame line ADR 0013 §11 asks the review log to record: `matchedPattern`
 * names the rule that decided and `executedUnit` the command it decided about,
 * and this names why that rule was consulted instead of the floor. Absent for
 * every other decision, so a line states what was true rather than enumerating
 * what was not.
 *
 * It rides the gate's `logContext` rather than the prompt payload because an
 * exempt unit's usual outcome is that no prompt happens at all — the same
 * routing `effect`/`effectSource` take on the bash path gates.
 */
function floorExemptionFact(
  check: PermissionCheckResult,
): Record<string, unknown> {
  return check.floorExemption === undefined
    ? {}
    : { floorExemption: check.floorExemption };
}
