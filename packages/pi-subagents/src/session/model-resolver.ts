/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */
import type { Model } from "@earendil-works/pi-ai";

export interface ModelRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAll(): Model<any>[];
  getAvailable?(): Model<any>[];
}

/** Successful model resolution — `model` is the resolved or inherited model instance. */
export interface ModelResolutionResult {
  model: Model<any> | undefined;
  error?: undefined;
}

/** Failed model resolution when the model was user-specified (params) — surface the error. */
export interface ModelResolutionError {
  model?: undefined;
  error: string;
}

/** Discriminated union returned by `resolveInvocationModel`. */
export type ModelResolution = ModelResolutionResult | ModelResolutionError;

/**
 * Resolve the effective model for an agent invocation.
 *
 * Encapsulates the three-branch fallback policy used in `Agent.execute`:
 * 1. No `modelInput` → inherit `parentModel`.
 * 2. `modelInput` resolves → return the resolved model.
 * 3. `modelInput` fails:
 *    - `modelFromParams` true  → return `{ error }` so the caller can surface it.
 *    - `modelFromParams` false → silent fallback to `parentModel`.
 *
 * `modelFromParams` reports which side supplied the winning string, not merely whether
 * the caller passed one — a caller whose value an agent's `locked:` frontmatter discarded
 * did not win, so its typo is not the string being resolved here.
 */
export function resolveInvocationModel(
  parentModel: Model<any> | undefined,
  modelInput: string | undefined,
  modelFromParams: boolean,
  registry: ModelRegistry | undefined,
): ModelResolution {
  if (!modelInput) return { model: parentModel };
  if (!registry) return { error: "No model registry available." };
  const resolved = resolveModel(modelInput, registry);
  if (typeof resolved !== "string") return { model: resolved };
  if (modelFromParams) return { error: resolved };
  return { model: parentModel };
}

/**
 * Resolve a model string to a Model instance.
 * Accepts provider/modelId and legacy provider:modelId, then fuzzy-matches
 * within the named provider. Unqualified names search all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): Model<any> | string {
  // Availability means credentials are configured, not that the account's plan
  // supports every model in the provider catalog.
  const all = registry.getAvailable?.() ?? registry.getAll();
  const normalized = normalizeModelReference(input);
  if (normalized !== undefined) {
    const slash = normalized.indexOf("/");
    const provider = slash < 0 ? undefined : normalized.slice(0, slash).toLowerCase();
    const query = slash < 0 ? normalized : normalized.slice(slash + 1);
    // A qualified reference must never migrate to another provider, even when
    // that provider exposes the requested name inside one of its model ids.
    const candidates = provider === undefined
      ? all
      : all.filter(model => model.provider.toLowerCase() === provider);
    const bestMatch = findBestFuzzyMatch(candidates, query.toLowerCase());
    if (bestMatch) {
      const found = registry.find(bestMatch.provider, bestMatch.id);
      if (found) return found;
    }
  }

  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}\n\nCatalog availability does not guarantee access with the configured account.`;
}

/**
 * Native model-reference syntax shared with host write paths. Legacy GUI values
 * used provider:modelId; keep the whole model id (including / and :) intact.
 * Unqualified fuzzy names remain supported. Undefined means malformed input.
 */
export function normalizeModelReference(input: string): string | undefined {
  const value = input.trim();
  if (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(input)) return undefined;
  const separator = value.search(/[:/]/);
  if (separator < 0) return value;
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (!provider || !model || /\s/.test(provider) || /\s/.test(model)) return undefined;
  return `${provider}/${model}`;
}

/**
 * Score each candidate model — prefer exact id match > id contains > name
 * contains > provider+id contains — and return the best match at or above
 * the acceptance threshold (20), or undefined if nothing scores high enough.
 */
function findBestFuzzyMatch(all: Model<any>[], query: string): Model<any> | undefined {
  let bestMatch: Model<any> | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (query.split(/[\s\-/]+/).every(part => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  return bestScore >= 20 ? bestMatch : undefined;
}
