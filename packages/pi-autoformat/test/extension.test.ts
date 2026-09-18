import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { LoadConfigResult } from "#src/config-loader";
import {
  buildSteeringMessageContent,
  createAutoformatExtension,
  createDefaultAutoformatter,
} from "#src/extension";
import { createFormatterConfig } from "#src/formatter-config";
import type { PromptAutoformatterResult } from "#src/prompt-autoformatter";

type Handler = (event: never, ctx: TestContext) => void | Promise<void>;

type EventName =
  | "session_start"
  | "tool_call"
  | "tool_result"
  | "turn_end"
  | "agent_end"
  | "session_shutdown";

/**
 * Class-based stub that mirrors Pi's real `Theme.fg` `this`-binding
 * requirement. Plain object literals like `{ fg: (n, t) => t }` would
 * not surface the regression fixed in 6a6ec16, so every test ctx must
 * use this stub (or a real Theme instance).
 */
class StubTheme {
  private readonly fgColors = new Map<string, string>([
    ["success", ""],
    ["warning", ""],
    ["error", ""],
    ["dim", ""],
    ["accent", ""],
  ]);

  fg(color: string, text: string): string {
    if (!this.fgColors.has(color)) {
      throw new Error(`Unknown theme color: ${color}`);
    }
    return text;
  }
}

/** Build a `Theme`-shaped value backed by `StubTheme`. */
function makeStubTheme(): Theme {
  return new StubTheme() as unknown as Theme;
}

/**
 * Narrowed `ExtensionContext` view used by the autoformat extension. The
 * real `ExtensionContext` requires sessionManager/modelRegistry/etc. that
 * the autoformatter never touches, so tests fabricate only the surface
 * exercised here. `ui.theme` is anchored to the real `Theme` type so
 * plain-arrow stubs are rejected at compile time.
 */
type TestContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus?: (key: string, text: string | undefined) => void;
    theme?: Theme;
  };
};

class TestPi {
  private readonly handlers = new Map<EventName, Handler[]>();
  private readonly busHandlers = new Map<
    string,
    Array<(data: unknown) => void>
  >();

  // Cast through unknown: TestPi only models the events we exercise, not
  // ExtensionAPI's full overload set. The boundary cast lives here once
  // and the autoformat-side typing remains anchored to ExtensionAPI.
  readonly on = ((eventName: EventName, handler: Handler): void => {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
  }) as unknown as ExtensionAPI["on"];

  readonly events: ExtensionAPI["events"] = {
    emit: (_channel: string, _data: unknown): void => {
      // Tests use `emitBus` for clarity; the EventBus.emit is a no-op in
      // tests because no real bus producers run.
    },
    on: (channel, handler) => {
      const existing = this.busHandlers.get(channel) ?? [];
      existing.push(handler);
      this.busHandlers.set(channel, existing);
      return () => {
        const current = this.busHandlers.get(channel) ?? [];
        this.busHandlers.set(
          channel,
          current.filter((h) => h !== handler),
        );
      };
    },
  };

  readonly sentMessages: Array<{
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];

  readonly sendMessage = ((message: unknown, options?: unknown): void => {
    this.sentMessages.push({
      message: message as Record<string, unknown>,
      options: options as Record<string, unknown> | undefined,
    });
  }) as unknown as ExtensionAPI["sendMessage"];

  /** Cast helper: TestPi satisfies the slice of ExtensionAPI under test. */
  asExtensionAPI(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }

  emitBus(channel: string, data: unknown): void {
    for (const handler of this.busHandlers.get(channel) ?? []) {
      handler(data);
    }
  }

  busHandlerCount(channel: string): number {
    return (this.busHandlers.get(channel) ?? []).length;
  }

  async emit(
    eventName: EventName,
    event: unknown,
    ctx: TestContext,
  ): Promise<void> {
    for (const handler of this.handlers.get(eventName) ?? []) {
      await handler(event as never, ctx);
    }
  }
}

function createLoadResult(): LoadConfigResult {
  return {
    config: createFormatterConfig(),
    globalConfigPath: "/global/config.json",
    projectConfigPath: "/project/config.json",
    issues: [],
  };
}

function createContext(overrides?: Partial<TestContext>): TestContext {
  return {
    cwd: "/repo",
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: makeStubTheme(),
    },
    ...overrides,
  };
}

function createFlushResult(): PromptAutoformatterResult {
  return {
    groups: [
      {
        chain: ["prettier"],
        files: ["/repo/src/example.ts"],
        runs: [
          {
            formatterName: "prettier",
            command: ["prettier", "--write", "/repo/src/example.ts"],
            files: ["/repo/src/example.ts"],
            success: true,
            exitCode: 0,
          },
        ],
        changedFiles: [],
      },
    ],
  };
}

