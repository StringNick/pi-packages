import { describe, expect, it } from "vitest";
import { deriveParentSessionFile } from "#src/parent-session";

describe("deriveParentSessionFile", () => {
  it("derives parent file from a subagent session path", () => {
    const sessionFile =
      "/home/user/.zrow/agent/sessions/--project--/2026-05-20T12-00-00Z_/tasks/2026-05-20T12-01-00Z_.jsonl";
    expect(deriveParentSessionFile(sessionFile)).toBe(
      "/home/user/.zrow/agent/sessions/--project--/2026-05-20T12-00-00Z_.jsonl",
    );
  });

  it("returns undefined when not in a tasks directory", () => {
    const sessionFile =
      "/home/user/.zrow/agent/sessions/--project--/2026-05-20T12-00-00Z_.jsonl";
    expect(deriveParentSessionFile(sessionFile)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(deriveParentSessionFile(undefined)).toBeUndefined();
  });

  it("handles nested tasks directories (picks immediate parent)", () => {
    // A deeply nested subagent: parent/tasks/child/tasks/grandchild.jsonl
    const sessionFile = "/sessions/parent/tasks/child/tasks/grandchild.jsonl";
    expect(deriveParentSessionFile(sessionFile)).toBe(
      "/sessions/parent/tasks/child.jsonl",
    );
  });

  it("returns undefined when tasks is not the immediate parent directory", () => {
    // tasks exists in the path but not as the immediate parent
    const sessionFile = "/sessions/tasks/subdir/session.jsonl";
    expect(deriveParentSessionFile(sessionFile)).toBeUndefined();
  });
});
