import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsManager } from "#src/settings";

it("rebinds admitted native settings without retaining project values or allowing untrusted writes", () => {
  const root = mkdtempSync(join(tmpdir(), "hosted-settings-"));
  try {
    const agentDir = join(root, "profile"); const a = join(root, "a"); const b = join(root, "b");
    mkdirSync(agentDir); mkdirSync(join(a, ".pi"), { recursive: true }); mkdirSync(join(b, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ maxConcurrent: 7 }));
    const path = join(a, ".pi", "subagents.json");
    const original = JSON.stringify({ maxConcurrent: 2, defaultMaxTurns: 8, excludedExtensionPackages: ["project-package"], allowProjectAgents: true });
    writeFileSync(path, original);
    writeFileSync(join(b, ".pi", "subagents.json"), JSON.stringify({ graceTurns: 12 }));
    const settings = new SettingsManager({ agentDir, cwd: "unused-ambient", emit: vi.fn() });
    const owner = new AbortController(); const assertActive = () => owner.signal.throwIfAborted();
    settings.bindContext(a, agentDir, true, assertActive);
    expect(settings.maxConcurrent).toBe(2); expect(settings.defaultMaxTurns).toBe(8);
    settings.bindContext(a, agentDir, false, assertActive);
    expect(settings.maxConcurrent).toBe(7); expect(settings.defaultMaxTurns).toBeUndefined();
    expect(settings.excludedExtensionPackages).toEqual([]);
    expect(() => settings.saveAndNotify("saved")).toThrow("project trust");
    expect(readFileSync(path, "utf8")).toBe(original);
    settings.bindContext(b, agentDir, true, assertActive);
    expect(settings.graceTurns).toBe(12); expect(settings.defaultMaxTurns).toBeUndefined();
    owner.abort(new Error("retired"));
    expect(() => settings.load()).toThrow("retired");
    expect(() => settings.saveAndNotify("saved")).toThrow("retired");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