describe("createAutoformatExtension", () => {
  it("preserves the theme `this` binding when coloring the status line", async () => {
    // Regression: Pi's real Theme.fg is an instance method that reads
    // `this.fgColors`. If our extension destructures the method off the
    // theme object and calls it standalone, `this` is undefined and the
    // call throws "Cannot read properties of undefined (reading
    // 'fgColors')". The module-level `StubTheme` reproduces that shape.
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: { notify, setStatus, theme: makeStubTheme() },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue(createFlushResult()),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    setStatus.mockClear();
    await pi.emit("agent_end", {}, ctx);

    // The flush must succeed cleanly: no "Unexpected runtime error" warning,
    // and a normal success status was written.
    const warningCalls = notify.mock.calls.filter((c) => c[1] === "warning");
    expect(warningCalls).toEqual([]);
    expect(setStatus).toHaveBeenCalledWith(
      "pi-autoformat",
      expect.stringContaining("pi-autoformat:"),
    );
  });

  it("clears the autoformat status on an empty flush in the TUI", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: {
        notify,
        setStatus,
        theme: makeStubTheme(),
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    setStatus.mockClear();
    await pi.emit("agent_end", {}, ctx);

    expect(setStatus).toHaveBeenCalledWith("pi-autoformat", undefined);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports interactive success summaries via the footer status", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: {
        notify,
        setStatus,
        theme: makeStubTheme(),
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier"],
              files: ["/repo/src/example.ts", "/repo/README.md"],
              runs: [
                {
                  formatterName: "prettier",
                  command: [],
                  files: ["/repo/src/example.ts", "/repo/README.md"],
                  success: true,
                  exitCode: 0,
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    setStatus.mockClear();
    await pi.emit("agent_end", {}, ctx);

    expect(setStatus).toHaveBeenCalledTimes(1);
    const [statusKey, statusText] = setStatus.mock.calls[0];
    expect(statusKey).toBe("pi-autoformat");
    expect(statusText).toContain("pi-autoformat:");
    expect(statusText).toContain("2 files");
    expect(statusText).toContain("prettier");
    expect(notify).not.toHaveBeenCalled();
  });

  it("counts files across multiple groups in the success summary", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: {
        notify,
        setStatus,
        theme: makeStubTheme(),
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier"],
              files: ["/repo/a.ts", "/repo/b.ts"],
              runs: [
                {
                  formatterName: "prettier",
                  command: [],
                  files: ["/repo/a.ts", "/repo/b.ts"],
                  success: true,
                  exitCode: 0,
                },
              ],
            },
            {
              chain: ["prettier", "markdownlint"],
              files: ["/repo/c.md"],
              runs: [
                {
                  formatterName: "prettier",
                  command: [],
                  files: ["/repo/c.md"],
                  success: true,
                  exitCode: 0,
                },
                {
                  formatterName: "markdownlint",
                  command: [],
                  files: ["/repo/c.md"],
                  success: true,
                  exitCode: 0,
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    setStatus.mockClear();
    await pi.emit("agent_end", {}, ctx);

    const [, statusText] = setStatus.mock.calls[0];
    expect(statusText).toContain("3 files");
    expect(statusText).toContain("prettier");
    expect(statusText).toContain("markdownlint");
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports per-batch failure lines listing each batch's files", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const fg = vi.fn((_name: string, text: string) => text);
    class SpyTheme {
      fg = fg;
    }
    const ctx = createContext({
      ui: {
        notify,
        setStatus,
        theme: new SpyTheme() as unknown as Theme,
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier"],
              files: ["/repo/a.ts", "/repo/b.ts"],
              runs: [
                {
                  formatterName: "prettier",
                  command: [],
                  files: ["/repo/a.ts", "/repo/b.ts"],
                  success: false,
                  exitCode: 2,
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("agent_end", {}, ctx);

    expect(notify).toHaveBeenCalledWith(
      "Formatter failures in 1 batch:\nprettier (exit 2): /repo/a.ts, /repo/b.ts",
      "warning",
    );
    const failureStatusCalls = setStatus.mock.calls.filter(
      (c) => c[1] !== undefined,
    );
    expect(failureStatusCalls).toHaveLength(1);
    const [statusKey, statusText] = failureStatusCalls[0];
    expect(statusKey).toBe("pi-autoformat");
    expect(statusText).toContain("1 batch failed");
    expect(statusText).toContain("prettier");
    expect(fg).toHaveBeenCalledWith("error", expect.any(String));
  });

  it("shows mixed-result failures with surviving success batches in the status", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: {
        notify,
        setStatus,
        theme: makeStubTheme(),
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier", "markdownlint"],
              files: ["/repo/x.md"],
              runs: [
                {
                  formatterName: "prettier",
                  command: [],
                  files: ["/repo/x.md"],
                  success: true,
                  exitCode: 0,
                },
                {
                  formatterName: "markdownlint",
                  command: [],
                  files: ["/repo/x.md"],
                  success: false,
                  exitCode: 1,
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    setStatus.mockClear();
    await pi.emit("agent_end", {}, ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("markdownlint (exit 1): /repo/x.md"),
      "warning",
    );
    const failureStatus = setStatus.mock.calls.find((c) => c[1] !== undefined);
    expect(failureStatus).toBeDefined();
    const text = failureStatus?.[1] as string;
    expect(text).toContain("1 batch failed");
    expect(text).toContain("1 ok");
  });

  it("renders fallback context in success summaries when present", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: {
        notify,
        setStatus,
        theme: makeStubTheme(),
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: [{ fallback: ["biome", "prettier"] }],
              files: ["/repo/a.ts"],
              runs: [
                {
                  formatterName: "prettier",
                  command: ["prettier", "--write", "/repo/a.ts"],
                  files: ["/repo/a.ts"],
                  success: true,
                  exitCode: 0,
                  fallbackContext: { skipped: ["biome"] },
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    setStatus.mockClear();
    await pi.emit("agent_end", {}, ctx);

    const statusTexts = setStatus.mock.calls.map((c) => c[1] as string);
    expect(
      statusTexts.some((m) =>
        m.includes("prettier (fallback after biome unavailable)"),
      ),
    ).toBe(true);
  });

  it("renders fallback context in failure summaries when present", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const ctx = createContext({ ui: { notify } });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: [{ fallback: ["biome", "prettier"] }],
              files: ["/repo/a.ts"],
              runs: [
                {
                  formatterName: "prettier",
                  command: ["prettier", "--write", "/repo/a.ts"],
                  files: ["/repo/a.ts"],
                  success: false,
                  exitCode: 2,
                  fallbackContext: { skipped: ["biome"] },
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("agent_end", {}, ctx);

    expect(notify).toHaveBeenCalledWith(
      "Formatter failures in 1 batch:\nprettier (fallback after biome unavailable) (exit 2): /repo/a.ts",
      "warning",
    );
  });

  describe("formatterOutput surfacing", () => {
    function makeFailedFlushResult(stdout: string, stderr: string) {
      return {
        groups: [
          {
            chain: ["prettier"],
            files: ["/repo/a.ts"],
            runs: [
              {
                formatterName: "prettier",
                command: ["prettier", "--write", "/repo/a.ts"],
                files: ["/repo/a.ts"],
                success: false,
                exitCode: 2,
                stdout,
                stderr,
              },
            ],
          },
        ],
      };
    }

    it("omits stdout/stderr by default (onFailure: none)", async () => {
      const pi = new TestPi();
      const notify = vi.fn();
      const ctx = createContext({ ui: { notify } });

      createAutoformatExtension(pi.asExtensionAPI(), {
        loadConfig: vi.fn().mockReturnValue(createLoadResult()),
        createAutoformatter: vi.fn().mockReturnValue({
          recordToolResult: vi.fn(),
          flushPrompt: vi
            .fn()
            .mockResolvedValue(makeFailedFlushResult("out", "err")),
        }),
      });

      await pi.emit("session_start", {}, ctx);
      await pi.emit("agent_end", {}, ctx);

      expect(notify).toHaveBeenCalledWith(
        "Formatter failures in 1 batch:\nprettier (exit 2): /repo/a.ts",
        "warning",
      );
    });

    it("appends only stderr under onFailure: stderr", async () => {
      const pi = new TestPi();
      const notify = vi.fn();
      const ctx = createContext({ ui: { notify } });

      createAutoformatExtension(pi.asExtensionAPI(), {
        loadConfig: vi.fn().mockReturnValue({
          ...createLoadResult(),
          config: createFormatterConfig({
            formatterOutput: { onFailure: "stderr" },
          }),
        }),
        createAutoformatter: vi.fn().mockReturnValue({
          recordToolResult: vi.fn(),
          flushPrompt: vi
            .fn()
            .mockResolvedValue(
              makeFailedFlushResult("chatty stdout", "boom!\nat foo"),
            ),
        }),
      });

      await pi.emit("session_start", {}, ctx);
      await pi.emit("agent_end", {}, ctx);

      const [message] = notify.mock.calls[0];
      expect(message).toContain("prettier (exit 2): /repo/a.ts");
      expect(message).toContain("  stderr:");
      expect(message).toContain("    boom!");
      expect(message).toContain("    at foo");
      expect(message).not.toContain("  stdout:");
      expect(message).not.toContain("chatty stdout");
    });

    it("appends stdout above stderr under onFailure: both", async () => {
      const pi = new TestPi();
      const notify = vi.fn();
      const ctx = createContext({ ui: { notify } });

      createAutoformatExtension(pi.asExtensionAPI(), {
        loadConfig: vi.fn().mockReturnValue({
          ...createLoadResult(),
          config: createFormatterConfig({
            formatterOutput: { onFailure: "both" },
          }),
        }),
        createAutoformatter: vi.fn().mockReturnValue({
          recordToolResult: vi.fn(),
          flushPrompt: vi
            .fn()
            .mockResolvedValue(makeFailedFlushResult("out line", "err line")),
        }),
      });

      await pi.emit("session_start", {}, ctx);
      await pi.emit("agent_end", {}, ctx);

      const [message] = notify.mock.calls[0];
      const stdoutIdx = message.indexOf("  stdout:");
      const stderrIdx = message.indexOf("  stderr:");
      expect(stdoutIdx).toBeGreaterThanOrEqual(0);
      expect(stderrIdx).toBeGreaterThan(stdoutIdx);
      expect(message).toContain("    out line");
      expect(message).toContain("    err line");
    });

    it("omits an empty stdout block under onFailure: both", async () => {
      const pi = new TestPi();
      const notify = vi.fn();
      const ctx = createContext({ ui: { notify } });

      createAutoformatExtension(pi.asExtensionAPI(), {
        loadConfig: vi.fn().mockReturnValue({
          ...createLoadResult(),
          config: createFormatterConfig({
            formatterOutput: { onFailure: "both" },
          }),
        }),
        createAutoformatter: vi.fn().mockReturnValue({
          recordToolResult: vi.fn(),
          flushPrompt: vi
            .fn()
            .mockResolvedValue(makeFailedFlushResult("", "only stderr")),
        }),
      });

      await pi.emit("session_start", {}, ctx);
      await pi.emit("agent_end", {}, ctx);

      const [message] = notify.mock.calls[0];
      expect(message).not.toContain("  stdout:");
      expect(message).toContain("  stderr:");
      expect(message).toContain("    only stderr");
    });

    it("truncates a multi-kilobyte stderr while preserving the tail", async () => {
      const pi = new TestPi();
      const notify = vi.fn();
      const ctx = createContext({ ui: { notify } });

      // 200 lines, ~50 bytes each → ~10 KB. Cap well below.
      const longStderr = Array.from(
        { length: 200 },
        (_, i) =>
          `line${String(i).padStart(3, "0")}: ${"diagnostic-".repeat(3)}`,
      ).join("\n");

      createAutoformatExtension(pi.asExtensionAPI(), {
        loadConfig: vi.fn().mockReturnValue({
          ...createLoadResult(),
          config: createFormatterConfig({
            formatterOutput: {
              onFailure: "stderr",
              maxBytes: 1024,
              maxLines: 100,
            },
          }),
        }),
        createAutoformatter: vi.fn().mockReturnValue({
          recordToolResult: vi.fn(),
          flushPrompt: vi.fn().mockResolvedValue({
            groups: [
              {
                chain: ["prettier"],
                files: ["/repo/a.ts"],
                runs: [
                  {
                    formatterName: "prettier",
                    command: ["prettier", "--write", "/repo/a.ts"],
                    files: ["/repo/a.ts"],
                    success: false,
                    exitCode: 2,
                    stderr: longStderr,
                  },
                ],
              },
            ],
          }),
        }),
      });

      await pi.emit("session_start", {}, ctx);
      await pi.emit("agent_end", {}, ctx);

      const [message] = notify.mock.calls[0];
      expect(message).toMatch(/\(truncated, \d+ earlier (bytes|lines)\)/);
      // Tail must survive.
      expect(message).toContain("line199");
      // Head must not.
      expect(message).not.toContain("line000");
      expect(message).not.toContain("line050");
    });

    it("never annotates successful runs even under onFailure: both", async () => {
      const pi = new TestPi();
      const notify = vi.fn();
      const setStatus = vi.fn();
      const ctx = createContext({
        ui: {
          notify,
          setStatus,
          theme: makeStubTheme(),
        },
      });

      createAutoformatExtension(pi.asExtensionAPI(), {
        loadConfig: vi.fn().mockReturnValue({
          ...createLoadResult(),
          config: createFormatterConfig({
            formatterOutput: { onFailure: "both" },
          }),
        }),
        createAutoformatter: vi.fn().mockReturnValue({
          recordToolResult: vi.fn(),
          flushPrompt: vi.fn().mockResolvedValue({
            groups: [
              {
                chain: ["prettier"],
                files: ["/repo/a.ts"],
                runs: [
                  {
                    formatterName: "prettier",
                    command: ["prettier", "--write", "/repo/a.ts"],
                    files: ["/repo/a.ts"],
                    success: true,
                    exitCode: 0,
                    stdout: "would never be shown",
                    stderr: "deprecation notice",
                  },
                ],
              },
            ],
          }),
        }),
      });

      await pi.emit("session_start", {}, ctx);
      await pi.emit("agent_end", {}, ctx);

      // No failure notify; success status only.
      expect(notify).not.toHaveBeenCalled();
      const statusTexts = setStatus.mock.calls
        .map((c) => c[1])
        .filter((t): t is string => typeof t === "string");
      for (const text of statusTexts) {
        expect(text).not.toContain("would never be shown");
        expect(text).not.toContain("deprecation notice");
      }
    });
  });

  it("hides interactive success summaries when configured", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: {
        notify,
        setStatus,
        theme: makeStubTheme(),
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue({
        ...createLoadResult(),
        config: createFormatterConfig({
          hideSummariesInTui: true,
        }),
      }),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue(createFlushResult()),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    setStatus.mockClear();
    await pi.emit("agent_end", {}, ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith("pi-autoformat", undefined);
  });

  it("still surfaces failures when hideSummariesInTui is true", async () => {
    const pi = new TestPi();
    const notify = vi.fn();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: {
        notify,
        setStatus,
        theme: makeStubTheme(),
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue({
        ...createLoadResult(),
        config: createFormatterConfig({
          hideSummariesInTui: true,
        }),
      }),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier"],
              files: ["/repo/a.ts"],
              runs: [
                {
                  formatterName: "prettier",
                  command: [],
                  files: ["/repo/a.ts"],
                  success: false,
                  exitCode: 2,
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    setStatus.mockClear();
    await pi.emit("agent_end", {}, ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("prettier (exit 2): /repo/a.ts"),
      "warning",
    );
    const failureStatus = setStatus.mock.calls.find((c) => c[1] !== undefined);
    expect(failureStatus?.[1]).toContain("1 batch failed");
  });

  it("keeps non-interactive success summaries on console.log without setStatus", async () => {
    const pi = new TestPi();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setStatus = vi.fn();
    const ctx: TestContext = {
      cwd: "/repo",
      hasUI: false,
      ui: { notify: vi.fn(), setStatus },
    };

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier"],
              files: ["/repo/a.ts"],
              runs: [
                {
                  formatterName: "prettier",
                  command: [],
                  files: ["/repo/a.ts"],
                  success: true,
                  exitCode: 0,
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("agent_end", {}, ctx);

    expect(log).toHaveBeenCalledWith(
      "[pi-autoformat] Autoformatted 1 file: /repo/a.ts",
    );
    expect(setStatus).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    log.mockRestore();
    warn.mockRestore();
  });

  it("reports non-interactive formatter failures via console warnings", async () => {
    const pi = new TestPi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = createContext({ hasUI: false });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier", "markdownlint-cli2"],
              files: ["/repo/README.md"],
              runs: [
                {
                  formatterName: "prettier",
                  command: ["prettier", "--write", "/repo/README.md"],
                  files: ["/repo/README.md"],
                  success: false,
                  exitCode: 2,
                },
                {
                  formatterName: "markdownlint-cli2",
                  command: ["markdownlint-cli2", "--fix", "/repo/README.md"],
                  files: ["/repo/README.md"],
                  success: false,
                  exitCode: 1,
                },
              ],
            },
          ],
        }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("agent_end", {}, ctx);

    expect(warn).toHaveBeenCalledWith(
      "[pi-autoformat] Formatter failures in 2 batches:\nprettier (exit 2): /repo/README.md\nmarkdownlint-cli2 (exit 1): /repo/README.md",
    );
    expect(log).not.toHaveBeenCalled();
    // Non-interactive contexts must never touch setStatus even when present.
    const setStatus = (ctx.ui as { setStatus?: ReturnType<typeof vi.fn> })
      .setStatus;
    expect(setStatus).toBeDefined();
    expect(setStatus).not.toHaveBeenCalled();

    warn.mockRestore();
    log.mockRestore();
  });

  it("reports non-interactive config issues via console warnings", async () => {
    const pi = new TestPi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ctx = createContext({ hasUI: false });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue({
        ...createLoadResult(),
        issues: [
          {
            path: "commandTimeoutMs",
            message: "Expected a positive integer.",
            sourcePath: "/repo/.zrow/extensions/pi-autoformat/config.json",
          },
        ],
      }),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
      }),
    });

    await pi.emit("session_start", {}, ctx);

    expect(warn).toHaveBeenCalledWith(
      "[pi-autoformat] Configuration issues detected:\n/repo/.zrow/extensions/pi-autoformat/config.json commandTimeoutMs: Expected a positive integer.",
    );

    warn.mockRestore();
  });

  it("clears the autoformat status on session_start and session_shutdown", async () => {
    const pi = new TestPi();
    const setStatus = vi.fn();
    const ctx = createContext({
      ui: {
        notify: vi.fn(),
        setStatus,
        theme: makeStubTheme(),
      },
    });

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    expect(setStatus).toHaveBeenCalledWith("pi-autoformat", undefined);

    setStatus.mockClear();
    await pi.emit("session_shutdown", {}, ctx);
    expect(setStatus).toHaveBeenCalledWith("pi-autoformat", undefined);
  });

  it("records successful tool results and flushes at prompt end in prompt mode", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const autoformatter = {
      recordToolResult: vi.fn(),
      flushPrompt: vi.fn().mockResolvedValue(createFlushResult()),
    };
    const reportFlushResult = vi.fn();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue(autoformatter),
      reportFlushResult,
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit(
      "tool_result",
      {
        toolName: "write",
        input: { path: "src/example.ts", content: "export {};" },
        isError: false,
      },
      ctx,
    );
    await pi.emit("agent_end", {}, ctx);

    expect(autoformatter.recordToolResult).toHaveBeenCalledWith(
      "write",
      {
        path: "src/example.ts",
        content: "export {};",
      },
      "",
    );
    expect(autoformatter.flushPrompt).toHaveBeenCalledTimes(1);
    expect(reportFlushResult).toHaveBeenCalledTimes(1);
  });

  it("ignores failed tool results", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const autoformatter = {
      recordToolResult: vi.fn(),
      flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
    };

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue(autoformatter),
      reportFlushResult: vi.fn(),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit(
      "tool_result",
      {
        toolName: "write",
        input: { path: "src/example.ts", content: "" },
        isError: true,
      },
      ctx,
    );

    expect(autoformatter.recordToolResult).not.toHaveBeenCalled();
  });

  it("forwards bash tool output to the autoformatter", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const autoformatter = {
      recordToolResult: vi.fn(),
      flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
      addTouchedPath: vi.fn(),
    };

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue(autoformatter),
      reportFlushResult: vi.fn(),
    });

    await pi.emit(
      "tool_result",
      {
        toolName: "bash",
        input: { command: "sed -i 's/a/b/' foo.txt" },
        isError: false,
        content: [{ type: "text", text: "some output" }],
      },
      ctx,
    );

    expect(autoformatter.recordToolResult).toHaveBeenCalledWith(
      "bash",
      { command: "sed -i 's/a/b/' foo.txt" },
      "some output",
    );
  });

  it("reports config issues on session start", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const reportConfigIssues = vi.fn();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue({
        ...createLoadResult(),
        issues: [
          {
            path: "commandTimeoutMs",
            message: "Expected a positive integer.",
            sourcePath: "/repo/.zrow/extensions/pi-autoformat/config.json",
          },
        ],
      }),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
      }),
      reportConfigIssues,
    });

    await pi.emit("session_start", {}, ctx);

    expect(reportConfigIssues).toHaveBeenCalledWith(
      [
        {
          path: "commandTimeoutMs",
          message: "Expected a positive integer.",
          sourcePath: "/repo/.zrow/extensions/pi-autoformat/config.json",
        },
      ],
      { ctx },
    );
  });

  it("subscribes to the configured EventBus channel and forwards touched paths", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const addTouchedPath = vi.fn();
    const autoformatter = {
      recordToolResult: vi.fn(),
      flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
      addTouchedPath,
    };

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue(autoformatter),
      reportFlushResult: vi.fn(),
    });

    await pi.emit("session_start", {}, ctx);
    expect(pi.busHandlerCount("autoformat:touched")).toBe(1);

    pi.emitBus("autoformat:touched", { path: "src/a.ts" });
    pi.emitBus("autoformat:touched", {
      paths: ["src/b.ts", "src/c.ts"],
    });
    pi.emitBus("autoformat:touched", "not-an-object");

    expect(addTouchedPath.mock.calls.map((c) => c[0])).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);

    await pi.emit("session_shutdown", {}, ctx);
    expect(pi.busHandlerCount("autoformat:touched")).toBe(0);
  });

  it("does not subscribe when eventBusMutationChannel.enabled is false", async () => {
    const pi = new TestPi();
    const ctx = createContext();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue({
        ...createLoadResult(),
        config: createFormatterConfig({
          eventBusMutationChannel: { enabled: false },
        }),
      }),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
        addTouchedPath: vi.fn(),
      }),
      reportFlushResult: vi.fn(),
    });

    await pi.emit("session_start", {}, ctx);
    expect(pi.busHandlerCount("autoformat:touched")).toBe(0);
  });

  it("respects a custom EventBus channel name", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const addTouchedPath = vi.fn();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue({
        ...createLoadResult(),
        config: createFormatterConfig({
          eventBusMutationChannel: { channel: "my:channel" },
        }),
      }),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
        addTouchedPath,
      }),
      reportFlushResult: vi.fn(),
    });

    await pi.emit("session_start", {}, ctx);
    pi.emitBus("my:channel", { path: "src/x.ts" });
    expect(addTouchedPath).toHaveBeenCalledWith("src/x.ts");
  });

  it("wires customMutationTools into the default autoformatter queue", async () => {
    const config = createFormatterConfig({
      customMutationTools: [{ toolName: "my-codegen", pathField: "output" }],
      formatters: {
        "echo-fmt": {
          command: ["true"],
        },
      },
      chains: {
        ".ts": ["echo-fmt"],
      },
    });
    const autoformatter = createDefaultAutoformatter("/repo", config);

    autoformatter.recordToolResult(
      "my-codegen",
      { output: "src/generated.ts" },
      "",
    );
    const result = await autoformatter.flushPrompt();

    expect(result.groups.flatMap((g) => g.files)).toEqual([
      "/repo/src/generated.ts",
    ]);
  });

  it("does not send a follow-up message from agent_end", async () => {
    const pi = new TestPi();
    const ctx = createContext();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue(createFlushResult()),
        addTouchedPath: vi.fn(),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("agent_end", {}, ctx);

    // agent_end should NOT send messages (steering is at turn_end only)
    expect(pi.sentMessages).toHaveLength(0);
  });

  it("flushes formatters at turn_end", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const autoformatter = {
      recordToolResult: vi.fn(),
      flushPrompt: vi.fn().mockResolvedValue(createFlushResult()),
      addTouchedPath: vi.fn(),
    };
    const reportFlushResult = vi.fn();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue(autoformatter),
      reportFlushResult,
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit(
      "tool_result",
      {
        toolName: "write",
        input: { path: "src/example.ts", content: "export {};" },
        isError: false,
      },
      ctx,
    );
    await pi.emit("turn_end", {}, ctx);

    expect(autoformatter.flushPrompt).toHaveBeenCalledTimes(1);
    expect(reportFlushResult).toHaveBeenCalledTimes(1);
  });

  it("sends a steering message when turn_end flush changes files", async () => {
    const pi = new TestPi();
    const ctx = createContext();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier"],
              files: ["/repo/src/foo.ts"],
              runs: [
                {
                  formatterName: "prettier",
                  command: ["prettier", "--write"],
                  files: ["/repo/src/foo.ts"],
                  success: true,
                  exitCode: 0,
                },
              ],
              changedFiles: ["/repo/src/foo.ts"],
            },
          ],
        }),
        addTouchedPath: vi.fn(),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("turn_end", {}, ctx);

    expect(pi.sentMessages).toHaveLength(1);
    const content = pi.sentMessages[0].message.content as string;
    expect(content).toContain("[pi-autoformat] Formatted 1 file(s)");
    expect(content).toContain("/repo/src/foo.ts");
  });

  it("does not send a steering message when turn_end flush has no changes and no failures", async () => {
    const pi = new TestPi();
    const ctx = createContext();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["prettier"],
              files: ["/repo/src/foo.ts"],
              runs: [
                {
                  formatterName: "prettier",
                  command: ["prettier", "--write"],
                  files: ["/repo/src/foo.ts"],
                  success: true,
                  exitCode: 0,
                },
              ],
              changedFiles: [],
            },
          ],
        }),
        addTouchedPath: vi.fn(),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("turn_end", {}, ctx);

    expect(pi.sentMessages).toHaveLength(0);
  });

  it("sends a steering message with failure details on formatter failure", async () => {
    const pi = new TestPi();
    const ctx = createContext();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({
          groups: [
            {
              chain: ["biome"],
              files: ["/repo/src/broken.ts"],
              runs: [
                {
                  formatterName: "biome",
                  command: ["biome", "format", "--write"],
                  files: ["/repo/src/broken.ts"],
                  success: false,
                  exitCode: 1,
                  stderr: "SyntaxError: Unexpected token at line 42",
                },
              ],
              changedFiles: [],
            },
          ],
        }),
        addTouchedPath: vi.fn(),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("turn_end", {}, ctx);

    expect(pi.sentMessages).toHaveLength(1);
    const content = pi.sentMessages[0].message.content as string;
    expect(content).toContain("Failures:");
    expect(content).toContain("biome (exit 1) on /repo/src/broken.ts");
    expect(content).toContain("SyntaxError: Unexpected token at line 42");
  });

  it("does not send a steering message on empty flush", async () => {
    const pi = new TestPi();
    const ctx = createContext();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockResolvedValue({ groups: [] }),
        addTouchedPath: vi.fn(),
      }),
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit("turn_end", {}, ctx);

    expect(pi.sentMessages).toHaveLength(0);
  });

  it("formats EventBus-sourced files at agent_end as safety net", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const reportFlushResult = vi.fn();
    let flushCallCount = 0;

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue({
        recordToolResult: vi.fn(),
        flushPrompt: vi.fn().mockImplementation(() => {
          flushCallCount += 1;
          // First flush (turn_end) is empty; second (agent_end) has work
          if (flushCallCount === 1) {
            return Promise.resolve({ groups: [] });
          }
          return Promise.resolve(createFlushResult());
        }),
        addTouchedPath: vi.fn(),
      }),
      reportFlushResult,
    });

    await pi.emit("session_start", {}, ctx);
    // Simulate EventBus file added after turn_end
    await pi.emit("turn_end", {}, ctx);
    // Now agent_end flushes the EventBus-sourced file
    await pi.emit("agent_end", {}, ctx);

    expect(reportFlushResult).toHaveBeenCalledTimes(2);
    // Second call has groups (from the safety-net flush)
    const secondResult = reportFlushResult.mock.calls[1][0];
    expect(secondResult.groups.length).toBeGreaterThan(0);
  });

  it("does not re-flush at agent_end after turn_end already flushed", async () => {
    const pi = new TestPi();
    const ctx = createContext();
    const autoformatter = {
      recordToolResult: vi.fn(),
      flushPrompt: vi.fn().mockResolvedValue(createFlushResult()),
      addTouchedPath: vi.fn(),
    };
    const reportFlushResult = vi.fn();

    createAutoformatExtension(pi.asExtensionAPI(), {
      loadConfig: vi.fn().mockReturnValue(createLoadResult()),
      createAutoformatter: vi.fn().mockReturnValue(autoformatter),
      reportFlushResult,
    });

    await pi.emit("session_start", {}, ctx);
    await pi.emit(
      "tool_result",
      {
        toolName: "write",
        input: { path: "src/example.ts", content: "export {};" },
        isError: false,
      },
      ctx,
    );
    await pi.emit("turn_end", {}, ctx);
    reportFlushResult.mockClear();
    autoformatter.flushPrompt.mockClear();

    // agent_end calls flush but queue is already empty
    autoformatter.flushPrompt.mockResolvedValue({ groups: [] });
    await pi.emit("agent_end", {}, ctx);

    expect(autoformatter.flushPrompt).toHaveBeenCalledTimes(1);
    // The second flush should produce an empty result
  });
});

