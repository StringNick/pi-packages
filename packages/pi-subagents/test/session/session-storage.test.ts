import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteSubagentSessionFiles, getSubagentSessionDirectory } from "#src/service/host";

const io = vi.hoisted(() => ({ rm: vi.fn<typeof rm>() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  io.rm.mockImplementation(actual.rm);
  return { ...actual, rm: io.rm };
});

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-storage-"));
  roots.push(root);
  const parent = join(root, "parent.jsonl");
  const tasks = getSubagentSessionDirectory(parent);
  await writeFile(parent, "parent");
  await mkdir(tasks, { recursive: true });
  await writeFile(join(tasks, "child.jsonl"), "child");
  return { root, parent, tasks };
}

afterEach(async () => {
  // Clear injected one-shot failures before removing test-owned roots.
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  io.rm.mockReset().mockImplementation(actual.rm);
  for (const root of roots.splice(0)) await actual.rm(root, { recursive: true, force: true });
});

describe("persisted parent child storage", () => {
  it.each([
    "",
    "relative.jsonl",
    "/sessions/.jsonl",
    "/sessions/..jsonl",
    "/sessions/...jsonl",
    "/sessions/parent",
    "/sessions/parent.jsonl/",
  ])("refuses ambiguous parent paths: %s", async (file) => {
    expect(() => getSubagentSessionDirectory(file)).toThrow();
    await expect(deleteSubagentSessionFiles(file)).rejects.toThrow();
  });

  it("preserves the parent and adjacent extension artifacts", async () => {
    const { parent, tasks } = await fixture();
    const adjacent = join(dirname(tasks), "other-extension.txt");
    await writeFile(adjacent, "keep");
    await deleteSubagentSessionFiles(parent);
    expect(await readFile(parent, "utf8")).toBe("parent");
    expect(await readFile(adjacent, "utf8")).toBe("keep");
    await expect(access(tasks)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(deleteSubagentSessionFiles(parent)).resolves.toBeUndefined();
  });

  it("removes an empty container left by an interrupted cleanup", async () => {
    const { parent, tasks } = await fixture();
    await rm(tasks, { recursive: true });
    await deleteSubagentSessionFiles(parent);
    await expect(access(dirname(tasks))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(deleteSubagentSessionFiles(parent)).resolves.toBeUndefined();
  });

  it("propagates filesystem failure without removing the parent and permits retry", async () => {
    const { parent, tasks } = await fixture();
    io.rm.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(deleteSubagentSessionFiles(parent)).rejects.toMatchObject({ code: "EACCES" });
    expect(await readFile(parent, "utf8")).toBe("parent");
    expect(await readFile(join(tasks, "child.jsonl"), "utf8")).toBe("child");
    await deleteSubagentSessionFiles(parent);
    await expect(access(tasks)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow nested symlinks", async () => {
    const { root, parent, tasks } = await fixture();
    const unrelated = join(root, "unrelated");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep.jsonl"), "keep");
    await symlink(unrelated, join(tasks, "external"), "dir");
    await deleteSubagentSessionFiles(parent);
    expect(await readFile(join(unrelated, "keep.jsonl"), "utf8")).toBe("keep");
  });

  it("refuses a symlink replacing the tasks directory", async () => {
    const { root, parent, tasks } = await fixture();
    await rm(tasks, { recursive: true });
    const unrelated = join(root, "unrelated");
    await mkdir(unrelated);
    await symlink(unrelated, tasks, "dir");
    await expect(deleteSubagentSessionFiles(parent)).rejects.toThrow("Unsafe subagent storage");
    await access(parent);
    await access(unrelated);
  });
});
