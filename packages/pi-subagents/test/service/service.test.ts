import { afterEach, describe, expect, it } from "vitest";
import { getSubagentsService, registerSubagentsService, SUBAGENT_EVENTS, type SubagentsService } from "#src/service/service";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

function service() { return { spawn: () => "id" } as unknown as SubagentsService; }
function register(parent: string, value: SubagentsService) {
  const dispose = registerSubagentsService(parent, value);
  disposers.push(dispose);
  return dispose;
}

describe("SubagentsService accessors", () => {
  it("returns undefined before registration", () => {
    expect(getSubagentsService()).toBeUndefined();
    expect(getSubagentsService("parent")).toBeUndefined();
  });
  it("resolves two parents independently and refuses ambiguous zero-argument lookup", () => {
    const first = service();
    const second = service();
    const disposeFirst = register("first", first);
    expect(getSubagentsService()).toBe(first);
    register("second", second);
    expect(getSubagentsService()).toBeUndefined();
    expect(getSubagentsService("first")).toBe(first);
    expect(getSubagentsService("second")).toBe(second);
    disposeFirst();
    expect(getSubagentsService()).toBe(second);
  });
  it("rejects duplicate owners and stale cleanup cannot evict a reused service object", () => {
    const value = service();
    const dispose = register("parent", value);
    expect(() => register("parent", value)).toThrow("already registered");
    dispose();
    register("parent", value);
    dispose();
    expect(getSubagentsService("parent")).toBe(value);
  });
  it("requires a real parent key", () => {
    expect(() => register(" ", service())).toThrow("parent session id");
  });
});

describe("SUBAGENT_EVENTS", () => {
  it("retains lifecycle channels without claiming they contain live transcript events", () => {
    expect(SUBAGENT_EVENTS.CREATED).toBe("subagents:created");
    expect("ACTIVITY" in SUBAGENT_EVENTS).toBe(false);
  });
});
