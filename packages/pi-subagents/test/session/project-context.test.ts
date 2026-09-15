import { describe, expect, it } from "vitest";
import { renderProjectContext } from "#src/session/project-context";

describe("renderProjectContext", () => {
  describe("Pi's block format", () => {
    // Byte-exact against core/system-prompt.ts, which writes the lead-in
    // sentence and separates each block with a blank line.
    it("renders one context file the way Pi's buildSystemPrompt does", () => {
      expect(
        renderProjectContext([{ path: "/repo/AGENTS.md", content: "Repo rules." }]),
      ).toBe(
        [
          "<project_context>",
          "",
          "Project-specific instructions and guidelines:",
          "",
          '<project_instructions path="/repo/AGENTS.md">',
          "Repo rules.",
          "</project_instructions>",
          "",
          "</project_context>",
        ].join("\n"),
      );
    });

    it("separates several context files with a blank line", () => {
      expect(
        renderProjectContext([
          { path: "/repo/AGENTS.md", content: "Repo rules." },
          { path: "/repo/sub/AGENTS.md", content: "Nested rules." },
        ]),
      ).toBe(
        [
          "<project_context>",
          "",
          "Project-specific instructions and guidelines:",
          "",
          '<project_instructions path="/repo/AGENTS.md">',
          "Repo rules.",
          "</project_instructions>",
          "",
          '<project_instructions path="/repo/sub/AGENTS.md">',
          "Nested rules.",
          "</project_instructions>",
          "",
          "</project_context>",
        ].join("\n"),
      );
    });

    it("attributes the instructions to the path the loader reported", () => {
      expect(
        renderProjectContext([
          { path: "/worktree/issue-918/AGENTS.md", content: "Worktree rules." },
        ]),
      ).toContain('<project_instructions path="/worktree/issue-918/AGENTS.md">');
    });
  });

  describe("a directory with no context files", () => {
    it("renders nothing for an empty list", () => {
      expect(renderProjectContext([])).toBeUndefined();
    });

    it("renders nothing when the loader reported none at all", () => {
      expect(renderProjectContext(undefined)).toBeUndefined();
    });
  });
});
