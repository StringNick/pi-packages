import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";

/** Flat options for {@link createResolvedSpawnConfig}; only the scalars tests vary. */
export interface ResolvedSpawnConfigOptions {
  subagentType?: string;
  rawType?: string;
  displayName?: string;
  prompt?: string;
  description?: string;
  model?: string;
  runInBackground?: boolean;
  notes?: string[];
}

/**
 * Build a `ResolvedSpawnConfig` for tool tests from flat options.
 *
 * Derives the mirrored regions the hand-built fixtures duplicate:
 * `execution.runInBackground` → `execution.agentInvocation.runInBackground`, and
 * `displayName`/`description`/`subagentType`/`model` → `presentation.detailBase`.
 * Flat options sidestep the `Partial<ResolvedSpawnConfig>` deep-merge trap.
 */
export function createResolvedSpawnConfig(
  options: ResolvedSpawnConfigOptions = {},
): ResolvedSpawnConfig {
  const subagentType = options.subagentType ?? "worker";
  const displayName = options.displayName ?? "worker";
  const description = options.description ?? "task";
  const runInBackground = options.runInBackground ?? false;
  const modelName = options.model;
  const rawType = options.rawType ?? subagentType;

  return {
    identity: { subagentType, rawType, displayName },
    notes: options.notes ?? [],
    execution: {
      prompt: options.prompt ?? "do the task",
      description,
      model: undefined,
      effectiveMaxTurns: undefined,
      thinking: undefined,
      inheritContext: false,
      runInBackground,
      agentInvocation: {
        modelName,
        thinking: undefined,
        maxTurns: undefined,
        inheritContext: false,
        runInBackground,
      },
    },
    presentation: {
      modelName,
      agentTags: [],
      detailBase: { displayName, description, subagentType, modelName, tags: undefined },
    },
  };
}
