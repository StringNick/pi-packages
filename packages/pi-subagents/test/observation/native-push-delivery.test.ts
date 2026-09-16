import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type Context,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  Type,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionError,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { NotificationManager } from "#src/observation/notification";
import { createTestSubagent } from "#test/helpers/make-subagent";

type NativeMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];
type SendNotification = ConstructorParameters<typeof NotificationManager>[0];

describe("NotificationManager with native Pi AgentSession", () => {
  describe("busy parent", () => {
    it("buffers during tool execution, then steers the complete report into the next request without polling", async () => {
      const toolStarted = Promise.withResolvers<void>();
      const releaseTool = Promise.withResolvers<void>();
      const work = defineTool({
        name: "parent_work",
        label: "Parent work",
        description: "Deterministic independent parent work",
        parameters: Type.Object({}),
        execute: async (_id, _params, signal) => {
          const release = () => releaseTool.resolve();
          signal?.throwIfAborted();
          signal?.addEventListener("abort", release, { once: true });
          try {
            toolStarted.resolve();
            await releaseTool.promise;
            return { content: [{ type: "text", text: "Parent work finished" }], details: {} };
          } finally {
            signal?.removeEventListener("abort", release);
          }
        },
      });
      const h = await nativeParent([work]);
      const run = h.session.prompt("Do independent work while the child runs.");
      await h.first.received;
      h.first.respond(fauxAssistantMessage(fauxToolCall("parent_work", {}, { id: "work-1" }), {
        stopReason: "toolUse",
      }));
      await toolStarted.promise;

      h.notifications.sendCompletion(h.record);
      expect(h.session.isStreaming).toBe(true);
      expect(h.send).not.toHaveBeenCalled();
      expect(h.notifications.pendingDelivery).toBe(true);
      expect(h.record.consumed).toBe(false);
      expect(h.faux.state.callCount).toBe(1);

      releaseTool.resolve();
      await h.firstTurnEnded.promise;
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.send.mock.calls[0][1]).toEqual({ deliverAs: "steer", triggerTurn: true });
      expect(h.notifications.pendingDelivery).toBe(false);
      expect(h.events.some((event) => event.type === "agent_settled")).toBe(false);

      const delivered = await h.deliveryStarted.promise;
      expect(delivered.details).toBe(h.send.mock.calls[0][0].details);
      expect(h.record.consumed).toBe(false);
      expect(h.acknowledgements).toEqual([]);
      expect(h.faux.state.callCount).toBe(1);
      h.notifications.sendCompletion(h.record);
      expect(h.send).toHaveBeenCalledTimes(1);

      h.releaseDelivery.resolve();
      const nextRequest = await h.second.received;
      expectReportDelivery(h, nextRequest, delivered);
      expect(h.events.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName))
        .toEqual(["parent_work"]);
      expect(nextRequest.messages.map((message) => message.role))
        .toEqual(["user", "assistant", "toolResult", "user"]);
      expect(h.events.some((event) => event.type === "agent_end")).toBe(false);

      h.second.respond(fauxAssistantMessage("Used the child's report."));
      await run;
      expect(h.faux.state.callCount).toBe(2);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.notifications.pendingDelivery).toBe(false);
      expect(h.session.isIdle).toBe(true);
    });
  });

  describe("idle parent", () => {
    it("wakes a previously finished parent with triggerTurn and acknowledges only the delivered message", async () => {
      const h = await nativeParent();
      const run = h.session.prompt("Work independently until the child reports back.");
      await h.first.received;
      h.first.respond(fauxAssistantMessage("Waiting for the child's report."));
      await run;
      expect(h.session.isIdle).toBe(true);
      expect(h.events.filter((event) => event.type === "agent_settled")).toHaveLength(1);

      // No second prompt/continue call: Pi's sendMessage must own the wake-up.
      h.notifications.sendCompletion(h.record);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.send.mock.calls[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
      const delivered = await h.deliveryStarted.promise;
      expect(h.session.isStreaming).toBe(true);
      expect(h.record.consumed).toBe(false);
      expect(h.faux.state.callCount).toBe(1);

      h.releaseDelivery.resolve();
      const nextRequest = await h.second.received;
      expectReportDelivery(h, nextRequest, delivered);
      expect(nextRequest.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(h.events.filter((event) => event.type === "agent_start")).toHaveLength(2);
      h.second.respond(fauxAssistantMessage("Resumed with the child's report."));
      await h.session.waitForIdle();
      expect(h.session.isIdle).toBe(true);
      expect(h.events.filter((event) => event.type === "agent_settled")).toHaveLength(2);
      expect(h.faux.state.callCount).toBe(2);
    });
  });

  describe("failed parent boundary", () => {
    it.each(["error", "aborted"] as const)("uses agent_settled rather than steering into an %s turn", async (stopReason) => {
      const h = await nativeParent();
      const run = h.session.prompt("The child is still working.");
      await h.first.received;
      h.notifications.sendCompletion(h.record);
      expect(h.send).not.toHaveBeenCalled();

      // The abort case cancels the real session signal, not just a labelled reply.
      const abort = stopReason === "aborted" ? h.session.abort() : undefined;
      h.first.respond(fauxAssistantMessage("", { stopReason: "error", errorMessage: "Deterministic failure" }));
      await h.firstTurnEnded.promise;
      expect(h.turnBoundaries[0]).toEqual({ stopReason, pending: true, sent: 0, consumed: false });

      const delivered = await h.deliveryStarted.promise;
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.send.mock.calls[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
      expect(h.record.consumed).toBe(false);
      expect(h.events.filter((event) => event.type === "agent_end")).toHaveLength(1);

      h.releaseDelivery.resolve();
      expectReportDelivery(h, await h.second.received, delivered);
      h.second.respond(fauxAssistantMessage("Recovered with the child's report."));
      await run;
      await h.session.waitForIdle();
      await abort;
      expect(h.faux.state.callCount).toBe(2);
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.session.isIdle).toBe(true);
    });
  });
});

