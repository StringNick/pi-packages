/**
 * Acceptance test: the production extension subscribes to Pi's real
 * EventBus and runs configured formatters on paths emitted via the
 * `autoformat:touched` channel.
 *
 * Drives the `pi` CLI in `--mode rpc` with two extensions loaded:
 *
 * 1. `src/extension.ts` — the production autoformatter.
 * 2. `test/fixtures/event-bus-emitter.ts` — exposes `/emit-touched` so
 *    the test can stage a real EventBus emit without an LLM.
 *
 * The "formatter" configured in the temp project is
 * `test/fixtures/formatter-recorder.mjs`, which appends one JSON line
 * per invocation to a log file. That gives us a deterministic ground
 * truth for what Pi actually invoked, without mocking anything inside
 * the extension.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { piAvailable, rpcVitestTimeoutMs, runRpcSession } from "./helpers/rpc";

const FIXTURE_EXTENSION = resolve(
  __dirname,
  "fixtures",
  "event-bus-emitter.ts",
);
const RECORDER_PATH = resolve(__dirname, "fixtures", "formatter-recorder.mjs");

const describeIfPi = piAvailable ? describe : describe.skip;

type RecorderEntry = {
  argv: string[];
  cwd: string;
};

function readRecorderLog(logPath: string): RecorderEntry[] {
  const contents = readFileSync(logPath, "utf-8");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecorderEntry);
}

describeIfPi("acceptance: autoformat:touched event bus", () => {
  let workDir: string;
  let logPath: string;

  beforeEach(() => {
    // realpathSync resolves macOS's /var → /private/var symlink so the
    // recorder's process.cwd() (which Pi spawns from a realpath'd cwd)
    // matches what the test expects.
    workDir = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-autoformat-eventbus-")),
    );
    logPath = join(workDir, "recorder.log");

    // Project config: formatter writes to the recorder; flush on session
    // shutdown so closing stdin is enough to drain the queue.
    const configDir = join(workDir, ".zrow", "extensions", "pi-autoformat");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        eventBusMutationChannel: {
          enabled: true,
          channel: "autoformat:touched",
        },
        formatters: {
          recorder: {
            command: ["node", RECORDER_PATH],
            environment: {
              PI_AUTOFORMAT_RECORDER_LOG: logPath,
            },
          },
        },
        chains: {
          ".ts": ["recorder"],
        },
      }),
    );

    // The file the test will tell pi about. The formatter is invoked
    // against this absolute path; the file does not actually need to be
    // formatted, but it must exist for in-scope filtering.
    writeFileSync(join(workDir, "out.ts"), "export const x = 1;\n");
  });

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it(
    "runs the configured formatter on paths emitted via pi.events",
    async () => {
      const targetPath = join(workDir, "out.ts");

      const { exitCode, stderr, responses } = await runRpcSession({
        cwd: workDir,
        extraExtensions: [FIXTURE_EXTENSION],
        commands: [
          { id: "1", type: "prompt", message: `/emit-touched ${targetPath}` },
        ],
      });

      expect(exitCode).toBe(0);
      expect(stderr).not.toMatch(/Extension .* error/i);

      const promptResponse = responses.find((r) => r.id === "1");
      expect(promptResponse?.success).toBe(true);

      const entries = readRecorderLog(logPath);
      expect(entries).toHaveLength(1);
      expect(entries[0].argv).toEqual([targetPath]);
      expect(entries[0].cwd).toBe(workDir);
    },
    rpcVitestTimeoutMs(),
  );
});

if (!piAvailable) {
  describe.skip("acceptance: autoformat:touched event bus", () => {
    it("skipped because node_modules/.bin/pi is not present", () => {
      // Intentionally empty.
    });
  });
}
