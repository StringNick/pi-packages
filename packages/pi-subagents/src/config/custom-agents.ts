/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import { DEFAULT_AGENT_NAMES } from "#src/config/default-agents";
import { isLockableField, type LockDeclaration } from "#src/config/invocation-config";
import { parseThinkingLevel, thinkingLevelError } from "#src/config/thinking-level";
import { debugLog } from "#src/debug";
import type { AgentConfig } from "#src/types";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — a file matching a builtin case-insensitively (e.g. a
 * legacy Explore.md) overrides the canonical builtin (see `canonicalBuiltinName`);
 * other names (e.g. Plan, general-purpose) load as ordinary custom agents.
 */
export interface LoadCustomAgentsOptions {
  agentDir?: string;
  includeProject?: boolean;
  /**
   * Skip agent files larger than this many bytes. Unset means unbounded
   * (historical behavior). Hosts pass a bound so one oversized file cannot
   * break discovery; skipped files are reported via `onFileError`.
   */
  maxFileBytes?: number;
  /**
   * Called for files skipped by `maxFileBytes` or with unparseable
   * frontmatter instead of throwing. Unset preserves throwing on parse errors.
   */
  onFileError?: (file: string, error: unknown) => void;
}

export function loadCustomAgents(cwd: string, options: LoadCustomAgentsOptions = {}): Map<string, AgentConfig> {
  const globalDir = join(options.agentDir ?? getAgentDir(), "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadFromDir(globalDir, agents, "global", options);   // lower priority
  if (options.includeProject !== false) loadFromDir(projectDir, agents, "project", options);  // higher priority (overwrites)
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(dir: string, agents: Map<string, AgentConfig>, source: "project" | "global", options: LoadCustomAgentsOptions): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch (err) {
    debugLog("readdirSync agents dir", err);
    return;
  }

  for (const file of files) {
    const name = canonicalBuiltinName(basename(file, ".md"));
    const path = join(dir, file);

    if (options.maxFileBytes !== undefined) {
      let size: number | undefined;
      try {
        size = statSync(path).size;
      } catch (err) {
        debugLog("statSync agent file", err);
        continue;
      }
      if (size > options.maxFileBytes) {
        const error = new Error(`Agent file ${file} exceeds the size limit and was skipped.`);
        if (options.onFileError) options.onFileError(path, error);
        else debugLog("agent file skipped", error);
        continue;
      }
    }

    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch (err) {
      debugLog("readFileSync agent file", err);
      continue;
    }

    let fm: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content));
    } catch (err) {
      if (options.onFileError) {
        options.onFileError(path, err);
        continue;
      }
      throw err;
    }

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      toolGuideline: str(fm.tool_guideline)?.trim() || undefined,
      toolNames: listField(fm.tools, BUILTIN_TOOL_NAMES),
      model: str(fm.model),
      thinking: thinkingLevel(fm.thinking, name),
      maxTurns: nonNegativeInt(fm.max_turns),
      systemPrompt: body.trim(),
      promptMode: fm.prompt_mode === "replace" ? "replace" : "append",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
      locked: lockDeclaration(fm.locked, name),
      enabled: fm.enabled !== false,  // default true; explicitly false disables
      source,
      sourcePath: path,
    });
  }
}

/**
 * Canonicalize a file-derived agent name against the builtins.
 *
 * Builtin names are exact lowercase; a file matching one case-insensitively
 * (e.g. a legacy Explore.md) takes the canonical builtin name so it overrides
 * the builtin instead of registering a duplicate alongside it. Names with no
 * builtin match keep their file casing and load as ordinary custom agents.
 */
function canonicalBuiltinName(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const builtin of DEFAULT_AGENT_NAMES) {
    if (builtin.toLowerCase() === lower) return builtin;
  }
  return fileName;
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/**
 * Parse the `locked:` key into a lock declaration, or undefined when it claims nothing.
 *
 * `true` is the whole-file form; anything else parses as a field list, so both YAML
 * spellings `tools:` accepts work here too. An entry naming no lockable field is
 * dropped rather than failing the agent's load.
 */
function lockDeclaration(val: unknown, agentName: string): LockDeclaration | undefined {
  if (typeof val === "boolean") return val ? true : undefined;

  const entries = parseListField(val);
  if (entries === undefined) return undefined;

  const fields = entries.filter(isLockableField);
  const unknownEntries = entries.filter((entry) => !isLockableField(entry));
  if (unknownEntries.length > 0) {
    debugLog(`agent ${agentName} frontmatter locked`, `unknown fields: ${unknownEntries.join(", ")}`);
  }
  return fields.length > 0 ? fields : undefined;
}

/**
 * Extract a thinking level, dropping an unrecognized one.
 *
 * Passing it through would not surface as an error: Pi clamps a level missing from
 * its own table down to `off`, silently disabling thinking for an agent whose author
 * asked for more of it. Inheriting the parent's level is the safer miss (Refs #834).
 */
function thinkingLevel(val: unknown, agentName: string): AgentConfig["thinking"] {
  const level = parseThinkingLevel(val);
  if (val != null && level === undefined) {
    debugLog(`agent ${agentName} frontmatter thinking`, thinkingLevelError(val));
  }
  return level;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

/**
 * Parse a raw list field into items, or undefined if absent/empty/"none".
 *
 * Frontmatter is YAML, so a list field is written either as a comma-separated
 * scalar (`tools: read, grep`) or as a sequence (`tools: [read, grep]`). Both
 * are supported: a sequence keeps its entries intact, while a scalar is split
 * on commas.
 */
function parseListField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const items = Array.isArray(val)
    ? val.map(entry => String(entry).trim()).filter(Boolean)
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- val is already narrowed past null/undefined; String() is the intended coercion here
    : String(val).trim().split(",").map(entry => entry.trim()).filter(Boolean);
  if (items.length === 0) return undefined;
  return items.length === 1 && items[0] === "none" ? undefined : items;
}

/**
 * Parse a list field with defaults.
 * omitted → defaults; "none"/empty → []; otherwise → listed items.
 */
function listField(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseListField(val) ?? [];
}
