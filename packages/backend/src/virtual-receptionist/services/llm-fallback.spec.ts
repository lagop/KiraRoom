import { LLMProvider } from "@kira/shared";
import { LLMService } from "./llm.service";

/**
 * When Anthropic failed (it ran out of credit during a test), the request
 * went to the configured fallback, OpenAI, whose provider has no tool
 * support: the receptionist would have kept answering with no access to
 * services, prices or availability, from memory, and unable to book. A
 * request that needs tools now fails instead, and the caller gives its
 * honest error message.
 */
function setup(fallback: string) {
  const calls: string[] = [];
  const provider = (type: string) => ({
    generateCompletion: jest.fn(async () => {
      calls.push(type);
      if (type === LLMProvider.ANTHROPIC) throw new Error("Your credit balance is too low");
      return { id: "r", text: `respuesta de ${type}`, usage: {} };
    }),
  });
  const providerFactory: any = { createProvider: (type: string) => provider(type) };
  const config: any = { get: (key: string) => (key === "LLM_FALLBACK_PROVIDER" ? fallback : undefined) };
  const platform: any = { resolveEffective: async () => ({ provider: LLMProvider.ANTHROPIC, model: "m" }) };
  const stub: any = {};
  const service = new LLMService(providerFactory, config, stub, stub, stub, platform, stub);
  return { service, calls };
}

const TOOLS = [{ name: "list_services", input_schema: { type: "object" } }];

describe("LLMService fallback provider", () => {
  it("does not hand a request that needs tools to a provider without them", async () => {
    const { service, calls } = setup(LLMProvider.OPENAI);

    await expect(
      service.generateResponse("hola", [], undefined, undefined, { tools: TOOLS, systemPromptOverride: "s" }),
    ).rejects.toThrow(/credit balance/);
    expect(calls).toEqual([LLMProvider.ANTHROPIC]);
  });

  it("still falls back to a provider that runs tools", async () => {
    const { service, calls } = setup(LLMProvider.MiniMax);

    const out = await service.generateResponse("hola", [], undefined, undefined, {
      tools: TOOLS,
      systemPromptOverride: "s",
    });

    expect(calls).toEqual([LLMProvider.ANTHROPIC, LLMProvider.MiniMax]);
    expect(out.text).toBe("respuesta de MiniMax");
  });

  it("still falls back for a request without tools", async () => {
    const { service, calls } = setup(LLMProvider.OPENAI);

    await service.generateResponse("hola", [], undefined, undefined, { systemPromptOverride: "s" });

    expect(calls).toEqual([LLMProvider.ANTHROPIC, LLMProvider.OPENAI]);
  });
});
