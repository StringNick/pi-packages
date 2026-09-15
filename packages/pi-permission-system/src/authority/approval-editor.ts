import { randomUUID } from "node:crypto";
import { compileWildcardPattern } from "#src/policy/wildcard-matcher";
import { surfaceFamilyMembers } from "#src/access-intent/path-surfaces";
import { pathMatchOptions } from "#src/policy/rule";
import { pathFlavorForPlatform } from "#src/path/path-flavor";

type Scope = "session" | "workspace" | "global";
type Kind = "exact" | "wildcard";
export type EditedApproval = { scope: Scope; surface: string; patterns: readonly string[] };
type Group = { surface: string; exactPatterns: readonly string[]; suggestedPatterns: readonly string[] };
export type ApprovalEditorDefinition = {
  version: 1;
  scopes: Scope[];
  rows: { id: string; surface: string; exact: string; suggested: string; allowWildcard: boolean }[];
};

/** Encoding only. The permission engine's matcher remains the only matcher. */
function unpack(pattern: string): { prefix: string; text: string } {
  const shell = /^(shell-v1:(?:sandbox|host):[a-f0-9]{64}:)(.*)$/su.exec(pattern);
  const prefix = shell?.[1] ?? "";
  const value = shell?.[2] ?? pattern;
  if (!value.startsWith("literal-v1:")) return { prefix, text: value };
  const literal: unknown = JSON.parse(value.slice("literal-v1:".length));
  if (typeof literal !== "string") throw new Error("Invalid exact permission pattern");
  return { prefix, text: literal };
}

export function createApprovalEditor(
  groups: readonly Group[],
  scopes: Scope[],
  save: (approvals: readonly EditedApproval[], lifetime?: { signal?: AbortSignal }) => Promise<void>,
) {
  const originals = groups.flatMap((group) => group.exactPatterns.map((pattern, index) => ({
    surface: group.surface,
    ...unpack(pattern),
    suggested: unpack(group.suggestedPatterns[index] ?? pattern).text,
  })));
  if (!originals.length || originals.length > 32) return undefined;
  const definition: ApprovalEditorDefinition = {
    version: 1, scopes,
    rows: originals.map((row, index) => ({
      id: `rule-${index}`, surface: row.surface, exact: row.text,
      suggested: row.suggested, allowWildcard: !row.prefix.startsWith("shell-v1:host:"),
    })),
  };
  let committed: string | undefined;
  let saving = false;
  const preview = (value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid permission draft");
    const draft = value as { scope?: unknown; rows?: unknown };
    if (!scopes.includes(draft.scope as Scope) || !Array.isArray(draft.rows) || draft.rows.length !== originals.length) {
      throw new Error("Permission draft does not belong to this request");
    }
    const seen = new Set<string>();
    const selections: EditedApproval[] = [];
    const matchers: { surface: string; prefix: string; matches(value: string): boolean }[] = [];
    for (const raw of draft.rows) {
      if (!raw || typeof raw !== "object") throw new Error("Invalid permission row");
      const row = raw as { id?: unknown; selected?: unknown; pattern?: unknown; kind?: unknown };
      const index = definition.rows.findIndex((item) => item.id === row.id);
      if (index < 0 || seen.has(String(row.id)) || typeof row.selected !== "boolean") throw new Error("Invalid permission row identity");
      seen.add(String(row.id));
      if (!row.selected) continue;
      if (typeof row.pattern !== "string" || !row.pattern.trim() || row.pattern.length > 8_192 ||
        (row.kind !== "exact" && row.kind !== "wildcard")) throw new Error("Invalid permission pattern");
      const original = originals[index]!;
      if (!definition.rows[index]!.allowWildcard && (row.kind !== "exact" || row.pattern !== original.text)) {
        throw new Error("Outside-sandbox permissions must retain this exact invocation");
      }
      const kind: Kind = row.kind;
      const encoded = kind === "exact" ? `literal-v1:${JSON.stringify(row.pattern)}` : row.pattern;
      const matcher = compileWildcardPattern(encoded, "allow", pathMatchOptions(original.surface, pathFlavorForPlatform(process.platform)));
      if (!matcher.matches(original.text)) throw new Error(`Rule ${index + 1} does not match its requested command or path`);
      matchers.push({ surface: original.surface, prefix: original.prefix, matches: matcher.matches });
      selections.push({ scope: draft.scope as Scope, surface: original.surface, patterns: [original.prefix + encoded] });
    }
    if (!selections.length) throw new Error("Select at least one permission to save");
    return {
      selections,
      coverage: originals.map((row, index) => ({
        id: definition.rows[index]!.id,
        saved: (surfaceFamilyMembers(row.surface) ?? [row.surface]).every((surface) =>
          matchers.some((matcher) =>
            matcher.prefix === row.prefix &&
            (surfaceFamilyMembers(matcher.surface) ?? [matcher.surface]).includes(surface) && matcher.matches(row.text))),
      })),
    };
  };
  return {
    definition,
    async action(actionId: string, value: unknown, lifetime?: { signal?: AbortSignal }) {
      lifetime?.signal?.throwIfAborted();
      if (saving) throw new Error("Permissions are being saved");
      if (committed) throw new Error("Permissions already saved");
      if (actionId !== "permissions.preview" && actionId !== "permissions.save") throw new Error("Unknown permission action");
      const result = preview(value);
      if (actionId === "permissions.preview") return { coverage: result.coverage };
      saving = true;
      try {
        await save(result.selections, lifetime);
        committed = `permissions-saved:${randomUUID()}`;
        return { coverage: result.coverage, committedValue: committed };
      } finally { saving = false; }
    },
    accepts(value: string | undefined) { return committed !== undefined && value === committed; },
  };
}
