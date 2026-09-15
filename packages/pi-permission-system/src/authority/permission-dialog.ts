import { getPiPermissionHostPolicy } from "#src/host-policy";
import type { SessionGrantWidth } from "#src/session/approval-grant";
import type { DecisionSource } from "./decision-source";
import type { PromptPayload } from "#src/presentation/prompt-payload";
import { createApprovalEditor, type EditedApproval } from "./approval-editor";

export type PermissionDecisionState =
  | "approved"
  | "approved_for_session"
  | "approved_for_serving_session"
  | "denied"
  | "denied_with_reason";

export type PermissionPromptDecision = {
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
  /**
   * True when no human ever ruled on this ask: either no live authority was
   * reachable at all (`DenyingAuthorizer`, a no-UI non-subagent session) or the
   * forwarding path gave up before reaching one (`ParentAuthorizer` — target
   * unresolvable, request undeliverable, target not serving, or no answer
   * within the timeout). Consumed by the gate (block reason) and
   * `PermissionPrompter` (review-entry resolution) to report
   * "confirmation_unavailable" rather than a plain user denial — a user who
   * was never asked denied nothing (#719). The decision-event resolution
   * reads the `unavailable` decider below instead (#772).
   */
  confirmationUnavailable?: true;
  /**
   * How wide a whole-session grant the human chose, when they chose one.
   *
   * Orthogonal to `state` rather than a value of it: the two directions and
   * the subagent/serving scope vary independently, and an unrecognized `state`
   * is rejected outright by the forwarded-response reader, where an
   * unrecognized field is merely dropped. Absent means `"proven"` — the
   * direction the gate named, which is what every producer chose before #813.
   */
  sessionGrantWidth?: SessionGrantWidth;
  /**
   * What decided this request, stamped by the site that decided it.
   *
   * Required: every decision names its decider, and the type is what
   * guarantees it rather than a convention each producer has to remember — the
   * same discipline `PromptPermissionDetails.payload` carries (#726).
   */
  decidedBy: DecisionSource;
  reusableApproval?: {
    scope: "session" | "workspace" | "global";
    patternKind: "exact" | "suggested";
    surface: string;
    patterns: readonly string[];
  };
  /** Every reusable rule one approval decision saves, across surfaces. */
  reusableApprovals?: readonly {
    scope: "session" | "workspace" | "global";
    patternKind: "exact" | "suggested";
    surface: string;
    patterns: readonly string[];
  }[];
};

/**
 * A decision before its decider is known.
 *
 * The inner producers — the dialog's decision model, the `select`/`input`
 * fallback, the verdict mapper — state the outcome; which decider to attribute
 * it to is settled one layer up, at the site that chose the producer. The same
 * shape `GateBypass.decision` uses for the request id: a producer emits only
 * what it knows.
 */
export type UnattributedDecision = Omit<PermissionPromptDecision, "decidedBy">;

type PermissionDialogChoice =
  | {
      value: string;
      action: "allow-once" | "allow-session" | "deny" | "deny-with-reason";
    }
  | {
      value: string;
      action: "allow-reusable";
      scope: "session" | "workspace" | "global";
      patternKind: "exact" | "suggested";
      surface: string;
      pattern: string;
      patterns: readonly string[];
      matchLabel?: string;
      /** Present when one choice saves several surfaces' rules together. */
      groups?: readonly ReusablePermissionOption[];
      /** Which of the offered groups and pattern kinds this choice persists. */
      saveVariant?: {
        mode: "all" | "single";
        kind: "exact" | "suggested";
        surface?: string;
      };
    };

export interface PermissionDecisionUi {
  select(
    title: string,
    options: string[],
    dialogOptions?: {
      timeout?: number;
      zrowPermission?: {
        title: string;
        message: string;
        choices: PermissionDialogChoice[];
        editor?: ReturnType<typeof createApprovalEditor>;
        request?: PromptPayload;
        diagnostic?: { requestId: string; toolCallId?: string; hostApprovalReason?: string };
      };
    },
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    dialogOptions?: { timeout?: number },
  ): Promise<string | undefined>;
}

/** Keep local and forwarded portable approval prompts on one bounded deadline. */
export const PERMISSION_UI_TIMEOUT_MS = 10 * 60 * 1000;

