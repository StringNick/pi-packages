import type { AccessPath } from "#src/access-intent/access-path";
import { getPiPermissionHostPolicy } from "#src/host-policy";
import type { PathNormalizer } from "#src/path/path-normalizer";
import type { ScopedPermissionResolver } from "#src/policy/permission-resolver";
import { buildExternalDirectoryAskPayload, buildPathAskPayload } from "#src/presentation/path-ask-payload";
import { SessionApproval } from "#src/session/session-approval";
import type { PermissionCheckResult } from "#src/types";
import type { GateDescriptor, GateResult } from "#src/handlers/gates/descriptor";
import { resolveExternalDirectoryPolicy } from "#src/handlers/gates/external-directory-policy";
import { accessFactsFromPath } from "#src/handlers/gates/helpers";
import type { ToolCallContext } from "#src/handlers/gates/types";

const MAX_HOST_TOOL_PATHS = 100;

export interface HostToolPathCheck {
  readonly inputPath: string;
  readonly path: AccessPath;
  readonly approvalPattern: string;
  readonly check: PermissionCheckResult;
}

export function getHostToolPaths(toolName: string, input: unknown): string[] {
  const projected = getPiPermissionHostPolicy()?.getToolAccessPaths?.(toolName, input);
  if (projected === undefined) return [];
  if (!Array.isArray(projected) || projected.length > MAX_HOST_TOOL_PATHS) {
    throw new Error(`Host tool path projection for '${toolName}' is invalid.`);
  }
  const paths = [
    ...new Set(
      projected.map((path) => {
        if (typeof path !== "string" || !path.trim()) {
          throw new Error(`Host tool path projection for '${toolName}' contains an invalid path.`);
        }
        return path;
      }),
    ),
  ];
  if (paths.length === 0) {
    throw new Error(`Host tool path projection for '${toolName}' did not identify any paths.`);
  }
  return paths;
}

function decisiveChecks(checks: readonly HostToolPathCheck[]): HostToolPathCheck[] {
  const denied = checks.filter(({ check }) => check.state === "deny");
  if (denied.length > 0) return denied;
  const asked = checks.filter(({ check }) => check.state === "ask");
  if (asked.length > 0) return asked;
  return [];
}

function pathEvidence(checks: readonly HostToolPathCheck[]) {
  return checks.map(({ inputPath, path }) => ({
    label: "affected path",
    text: inputPath,
    detail: path.resolvedAlias() ?? null,
  }));
}

function multiPathDescriptor(input: {
  tcc: ToolCallContext;
  surface: "path" | "external_directory";
  checks: readonly HostToolPathCheck[];
}): GateResult {
  const relevant = decisiveChecks(input.checks);
  if (relevant.length === 0) return null;
  const first = relevant[0]!;
  const basePayload =
    input.surface === "path"
      ? buildPathAskPayload({
          surface: input.surface,
          toolName: input.tcc.toolName,
          pathValue: first.inputPath,
          agentName: input.tcc.agentName,
          matchedPattern: first.check.matchedPattern,
        })
      : buildExternalDirectoryAskPayload({
          surface: input.surface,
          toolName: input.tcc.toolName,
          pathValue: first.inputPath,
          resolvedPath: first.path.resolvedAlias(),
          cwd: input.tcc.cwd,
          agentName: input.tcc.agentName,
          matchedPattern: first.check.matchedPattern,
        });
  return {
    surface: input.surface,
    input: { paths: relevant.map(({ inputPath }) => inputPath) },
    preCheck: first.check,
    payload: {
      ...basePayload,
      evidence: [...basePayload.evidence, ...pathEvidence(relevant)],
    },
    sessionApproval: SessionApproval.multiple(
      input.surface,
      relevant.map(({ approvalPattern }) => approvalPattern),
      relevant.map(({ path }) => path.value()),
    ),
    promptDetails: {
      source: "tool_call",
      agentName: input.tcc.agentName,
      toolCallId: input.tcc.toolCallId,
      toolName: input.tcc.toolName,
      path: first.inputPath,
      ...(relevant.length === 1
        ? { accessIntent: accessFactsFromPath(input.surface, first.path) }
        : {}),
    },
    logContext: {
      source: "tool_call",
      toolCallId: input.tcc.toolCallId,
      toolName: input.tcc.toolName,
      paths: relevant.map(({ inputPath }) => inputPath),
    },
    decision: {
      surface: input.surface,
      value: relevant.map(({ inputPath }) => inputPath).join(", "),
    },
  } satisfies GateDescriptor;
}

export function resolveHostToolChecks(
  tcc: ToolCallContext,
  surface: string,
  paths: readonly string[],
  resolver: ScopedPermissionResolver,
  normalizer: PathNormalizer,
): HostToolPathCheck[] {
  return paths.map((inputPath) => {
    const path = normalizer.forPath(inputPath);
    return {
      inputPath,
      path,
      approvalPattern: normalizer.approvalPatternFor(path),
      check: resolver.resolve({
        kind: "access-path",
        surface,
        path,
        agentName: tcc.agentName ?? undefined,
      }),
    };
  });
}

export function describeHostPathGate(
  tcc: ToolCallContext,
  paths: readonly string[],
  resolver: ScopedPermissionResolver,
  normalizer: PathNormalizer,
): GateResult {
  return multiPathDescriptor({
    tcc,
    surface: "path",
    checks: resolveHostToolChecks(tcc, "path", paths, resolver, normalizer),
  });
}

export function describeHostExternalDirectoryGate(
  tcc: ToolCallContext,
  paths: readonly string[],
  resolver: ScopedPermissionResolver,
  normalizer: PathNormalizer,
): GateResult {
  const external = paths.filter((path) => normalizer.isOutsideWorkingDirectory(path));
  return multiPathDescriptor({
    tcc,
    surface: "external_directory",
    checks: external.map((inputPath) => {
      const path = normalizer.forPath(inputPath);
      return {
        inputPath,
        path,
        approvalPattern: normalizer.approvalPatternFor(path),
        check: resolveExternalDirectoryPolicy(path, resolver, "external_directory", tcc.agentName ?? undefined),
      };
    }),
  });
}
