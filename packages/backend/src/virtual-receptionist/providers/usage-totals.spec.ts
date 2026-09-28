import { ConfigService } from "@nestjs/config";
import { AnthropicProvider } from "./anthropic.provider";
import { createUsageAccumulator } from "./usage-totals";

/**
 * Token usage must count every round-trip of the tool loop.
 *
 * Both Anthropic-shaped providers reported `response.usage` from the LAST
 * response, and the loop reassigns `response`, so every intermediate request
 * was invisible. A two-message production exchange in which the receptionist
 * ran three tools was recorded as 2 calls / 6718 input tokens — the floor, not
 * the total — and that number feeds the cost model and the message-credit
 * wallet.
 *
 * The provider cases below are the ones that would have caught it: the old
 * code reports the final response's 40 input tokens instead of the 2240
 * actually billed.
 */

describe("createUsageAccumulator", () => {
  it("sums each counter independently across responses", () => {
    const usage = createUsageAccumulator();

    usage.add({
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
    });
    usage.add({
      input_tokens: 40,
      output_tokens: 10,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 0,
    });

    expect(usage.totals()).toEqual({
      promptTokens: 1040,
      completionTokens: 60,
      totalTokens: 1100,
      cachedInputTokens: 8,
      cacheWriteTokens: 3,
      requests: 2,
    });
  });

  it("reports zeroes before anything is added", () => {
    expect(createUsageAccumulator().totals()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      requests: 0,
    });
  });

  it("keeps fresh input separate from cached input", () => {
    // The Anthropic API excludes cache reads from input_tokens, and the
    // telemetry downstream relies on that split to compute a hit rate.
    const usage = createUsageAccumulator();
    usage.add({ input_tokens: 100, cache_read_input_tokens: 900 });

    expect(usage.totals().promptTokens).toBe(100);
    expect(usage.totals().cachedInputTokens).toBe(900);
    expect(usage.totals().totalTokens).toBe(100);
  });

  it("counts a response with no usage block as a request", () => {
    // Dropping it would undercount, which is the bug this file exists for.
    const usage = createUsageAccumulator();
    usage.add(undefined);
    usage.add(null);

    expect(usage.totals().requests).toBe(2);
    expect(usage.totals().promptTokens).toBe(0);
  });

  it("treats missing fields as zero rather than NaN", () => {
    const usage = createUsageAccumulator();
    usage.add({ input_tokens: 5 });

    const totals = usage.totals();
    for (const value of Object.values(totals)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(totals.completionTokens).toBe(0);
  });

  it("ignores negative and non-finite values", () => {
    // Usage numbers are billing input; one bad value must not poison the sum.
    const usage = createUsageAccumulator();
    usage.add({ input_tokens: -5, output_tokens: NaN } as any);
    usage.add({ input_tokens: 10, output_tokens: Infinity } as any);

    expect(usage.totals().promptTokens).toBe(10);
    expect(usage.totals().completionTokens).toBe(0);
  });

  it("does not let a later call mutate an earlier snapshot", () => {
    const usage = createUsageAccumulator();
    usage.add({ input_tokens: 10 });
    const first = usage.totals();
    usage.add({ input_tokens: 10 });

    expect(first.promptTokens).toBe(10);
    expect(usage.totals().promptTokens).toBe(20);
  });
});

/**
 * The provider end of it. A two-iteration tool loop bills three requests, and
 * the returned usage has to be the sum of all three.
 */
describe("AnthropicProvider reports usage for the whole tool loop", () => {
  const TOOLS = [{ name: "list_services", input_schema: { type: "object" } }];

  function build(responses: any[]) {
    const config = { get: () => undefined } as unknown as ConfigService;
    const provider = new AnthropicProvider(config);

    const create = jest.fn();
    for (const r of responses) {
      create.mockResolvedValueOnce(r);
    }

    // Stand in for a configured client, and stop generateCompletion from
    // re-initialising it from the (absent) env key.
    (provider as any).anthropic = { messages: { create } };
    (provider as any).initializeClient = (): void => undefined;

    return { provider, create };
  }

  function toolUse(id: string, usage: any) {
    return {
      id: `msg-${id}`,
      content: [{ type: "tool_use", id, name: "list_services", input: {} }],
      usage,
      stop_reason: "tool_use",
    };
  }

  function finalText(usage: any) {
    return {
      id: "msg-final",
      content: [{ type: "text", text: "Tenemos corte y color." }],
      usage,
      stop_reason: "end_turn",
    };
  }

  async function run(responses: any[], maxToolIterations = 5) {
    const { provider, create } = build(responses);
    const completion = await provider.generateCompletion(
      "system prompt",
      [],
      { model: "claude-haiku-4-5", maxTokens: 512, temperature: 0.3 } as any,
      "Que servicios teneis?",
      {
        tools: TOOLS,
        executeTool: async () => ({ services: [] }),
        maxToolIterations,
      },
    );
    return { completion, create };
  }

  it("sums the input tokens of all three requests", async () => {
    const { completion, create } = await run([
      toolUse("t1", { input_tokens: 1000, output_tokens: 20 }),
      toolUse("t2", { input_tokens: 1200, output_tokens: 25 }),
      finalText({ input_tokens: 40, output_tokens: 15 }),
    ]);

    expect(create).toHaveBeenCalledTimes(3);
    // The bug reported 40 — the last response only.
    expect(completion.usage!.promptTokens).toBe(2240);
    expect(completion.usage!.completionTokens).toBe(60);
    expect(completion.usage!.totalTokens).toBe(2300);
  });

  it("sums cache reads and writes across the loop too", async () => {
    const { completion } = await run([
      toolUse("t1", {
        input_tokens: 100,
        output_tokens: 10,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 0,
      }),
      finalText({
        input_tokens: 60,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2000,
      }),
    ]);

    expect((completion.usage as any).cacheWriteTokens).toBe(2000);
    expect((completion.usage as any).cachedInputTokens).toBe(2000);
  });

  it("still reports usage when no tool is called at all", async () => {
    const { completion, create } = await run([
      finalText({ input_tokens: 900, output_tokens: 30 }),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(completion.usage!.promptTokens).toBe(900);
  });

  it("counts what the iteration cap already spent", async () => {
    // The model keeps asking for tools and maxToolIterations stops the loop.
    // Whatever was spent getting there still has to be reported.
    const { provider } = build([]);
    const create = (provider as any).anthropic.messages.create as jest.Mock;
    create.mockResolvedValue(
      toolUse("loop", { input_tokens: 500, output_tokens: 10 }),
    );

    const completion = await provider.generateCompletion(
      "system prompt",
      [],
      { model: "claude-haiku-4-5", maxTokens: 512, temperature: 0.3 } as any,
      "hola",
      {
        tools: TOOLS,
        executeTool: async () => ({}),
        maxToolIterations: 2,
      },
    );

    // 1 initial request + 2 loop iterations.
    expect(create).toHaveBeenCalledTimes(3);
    expect((completion.usage as any).requests).toBe(3);
    expect(completion.usage!.promptTokens).toBe(1500);
  });
});