const APPROVE_OPTION = "Yes";
const APPROVE_FOR_SESSION_OPTION = "Yes, for this session";
const DENY_OPTION = "No";
const DENY_WITH_REASON_OPTION = "No, provide reason";
const MAX_REUSABLE_PATTERNS = 32;

function safeReusablePatterns(patterns: readonly string[] | undefined): readonly string[] | null {
  if (
    !patterns ||
    patterns.length === 0 ||
    patterns.length > MAX_REUSABLE_PATTERNS ||
    patterns.some((pattern) => !pattern.trim() || pattern.length > 8_192)
  ) {
    return null;
  }
  return [...patterns];
}

function reusableOptionLabel(
  surface: string,
  patterns: readonly string[],
  scope: "session" | "workspace" | "global",
  exact: boolean,
  matchLabel?: string,
): string {
  if (matchLabel) return `Yes, allow ${matchLabel} for this ${scope}`;
  const remainder = patterns.length > 1 ? ` and ${patterns.length - 1} more` : "";
  return `Yes, allow ${exact ? "exact " : ""}${surface} "${patterns[0]}"${remainder} for this ${scope}`;
}

/** One permission surface's exact and prefix-wildcard rule candidates. */
type ReusableApprovalGroup = {
  surface: string;
  exactPatterns: readonly string[];
  suggestedPatterns: readonly string[];
};

/**
 * Refine suggested prefix rules that collapsed to a bare executable wildcard
 * (`node *`). The suggestion becomes the executable plus the script or
 * subcommand token of the exact unit, so one click can never broaden a save
 * to every invocation of an interpreter. Suggestions are convenience, never
 * authority: the native matcher still evaluates every command unit.
 */
export function refineSuggestedShellPatterns(
  exactPatterns: readonly string[],
  suggestedPatterns: readonly string[],
): readonly string[] {
  return suggestedPatterns.map((suggested, index) => {
    if (!/^\S+ \*$/u.test(suggested.trim())) return suggested;
    const exact = (exactPatterns[index] ?? "").trim();
    // Literal patterns are opaque JSON, not command tokens. Cutting them into
    // a prefix corrupts the encoding and can widen literal wildcard characters.
    if (/^(?:shell-v1:(?:sandbox|host):[a-f0-9]{64}:)?literal-v1:/u.test(exact)) return exact;
    const tokens = exact.split(/\s+/);
    if (tokens.length < 2) return exact || suggested;
    return `${tokens[0]} ${tokens[1]}*`;
  });
}

function reusableMultiOptionLabel(
  count: number,
  kind: "exact" | "suggested",
  scope: "session" | "workspace" | "global",
): string {
  const rules = count === 1 ? "rule" : "rules";
  const qualifier = kind === "exact" ? "exact" : "prefix wildcard";
  return `Yes, allow this request and save ${count} ${qualifier} ${rules} for this ${scope}`;
}

type ReusablePermissionOption = {
  surface: string;
  patterns: readonly string[];
  patternKind: "exact" | "suggested";
  matchLabel?: string;
};

function safeReusableOptions(
  reusable: RequestPermissionOptions["reusableApproval"],
): ReusablePermissionOption[] {
  if (!reusable) return [];
  const proposed = reusable.choices ?? [
    {
      surface: reusable.surface,
      patterns: reusable.exactPatterns,
      patternKind: "exact" as const,
    },
    {
      surface: reusable.surface,
      patterns: refineSuggestedShellPatterns(
        reusable.exactPatterns,
        reusable.suggestedPatterns,
      ),
      patternKind: "suggested" as const,
    },
  ];
  const seen = new Set<string>();
  const result: ReusablePermissionOption[] = [];
  for (const option of proposed) {
    const patterns = safeReusablePatterns(option.patterns);
    const surface = option.surface.trim();
    if (!patterns || !surface || surface.length > 8_192) continue;
    const key = JSON.stringify([surface, patterns]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      surface,
      patterns,
      patternKind: option.patternKind,
      ...(option.matchLabel?.trim() ? { matchLabel: option.matchLabel.trim() } : {}),
    });
  }
  return result;
}

/**
 * Validate the per-surface groups of a combined approval. Each group carries
 * its exact rule and its prefix-wildcard alternative; identical groups
 * collapse so a shell and path ask never duplicate a rule.
 */
