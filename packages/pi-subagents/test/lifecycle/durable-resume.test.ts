import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { deleteSubagentSessionFiles, getSubagentSessionDirectory, registerSubagentHost } from "#src/service/host";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createFactorySession, createSubagentSessionDeps } from "#test/helpers/subagent-session-io";

const roots: string[] = [];
const disposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-resume-"));
  roots.push(root);
  const parent = join(root, "parent.jsonl");
  const tasks = getSubagentSessionDirectory(parent);
  const child = join(tasks, "child.jsonl");
  const cwd = join(root, "original-worktree");
  await mkdir(tasks, { recursive: true });
  await mkdir(cwd);
  await writeFile(parent, "parent");
  await writeFile(child, `${JSON.stringify({ type: "session", version: 3, id: "child-1", cwd, parentSession: "parent-1", timestamp: new Date().toISOString() })}\n`);
  const deps = createSubagentSessionDeps();
  deps.io.deriveSessionDir.mockReturnValue(tasks);
  deps.io.openSessionManager.mockImplementation((file: string, effectiveCwd: string, dir: string) => SessionManager.open(file, dir, effectiveCwd));
  const session = createFactorySession();
  deps.io.createSession.mockResolvedValue({ session });
  const params = {
    snapshot: STUB_SNAPSHOT,
    type: "Explore",
    runId: "run-1",
    parentSession: { parentSessionId: "parent-1", parentSessionFile: parent },
    resumeFrom: { outputFile: child, childSessionId: "child-1" },
  };
  return { root, parent, child, cwd, deps, params, session };
}

describe("durable resume ownership", () => {
  it("supplies the canonical header cwd to host admission before resource composition", async () => {
    const { cwd, deps, params } = await fixture();
    const createSessionFactory = vi.fn(async () => deps.io);
    disposers.push(registerSubagentHost("parent-1", { createSessionFactory, admitSession: () => undefined }));
    const child = await createSubagentSession(params, deps);
    try {
      expect(createSessionFactory).toHaveBeenCalledWith({ parentSessionId: "parent-1", runId: "run-1", cwd }, expect.any(AbortSignal));
      expect(deps.io.createSession.mock.calls[0][0].cwd).toBe(cwd);
      expect(deps.io.createSession.mock.calls[0][0].sessionManager.getCwd()).toBe(cwd);
    } finally {
      await child.dispose();
    }
  });

  it("cannot revive a deleted child from stale restored pointers", async () => {
    const { root, parent, deps, params } = await fixture();
    const other = join(root, "other.jsonl");
    const otherTasks = getSubagentSessionDirectory(other);
    await mkdir(otherTasks, { recursive: true });
    await writeFile(join(otherTasks, "child.jsonl"), "keep");
    await deleteSubagentSessionFiles(parent);
    await rm(parent);
    await expect(createSubagentSession(params, deps)).rejects.toThrow("identity mismatch");
    expect(deps.io.createSession).not.toHaveBeenCalled();
    expect(await readFile(join(otherTasks, "child.jsonl"), "utf8")).toBe("keep");
  });

  it("does not open the original child's transcript through fork-copied metadata", async () => {
    const { root, child, deps, params } = await fixture();
    const before = await readFile(child, "utf8");
    await expect(createSubagentSession({
      ...params,
      parentSession: { parentSessionId: "fork-1", parentSessionFile: join(root, "fork.jsonl") },
    }, deps)).rejects.toThrow("outside the parent's owned storage");
    expect(deps.io.openSessionManager).not.toHaveBeenCalled();
    expect(deps.io.createSession).not.toHaveBeenCalled();
    expect(await readFile(child, "utf8")).toBe(before);
  });
});
