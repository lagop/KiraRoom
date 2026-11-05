/**
 * The Claude models the platform can be set to, and what they cost.
 *
 * The default is Claude Haiku 5.5: production runs the virtual receptionist
 * on it (PlatformLlmConfig), it costs a tenth of Haiku 4.5 per token and it
 * caches prompts from 512 tokens. Haiku 4.5 stays in the list as the legacy
 * option; the Claude 3 ids that used to be here are retired and answer 404.
 *
 * Prices are US dollars per million tokens (Anthropic's first-party API).
 * A cache read costs 10 % of fresh input and a cache write (5-minute TTL)
 * 125 %, except where a model lists its own cache-read price (Opus 5.5).
 * Haiku 5.5 charges more above 100K prompt tokens ($0.50 / $2.50); a
 * receptionist prompt is far below that, so only the base price is kept.
 *
 * The message-credit wallet charges one credit per message whatever the
 * model; these prices are for estimating what a model costs the platform.
 * A model not in this table (a new id typed in the console, a gateway's own
 * name) has no price: `priceFor` returns null and the estimate is null,
 * never a crash or a made-up number.
 */

export const DEFAULT_CLAUDE_MODEL = 'claude-haiku-5-5';

export interface ClaudeModelInfo {
  id: string;
  name: string;
  /** Input tokens the model accepts. */
  contextWindow: number;
  /** USD per million fresh input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million cache-read tokens, when not 10 % of input. */
  cacheReadPerMTok?: number;
  legacy?: boolean;
}

export const CLAUDE_MODELS: readonly ClaudeModelInfo[] = [
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 1_000_000, inputPerMTok: 0.1, outputPerMTok: 0.5 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, inputPerMTok: 2, outputPerMTok: 10 },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    contextWindow: 1_000_000,
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5 (legacy)',
    contextWindow: 200_000,
    inputPerMTok: 1,
    outputPerMTok: 5,
    legacy: true,
  },
];

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Per-MTok prices for a model id, or null when unknown. A dated snapshot
 * ("claude-haiku-4-5-20251001") is priced as its alias.
 */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  const id = String(model ?? '')
    .trim()
    .toLowerCase()
    .replace(/-\d{8}$/, '');
  const info = CLAUDE_MODELS.find((m) => m.id === id);
  if (!info) return null;
  return {
    input: info.inputPerMTok,
    output: info.outputPerMTok,
    cacheRead: info.cacheReadPerMTok ?? info.inputPerMTok * 0.1,
    cacheWrite: info.inputPerMTok * 1.25,
  };
}

/** The four counters UsageTotals carries (fresh input excludes cache reads and writes). */
export interface TokenCounts {
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/** Estimated USD for the tokens, or null for a model without a price. */
export function estimateCostUsd(model: string | null | undefined, usage: TokenCounts): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return (
    (n(usage.promptTokens) * price.input +
      n(usage.completionTokens) * price.output +
      n(usage.cachedInputTokens) * price.cacheRead +
      n(usage.cacheWriteTokens) * price.cacheWrite) /
    1_000_000
  );
}
