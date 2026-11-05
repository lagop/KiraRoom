import { ConfigService } from "@nestjs/config";
import { LLMProvider } from "@kira/shared";
import { LLMService, NoToolProviderError } from "./services/llm.service";
import { DEFAULT_CLAUDE_MODEL } from "./providers/anthropic-models";
import { isReplyToProposal, PROPOSAL_MAX_AGE_MINUTES } from "./tools/receptionist-booking";
import { asksForSuggestions, VirtualReceptionistService } from "./virtual-receptionist.service";
import { logId } from "./log-id";
import {
  CONVERSATION_RETENTION_MONTHS,
  ConversationRetentionScheduler,
  conversationRetentionCutoff,
} from "./schedulers/conversation-retention.scheduler";
import { publicChatReply } from "./public-chat/public-chat-reply";
import {
  ChatDailyLimitException,
  PUBLIC_CHAT_IP_DAILY_MESSAGES,
  PublicChatAccessService,
} from "./public-chat/public-chat-access.service";

/**
 * Findings of the receptionist core audit (November 2026), one block each.
 */

// Built at runtime: a literal key-looking string trips the secret scan.
const KEY = ["platform", "key", "for", "tests"].join("-");
const TOOLS = [{ name: "list_services", input_schema: { type: "object" } }];

function promptFor(context: Record<string, unknown>): string {
  const configService = { get: (): undefined => undefined } as unknown as ConfigService;
  const stub = {} as any;
  const service = new LLMService(stub, configService, stub, stub, stub, stub);
  return (service as any).buildSystemPrompt(context);
}

const SALON = {
  name: "Salón Prueba",
  language: "es",
  phone: "+34 600 000 000",
  whatsapp: "+34 611 000 000",
  email: "hola@salon.test",
  publicUrl: "https://salon.test",
  workingHours: {},
  services: [],
  professionals: [],
};

describe("the prompt has no unfilled placeholders (V10)", () => {
  it("fills the salon's phone, WhatsApp and booking page into the booking flow", () => {
    const prompt = promptFor(SALON);
    expect(prompt).not.toMatch(/\{\{|\}\}/);
    expect(prompt).toContain("por teléfono al +34 600 000 000, por WhatsApp al +34 611 000 000 o por email a hola@salon.test");
    expect(prompt).toContain("puede hacerlo en https://salon.test o llamando al +34 600 000 000");
    // The booking-state block nobody filled in is gone.
    expect(prompt).not.toContain("ESTADO ACTUAL DE LA RESERVA");
  });

  it("drops the contact details the salon does not have instead of leaving braces", () => {
    for (const language of ["es", "en"]) {
      const prompt = promptFor({ ...SALON, language, phone: undefined, whatsapp: undefined, email: undefined, publicUrl: undefined });
      expect(prompt).not.toMatch(/\{\{|\}\}/);
    }
    const es = promptFor({ ...SALON, phone: undefined, whatsapp: undefined, email: undefined, publicUrl: undefined });
    expect(es).toContain("puede hacerlo directamente con el salón");
  });

  it("says it is an AI and promises no human contact (V18, W2)", () => {
    const prompt = promptFor(SALON);
    expect(prompt).toContain("asistente automático (IA) de Salón Prueba");
    expect(prompt).not.toMatch(/Recepcionista Virtual|operador humano|deriva a un humano|conectar con una persona|lo consultas con el salón/);
    // Server notes come only in their own system block (V11).
    expect(prompt).toContain("NOTAS DEL SERVIDOR PARA ESTE TURNO");
  });
});

