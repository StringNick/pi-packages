import type { ShellToolsConfig } from "#src/config/config-schema";
import type { FlatPermissionConfig } from "#src/types";

/**
 * Optional process-host policy. The symbol boundary survives Pi's isolated
 * extension module loaders while keeping the package standalone by default.
 */
export const PI_PERMISSION_HOST_POLICY_KEY = Symbol.for(
  "pi-permission-system.host-policy.v1",
);

export interface PiPermissionHostPolicy {
  hasShellExecutionScope?(sessionId: string | null): boolean;
  /** Distinguish terminal denial from a cancelled pending evaluation during a live mode change. */
  onApprovalDecision?(approved: boolean, confirmationUnavailable: boolean): void;
  /** Preserve a Core-owned exact call scope while native approval forwarding awaits UI. */
  runApprovalPrompt?<T>(requestId: string, prompt: () => Promise<T>): Promise<T>;
  /** Scope native checks and bind their outcome to Core's exact tool callback. */
  runToolCall?(call: {
    sessionId: string; toolCallId: string; toolName: string; cwd: string;
    input: unknown; signal?: AbortSignal;
  }, evaluate: () => Promise<{ action: "allow" } | { action: "block"; reason: string }>):
    Promise<{ action: "allow" } | { action: "block"; reason: string }>;
  /** Namespace shell reusable choices by Core-attested invocation context. */
  scopeShellApprovalPatterns?(surface: string, patterns: readonly string[]): string[];
  inspectShellProgram?(command: string, units: readonly {
    text: string; wrapperKind?: unknown; commandContext?: unknown;
  }[]): void;
  /** Core-owned policy used instead of file-sourced permission rules. */
  permission: FlatPermissionConfig;
  /** Core-owned aliases that must pass through the native bash gate stack. */
  shellTools: ShellToolsConfig;
  /** Core-owned projection from one trusted tool call to every path it may mutate. */
  getToolAccessPaths?(
    toolName: string,
    input: unknown,
  ): readonly string[] | undefined;
  /** Core-owned reusable choices for a path-bearing tool call. */
  getReusableApprovalChoices?(input: {
    cwd: string;
    surface: string;
    toolName: string;
    paths: readonly string[];
    exactPatterns: readonly string[];
    suggestedPatterns: readonly string[];
  }): readonly Readonly<{
    surface: string;
    patterns: readonly string[];
    patternKind: "exact" | "suggested";
    matchLabel: string;
  }>[];
  /** Core-owned, session-specific auto-approval decision. */
  isFullAccess(sessionId: string | null): boolean;
  /** Core-owned, per-request auto-approval decision. */
  shouldAutoApprove(input: {
    sessionId: string | null;
    surface: string;
    toolName: string | null;
    input: unknown;
    matchedPattern: string | null;
    commandUnits?: readonly Readonly<{
      text: string;
      state: "allow" | "ask" | "deny";
      matchedPattern?: string;
      origin: string;
      wrapperKind?: unknown;
      commandContext?: unknown;
      executedUnit?: unknown;
    }>[];
  }): boolean;
  /** Bounded facts emitted when the Core host auto-approves a request. */
  describeAutoApproval?(input: Parameters<PiPermissionHostPolicy["shouldAutoApprove"]>[0]):
    | Readonly<Record<string, string | boolean>>
    | undefined;
  /** Content-free reason why Core did not auto-approve this ask. */
  describeApprovalRequirement?(input: Parameters<PiPermissionHostPolicy["shouldAutoApprove"]>[0]): string | undefined;
  /** Core-owned reusable rules, evaluated by this package's native matcher. */
  getRules(sessionId: string | null): readonly Readonly<{ surface: string; pattern: string }>[];
  /** Persist or retain the reusable approval selected in the portable prompt. */
  recordApproval(approval: {
    sessionId: string;
    scope: "session" | "workspace" | "global";
    surface: string;
    patterns: readonly string[];
    /** Execution context for scoping plain forwarded shell patterns. */
    execution?: { isolation: "sandbox" | "host"; cwd?: string };
  }): Promise<void>;
  /** Persist every reusable rule one combined approval decision selected. */
  recordApprovals?(approvals: readonly {
    sessionId: string;
    scope: "session" | "workspace" | "global";
    surface: string;
    patterns: readonly string[];
    /** Execution context for scoping plain forwarded shell patterns. */
    execution?: { isolation: "sandbox" | "host"; cwd?: string };
  }[], lifetime?: { signal?: AbortSignal }): Promise<void>;
}

export function getPiPermissionHostPolicy(): PiPermissionHostPolicy | undefined {
  return (globalThis as Record<symbol, unknown>)[PI_PERMISSION_HOST_POLICY_KEY] as
    | PiPermissionHostPolicy
    | undefined;
}
