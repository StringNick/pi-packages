/**
 * project-context.ts — Pi's `<project_context>` block, rendered from context files.
 */

import { debugNote } from "#src/debug";

/** A context file (`AGENTS.md` and kin) as Pi's loader reports it. */
export interface ContextFile {
  /** Absolute path the block attributes the instructions to. */
  path: string;
  /** The file's text. */
  content: string;
}

/**
 * Render context files as Pi's `<project_context>` block, byte for byte.
 *
 * Pi writes a lead-in sentence and separates each `<project_instructions>`
 * block with a blank line; matching it exactly is what keeps a block this
 * package renders indistinguishable from one `buildSystemPrompt` wrote.
 *
 * Returns undefined when there are no files, so a caller can tell "this
 * directory carries no project instructions" from "here they are".
 */
export function renderProjectContext(
  contextFiles: readonly ContextFile[] | undefined,
): string | undefined {
  if (!contextFiles || contextFiles.length === 0) return undefined;
  const blocks = contextFiles.map(
    ({ path, content }) =>
      `<project_instructions path="${path}">\n${content}\n</project_instructions>\n`,
  );
  return `<project_context>\n\nProject-specific instructions and guidelines:\n\n${blocks.join("\n")}\n</project_context>`;
}

/** The project-context block a session working in `cwd` would carry. */
export type ProjectContextLoader = (cwd: string) => string | undefined;

/** Pi's context-file discovery, as `loadProjectContextFiles` implements it. */
export type ContextFileDiscovery = (options: {
  cwd: string;
  agentDir: string;
}) => ContextFile[];

/**
 * A loader that resolves a directory's project instructions against the
 * filesystem, for a child whose adopted identity carries none of its own.
 *
 * An empty result means the directory, every ancestor of it, and the global
 * agent directory all carry no context file — a real outcome for a sandbox
 * workspace, and one with nothing in the child's prompt to show for it. The
 * debug note is the only place that absence is visible.
 */
export function createProjectContextLoader(
  discover: ContextFileDiscovery,
  agentDir: string,
): ProjectContextLoader {
  return (cwd) => {
    const block = renderProjectContext(discover({ cwd, agentDir }));
    if (!block) debugNote(`no project context under ${cwd}`);
    return block;
  };
}