function safeReusableGroups(
  reusable: RequestPermissionOptions["reusableApproval"],
): ReusableApprovalGroup[] {
  if (!reusable?.groups) return [];
  const seen = new Set<string>();
  const result: ReusableApprovalGroup[] = [];
  for (const group of reusable.groups) {
    const surface = group.surface.trim();
    const exactPatterns = safeReusablePatterns(group.exactPatterns);
    const suggested = safeReusablePatterns(group.suggestedPatterns);
    if (!exactPatterns || !surface || surface.length > 8_192) continue;
    const suggestedPatterns = suggested
      ? refineSuggestedShellPatterns(exactPatterns, suggested)
      : exactPatterns;
    const key = JSON.stringify([surface, exactPatterns]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ surface, exactPatterns, suggestedPatterns });
  }
  return result;
}

/**
 * A session-granting decision, naming its width only when it is not the
 * default — so a narrow grant serializes exactly as it did before the width
 * option existed.
 */
function sessionApproval(
  state: "approved_for_session" | "approved_for_serving_session",
  width: SessionGrantWidth,
): UnattributedDecision {
  return {
    approved: true,
    state,
    ...(width === "family" ? { sessionGrantWidth: width } : {}),
  };
}

export function normalizePermissionDenialReason(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createDeniedPermissionDecision(
  denialReason?: string,
): UnattributedDecision {
  const normalizedReason = normalizePermissionDenialReason(denialReason);
  return normalizedReason
    ? {
        approved: false,
        state: "denied_with_reason",
        denialReason: normalizedReason,
      }
    : {
        approved: false,
        state: "denied",
      };
}

export function isPermissionDecisionState(
  value: unknown,
): value is PermissionDecisionState {
  return (
    value === "approved" ||
    value === "approved_for_session" ||
    value === "approved_for_serving_session" ||
    value === "denied" ||
    value === "denied_with_reason"
  );
}

export interface RequestPermissionOptions {
  saveEditedApprovals?: (approvals: readonly EditedApproval[], lifetime?: { signal?: AbortSignal }) => Promise<void>;
  /** Correlation only; never tool input or approval continuation. */
  diagnostic?: { requestId: string; toolCallId?: string; hostApprovalReason?: string };
  /** Override the "for this session" option label (e.g. to show the suggested pattern). */
  sessionLabel?: string;
  /**
   * Present iff this ask's session grant can be widened to both directions:
   * its label is the extra option shown beside the proven-direction one
   * (#813). Absent leaves the prompt exactly four options.
   */
  sessionWidth?: { label: string };
  /**
   * Forwarded asks only: when set, choosing the "for this session" option opens
   * a second select asking whether the grant applies to the requesting subagent
   * only (the least-privilege default) or the whole serving session.
   */
  sessionScope?: {
    subagentLabel: string;
    servingSessionLabel: string;
  };
  reusableApproval?: {
    surface: string;
    exactPatterns: readonly string[];
    suggestedPatterns: readonly string[];
    choices?: readonly ReusablePermissionOption[];
    /** Per-surface rule groups saved together by one combined choice. */
    groups?: readonly {
      surface: string;
      exactPatterns: readonly string[];
      suggestedPatterns: readonly string[];
    }[];
    allowWorkspace: boolean;
    /** Global rules apply to every project of this app profile. */
    allowGlobal?: boolean;
  };
  /**
   * Whether the gate carries a persistable session approval for this request.
   * When false (or absent) and no reusable options apply, the "for this
   * session" choice is withheld: approving would persist nothing, so the
   * label would promise a session grant it cannot deliver.
   */
  hasSessionApproval?: boolean;
}

export async function requestPermissionDecisionFromUi(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  options?: RequestPermissionOptions,
  request?: PromptPayload,
): Promise<UnattributedDecision> {
  try {
    return await requestPermissionDecisionFromUiUnsafe(ui, title, message, options, request);
  } catch (error) {
    const denialReason =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "The interactive approval request ended without a decision.";
    return {
      approved: false,
      state: "denied",
      denialReason,
      confirmationUnavailable: true,
    };
  }
}

async function requestPermissionDecisionFromUiUnsafe(
  ui: PermissionDecisionUi,
  title: string,
  message: string,
  options?: RequestPermissionOptions,
  request?: PromptPayload,
): Promise<UnattributedDecision> {
  const hosted = getPiPermissionHostPolicy() !== undefined;
  const sessionOption = options?.sessionLabel ?? APPROVE_FOR_SESSION_OPTION;
  const widthOption = options?.sessionWidth?.label;
  const reusable = options?.reusableApproval;
  const reusableOptions = safeReusableOptions(reusable);
  const reusableGroups = safeReusableGroups(reusable);
  const editor = options?.saveEditedApprovals
    ? createApprovalEditor(reusableGroups, [
        "session",
        ...(reusable?.allowWorkspace ? ["workspace" as const] : []),
        ...(reusable?.allowGlobal ? ["global" as const] : []),
      ], options.saveEditedApprovals)
    : undefined;
  const choices: PermissionDialogChoice[] = [
    { value: APPROVE_OPTION, action: "allow-once" },
  ];
  if (reusableGroups.length > 1) {
    // One combined choice per scope saves every asking surface's rule; a
    // prefix-wildcard variant and per-surface single saves join it, so the
    // user picks exactly how far each saved rule reaches.
    const scopes: Array<"session" | "workspace" | "global"> = [
      "session",
      ...(reusable?.allowWorkspace ? (["workspace"] as const) : []),
      ...(reusable?.allowGlobal ? (["global"] as const) : []),
    ];
    const groupKinds = reusableGroups.map((group) => ({
      group,
      kinds: ["exact" as const, ...((group.suggestedPatterns.join("\u0000") !== group.exactPatterns.join("\u0000")) ? (["suggested" as const]) : [])],
    }));
    const displayGroups = (
      kind: "exact" | "suggested",
      group?: ReusableApprovalGroup,
    ): ReusablePermissionOption[] =>
      (group ? [group] : reusableGroups).map((entry) => ({
        surface: entry.surface,
        patterns: kind === "exact" ? entry.exactPatterns : entry.suggestedPatterns,
        patternKind: kind,
      }));
    for (const scope of scopes) {
      for (const kind of ["exact", "suggested"] as const) {
        const variantGroups = displayGroups(kind);
        const flatPatterns = variantGroups.flatMap((group) => group.patterns);
        if (kind === "suggested" && flatPatterns.join("\u0000") === displayGroups("exact").flatMap((group) => group.patterns).join("\u0000")) {
          continue;
        }
        choices.push({
          value: reusableMultiOptionLabel(reusableGroups.length, kind, scope),
          action: "allow-reusable",
          scope,
          patternKind: kind,
          surface: reusableGroups[0]!.surface,
          pattern: flatPatterns[0]!,
          patterns: flatPatterns,
          groups: variantGroups,
          saveVariant: { mode: "all", kind },
          ...(variantGroups.length > 1 || kind === "suggested"
            ? {
                matchLabel: `all ${reusableGroups.length} rules${kind === "suggested" ? " (prefix wildcards)" : " (exact)"}`,
              }
            : {}),
        });
      }
      // Per-surface saves keep one asking gate silent without covering the
      // sibling surface; bounded to the common two-surface combined ask.
      if (reusableGroups.length <= 2) {
        for (const { group, kinds } of groupKinds) {
          for (const kind of kinds) {
            const patterns = kind === "exact" ? group.exactPatterns : group.suggestedPatterns;
            choices.push({
              value: reusableOptionLabel(
                group.surface,
                patterns,
                scope,
                kind === "exact",
                `only ${group.surface} (${kind === "exact" ? "exact" : "prefix wildcard"})`,
              ),
              action: "allow-reusable",
              scope,
              patternKind: kind,
              surface: group.surface,
              pattern: patterns[0]!,
              patterns,
              groups: displayGroups(kind, group),
              saveVariant: { mode: "single", kind, surface: group.surface },
              matchLabel: `only ${group.surface} (${kind === "exact" ? "exact" : "prefix wildcard"})`,
            });
          }
        }
      }
    }
  } else if (reusableOptions.length > 0) {
    const scopes: Array<"session" | "workspace" | "global"> = [
      "session",
      ...(reusable?.allowWorkspace ? (["workspace"] as const) : []),
      ...(reusable?.allowGlobal ? (["global"] as const) : []),
    ];
    for (const scope of scopes) {
      for (const option of reusableOptions) {
        choices.push({
          value: reusableOptionLabel(
            option.surface,
            option.patterns,
            scope,
            option.patternKind === "exact",
            option.matchLabel,
          ),
          action: "allow-reusable",
          scope,
          patternKind: option.patternKind,
          surface: option.surface,
          pattern: option.patterns[0]!,
          patterns: option.patterns,
          ...(option.matchLabel ? { matchLabel: option.matchLabel } : {}),
        });
      }
    }
  } else if (options?.hasSessionApproval === true || (!hosted && options?.hasSessionApproval !== false)) {
    choices.push({ value: sessionOption, action: "allow-session" });
    if (widthOption) choices.push({ value: widthOption, action: "allow-session" });
  }
  choices.push(
    { value: DENY_OPTION, action: "deny" },
    { value: DENY_WITH_REASON_OPTION, action: "deny-with-reason" },
  );

  const selected = !hosted && !reusable
    ? await ui.select(`${title}\n${message}`, choices.map((choice) => choice.value))
    : await ui.select(
    `${title}\n${message}`,
    choices.map((choice) => choice.value),
    {
      timeout: PERMISSION_UI_TIMEOUT_MS,
      zrowPermission: { title, message, choices, ...(request ? { request } : {}),
        ...(editor ? { editor } : {}),
        ...(options?.diagnostic ? { diagnostic: options.diagnostic } : {}),
      },
    },
  );

  if (selected === undefined) {
    if (!hosted) return createDeniedPermissionDecision();
    return { approved: false, state: "denied", confirmationUnavailable: true,
      denialReason: "The approval request ended without a decision." };
  }

  if (selected === APPROVE_OPTION || editor?.accepts(selected)) {
    return {
      approved: true,
      state: "approved",
    };
  }

  if (choices.some((choice) => choice.value === selected) &&
    (selected === sessionOption || (widthOption && selected === widthOption))) {
    // The two session options differ only in the width they grant; the scope
    // question below is the same for both.
    const width: SessionGrantWidth =
      selected === widthOption ? "family" : "proven";
    if (options?.sessionScope) {
      const scope = await ui.select(`${title}\nApply this session grant to:`, [
        options.sessionScope.subagentLabel,
        options.sessionScope.servingSessionLabel,
      ]);
      if (hosted && scope !== options.sessionScope.subagentLabel && scope !== options.sessionScope.servingSessionLabel) {
        return createDeniedPermissionDecision();
      }
      return sessionApproval(
        scope === options.sessionScope.servingSessionLabel
          ? "approved_for_serving_session"
          : "approved_for_session",
        width,
      );
    }
    return sessionApproval("approved_for_session", width);
  }

  const reusableChoice = choices.find(
    (choice): choice is Extract<PermissionDialogChoice, { action: "allow-reusable" }> =>
      choice.action === "allow-reusable" && choice.value === selected,
  );
  if (reusableChoice) {
    const variant = reusableChoice.saveVariant;
    if (variant && reusableGroups.length > 0) {
      const selectedGroups =
        variant.mode === "single" && variant.surface
          ? reusableGroups.filter((group) => group.surface === variant.surface)
          : reusableGroups;
      const selected = selectedGroups
        .map((group) => ({
          surface: group.surface,
          patterns:
            variant.kind === "exact" ? group.exactPatterns : group.suggestedPatterns,
        }))
        .filter((entry) => entry.patterns.length > 0);
      if (selected.length > 0) {
        return {
          approved: true,
          state: "approved_for_session",
          reusableApprovals: selected.map((entry) => ({
            scope: reusableChoice.scope,
            patternKind: variant.kind,
            surface: entry.surface,
            patterns: entry.patterns,
          })),
        };
      }
    }
    if (reusableChoice.groups && reusableChoice.groups.length > 0) {
      return {
        approved: true,
        state: "approved_for_session",
        reusableApprovals: reusableChoice.groups.map((group) => ({
          scope: reusableChoice.scope,
          patternKind: group.patternKind,
          surface: group.surface,
          patterns: group.patterns,
        })),
      };
    }
    return {
      approved: true,
      state: "approved_for_session",
      reusableApproval: {
        scope: reusableChoice.scope,
        patternKind: reusableChoice.patternKind,
        surface: reusableChoice.surface,
        patterns: reusableChoice.patterns,
      },
    };
  }

  if (selected === DENY_WITH_REASON_OPTION) {
    const denialReason = normalizePermissionDenialReason(
      await ui.input(
        `${title}\nShare why this request was denied (optional).`,
        "Reason shown back to the agent",
        { timeout: PERMISSION_UI_TIMEOUT_MS },
      ),
    );

    return createDeniedPermissionDecision(denialReason);
  }

  return createDeniedPermissionDecision();
}
