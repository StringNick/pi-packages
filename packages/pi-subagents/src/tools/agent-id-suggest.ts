import type { Subagent } from "#src/types";

/**
 * agent-id-suggest.ts — "Did you mean …?" for subagent ID lookups.
 *
 * Subagent IDs are 17-char prefixes of a UUID (`randomUUID().slice(0, 17)`),
 * an unusual shape models tend to "complete" from memory — e.g. appending one
 * more hex char. A miss in `get_subagent_result` / `steer_subagent` used to
 * answer with a generic "records are cleared" note, which sent the parent down
 * the wrong trail (session switch) when the real cause was a typo. This helper
 * separates the two cases: a close match names the intended agent, otherwise
 * the message lists what is actually registered.
 */

/** Typo tolerance for the edit-distance fallback (covers ±1 char on 17-char IDs). */
const MAX_DISTANCE = 2;

/** Upper bound on listed IDs when nothing is close — keeps the message compact. */
const MAX_LISTED = 5;

/** Classic Levenshtein distance over short ASCII IDs; no dependencies. */
export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const curr = [i];
		for (let j = 1; j <= b.length; j++) {
			curr[j] = Math.min(
				prev[j] + 1,
				curr[j - 1] + 1,
				prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = curr;
	}
	return prev[b.length];
}

/**
 * Closest registered ID to `requested`, or undefined when nothing is close.
 * An either-way prefix match wins immediately (covers truncation lapses and
 * extra-char typos like `…4627` for `…462`); otherwise the nearest ID within
 * `MAX_DISTANCE` edits is returned.
 */
export function findClosestAgentId(requested: string, ids: string[]): string | undefined {
	if (ids.includes(requested)) return requested;
	const prefixHit = ids
		.filter((id) => id.startsWith(requested) || requested.startsWith(id))
		.sort((a, b) => Math.abs(a.length - requested.length) - Math.abs(b.length - requested.length))[0];
	if (prefixHit) return prefixHit;
	let best: string | undefined;
	let bestDistance = MAX_DISTANCE + 1;
	for (const id of ids) {
		const distance = levenshtein(requested, id);
		if (distance < bestDistance) {
			best = id;
			bestDistance = distance;
		}
	}
	return bestDistance <= MAX_DISTANCE ? best : undefined;
}

/**
 * Miss message that distinguishes a likely typo from a genuinely absent record.
 * - Close match → name it and tell the model to copy `<task-id>` verbatim.
 * - No records at all → the session-switch explanation (the only case where it fits).
 * - Records exist but nothing close → list available IDs so the model can pick.
 */
export function formatAgentNotFound(requested: string, agents: Subagent[]): string {
	if (agents.length === 0) {
		return (
			`Agent not found: "${requested}". No agents are registered in this session — ` +
			`records are cleared at session start/switch, so it may be from a previous session.`
		);
	}
	const suggestion = findClosestAgentId(
		requested,
		agents.map((agent) => agent.id),
	);
	if (suggestion) {
		const match = agents.find((agent) => agent.id === suggestion);
		const label = match ? ` ("${match.description}")` : "";
		return (
			`Agent not found: "${requested}". Did you mean "${suggestion}"${label}? ` +
			`Copy the <task-id> from the subagent notification exactly instead of retyping it.`
		);
	}
	const listed = agents
		.slice(0, MAX_LISTED)
		.map((agent) => `"${agent.id}" ("${agent.description}")`)
		.join(", ");
	const overflow = agents.length > MAX_LISTED ? `, … (${agents.length} total)` : "";
	return (
		`Agent not found: "${requested}". No close match. ` +
		`Available agents: ${listed}${overflow}. ` +
		`Copy the <task-id> from the subagent notification exactly; ` +
		`records are cleared at session start/switch, so IDs from a previous session will not resolve.`
	);
}
