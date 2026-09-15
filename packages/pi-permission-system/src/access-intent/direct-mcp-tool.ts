/** A reusable permission choice for one direct MCP tool call. */
export interface DirectMcpReusableApproval {
  readonly surface: string;
  readonly patterns: readonly string[];
  readonly patternKind: "exact" | "suggested";
  readonly matchLabel: string;
}

export interface DirectMcpApproval {
  readonly serverName: string;
  readonly argumentPattern: string;
  readonly choices: readonly DirectMcpReusableApproval[];
}

/** Match pi-mcp-adapter's `toolPrefix: "mcp"` server-name encoding. */
function directMcpServerPrefix(serverName: string): string {
  const encoded = Array.from(serverName.trim(), (character) =>
    /^[A-Za-z0-9_-]$/u.test(character)
      ? character
      : `_${character.codePointAt(0)?.toString(16) ?? ""}_`,
  ).join("");
  return `mcp__${encoded}_`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Encode arguments into a literal-safe value for the wildcard matcher. */
export function directMcpArgumentPattern(input: unknown): string {
  return `args:${encodeURIComponent(stableStringify(input)).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

/**
 * Resolve a direct `mcp__{server}_{tool}` call and construct least-to-most
 * permissive reusable grants. Unknown/non-MCP extension tools return null.
 */
export function directMcpApproval(
  toolName: string,
  input: unknown,
  configuredServerNames: readonly string[],
): DirectMcpApproval | null {
  const candidates = configuredServerNames
    .map((serverName) => ({ serverName: serverName.trim(), prefix: directMcpServerPrefix(serverName) }))
    .filter(({ serverName, prefix }) => serverName.length > 0 && toolName.startsWith(prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  const resolved = candidates[0];
  if (!resolved || toolName.length === resolved.prefix.length) return null;

  const argumentPattern = directMcpArgumentPattern(input);
  return {
    serverName: resolved.serverName,
    argumentPattern,
    choices: [
      {
        surface: toolName,
        patterns: [argumentPattern],
        patternKind: "exact",
        matchLabel: "Exact request",
      },
      {
        surface: toolName,
        patterns: ["*"],
        patternKind: "suggested",
        matchLabel: "This tool, any arguments",
      },
      {
        surface: `${resolved.prefix}*`,
        patterns: ["*"],
        patternKind: "suggested",
        matchLabel: `Any tool on ${resolved.serverName}`,
      },
      {
        surface: "mcp__*",
        patterns: ["*"],
        patternKind: "suggested",
        matchLabel: "Any MCP tool",
      },
    ],
  };
}
