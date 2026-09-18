import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import sessionTools from "#src/index";

function captureTools(factory: (pi: ExtensionAPI) => void) {
  const tools = new Map<
    string,
    { execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const pi = {
    registerTool: vi.fn(
      (tool: {
        name: string;
        execute: (...args: unknown[]) => Promise<unknown>;
      }) => {
        tools.set(tool.name, tool);
      },
    ),
  } as unknown as ExtensionAPI;
  factory(pi);
  return tools;
}

function makeCtx(sessionFile: string | undefined): ExtensionContext {
  return {
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => sessionFile,
    },
  } as unknown as ExtensionContext;
}

const mockExistsSync = vi.hoisted(() =>
  vi.fn((_path: string): boolean => false),
);
const mockReaddirSync = vi.hoisted(() =>
  vi.fn((_path: string): string[] => []),
);
const mockStatSync = vi.hoisted(() =>
  vi.fn((_path: string): { mtimeMs: number } => ({ mtimeMs: 0 })),
);
vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  default: {
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    statSync: mockStatSync,
  },
}));

describe("list_session_files tool", () => {
  it("lists session files for a cwd, newest first", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("list_session_files")!;
    expect(tool).toBeDefined();

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      "2026-05-20T12-00-00Z_.jsonl",
      "2026-05-20T12-01-00Z_.jsonl",
    ]);
    mockStatSync.mockImplementation((path: string) => {
      if (path.endsWith("12-00-00Z_.jsonl")) return { mtimeMs: 1000 };
      return { mtimeMs: 2000 };
    });

    const ctx = makeCtx(undefined);
    const result = await tool.execute(
      "tc1",
      { cwd: "/Users/chris/development/pi/pi-packages-worktrees/issue-546" },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(
      homedir(),
      ".zrow",
      "agent",
      "sessions",
      "--Users-chris-development-pi-pi-packages-worktrees-issue-546--",
    );
    expect(text).toBe(
      `Session directory: ${dir}\n2 session files, newest first:\n  ${join(dir, "2026-05-20T12-01-00Z_.jsonl")}\n  ${join(dir, "2026-05-20T12-00-00Z_.jsonl")}`,
    );
  });

  it("reports no session files found for an empty directory", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("list_session_files")!;

    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx(undefined);
    const result = await tool.execute(
      "tc1",
      { cwd: "/nowhere" },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("No session files found.");
  });

  it("derives the sessions root from the current session file when available", async () => {
    const tools = captureTools(sessionTools);
    const tool = tools.get("list_session_files")!;

    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(["s.jsonl"]);
    mockStatSync.mockReturnValue({ mtimeMs: 500 });

    const ctx = makeCtx(
      "/custom/root/.zrow/agent/sessions/--Users-chris-current--/2026-01-01T00-00-00Z_.jsonl",
    );
    // vi.spyOn process.cwd to match the current-session encoding
    const cwdSpy = vi
      .spyOn(process, "cwd")
      .mockReturnValue("/Users/chris/current");

    const result = await tool.execute(
      "tc1",
      { cwd: "/Users/chris/peer" },
      undefined,
      undefined,
      ctx,
    );
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain(
      "/custom/root/.zrow/agent/sessions/--Users-chris-peer--",
    );
    cwdSpy.mockRestore();
  });

  describe("details", () => {
    it("returns listing details with directory and count", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("list_session_files")!;

      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["a.jsonl", "b.jsonl"]);
      mockStatSync.mockReturnValue({ mtimeMs: 100 });

      const ctx = makeCtx(undefined);
      const result = (await tool.execute(
        "tc1",
        { cwd: "/Users/chris/peer" },
        undefined,
        undefined,
        ctx,
      )) as { details: { kind: string; directory: string; count: number } };

      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      expect(result.details.kind).toBe("listing");
      expect(result.details.count).toBe(2);
      expect(result.details.directory).toBe(
        join(homedir(), ".zrow", "agent", "sessions", "--Users-chris-peer--"),
      );
    });

    it("returns listing details with count 0 for an empty directory", async () => {
      const tools = captureTools(sessionTools);
      const tool = tools.get("list_session_files")!;

      mockExistsSync.mockReturnValue(false);

      const ctx = makeCtx(undefined);
      const result = (await tool.execute(
        "tc1",
        { cwd: "/nowhere" },
        undefined,
        undefined,
        ctx,
      )) as { details: { kind: string; count: number } };

      expect(result.details.kind).toBe("listing");
      expect(result.details.count).toBe(0);
    });
  }); // describe("details")
});
