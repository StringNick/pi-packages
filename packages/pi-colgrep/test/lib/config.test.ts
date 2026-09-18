import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_ID,
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfig,
  normalizeConfig,
} from "#src/lib/config";

describe("getGlobalConfigPath", () => {
  it("constructs the expected global path", () => {
    expect(getGlobalConfigPath("/home/user/.zrow")).toBe(
      `/home/user/.zrow/extensions/${EXTENSION_ID}/config.json`,
    );
  });
});

describe("getProjectConfigPath", () => {
  it("constructs the expected project path", () => {
    expect(getProjectConfigPath("/my/project")).toBe(
      `/my/project/.zrow/extensions/${EXTENSION_ID}/config.json`,
    );
  });
});

describe("normalizeConfig", () => {
  it("returns empty config for non-object input", () => {
    expect(normalizeConfig(null)).toEqual({});
    expect(normalizeConfig("string")).toEqual({});
    expect(normalizeConfig(42)).toEqual({});
    expect(normalizeConfig([])).toEqual({});
  });

  it("returns empty config when indexOnStartup is absent", () => {
    expect(normalizeConfig({})).toEqual({});
  });

  it("accepts a boolean indexOnStartup", () => {
    expect(normalizeConfig({ indexOnStartup: true })).toEqual({
      indexOnStartup: true,
    });
    expect(normalizeConfig({ indexOnStartup: false })).toEqual({
      indexOnStartup: false,
    });
  });

  it("ignores non-boolean indexOnStartup values", () => {
    expect(normalizeConfig({ indexOnStartup: "yes" })).toEqual({});
    expect(normalizeConfig({ indexOnStartup: 1 })).toEqual({});
    expect(normalizeConfig({ indexOnStartup: null })).toEqual({});
  });

  it("ignores unknown keys", () => {
    expect(normalizeConfig({ indexOnStartup: false, unknown: true })).toEqual({
      indexOnStartup: false,
    });
  });
});

describe("loadConfig", () => {
  const tmpFiles: string[] = [];

  function writeTmp(content: string): string {
    const path = join(
      tmpdir(),
      `pi-colgrep-test-${Date.now()}-${Math.random()}.json`,
    );
    writeFileSync(path, content);
    tmpFiles.push(path);
    return path;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        unlinkSync(f);
      } catch {}
    }
    tmpFiles.length = 0;
  });

  it("defaults indexOnStartup to true when both files are missing", () => {
    expect(
      loadConfig({
        globalConfigPath: "/nonexistent/global.json",
        projectConfigPath: "/nonexistent/project.json",
      }),
    ).toEqual({ indexOnStartup: true });
  });

  it("honors an explicit indexOnStartup: false from the global file", () => {
    const global = writeTmp(JSON.stringify({ indexOnStartup: false }));
    expect(
      loadConfig({
        globalConfigPath: global,
        projectConfigPath: "/nonexistent/project.json",
      }),
    ).toEqual({ indexOnStartup: false });
  });

  it("honors an explicit indexOnStartup: false from the project file", () => {
    const project = writeTmp(JSON.stringify({ indexOnStartup: false }));
    expect(
      loadConfig({
        globalConfigPath: "/nonexistent/global.json",
        projectConfigPath: project,
      }),
    ).toEqual({ indexOnStartup: false });
  });

  it("lets the project file override the global file", () => {
    const global = writeTmp(JSON.stringify({ indexOnStartup: true }));
    const project = writeTmp(JSON.stringify({ indexOnStartup: false }));
    expect(
      loadConfig({ globalConfigPath: global, projectConfigPath: project }),
    ).toEqual({ indexOnStartup: false });
  });

  it("defaults to true when a non-boolean value is present", () => {
    const global = writeTmp(JSON.stringify({ indexOnStartup: "nope" }));
    expect(
      loadConfig({
        globalConfigPath: global,
        projectConfigPath: "/nonexistent/project.json",
      }),
    ).toEqual({ indexOnStartup: true });
  });

  it("warns and defaults to true when a file contains malformed JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const global = writeTmp("not valid json {{{");
    expect(
      loadConfig({
        globalConfigPath: global,
        projectConfigPath: "/nonexistent/project.json",
      }),
    ).toEqual({ indexOnStartup: true });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("[pi-colgrep]");
    warn.mockRestore();
  });
});
