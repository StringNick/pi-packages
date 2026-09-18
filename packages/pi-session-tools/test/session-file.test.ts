import { describe, expect, it, vi } from "vitest";

const mockExistsSync = vi.hoisted(() =>
  vi.fn((_path: string): boolean => false),
);
const mockReadFileSync = vi.hoisted(() =>
  vi.fn((_path: string, _enc: string): string => ""),
);
const mockReaddirSync = vi.hoisted(() =>
  vi.fn((_path: string): string[] => []),
);
const mockStatSync = vi.hoisted(() =>
  vi.fn((_path: string): { mtimeMs: number } => ({ mtimeMs: 0 })),
);
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  default: {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
  },
}));

describe("readSessionFileEntries", () => {
  it("returns undefined when the file does not exist", async () => {
    const { readSessionFileEntries } = await import("#src/session-file");
    mockExistsSync.mockReturnValue(false);
    expect(readSessionFileEntries("/does/not/exist.jsonl")).toBeUndefined();
  });

  it("parses entries and strips the session header", async () => {
    const { readSessionFileEntries } = await import("#src/session-file");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "s1",
          timestamp: "t0",
          cwd: "/project",
        }),
        JSON.stringify({
          type: "message",
          id: "1",
          parentId: null,
          timestamp: "t1",
          message: { role: "user", content: "hello" },
        }),
      ].join("\n"),
    );
    const entries = readSessionFileEntries("/sessions/project/s1.jsonl");
    expect(entries).toEqual([
      {
        type: "message",
        id: "1",
        parentId: null,
        timestamp: "t1",
        message: { role: "user", content: "hello" },
      },
    ]);
  });

  it("skips malformed lines", async () => {
    const { readSessionFileEntries } = await import("#src/session-file");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      [
        "not json",
        JSON.stringify({ type: "compaction", tokensBefore: 10 }),
      ].join("\n"),
    );
    const entries = readSessionFileEntries("/sessions/project/s1.jsonl");
    expect(entries).toEqual([{ type: "compaction", tokensBefore: 10 }]);
  });
});

describe("encodeCwdToSessionDirName", () => {
  it("strips the leading slash, replaces slashes with dashes, and wraps in --...--", async () => {
    const { encodeCwdToSessionDirName } = await import("#src/session-file");
    expect(
      encodeCwdToSessionDirName("/Users/chris/development/pi/pi-packages"),
    ).toBe("--Users-chris-development-pi-pi-packages--");
  });

  it("handles a root-level cwd", async () => {
    const { encodeCwdToSessionDirName } = await import("#src/session-file");
    expect(encodeCwdToSessionDirName("/")).toBe("----");
  });
});

describe("deriveSessionsRoot", () => {
  it("derives the root from the current session file when the encoded cwd segment is present", async () => {
    const { deriveSessionsRoot } = await import("#src/session-file");
    const sessionFile =
      "/home/user/.zrow/agent/sessions/--Users-chris-project--/2026-05-20T12-00-00Z_.jsonl";
    expect(deriveSessionsRoot(sessionFile, "/Users/chris/project")).toBe(
      "/home/user/.zrow/agent/sessions",
    );
  });

  it("derives the root for a subagent session file (nested tasks/ path)", async () => {
    const { deriveSessionsRoot } = await import("#src/session-file");
    const sessionFile =
      "/home/user/.zrow/agent/sessions/--Users-chris-project--/2026-05-20T12-00-00Z_/tasks/2026-05-20T12-01-00Z_.jsonl";
    expect(deriveSessionsRoot(sessionFile, "/Users/chris/project")).toBe(
      "/home/user/.zrow/agent/sessions",
    );
  });

  it("falls back to the homedir default when the session file is undefined", async () => {
    const { deriveSessionsRoot } = await import("#src/session-file");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    expect(deriveSessionsRoot(undefined, "/Users/chris/project")).toBe(
      join(homedir(), ".zrow", "agent", "sessions"),
    );
  });

  it("falls back to the homedir default when the encoded cwd segment is absent", async () => {
    const { deriveSessionsRoot } = await import("#src/session-file");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const sessionFile =
      "/home/user/.zrow/agent/sessions/--other-project--/s.jsonl";
    expect(deriveSessionsRoot(sessionFile, "/Users/chris/project")).toBe(
      join(homedir(), ".zrow", "agent", "sessions"),
    );
  });
});

describe("listSessionFiles", () => {
  it("returns an empty array when the directory does not exist", async () => {
    const { listSessionFiles } = await import("#src/session-file");
    mockExistsSync.mockReturnValue(false);
    expect(listSessionFiles("/sessions/--missing--")).toEqual([]);
  });

  it("lists .jsonl files newest-first by mtime", async () => {
    const { listSessionFiles } = await import("#src/session-file");
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      "2026-05-20T12-00-00Z_.jsonl",
      "2026-05-20T12-01-00Z_.jsonl",
      "tasks",
    ]);
    mockStatSync.mockImplementation((path: string) => {
      if (path.endsWith("12-00-00Z_.jsonl")) return { mtimeMs: 1000 };
      if (path.endsWith("12-01-00Z_.jsonl")) return { mtimeMs: 2000 };
      return { mtimeMs: 0 };
    });
    const files = listSessionFiles("/sessions/--project--");
    expect(files).toEqual([
      "/sessions/--project--/2026-05-20T12-01-00Z_.jsonl",
      "/sessions/--project--/2026-05-20T12-00-00Z_.jsonl",
    ]);
  });

  it("filters out non-.jsonl entries", async () => {
    const { listSessionFiles } = await import("#src/session-file");
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["tasks", "notes.txt", "s.jsonl"]);
    mockStatSync.mockReturnValue({ mtimeMs: 500 });
    const files = listSessionFiles("/sessions/--project--");
    expect(files).toEqual(["/sessions/--project--/s.jsonl"]);
  });
});
