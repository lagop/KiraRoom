/**
 * Token usage summed across every round-trip of a tool loop.
 *
 * The Anthropic-shaped providers drive the model in a loop: ask, run the
 * `tool_use` blocks it asked for, append the `tool_result`s, ask again. Every
 * one of those asks is a separately billed request that resends the entire
 * prompt -- system, tools and the conversation so far.
 *
 * Both providers used to report `response.usage` from the LAST response only,
 * because the loop reassigns `response` and the return statement reads it
 * after the loop has finished. Every intermediate round-trip was invisible.
 *
 * Measured in production on the test salon: a two-message exchange in which
 * the receptionist ran `list_services`, `get_salon_info` and
 * `check_availability` was recorded as 2 calls / 6718 input tokens. That is
 * the floor, not the total -- and it is the number that feeds the cost model
 * and the message-credit wallet.
 *
 * Semantics follow the Anthropic API, which the downstream telemetry already
 * assumes: `input_tokens` counts only FRESH input, with cache reads and cache
 * writes reported separately. So the four counters are summed independently
 * and `totalTokens` stays "fresh input + output".
 */

/** The `usage` shape both Anthropic and MiniMax return. */
export interface AnthropicUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface UsageTotals {
  /** Fresh (uncached) input tokens across every round-trip. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  /**
   * How many billed requests produced these totals.
   *
   * Distinct from `tenant_llm_usage.calls`, which counts messages answered:
   * one message can cost several requests. Surfaced so the real round-trip
   * count is observable without a schema change.
   */
  requests: number;
}

export interface UsageAccumulator {
  add(usage: AnthropicUsageLike | null | undefined): void;
  totals(): UsageTotals;
}

/**
 * A provider calls `add` once per response it receives -- including the
 * first one, before the loop -- and `totals` once at the end.
 */
export function createUsageAccumulator(): UsageAccumulator {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let requests = 0;

  return {
    add(usage) {
      // A response always counts as a request, even if the provider sent no
      // usage block: dropping it would undercount again, which is the whole
      // point of this file.
      requests += 1;
      if (!usage) {
        return;
      }
      promptTokens += nonNegative(usage.input_tokens);
      completionTokens += nonNegative(usage.output_tokens);
      cachedInputTokens += nonNegative(usage.cache_read_input_tokens);
      cacheWriteTokens += nonNegative(usage.cache_creation_input_tokens);
    },
    totals() {
      return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        cachedInputTokens,
        cacheWriteTokens,
        requests,
      };
    },
  };
}

/**
 * Usage numbers are billing input, so a missing, negative or non-finite
 * value must contribute zero rather than poison the sum with NaN.
 */
function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
