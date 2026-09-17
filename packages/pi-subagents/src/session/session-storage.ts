import { lstat, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { deriveSubagentSessionDir } from "#src/session/session-dir";

/** Owned child storage for a persisted parent; never resolves the shared temp fallback. */
export function getSubagentSessionDirectory(parentSessionFile: string): string {
  const stem = basename(parentSessionFile).slice(0, -".jsonl".length);
  if (
    !isAbsolute(parentSessionFile) ||
    !parentSessionFile.endsWith(".jsonl") ||
    !stem ||
    stem === "." ||
    stem === ".."
  ) {
    throw new Error("Subagent storage cleanup requires an absolute parent JSONL path");
  }
  return deriveSubagentSessionDir(parentSessionFile, "");
}

/**
 * Permanently remove all nested child transcripts after the caller has stopped
 * every writer and fenced new launches. Does not stop agents or delete the parent.
 * Missing storage succeeds; unsafe paths and IO errors propagate so the caller
 * can keep the parent and retry. Ordinary runtime disposal must not call this.
 */
export async function deleteSubagentSessionFiles(parentSessionFile: string): Promise<void> {
  const tasks = getSubagentSessionDirectory(parentSessionFile);
  const owner = dirname(tasks);
  for (const directory of [owner, tasks]) {
    const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) {
      if (directory === owner) return;
      break;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe subagent storage directory: ${directory}`);
    }
  }
  // Recursive rm unlinks nested symlinks rather than following them.
  await rm(tasks, { recursive: true, force: true });
  try {
    // Only remove the empty container, not other extensions' adjacent artifacts.
    await rmdir(owner);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  }
}
