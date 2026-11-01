import { AnthropicProvider } from './anthropic.provider';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, estimateCostUsd, priceFor } from './anthropic-models';

/** Model list and prices. No request reaches the API. */
describe('Claude models and prices', () => {
  it('defaults to Claude Haiku 5.5', () => {
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-haiku-5-5');
  });

  it('lists the current models and Haiku 4.5 as legacy, no retired Claude 3 ids', () => {
    const ids = CLAUDE_MODELS.map((m) => m.id);
    expect(ids).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5']);
    expect(CLAUDE_MODELS.find((m) => m.id === 'claude-haiku-4-5')?.legacy).toBe(true);
    expect(ids.some((id) => id.startsWith('claude-3'))).toBe(false);
  });

  it('prices Haiku 5.5 at $0.10 / $0.50 per MTok, cache read 10 % and write 125 % of input', () => {
    const p = priceFor('claude-haiku-5-5')!;
    expect(p.input).toBeCloseTo(0.1);
    expect(p.output).toBeCloseTo(0.5);
    expect(p.cacheRead).toBeCloseTo(0.01);
    expect(p.cacheWrite).toBeCloseTo(0.125);
  });

  it('estimates the cost of a message from its four counters', () => {
    // 1M fresh in, 1M out, 1M cache read, 1M cache write on Haiku 5.5.
    const usd = estimateCostUsd('claude-haiku-5-5', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125);
    // Haiku 4.5 is ten times that.
    expect(estimateCostUsd('claude-haiku-4-5', { promptTokens: 1_000_000, completionTokens: 1_000_000 })).toBeCloseTo(6);
  });

  it('prices a dated snapshot as its alias and ignores case', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(priceFor('claude-haiku-4-5'));
    expect(priceFor(' Claude-Haiku-5-5 ')).toEqual(priceFor('claude-haiku-5-5'));
  });

  it('has no price, and no crash, for a model it does not know', () => {
    expect(priceFor('claude-3-haiku-20240307')).toBeNull();
    expect(priceFor('MiniMax-M3')).toBeNull();
    expect(priceFor(undefined)).toBeNull();
    expect(estimateCostUsd('some-new-model', { promptTokens: 1000 })).toBeNull();
  });

  it('bad counters count as zero', () => {
    expect(estimateCostUsd('claude-haiku-5-5', { promptTokens: NaN, completionTokens: -5 })).toBe(0);
  });

  it("the Anthropic provider's model list is this table", async () => {
    const provider = new AnthropicProvider({ get: () => undefined } as any);
    const models = await provider.getAvailableModels();
    expect(models.map((m) => m.id)).toEqual(CLAUDE_MODELS.map((m) => m.id));
    expect(models[0].costPerToken).toBeCloseTo(0.0001); // USD per 1K input tokens
  });
});
