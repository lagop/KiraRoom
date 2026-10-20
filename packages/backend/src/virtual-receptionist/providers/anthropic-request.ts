/**
 * The parts of an Anthropic Messages request that depend on the model, and
 * where the prompt-cache breakpoints go. Pure functions, so the rules are
 * tested without the SDK.
 *
 * Claude Haiku 5.5 (claude-haiku-5-5) costs a tenth of Claude Haiku 4.5 per
 * token, caches prompts from 512 tokens instead of 4,096, and differs in
 * ways that break the old request (its migration guide,
 * platform.claude.com/docs/en/models/haiku-5-5/migration-guide):
 *
 *  - `temperature` other than 1, any `top_p` other than 0.99, and both
 *    together return a 400. We sent 0.7.
 *  - Adaptive thinking is on by default and set with `output_config.effort`;
 *    its thinking blocks must go back unchanged with the tool results.
 *  - Thinking tokens count toward `max_tokens`.
 *  - It can stop with `stop_reason: "refusal"`.
 *
 * The rest of the Claude 5 family is treated the same way. Leaving out the
 * sampling parameters is safe on any model; what is assumed for the family
 * beyond Haiku 5.5 is that it takes `output_config.effort`.
 */

/** Models that think adaptively and reject custom sampling parameters. */
export function isAdaptiveThinkingModel(model: string | undefined): boolean {
  return /^claude-(haiku-5|sonnet-5|opus-5|fable|mythos)/.test((model ?? '').trim());
}

/**
 * `temperature` / `top_p` for the request: none on adaptive-thinking models;
 * otherwise temperature, or top_p only when no temperature is set (newer
 * Haiku/Sonnet 4.5 models reject the two together).
 */
export function samplingParams(
  model: string,
  temperature: number | undefined,
  topP: number | undefined,
): { temperature?: number; top_p?: number } {
  if (isAdaptiveThinkingModel(model)) return {};
  if (temperature !== undefined) return { temperature };
  if (topP !== undefined) return { top_p: topP };
  return {};
}

/** Effort levels the API takes. */
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * How much the model thinks before answering. A receptionist answers short
 * questions and calls a tool or two: `low` keeps replies fast and cheap, and
 * at that level the model can skip thinking on simple messages. LLM_EFFORT
 * overrides it; `off` sends nothing.
 */
export function thinkingParams(model: string, effort: string | undefined): { output_config?: { effort: string } } {
  if (!isAdaptiveThinkingModel(model)) return {};
  const level = (effort ?? 'low').trim().toLowerCase();
  if (level === 'off' || !EFFORTS.has(level)) return {};
  return { output_config: { effort: level } };
}

/**
 * Thinking shares `max_tokens` with the answer, so an adaptive-thinking
 * model gets room for both: a cap tuned for Haiku 4.5's answers alone could
 * stop it after the thinking and before any text. A cap costs nothing
 * unless used.
 */
export function maxTokensFor(model: string, configured: number): number {
  return isAdaptiveThinkingModel(model) ? Math.max(configured, 4096) : configured;
}

type Block = { type: string; text?: string; cache_control?: { type: 'ephemeral' }; [k: string]: unknown };
type Message = { role: 'user' | 'assistant'; content: string | Block[] };

const EPHEMERAL = { type: 'ephemeral' as const };

/**
 * The messages with prompt-cache breakpoints, as a copy (the tool loop keeps
 * appending to the original, and a request takes at most four breakpoints).
 *
 * The system prompt already carries one. Two more go here:
 *
 *  - at the end of the stored history (`historyCount` messages). The next
 *    turn of the conversation sends that same history plus two messages, so
 *    it reads everything up to here from the cache and writes only the new
 *    tail. The current user turn cannot be the stable point: it carries the
 *    salon's clock, which the stored message does not.
 *  - on the last message, so the next request of the tool loop -- the same
 *    messages plus a tool call and its result -- reads all of this one.
 *
 * Below the model's minimum prefix (4,096 tokens on Haiku 4.5, 512 on
 * Haiku 5.5) the API ignores a breakpoint without error.
 */
export function withCacheBreakpoints(messages: Message[], historyCount: number): Message[] {
  const marks = new Set<number>();
  if (historyCount > 0 && historyCount <= messages.length) marks.add(historyCount - 1);
  if (messages.length > 0) marks.add(messages.length - 1);
  return messages.map((m, i) => (marks.has(i) ? markLastBlock(m) : m));
}

function markLastBlock(message: Message): Message {
  if (typeof message.content === 'string') {
    // Empty text blocks cannot be cached; leave them as they are.
    if (!message.content.trim()) return message;
    return { ...message, content: [{ type: 'text', text: message.content, cache_control: EPHEMERAL }] };
  }
  const blocks = [...message.content];
  // Thinking blocks cannot carry a breakpoint: mark the last block that can.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
    if (b.type === 'text' && !(b.text ?? '').trim()) continue;
    blocks[i] = { ...b, cache_control: EPHEMERAL };
    return { ...message, content: blocks };
  }
  return message;
}
