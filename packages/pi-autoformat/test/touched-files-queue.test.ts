import { describe, expect, it } from "vitest";

import type { FormatScope } from "#src/format-scope";
import {
  type MutationSourceHandler,
  TouchedFilesQueue,
  writeOrEditHandler,
} from "#src/touched-files-queue";

describe("TouchedFilesQueue", () => {
  it("collects paths from write and edit tool results", () => {
    const queue = new TouchedFilesQueue("/repo");

    queue.recordToolResult("write", { path: "src/index.ts" });
    queue.recordToolResult("edit", { path: "docs/readme.md" });

    expect(queue.flush()).toEqual([
      "/repo/src/index.ts",
      "/repo/docs/readme.md",
    ]);
  });

  it("dedupes repeated file touches in a prompt", () => {
    const queue = new TouchedFilesQueue("/repo");

    queue.recordToolResult("write", { path: "src/index.ts" });
    queue.recordToolResult("edit", { path: "./src/index.ts" });
    queue.recordToolResult("edit", { path: "/repo/src/index.ts" });

    expect(queue.flush()).toEqual(["/repo/src/index.ts"]);
  });

  it("ignores non-mutation tools and invalid payloads", () => {
    const queue = new TouchedFilesQueue("/repo");

    queue.recordToolResult("bash", { path: "src/index.ts" });
    queue.recordToolResult("write", { foo: "bar" });
    queue.recordToolResult("edit", null);

    expect(queue.flush()).toEqual([]);
  });

  it("clears collected state after flush", () => {
    const queue = new TouchedFilesQueue("/repo");

    queue.recordToolResult("write", { path: "src/index.ts" });

    expect(queue.flush()).toEqual(["/repo/src/index.ts"]);
    expect(queue.flush()).toEqual([]);
  });

  it("filters paths outside the configured format scope", () => {
    const scope: FormatScope = {
      roots: ["/repo"],
      caseInsensitive: false,
    };
    const queue = new TouchedFilesQueue({ cwd: "/repo", scope });

    queue.recordToolResult("write", { path: "src/index.ts" });
    queue.recordToolResult("write", { path: "/tmp/scratch.ts" });
    queue.recordToolResult("write", { path: "../sibling/file.ts" });

    expect(queue.flush()).toEqual(["/repo/src/index.ts"]);
  });

  it("runs custom mutation source handlers and dedupes across sources", () => {
    const bashHandler: MutationSourceHandler = (toolName) =>
      toolName === "bash" ? ["src/index.ts", "src/other.ts"] : [];
    const queue = new TouchedFilesQueue({
      cwd: "/repo",
      handlers: [writeOrEditHandler, bashHandler],
    });

    queue.recordToolResult("write", { path: "src/index.ts" });
    queue.recordToolResult("bash", { command: "sed -i ..." });

    expect(queue.flush()).toEqual(["/repo/src/index.ts", "/repo/src/other.ts"]);
  });

  it("accepts externally added paths via addPath", () => {
    const queue = new TouchedFilesQueue({ cwd: "/repo" });
    queue.addPath("src/snapshot.ts");
    expect(queue.flush()).toEqual(["/repo/src/snapshot.ts"]);
  });

  it("expands tilde paths to the home directory instead of joining with cwd", () => {
    const queue = new TouchedFilesQueue("/repo");
    const os = require("node:os");
    const home = os.homedir();

    queue.recordToolResult("write", {
      path: "~/.zrow/agent/extensions/pi-permission-system/config.json",
    });

    const flushed = queue.flush();
    expect(flushed).toEqual([
      `${home}/.zrow/agent/extensions/pi-permission-system/config.json`,
    ]);
    // Must NOT contain the cwd prefix
    expect(flushed[0]).not.toContain("/repo/");
  });

  it("expands bare tilde to the home directory", () => {
    const queue = new TouchedFilesQueue("/repo");
    const os = require("node:os");
    queue.addPath("~");
    expect(queue.flush()).toEqual([os.homedir()]);
  });
});