function modelRequest() {
  const request = Promise.withResolvers<Context>();
  const response = Promise.withResolvers<AssistantMessage>();
  return {
    received: request.promise,
    respond: response.resolve,
    step: (context: Context) => {
      request.resolve(context);
      return response.promise;
    },
  };
}

async function nativeParent(customTools: ToolDefinition[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-native-push-"));
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is forbidden in this test"));
  const intervals = vi.spyOn(globalThis, "setInterval");
  const first = modelRequest();
  const second = modelRequest();
  const deliveryStarted = Promise.withResolvers<Extract<NativeMessage, { role: "custom" }>>();
  const releaseDelivery = Promise.withResolvers<void>();
  const firstTurnEnded = Promise.withResolvers<void>();
  const record = createTestSubagent({
    result: "Evidence beyond the old preview: " + "verified result ".repeat(80),
    sessionReady: true,
    outputFile: "/sessions/child.jsonl",
  });
  const errors: ExtensionError[] = [];
  const events: AgentSessionEvent[] = [];
  const acknowledgements: Array<{ message: NativeMessage; before: boolean; after: boolean }> = [];
  const turnBoundaries: Array<{ stopReason: string; pending: boolean; sent: number; consumed: boolean }> = [];
  let session: AgentSession | undefined;
  let manager: NotificationManager | undefined;
  onTestFinished(async () => {
    manager?.dispose();
    releaseDelivery.resolve();
    first.respond(fauxAssistantMessage("Cleanup"));
    second.respond(fauxAssistantMessage("Cleanup"));
    try {
      await session?.abort();
      expect(network).not.toHaveBeenCalled();
      expect(intervals).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      session?.dispose();
      rmSync(cwd, { recursive: true, force: true });
      network.mockRestore();
      intervals.mockRestore();
    }
  });

  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  // Pi's own credential-free faux provider emits real stream events. Fixed chunk
  // size and promise gates avoid timers, sleeps, or a replacement agent/queue.
  const faux = fauxProvider({ api: "native-push-test", provider: "native-push-test", tokenSize: { min: 1024, max: 1024 } });
  faux.setResponses([first.step, second.step]);
  runtime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const ready = Promise.withResolvers<{ notifications: NotificationManager; send: ReturnType<typeof vi.fn<SendNotification>> }>();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Deterministic notification transport test.",
    appendSystemPrompt: [],
    extensionFactories: [(pi) => {
      const send = vi.fn<SendNotification>((message, options) => pi.sendMessage(message, options));
      const notifications = new NotificationManager(send);
      manager = notifications;
      // Mirror index.ts's notification hooks in a minimal native extension.
      // The package's tool/child-lifecycle composition is outside this test.
      pi.on("agent_start", () => notifications.onParentAgentStart());
      pi.on("turn_end", (event) => {
        if (event.message.role === "assistant" &&
          (event.message.stopReason === "error" || event.message.stopReason === "aborted")) return;
        notifications.onParentTurnEnd();
      });
      pi.on("message_end", (event) => {
        const before = record.consumed;
        notifications.onParentMessageEnd(event.message);
        if (event.message.role === "custom") {
          acknowledgements.push({ message: event.message, before, after: record.consumed });
        }
      });
      pi.on("agent_settled", () => notifications.onParentAgentSettled());
      // Pause real Pi immediately before message_end to distinguish handoff
      // from acknowledgement; no test calls onParentMessageEnd directly.
      pi.on("message_start", async (event) => {
        if (event.message.role !== "custom") return;
        deliveryStarted.resolve(event.message);
        await releaseDelivery.promise;
      });
      ready.resolve({ notifications, send });
    }],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { notifications, send } = await ready.promise;
  ({ session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    modelRuntime: runtime,
    model: faux.getModel(),
    thinkingLevel: "off",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    tools: customTools.map((tool) => tool.name),
    customTools,
  }));
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "turn_end" && event.message.role === "assistant") {
      turnBoundaries.push({ stopReason: event.message.stopReason, pending: notifications.pendingDelivery,
        sent: send.mock.calls.length, consumed: record.consumed });
      firstTurnEnded.resolve();
    }
  });
  expect(session.sessionFile).toBeUndefined();
  expect(await credentials.list()).toEqual([]);
  return { session, notifications, send, record, faux, first, second, deliveryStarted, releaseDelivery,
    firstTurnEnded, acknowledgements, turnBoundaries, events, network, intervals };
}

