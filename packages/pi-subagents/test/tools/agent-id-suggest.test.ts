import { describe, expect, it } from "vitest";
import {
	findClosestAgentId,
	formatAgentNotFound,
	levenshtein,
} from "#src/tools/agent-id-suggest";
import { createTestSubagent } from "#test/helpers/make-subagent";

describe("levenshtein", () => {
	it("scores identical strings as zero", () => {
		expect(levenshtein("abc", "abc")).toBe(0);
	});

	it("scores one extra trailing char as one", () => {
		expect(levenshtein("807081f0-bb07-4627", "807081f0-bb07-462")).toBe(1);
	});
});

describe("findClosestAgentId", () => {
	it("matches the exact ID", () => {
		expect(findClosestAgentId("agent-1", ["agent-1", "agent-2"])).toBe("agent-1");
	});

	it("matches when the request adds one trailing char", () => {
		expect(findClosestAgentId("807081f0-bb07-4627", ["807081f0-bb07-462"])).toBe(
			"807081f0-bb07-462",
		);
	});

	it("matches when the request drops the trailing char", () => {
		expect(findClosestAgentId("807081f0-bb07-46", ["807081f0-bb07-462"])).toBe(
			"807081f0-bb07-462",
		);
	});

	it("returns undefined when nothing is close", () => {
		expect(findClosestAgentId("zzz", ["agent-1", "agent-2"])).toBeUndefined();
	});
});

describe("formatAgentNotFound", () => {
	it("blames session switch only when no agents are registered", () => {
		const text = formatAgentNotFound("unknown", []);
		expect(text).toContain("No agents are registered");
		expect(text).not.toContain("Did you mean");
	});

	it("suggests the close match instead of the switch explanation", () => {
		const text = formatAgentNotFound("807081f0-bb07-4627", [
			createTestSubagent({ id: "807081f0-bb07-462" }),
		]);
		expect(text).toContain('Did you mean "807081f0-bb07-462"');
		expect(text).toContain("Copy the <task-id>");
	});

	it("lists available agents when nothing is close", () => {
		const text = formatAgentNotFound("zzz", [createTestSubagent({ id: "agent-1" })]);
		expect(text).toContain("No close match");
		expect(text).toContain('"agent-1"');
	});
});
