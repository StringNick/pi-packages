/**
 * session-file.ts — Read and locate Pi session files by path or by cwd.
 *
 * Pi encodes a session's launch cwd into its storage directory name
 * (`--<cwd with leading slash stripped and every "/" replaced by "-">--`)
 * under a sessions root (`~/.zrow/agent/sessions/` by default).
 * This module owns that encoding plus a generic JSONL session-file reader,
 * so callers can read an arbitrary session file without hand-rolling either.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSessionsDir } from "@earendil-works/pi-coding-agent";

/** Parsed JSONL entry with at least a `type` discriminant. */
export interface ParsedEntry {
  type: string;
  [key: string]: unknown;
}

/**
 * Read and parse session entries from a JSONL file.
 *
 * Filters out the session header (type: "session") and returns only
 * session entries (messages, compaction, model changes, etc.).
 * Returns undefined if the file does not exist.
 */
export function readSessionFileEntries(
  file: string,
): ParsedEntry[] | undefined {
  if (!existsSync(file)) return undefined;

  const content = readFileSync(file, "utf-8");
  const entries: ParsedEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ParsedEntry;
      // Skip the session header
      if (parsed.type === "session") continue;
      entries.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Encode a cwd to Pi's session-directory name: strip the leading `/`,
 * replace every `/` with `-`, and wrap the result in `--…--`.
 */
export function encodeCwdToSessionDirName(cwd: string): string {
  const stripped = cwd.startsWith("/") ? cwd.slice(1) : cwd;
  return `--${stripped.replaceAll("/", "-")}--`;
}

const DEFAULT_SESSIONS_ROOT = getSessionsDir();

/**
 * Derive the sessions root directory from the current session file.
 *
 * Locates `currentCwd`'s encoded segment (`/--…--/`) inside
 * `currentSessionFile` and returns the path prefix before it — this works
 * for both a normal session file and a subagent's nested `tasks/` file,
 * since the encoded segment is a path prefix in both.
 * Falls back to `~/.zrow/agent/sessions` when the session file is undefined
 * or the encoded segment is not found in it.
 */
export function deriveSessionsRoot(
  currentSessionFile: string | undefined,
  currentCwd: string,
): string {
  if (!currentSessionFile) return DEFAULT_SESSIONS_ROOT;

  const segment = `/${encodeCwdToSessionDirName(currentCwd)}/`;
  const segmentIndex = currentSessionFile.indexOf(segment);
  if (segmentIndex === -1) return DEFAULT_SESSIONS_ROOT;

  return currentSessionFile.slice(0, segmentIndex);
}

/**
 * List absolute paths of `.jsonl` files in a session directory, newest
 * first (by mtime, tie-broken by filename).
 * Returns an empty array if the directory does not exist.
 */
export function listSessionFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(directory, name))
    .sort((a, b) => {
      const mtimeDelta = statSync(b).mtimeMs - statSync(a).mtimeMs;
      return mtimeDelta !== 0 ? mtimeDelta : a.localeCompare(b);
    });
}
