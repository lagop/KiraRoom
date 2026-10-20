import { ConfigService } from "@nestjs/config";
import { AnthropicProvider } from "./anthropic.provider";
import {
  isAdaptiveThinkingModel,
  maxTokensFor,
  samplingParams,
  thinkingParams,
  withCacheBreakpoints,
} from "./anthropic-request";

/**
 * Requests that work on Claude Haiku 4.5 (what production runs) and on
 * Claude Haiku 5.5, which costs a tenth per token and caches from 512
 * tokens, but rejects the temperature we sent and needs its thinking blocks
 * back in the tool loop. And prompt-cache breakpoints that a conversation
 * can actually reuse. The SDK is mocked: no request leaves the machine.
 */
describe("model rules", () => {
  it("knows which models think adaptively", () => {
    expect(isAdaptiveThinkingModel("claude-haiku-5-5")).toBe(true);
    expect(isAdaptiveThinkingModel("claude-sonnet-5-5")).toBe(true);
    expect(isAdaptiveThinkingModel("claude-haiku-4-5")).toBe(false);
    expect(isAdaptiveThinkingModel("claude-haiku-4-5-20251001")).toBe(false);
    expect(isAdaptiveThinkingModel(undefined)).toBe(false);
  });

  it("sends no sampling parameters to Haiku 5.5, temperature as before to Haiku 4.5", () => {
    expect(samplingParams("claude-haiku-5-5", 0.7, 1)).toEqual({});
    expect(samplingParams("claude-haiku-4-5", 0.7, 1)).toEqual({ temperature: 0.7 });
    expect(samplingParams("claude-haiku-4-5", undefined, 0.9)).toEqual({ top_p: 0.9 });
  });

  it("asks Haiku 5.5 for low effort by default, honours LLM_EFFORT, never sends it to Haiku 4.5", () => {
    expect(thinkingParams("claude-haiku-5-5", undefined)).toEqual({ output_config: { effort: "low" } });
    expect(thinkingParams("claude-haiku-5-5", "Medium")).toEqual({ output_config: { effort: "medium" } });
    expect(thinkingParams("claude-haiku-5-5", "off")).toEqual({});
    expect(thinkingParams("claude-haiku-5-5", "nonsense")).toEqual({});
    expect(thinkingParams("claude-haiku-4-5", "medium")).toEqual({});
  });

  it("leaves room for thinking in max_tokens on Haiku 5.5 only", () => {
    expect(maxTokensFor("claude-haiku-5-5", 1500)).toBe(4096);
    expect(maxTokensFor("claude-haiku-5-5", 8000)).toBe(8000);
    expect(maxTokensFor("claude-haiku-4-5", 1500)).toBe(1500);
  });
});