describe("buildSteeringMessageContent", () => {
  it("returns undefined when no changedFiles and no failures", () => {
    const result = buildSteeringMessageContent({
      groups: [
        {
          chain: ["prettier"],
          files: ["/repo/a.ts"],
          runs: [
            {
              formatterName: "prettier",
              command: ["prettier", "--write"],
              files: ["/repo/a.ts"],
              success: true,
              exitCode: 0,
            },
          ],
          changedFiles: [],
        },
      ],
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty groups", () => {
    expect(buildSteeringMessageContent({ groups: [] })).toBeUndefined();
  });

  it("lists a single changed file", () => {
    const result = buildSteeringMessageContent({
      groups: [
        {
          chain: ["prettier"],
          files: ["/repo/src/foo.ts"],
          runs: [
            {
              formatterName: "prettier",
              command: ["prettier", "--write"],
              files: ["/repo/src/foo.ts"],
              success: true,
              exitCode: 0,
            },
          ],
          changedFiles: ["/repo/src/foo.ts"],
        },
      ],
    });
    expect(result).toContain("[pi-autoformat] Formatted 1 file(s)");
    expect(result).toContain("/repo/src/foo.ts");
  });

  it("lists three changed files", () => {
    const result = buildSteeringMessageContent({
      groups: [
        {
          chain: ["prettier"],
          files: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
          runs: [
            {
              formatterName: "prettier",
              command: [],
              files: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
              success: true,
              exitCode: 0,
            },
          ],
          changedFiles: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
        },
      ],
    });
    expect(result).toContain("3 file(s)");
    expect(result).toContain("/repo/a.ts");
    expect(result).toContain("/repo/b.ts");
    expect(result).toContain("/repo/c.ts");
  });

  it("truncates file lists beyond 10 files", () => {
    const changedFiles = Array.from({ length: 11 }, (_, i) => `/repo/f${i}.ts`);
    const result = buildSteeringMessageContent({
      groups: [
        {
          chain: ["prettier"],
          files: changedFiles,
          runs: [
            {
              formatterName: "prettier",
              command: [],
              files: changedFiles,
              success: true,
              exitCode: 0,
            },
          ],
          changedFiles,
        },
      ],
    });
    expect(result).toContain("11 file(s)");
    expect(result).toContain("/repo/f9.ts");
    expect(result).not.toContain("/repo/f10.ts");
    expect(result).toContain("and 1 more");
  });

  it("includes failure details with stderr", () => {
    const result = buildSteeringMessageContent({
      groups: [
        {
          chain: ["prettier"],
          files: ["/repo/bad.ts"],
          runs: [
            {
              formatterName: "prettier",
              command: ["prettier", "--write"],
              files: ["/repo/bad.ts"],
              success: false,
              exitCode: 2,
              stderr: "SyntaxError: Unexpected token at line 42",
            },
          ],
          changedFiles: [],
        },
      ],
    });
    expect(result).toContain("Failures:");
    expect(result).toContain("prettier (exit 2) on /repo/bad.ts");
    expect(result).toContain("SyntaxError: Unexpected token at line 42");
  });

  it("includes both changed files and failures", () => {
    const result = buildSteeringMessageContent({
      groups: [
        {
          chain: ["prettier"],
          files: ["/repo/ok.ts", "/repo/bad.ts"],
          runs: [
            {
              formatterName: "prettier",
              command: ["prettier", "--write"],
              files: ["/repo/ok.ts"],
              success: true,
              exitCode: 0,
            },
            {
              formatterName: "prettier",
              command: ["prettier", "--write"],
              files: ["/repo/bad.ts"],
              success: false,
              exitCode: 2,
              stderr: "SyntaxError",
            },
          ],
          changedFiles: ["/repo/ok.ts"],
        },
      ],
    });
    expect(result).toContain("[pi-autoformat] Formatted 1 file(s)");
    expect(result).toContain("/repo/ok.ts");
    expect(result).toContain("Failures:");
    expect(result).toContain("prettier (exit 2)");
  });
});
