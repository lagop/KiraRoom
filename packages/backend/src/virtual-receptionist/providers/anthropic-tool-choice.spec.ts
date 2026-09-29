import { ConfigService } from "@nestjs/config";
import { AnthropicProvider } from "./anthropic.provider";

/**
 * The receptionist forces create_appointment when the client says yes to a
 * stored proposal, and propose_appointment before a summary. The Anthropic
 * provider always sent `tool_choice: auto`, so neither was ever forced: a
 * replayed chat showed the summary, got "si", and the model answered without
 * calling create_appointment.
 */
describe("AnthropicProvider tool_choice", () => {
  const TOOLS = [{ name: "create_appointment", input_schema: { type: "object" } }];
  const usage = { input_tokens: 1, output_tokens: 1 };

  async function run(toolChoice?: any) {
    const provider = new AnthropicProvider({ get: () => undefined } as unknown as ConfigService);
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
    (provider as any).anthropic = { messages: { create } };
    (provider as any).initializeClient = (): void => undefined;

    await provider.generateCompletion(
      "system prompt",
      [],
      { model: "claude-haiku-4-5", maxTokens: 512, temperature: 0.3 } as any,
      "si",
      { tools: TOOLS, executeTool: async () => ({ created: true }), toolChoice },
    );
    return create.mock.calls.map((c) => c[0].tool_choice);
  }

  it("forces the named tool on the first request, then lets the model answer", async () => {
    expect(await run({ type: "tool", name: "create_appointment" })).toEqual([
      { type: "tool", name: "create_appointment" },
      { type: "auto" },
    ]);
  });

  it("stays auto when nothing is forced", async () => {
    expect(await run()).toEqual([{ type: "auto" }, { type: "auto" }]);
  });
});
