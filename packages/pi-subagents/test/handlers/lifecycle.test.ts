import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleManager, LifecycleRuntime } from "#src/handlers/lifecycle";
import { SessionLifecycleHandler } from "#src/handlers/lifecycle";

describe("SessionLifecycleHandler", () => {
  let runtime: LifecycleRuntime;
  let manager: LifecycleManager;
  let mockSetSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["setSessionContext"]>>;
  let mockClearSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["clearSessionContext"]>>;
  let mockEvictTerminalSessions: ReturnType<typeof vi.fn<LifecycleManager["evictTerminalSessions"]>>;
  let mockRestoreAgents: ReturnType<typeof vi.fn<LifecycleManager["restoreAgents"]>>;
  let mockAbortAll: ReturnType<typeof vi.fn<LifecycleManager["abortAll"]>>;
  let mockDispose: ReturnType<typeof vi.fn<LifecycleManager["dispose"]>>;
  let mockDisposeNotifications: ReturnType<typeof vi.fn<() => void>>;
  let mockUnpublishService: ReturnType<typeof vi.fn<() => void>>;
  let handler: SessionLifecycleHandler;

  beforeEach(() => {
    mockSetSessionContext = vi.fn();
    mockClearSessionContext = vi.fn();
    mockEvictTerminalSessions = vi.fn(() => Promise.resolve());
    mockRestoreAgents = vi.fn(() => 0);
    mockAbortAll = vi.fn();
    mockDispose = vi.fn(() => Promise.resolve());
    mockDisposeNotifications = vi.fn();
    mockUnpublishService = vi.fn();

    runtime = {
      setSessionContext: mockSetSessionContext,
      clearSessionContext: mockClearSessionContext,
    };
    manager = {
      evictTerminalSessions: mockEvictTerminalSessions,
      restoreAgents: mockRestoreAgents,
      abortAll: mockAbortAll,
      dispose: mockDispose,
    };

    handler = new SessionLifecycleHandler(
      runtime,
      manager,
      mockDisposeNotifications,
      mockUnpublishService,
    );
  });

  describe("handleSessionStart", () => {
    it("sets session context and restores durable records from parent entries", async () => {
      const entries = [
        {
          type: "custom",
          id: "e1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          customType: "subagents:record",
          data: {
            id: "a1",
            type: "general-purpose",
            description: "old work",
            status: "completed",
            outputFile: "/tmp/parent/tasks/x.jsonl",
            childSessionId: "child-1",
          },
        },
      ];
      const ctx = {
        sessionManager: {
          getSessionId: () => "parent-1",
          getSessionFile: () => "/tmp/parent.jsonl",
          getEntries: () => entries,
        },
      };

      await handler.handleSessionStart({}, ctx);

      expect(runtime.setSessionContext).toHaveBeenCalledWith(ctx);
      expect(manager.restoreAgents).toHaveBeenCalledWith(
        { parentSessionId: "parent-1", parentSessionFile: "/tmp/parent.jsonl" },
        [
          expect.objectContaining({
            id: "a1",
            status: "completed",
            outputFile: "/tmp/parent/tasks/x.jsonl",
            childSessionId: "child-1",
          }),
        ],
      );
    });

    it("sets context before restoring", async () => {
      const callOrder: string[] = [];
      mockSetSessionContext.mockImplementation(() => {
        callOrder.push("setSessionContext");
      });
      mockRestoreAgents.mockImplementation(() => {
        callOrder.push("restoreAgents");
        return 0;
      });

      await handler.handleSessionStart(
        {},
        { sessionManager: { getSessionId: () => "p", getSessionFile: () => undefined, getEntries: () => [] } },
      );

      expect(callOrder).toEqual(["setSessionContext", "restoreAgents"]);
    });

    it("skips restore when the context carries no session manager", async () => {
      await handler.handleSessionStart({}, { cwd: "/some/path" });

      expect(runtime.setSessionContext).toHaveBeenCalled();
      expect(manager.restoreAgents).not.toHaveBeenCalled();
    });

    it("skips restore when entries are unreadable", async () => {
      const ctx = {
        sessionManager: {
          getSessionId: () => "parent-1",
          getSessionFile: () => undefined,
          getEntries: () => {
            throw new Error("gone");
          },
        },
      };

      await handler.handleSessionStart({}, ctx);

      expect(manager.restoreAgents).not.toHaveBeenCalled();
    });
  });

  describe("handleSessionBeforeSwitch", () => {
    it("evicts terminal sessions but keeps the records", async () => {
      await handler.handleSessionBeforeSwitch();

      expect(manager.evictTerminalSessions).toHaveBeenCalled();
    });

    it("resolves only after the evicted children have shut down", async () => {
      const evicted = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
      mockEvictTerminalSessions.mockReturnValue(evicted.promise);

      let settled = false;
      const pending = handler.handleSessionBeforeSwitch().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      evicted.resolve();
      await pending;
      expect(settled).toBe(true);
    });
  });

  describe("handleSessionShutdown", () => {
    it("calls all cleanup steps", async () => {
      await handler.handleSessionShutdown();

      expect(mockUnpublishService).toHaveBeenCalled();
      expect(mockClearSessionContext).toHaveBeenCalled();
      expect(mockAbortAll).toHaveBeenCalled();
      expect(mockDisposeNotifications).toHaveBeenCalled();
      expect(mockDispose).toHaveBeenCalled();
    });

    it("calls cleanup in correct order", async () => {
      const callOrder: string[] = [];
      mockUnpublishService.mockImplementation(() => { callOrder.push("unpublishService"); });
      mockClearSessionContext.mockImplementation(() => {
        callOrder.push("clearSessionContext");
      });
      mockAbortAll.mockImplementation(() => {
        callOrder.push("abortAll");
      });
      mockDisposeNotifications.mockImplementation(() => { callOrder.push("disposeNotifications"); });
      mockDispose.mockImplementation(() => {
        callOrder.push("dispose");
        return Promise.resolve();
      });

      await handler.handleSessionShutdown();

      // Notifications are torn down before the aborts: a terminal transition
      // fires its nudge synchronously when no parent run is active, and Pi
      // cannot recall a message already handed to it.
      expect(callOrder).toEqual([
        "unpublishService",
        "clearSessionContext",
        "disposeNotifications",
        "abortAll",
        "dispose",
      ]);
    });

    it("resolves only after every child session has shut down", async () => {
      const disposed = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
      mockDispose.mockReturnValue(disposed.promise);

      let settled = false;
      const pending = handler.handleSessionShutdown().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      disposed.resolve();
      await pending;
      expect(settled).toBe(true);
    });
  });
});