describe("withCacheBreakpoints", () => {
  const history = [
    { role: "user" as const, content: "Hola" },
    { role: "assistant" as const, content: "¡Hola! ¿En qué te ayudo?" },
  ];
  const marked = (msgs: any[]) =>
    msgs.flatMap((m, i) =>
      typeof m.content === "string" ? [] : m.content.filter((b: any) => b.cache_control).map(() => i),
    );

  it("marks the end of the stored history and the last message", () => {
    const msgs = [...history, { role: "user" as const, content: "[reloj] quiero cita" }];
    const out = withCacheBreakpoints(msgs, 2);
    expect(marked(out)).toEqual([1, 2]);
    expect(out[1].content).toEqual([{ type: "text", text: "¡Hola! ¿En qué te ayudo?", cache_control: { type: "ephemeral" } }]);
  });

  it("does not touch the caller's messages", () => {
    const msgs = [...history, { role: "user" as const, content: "quiero cita" }];
    withCacheBreakpoints(msgs, 2);
    expect(msgs[1].content).toBe("¡Hola! ¿En qué te ayudo?");
  });

  it("uses a single breakpoint on the first message of a conversation", () => {
    expect(marked(withCacheBreakpoints([{ role: "user", content: "hola" }], 0))).toEqual([0]);
  });

  it("skips thinking blocks and empty text when placing a breakpoint", () => {
    const msgs: any[] = [
      { role: "user", content: "hola" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "check_availability", input: {} },
          { type: "thinking", thinking: "", signature: "s" },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ];
    const out = withCacheBreakpoints(msgs, 0) as any[];
    expect(out[2].content[0].cache_control).toEqual({ type: "ephemeral" });
    const withThinkingLast = withCacheBreakpoints(msgs.slice(0, 2), 0) as any[];
    expect(withThinkingLast[1].content[1].cache_control).toBeUndefined();
    expect(withThinkingLast[1].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(marked(withCacheBreakpoints([{ role: "user", content: "  " }], 0))).toEqual([]);
  });
});

describe("AnthropicProvider requests", () => {
  const TOOLS = [{ name: "check_availability", input_schema: { type: "object" } }];
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  function provider(create: jest.Mock, env: Record<string, string> = {}) {
    const p = new AnthropicProvider({ get: (k: string) => env[k] } as unknown as ConfigService);
    (p as any).anthropic = { messages: { create } };
    (p as any).initializeClient = (): void => undefined;
    return p;
  }

  function toolThenText(thinking = true) {
    return jest
      .fn()
      .mockResolvedValueOnce({
        id: "m1",
        content: [
          ...(thinking ? [{ type: "thinking", thinking: "", signature: "sig-1" }] : []),
          { type: "tool_use", id: "t1", name: "check_availability", input: { date: "2026-10-21" } },
        ],
        usage,
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        id: "m2",
        content: [{ type: "thinking", thinking: "", signature: "sig-2" }, { type: "text", text: "Tengo hueco a las 17:00." }],
        usage,
        stop_reason: "end_turn",
      });
  }

  const history = [
    { role: "user", content: "Hola" },
    { role: "assistant", content: "¡Hola!" },
  ] as any;

  it("on Haiku 5.5: no temperature, low effort, room for thinking, thinking blocks back with the tool result", async () => {
    const create = toolThenText();
    const completion = await provider(create).generateCompletion(
      "system prompt",
      history,
      { model: "claude-haiku-5-5", maxTokens: 1500, temperature: 0.7, topP: 1 } as any,
      "[reloj] ¿hueco mañana?",
      { tools: TOOLS, executeTool: async () => ({ slots: ["17:00"] }) },
    );

    expect(completion.text).toBe("Tengo hueco a las 17:00.");
    for (const [req] of create.mock.calls) {
      expect(req.temperature).toBeUndefined();
      expect(req.top_p).toBeUndefined();
      expect(req.output_config).toEqual({ effort: "low" });
      expect(req.max_tokens).toBe(4096);
    }
    const second = create.mock.calls[1][0];
    const assistantTurn = second.messages[3];
    expect(assistantTurn.role).toBe("assistant");
    expect(assistantTurn.content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig-1" });
    expect(assistantTurn.content[1]).toMatchObject({ type: "tool_use", id: "t1" });
  });

  it("on Haiku 4.5: temperature and max_tokens as configured, no effort", async () => {
    const create = toolThenText(false);
    await provider(create).generateCompletion(
      "system prompt",
      history,
      { model: "claude-haiku-4-5", maxTokens: 1500, temperature: 0.7 } as any,
      "¿hueco mañana?",
      { tools: TOOLS, executeTool: async () => ({}) },
    );
    const [first] = create.mock.calls[0];
    expect(first.temperature).toBe(0.7);
    expect(first.max_tokens).toBe(1500);
    expect(first.output_config).toBeUndefined();
  });

  it("caches the system prompt, the end of the history and the last message, never more than 4 breakpoints", async () => {
    const create = toolThenText();
    await provider(create).generateCompletion(
      "system prompt",
      history,
      { model: "claude-haiku-5-5", maxTokens: 1500 } as any,
      "[reloj] ¿hueco mañana?",
      { tools: TOOLS, executeTool: async () => ({}) },
    );
    for (const [req] of create.mock.calls) {
      const where = req.messages.flatMap((m: any, i: number) =>
        typeof m.content === "string" ? [] : m.content.filter((b: any) => b.cache_control).map(() => i),
      );
      const total = where.length + req.system.filter((b: any) => b.cache_control).length;
      expect(total).toBeLessThanOrEqual(4);
      expect(where[0]).toBe(1); // end of the stored history
      expect(where[where.length - 1]).toBe(req.messages.length - 1);
    }
    // The stored history passed in was not modified.
    expect(history[1].content).toBe("¡Hola!");
  });

  it("answers plainly when the model declines", async () => {
    const create = jest.fn().mockResolvedValueOnce({
      id: "m1",
      content: [{ type: "text", text: "partial" }],
      usage,
      stop_reason: "refusal",
    });
    const completion = await provider(create).generateCompletion(
      "system prompt",
      [],
      { model: "claude-haiku-5-5", maxTokens: 1500 } as any,
      "hola",
      { tools: TOOLS, executeTool: async () => ({}) },
    );
    expect(completion.finishReason).toBe("refusal");
    expect(completion.text).toContain("equipo del salón");
  });
});