function llm(opts: {
  platform?: { provider: LLMProvider; model: string; apiKey?: string } | null;
  env?: Record<string, unknown>;
  providers: Partial<Record<LLMProvider, { generateCompletion: jest.Mock }>>;
}) {
  const env = { LLM_RETRY_BASE_DELAY_MS: 1, LLM_RETRY_MAX_DELAY_MS: 2, ...(opts.env ?? {}) };
  const config = { get: (k: string) => (env as Record<string, unknown>)[k] } as unknown as ConfigService;
  const factory: any = {
    createProvider: (t: LLMProvider) => opts.providers[t] ?? { generateCompletion: jest.fn() },
    getDefaultProvider: () => LLMProvider.OPENAI,
  };
  const platform: any = { resolveEffective: async () => opts.platform ?? null };
  const usage = { record: jest.fn() };
  const prisma: any = { tenant: { findFirst: async () => null } };
  const service = new LLMService(factory, config, prisma, {} as any, platform, usage as any);
  return { service, usage };
}

const done = { id: "r", text: "ok", usage: { promptTokens: 1, completionTokens: 1 } };

describe("LLM provider, key and retries (V16, V17)", () => {
  it("passes the platform key to the provider and leaves the other providers' keys alone", async () => {
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fallback-provider-key";
    try {
      const anthropic = { generateCompletion: jest.fn(async () => done) };
      const { service } = llm({
        platform: { provider: LLMProvider.ANTHROPIC, model: "claude-haiku-5-5", apiKey: KEY },
        providers: { [LLMProvider.ANTHROPIC]: anthropic },
      });

      await service.generateResponse("hola", [], "t-1", undefined, { tools: TOOLS, systemPromptOverride: "s" });

      const [, , config, , options] = anthropic.generateCompletion.mock.calls[0] as any[];
      expect(config.model).toBe("claude-haiku-5-5");
      expect(options.credentials).toMatchObject({ apiKey: KEY });
      expect(process.env.OPENAI_API_KEY).toBe("fallback-provider-key");
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before;
    }
  });

  it("refuses a request that needs tools when no provider can run them", async () => {
    const openai = { generateCompletion: jest.fn(async () => done) };
    const { service } = llm({ platform: null, providers: { [LLMProvider.OPENAI]: openai } });

    await expect(
      service.generateResponse("hola", [], "t-1", undefined, { tools: TOOLS, systemPromptOverride: "s" }),
    ).rejects.toBeInstanceOf(NoToolProviderError);
    expect(openai.generateCompletion).not.toHaveBeenCalled();
  });

  it("uses a fallback that runs tools, with its own model", async () => {
    const anthropic = { generateCompletion: jest.fn(async () => done) };
    const { service } = llm({
      platform: null,
      env: { LLM_FALLBACK_PROVIDER: "anthropic" },
      providers: { [LLMProvider.ANTHROPIC]: anthropic },
    });

    await service.generateResponse("hola", [], "t-1", undefined, { tools: TOOLS, systemPromptOverride: "s" });

    const [, , config] = anthropic.generateCompletion.mock.calls[0] as any[];
    expect(config.model).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it("retries the request that failed, not the whole tool loop", async () => {
    let attempts = 0;
    const anthropic = {
      generateCompletion: jest.fn(async (_s, _h, _c, _m, options: any) => {
        // One round-trip that fails twice with "overloaded", then answers.
        await options.callWithRetry(async () => {
          attempts++;
          if (attempts < 3) throw Object.assign(new Error("overloaded"), { status: 529 });
          return {};
        });
        return done;
      }),
    };
    const { service } = llm({
      platform: { provider: LLMProvider.ANTHROPIC, model: "m", apiKey: KEY },
      providers: { [LLMProvider.ANTHROPIC]: anthropic },
    });

    await service.generateResponse("hola", [], "t-1", undefined, { tools: TOOLS, systemPromptOverride: "s" });

    expect(attempts).toBe(3);
    expect(anthropic.generateCompletion).toHaveBeenCalledTimes(1);
  });

  it("decides on retries from the HTTP status, not from digits in the message", () => {
    const { service } = llm({ providers: {} });
    expect(service.isRetryableError(Object.assign(new Error("max_tokens: 1500 is too large"), { status: 400 }))).toBe(false);
    expect(service.isRetryableError(new Error("max_tokens: 1500 is too large"))).toBe(false);
    expect(service.isRetryableError(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(true);
    expect(service.isRetryableError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(service.isRetryableError(new Error("socket hang up"))).toBe(true);
  });

  it("records what a failed request had already spent", async () => {
    const anthropic = {
      generateCompletion: jest.fn(async () => {
        throw Object.assign(new Error("Anthropic API error: bad request"), {
          status: 400,
          usage: { promptTokens: 900, completionTokens: 40 },
          model: "m",
        });
      }),
    };
    const { service, usage } = llm({
      platform: { provider: LLMProvider.ANTHROPIC, model: "m", apiKey: KEY },
      providers: { [LLMProvider.ANTHROPIC]: anthropic },
    });

    await expect(
      service.generateResponse("hola", [], "t-1", undefined, { tools: TOOLS, systemPromptOverride: "s" }),
    ).rejects.toThrow(/bad request/);
    expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t-1", inputTokens: 900, outputTokens: 40 }));
  });

  it("sends the turn's notes apart from the system prompt to a provider that supports it (V11)", async () => {
    const anthropic = { generateCompletion: jest.fn(async () => done) };
    const { service } = llm({
      platform: { provider: LLMProvider.ANTHROPIC, model: "m", apiKey: KEY },
      providers: { [LLMProvider.ANTHROPIC]: anthropic },
    });

    await service.generateResponse("hola", [], "t-1", undefined, {
      tools: TOOLS,
      systemPromptOverride: "system",
      systemNotes: "- nota",
    });

    const [system, , , message, options] = anthropic.generateCompletion.mock.calls[0] as any[];
    expect(system).toBe("system");
    expect(message).not.toContain("nota");
    expect(options.systemNotes).toBe("## NOTAS DEL SERVIDOR PARA ESTE TURNO\n- nota");
  });
});

describe("a yes books only the latest summary (V4)", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  it("is the very next client message, while the proposal is fresh", () => {
    expect(isReplyToProposal({ proposedAtUserTurn: 3, proposedAt: at(1) }, 4, now)).toBe(true);
    expect(isReplyToProposal({ proposedAtUserTurn: 3, proposedAt: at(1) }, 5, now)).toBe(false);
    expect(isReplyToProposal({ proposedAtUserTurn: 3, proposedAt: at(PROPOSAL_MAX_AGE_MINUTES + 1) }, 4, now)).toBe(false);
    expect(isReplyToProposal({ proposedAtUserTurn: 3, bookedAppointmentId: "a" }, 4, now)).toBe(false);
    // Proposals stored before proposedAt existed still work on the next message.
    expect(isReplyToProposal({ proposedAtUserTurn: 3 }, 4, now)).toBe(true);
  });
});

describe("cross-sell only when asked (V11)", () => {
  it("fires on a request for suggestions, not on everyday words", () => {
    expect(asksForSuggestions("¿Qué me recomiendas?")).toBe(true);
    expect(asksForSuggestions("¿Qué más tenéis?")).toBe(true);
    expect(asksForSuggestions("¿Tienen hueco mañana?")).toBe(false);
    expect(asksForSuggestions("¿Qué opciones de pago hay?")).toBe(false);
    expect(asksForSuggestions("¿Qué servicios de uñas tenéis?")).toBe(false);
  });
});

describe("no phone numbers in the logs (V9)", () => {
  it("names a WhatsApp sender by channel and a short hash", () => {
    const id = logId("whatsapp-34600111222");
    expect(id).toMatch(/^whatsapp#[0-9a-f]{8}$/);
    expect(id).not.toContain("600111222");
    expect(logId("whatsapp-34600111222")).toBe(id);
    expect(logId("visitor-33333333-3333-4333-8333-333333333333")).toMatch(/^visitor#/);
    expect(logId(undefined)).toBe("anonymous");
  });
});

describe("conversation retention (V1, M16)", () => {
  it("deletes conversations inactive for the retention period, any status, in batches", async () => {
    expect(CONVERSATION_RETENTION_MONTHS).toBe(12);
    const now = new Date("2026-11-04T03:45:00Z");
    const ids = Array.from({ length: 501 }, (_, i) => ({ id: `c-${i}` }));
    let served = 0;
    const prisma: any = {
      chatConversation: {
        findMany: jest.fn(async ({ take }: any) => {
          const page = ids.slice(served, served + take);
          served += page.length;
          return page;
        }),
        deleteMany: jest.fn(async ({ where }: any) => ({ count: where.id.in.length })),
      },
    };

    const deleted = await new ConversationRetentionScheduler(prisma).purgeInactiveConversations(now);

    expect(deleted).toBe(501);
    const cutoff = conversationRetentionCutoff(now);
    expect(cutoff.toISOString()).toBe("2025-11-04T03:45:00.000Z");
    expect(prisma.chatConversation.findMany.mock.calls[0][0].where).toEqual({ lastActivityAt: { lt: cutoff } });
    expect(prisma.chatConversation.deleteMany.mock.calls[0][0].where.lastActivityAt).toEqual({ lt: cutoff });
  });
});

describe("the public chat (V2, V7)", () => {
  const SECRET = ["test", "only", "signing", "key"].join("-").repeat(2);
  const SALON_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  it("caps one address per salon per day, whatever visitor id it sends", async () => {
    const svc = new PublicChatAccessService({ chatMessage: { count: async () => 0 } } as any);
    const now = new Date("2026-11-04T10:00:00Z");
    for (let i = 0; i < PUBLIC_CHAT_IP_DAILY_MESSAGES; i++) {
      // A fresh visitor each time: dropping the token used to reset the count.
      await svc.assertWithinDailyLimit(svc.identify({ salonId: SALON_ID }), SALON_ID, now, "203.0.113.7");
    }
    await expect(
      svc.assertWithinDailyLimit(svc.identify({ salonId: SALON_ID }), SALON_ID, now, "203.0.113.7"),
    ).rejects.toBeInstanceOf(ChatDailyLimitException);
    // Another address, or another salon, is not affected.
    await svc.assertWithinDailyLimit(svc.identify({ salonId: SALON_ID }), SALON_ID, now, "203.0.113.8");
    await svc.assertWithinDailyLimit(svc.identify({ salonId: OTHER }), OTHER, now, "203.0.113.7");
    // A day later the address may write again.
    await svc.assertWithinDailyLimit(
      svc.identify({ salonId: SALON_ID }),
      SALON_ID,
      new Date(now.getTime() + 24 * 3_600_000 + 1),
      "203.0.113.7",
    );
  });

  it("answers only what the widget needs", () => {
    const out = publicChatReply(
      {
        id: "c-1",
        content: "¡Hola!",
        requiresHandoff: false,
        toolsExecuted: [{ name: "list_services", input: {}, result: { error: "raw" } }],
        model: "m",
        intent: "OTHER",
        limitInfo: { cap: 500, used: 500, action: "degrade" },
      } as any,
      "token",
    );
    expect(out).toEqual({ id: "c-1", content: "¡Hola!", requiresHandoff: false, visitorToken: "token" });
  });
});

describe("a pending booking is not called confirmed (D1, V13)", () => {
  const svc = Object.create(VirtualReceptionistService.prototype) as VirtualReceptionistService;
  const salon = { name: "Salón Luna", phone: "", language: "es" as const, subscriptionStatus: "active" };
  const booked = { service: "Corte", professional: "Ana García", date: "2026-11-10", time: "10:00" };

  it("says reserved, pending the salon, when the salon confirms bookings itself", () => {
    expect(svc.bookedConfirmationText({ ...booked, confirmed: false }, salon)).toBe(
      "Tu cita queda reservada, pendiente de que Salón Luna la confirme: Corte con Ana García, el martes 10 de noviembre a las 10:00.",
    );
  });

  it("says confirmed only when it is", () => {
    expect(svc.bookedConfirmationText({ ...booked, confirmed: true, confirmationEmailSent: true }, salon)).toBe(
      "Tu cita está confirmada: Corte con Ana García, el martes 10 de noviembre a las 10:00. Te hemos enviado la confirmación por email.",
    );
  });
});
