import { ConfigService } from "@nestjs/config";
import { AnthropicProvider } from "./anthropic.provider";
import { MiniMaxProvider } from "./MiniMax.provider";

/**
 * The receptionist forces create_appointment when the client says yes to a
 * stored proposal, and propose_appointment before a summary. The forced
 * choice must apply to the first request of the tool loop and only to it.
 *
 * - Anthropic always sent `tool_choice: auto`, so nothing was ever forced: a
 *   replayed chat showed the summary, got "si", and the model answered
 *   without calling create_appointment.
 * - MiniMax sent the forced choice on every round, so the model could never
 *   answer in text and the client got the generic fallback after booking.
 */
const PROVIDERS = [
  {
    name: "Anthropic",
    build: (create: jest.Mock) => {
      const p = new AnthropicProvider({ get: () => undefined } as unknown as ConfigService);
      (p as any).anthropic = { messages: { create } };
      (p as any).initializeClient = (): void => undefined;
      return p;
    },
  },
  {
    name: "MiniMax",
    build: (create: jest.Mock) => {
      const p = new MiniMaxProvider({ get: () => undefined } as unknown as ConfigService);
      (p as any).client = { messages: { create } };
      (p as any).initializeClient = (): void => undefined;
      return p;
    },
  },
];

describe.each(PROVIDERS)("$name provider tool_choice", ({ build }) => {
  const TOOLS = [{ name: "create_appointment", input_schema: { type: "object" } }];
  const usage = { input_tokens: 1, output_tokens: 1 };

  async function run(toolChoice?: any) {
    const create = jest
      .fn()
      .mockResolvedValueOnce({
        id: "m1",
        content: [{ type: "tool_use", id: "t1", name: "create_appointment", input: {} }],
        usage,
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        id: "m2",
        content: [{ type: "text", text: "Reservada." }],
        usage,
        stop_reason: "end_turn",
      });
    const provider = build(create);

    const completion = await provider.generateCompletion(
      "system prompt",
      [],
      { model: "claude-haiku-4-5", maxTokens: 512, temperature: 0.3 } as any,
      "si",
      { tools: TOOLS, executeTool: async () => ({ created: true }), toolChoice },
    );
    return { choices: create.mock.calls.map((c) => c[0].tool_choice), text: completion.text };
  }

  it("forces the named tool on the first request, then lets the model answer", async () => {
    const { choices, text } = await run({ type: "tool", name: "create_appointment" });
    expect(choices).toEqual([{ type: "tool", name: "create_appointment" }, { type: "auto" }]);
    expect(text).toBe("Reservada.");
  });

  it("stays auto when nothing is forced", async () => {
    expect((await run()).choices).toEqual([{ type: "auto" }, { type: "auto" }]);
  });
});
