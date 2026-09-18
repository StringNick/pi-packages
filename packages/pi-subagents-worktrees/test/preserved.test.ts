import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LiveWorktrees } from "#src/active-worktrees";
import { findPreservedWorktrees, formatPreservedNotice } from "#src/preserved";
import { createWorktree, pruneWorktrees } from "#src/worktree";
import { initGitRepo } from "#test/support/git-fixture";

/** A registry reporting the given resolved paths as still in use by a child. */
function live(...resolvedPaths: string[]): LiveWorktrees {
  return { contains: (path) => resolvedPaths.includes(path) };
}

/** Add a detached worktree at an arbitrary path, bypassing `createWorktree`'s naming. */
function addWorktreeAt(repoDir: string, path: string): void {
  execFileSync("git", ["worktree", "add", "--detach", path, "HEAD"], {
    cwd: repoDir,
    stdio: "pipe",
  });
}

describe("findPreservedWorktrees", () => {
  let repoDir: string;
  const scratchPaths: string[] = [];

  beforeEach(() => {
    repoDir = initGitRepo("pi-wt-preserved-");
  });

  afterEach(() => {
    for (const path of scratchPaths) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", path], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        /* already gone */
      }
      rmSync(path, { recursive: true, force: true });
    }
    scratchPaths.length = 0;
    for (const wt of findPreservedWorktrees(repoDir, live())) {
      execFileSync("git", ["worktree", "remove", "--force", wt], {
        cwd: repoDir,
        stdio: "pipe",
      });
    }
    pruneWorktrees(repoDir);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("reports the rescue worktrees left on disk", () => {
    const first = createWorktree(repoDir, "first")!;
    const second = createWorktree(repoDir, "second")!;

    const preserved = findPreservedWorktrees(repoDir, live());

    // git reports resolved paths; the repository's own worktree is not one of ours.
    expect(preserved.toSorted()).toEqual(
      [realpathSync(first.path), realpathSync(second.path)].toSorted(),
    );
  });

  it("excludes a worktree a child is still running in", () => {
    const running = createWorktree(repoDir, "running")!;
    const abandoned = createWorktree(repoDir, "abandoned")!;

    const preserved = findPreservedWorktrees(
      repoDir,
      live(realpathSync(running.path)),
    );

    expect(preserved).toEqual([realpathSync(abandoned.path)]);
  });

  it("excludes the worktree the scan itself is running inside", () => {
    const host = createWorktree(repoDir, "host")!;
    const other = createWorktree(repoDir, "other")!;

    const preserved = findPreservedWorktrees(host.path, live());

    expect(preserved).toEqual([realpathSync(other.path)]);
  });

  it("excludes a worktree that this package did not create", () => {
    const foreign = join(tmpdir(), "not-a-rescue-worktree");
    scratchPaths.push(foreign);
    addWorktreeAt(repoDir, foreign);

    expect(findPreservedWorktrees(repoDir, live())).toEqual([]);
  });

  it("excludes a rescue-named worktree outside the temp root", () => {
    // node_modules is gitignored, so a leftover never pollutes the working tree.
    const outsideRoot = join(process.cwd(), "node_modules", ".zrow-wt-outside");
    mkdirSync(outsideRoot, { recursive: true });
    const outside = join(outsideRoot, "pi-agent-outside-1f2e9c04");
    scratchPaths.push(outside);
    addWorktreeAt(repoDir, outside);

    expect(findPreservedWorktrees(repoDir, live())).toEqual([]);
  });

  it("excludes a worktree whose directory is already gone", () => {
    const reaped = createWorktree(repoDir, "reaped")!;
    rmSync(reaped.path, { recursive: true, force: true });

    expect(findPreservedWorktrees(repoDir, live())).toEqual([]);
  });

  it("returns nothing when the directory is not a git repository", () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "pi-wt-nonrepo-"));
    try {
      expect(findPreservedWorktrees(nonRepo, live())).toEqual([]);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("formatPreservedNotice", () => {
  it("names the single worktree and points at the command", () => {
    const notice = formatPreservedNotice(["/tmp/pi-agent-abc123-1f2e9c04"]);

    expect(notice).toBe(
      "1 rescue worktree from a failed cleanup is still on disk:\n" +
        "  /tmp/pi-agent-abc123-1f2e9c04\n" +
        "They hold subagent work that was never merged, and the temp directory is cleared periodically.\n" +
        "Run /subagents-worktrees to inspect or remove them.",
    );
  });

  it("names every worktree when there are several", () => {
    const notice = formatPreservedNotice([
      "/tmp/pi-agent-abc123-1f2e9c04",
      "/tmp/pi-agent-def456-90ab77e1",
    ]);

    expect(notice).toContain("2 rescue worktrees");
    expect(notice).toContain("  /tmp/pi-agent-abc123-1f2e9c04");
    expect(notice).toContain("  /tmp/pi-agent-def456-90ab77e1");
  });

  it("summarizes the tail of a long list", () => {
    const paths = Array.from(
      { length: 7 },
      (_unused, index) => `/tmp/pi-agent-${index}-1f2e9c04`,
    );

    const notice = formatPreservedNotice(paths);

    expect(notice).toContain("  /tmp/pi-agent-4-1f2e9c04");
    expect(notice).not.toContain("  /tmp/pi-agent-5-1f2e9c04");
    expect(notice).toContain("…and 2 more");
  });
});