function expectReportDelivery(
  h: Awaited<ReturnType<typeof nativeParent>>,
  request: Context,
  delivered: Extract<NativeMessage, { role: "custom" }>,
) {
  const sent = h.send.mock.calls[0][0];
  // Assert the report, not Pi's surrounding custom-message presentation text.
  expect(sent.content).toContain(`<result>${h.record.result}</result>`);
  expect(sent.content).toContain("<output-file>/sessions/child.jsonl</output-file>");
  expect(sent.content).not.toContain("get_subagent_result");
  expect(request.messages.at(-1)).toEqual({
    role: "user", content: [{ type: "text", text: sent.content }], timestamp: delivered.timestamp,
  });
  expect(h.acknowledgements).toEqual([{ message: delivered, before: false, after: true }]);
  expect(h.acknowledgements[0].message).toBe(delivered);
  expect(delivered.details).toBe(sent.details);
  expect(h.session.messages.find((message) => message.role === "custom")).toBe(delivered);
  const entry = h.session.sessionManager.getEntries().find((item) => item.type === "custom_message");
  expect(entry?.details).toBe(sent.details);
  expect(h.record.consumed).toBe(true);
  expect(h.network).not.toHaveBeenCalled();
  expect(h.intervals).not.toHaveBeenCalled();
}
