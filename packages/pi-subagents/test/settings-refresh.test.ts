/**
 * settings-refresh.test.ts — Admission-time refresh and bounded discovery.
 *
 * `SettingsManager.refresh()` re-reads layered files without emitting, so
 * hosts observe runtime tuning changed on disk at the next spawn. Discovery
 * bounds (`maxFileBytes`, `onFileError`) let hosts skip oversized or broken
 * agent files without breaking the whole load.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCustomAgents } from "#src/config/custom-agents";
import { SettingsManager } from "#src/settings";
import { createSettingsDirs, type SettingsDirs } from "#test/helpers/tmp-settings-dirs";

describe("SettingsManager.refresh", () => {
  let dirs: SettingsDirs;
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    dirs = createSettingsDirs("subagents.json");
    ({ globalDir, projectDir } = dirs);
  });

  afterEach(() => {
    dirs.dispose();
  });

  it("picks up disk changes without emitting lifecycle events", () => {
    const emit = vi.fn();
    const settings = new SettingsManager({ emit, cwd: projectDir, agentDir: globalDir });
    settings.load();
    expect(settings.maxConcurrent).toBe(4);
    expect(emit).toHaveBeenCalledTimes(1);

    dirs.writeProject({ maxConcurrent: 12 });
    settings.refresh();
    expect(settings.maxConcurrent).toBe(12);
    // No second lifecycle event: refresh is silent by design.
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("clearing a key from disk clears the value on refresh", () => {
    const settings = new SettingsManager({ emit: vi.fn(), cwd: projectDir, agentDir: globalDir });
    dirs.writeProject({ maxConcurrent: 12, graceTurns: 9 });
    settings.load();
    expect(settings.graceTurns).toBe(9);
    dirs.writeProject({ maxConcurrent: 12 });
    settings.refresh();
    expect(settings.graceTurns).toBe(5);
  });
});

describe("loadCustomAgents bounds", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-agents-bounds-"));
    agentDir = join(root, "profile");
    cwd = join(root, "project");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(join(cwd, ".zrow", "agents"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("skips oversized files and reports them instead of breaking discovery", () => {
    writeFileSync(join(agentDir, "agents", "big.md"), `---\ndescription: Big\n---\n\n${"x".repeat(200)}`);
    writeFileSync(join(agentDir, "agents", "small.md"), "---\ndescription: Small\n---\n\nHi.\n");
    const errors: Array<[string, unknown]> = [];
    const agents = loadCustomAgents(cwd, {
      agentDir,
      includeProject: false,
      maxFileBytes: 100,
      onFileError: (file, error) => {
        errors.push([file, error]);
      },
    });
    expect([...agents.keys()]).toEqual(["small"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toContain("big.md");
  });

  it("skips malformed frontmatter with a report instead of throwing", () => {
    writeFileSync(join(agentDir, "agents", "broken.md"), "---\n: [unclosed\n---\n\nBody.\n");
    writeFileSync(join(agentDir, "agents", "fine.md"), "---\ndescription: Fine\n---\n\nBody.\n");
    const errors: Array<[string, unknown]> = [];
    const agents = loadCustomAgents(cwd, {
      agentDir,
      includeProject: false,
      onFileError: (file, error) => {
        errors.push([file, error]);
      },
    });
    expect([...agents.keys()]).toEqual(["fine"]);
    expect(errors).toHaveLength(1);
  });

  it("still throws on malformed frontmatter without a reporter", () => {
    writeFileSync(join(agentDir, "agents", "broken.md"), "---\n: [unclosed\n---\n\nBody.\n");
    expect(() => loadCustomAgents(cwd, { agentDir, includeProject: false })).toThrow();
  });
});
