import { VirtualReceptionistService } from './virtual-receptionist.service';
import { ChatIntent, LLMProvider, SendMessageDto } from '@kira/shared';
import { SalonToolsService } from './tools/salon-tools';

/**
 * L-2 integration tests for the orchestrator's tool-passing flow.
 *
 * Strategy: build a `VirtualReceptionistService` instance with all
 * collaborators stubbed except the real `SalonToolsService`. We feed
 * pre-canned `LLMService.generateResponse` responses (text-only or
 * tool-call) and verify that:
 *
 *  - The orchestrator passes `SALON_TOOLS` and an `executeTool`
 *    closure to the LLM service.
 *  - The `executeTool` closure actually runs against the real
 *    `SalonToolsService` against an in-memory Prisma stub.
 *  - The final text from the LLM is what gets returned to the caller.
 *  - The assistant message is persisted to the conversation.
 *  - Tool execution failures are caught and turned into structured
 *    `tool_result` errors so the LLM can self-correct.
 */

function makePrisma(services: any[], professionals: any[], tenant: any = null) {
  return {
    service: {
      findMany: jest.fn().mockImplementation(async ({ where, orderBy, take }: any) => {
        let out = services.filter(
          (s) =>
            (!where?.tenantId || s.tenantId === where.tenantId) &&
            (where?.isActive === undefined || s.isActive === where.isActive) &&
            (!where?.category || s.category === where.category),
        );
        if (typeof take === 'number') out = out.slice(0, take);
        return out;
      }),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
        services.find(
          (s) =>
            s.id === where?.id && s.tenantId === where?.tenantId &&
            (where?.isActive === undefined || s.isActive === where.isActive),
        ) ?? null,
      ),
    },
    professional: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        professionals.filter(
          (p) =>
            (!where?.tenantId || p.tenantId === where.tenantId) &&
            (where?.isActive === undefined || p.isActive === where.isActive),
        ),
      ),
    },
    tenant: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) =>
        where?.id === (tenant?.id ?? 't-1') ? tenant : null,
      ),
    },
  } as any;
}

const TENANT_ID = 't-1';

const SAMPLE_SERVICES = [
  {
    id: 's-cut-w',
    tenantId: TENANT_ID,
    name: 'Corte de Cabello Mujer',
    description: 'Corte y peinado para mujer',
    category: 'HAIR',
    duration: 60,
    price: 45,
    currency: 'EUR',
    isActive: true,
  },
  {
    id: 's-cut-m',
    tenantId: TENANT_ID,
    name: 'Corte de Cabello Hombre',
    description: 'Corte clásico para caballero',
    category: 'HAIR',
    duration: 30,
    price: 18,
    currency: 'EUR',
    isActive: true,
  },
  {
    id: 's-massage',
    tenantId: TENANT_ID,
    name: 'Masaje Relajante',
    description: 'Masaje de 60 minutos',
    category: 'MASSAGE',
    duration: 60,
    price: 55,
    currency: 'EUR',
    isActive: true,
  },
];

const SAMPLE_TENANT = {
  id: TENANT_ID,
  name: 'Kira Studio Test',
  description: null,
  email: 'salon@test.com',
  phone: '+34123456789',
  whatsapp: null,
  street: 'Calle Mayor 1',
  city: 'Madrid',
  state: null,
  postalCode: '28001',
  country: 'ES',
  timezone: 'Europe/Madrid',
  currency: 'EUR',
  openingHours: { open: '09:00', close: '20:00' },
  assistantName: 'Kira',
};

/**
 * Build a fully-stubbed `VirtualReceptionistService`. The only "real"
 * collaborator is `SalonToolsService` — everything else is mocked.
 */
function buildService({
  generateResponse,
  analysisIntent = ChatIntent.OTHER,
  conversationMessages = [],
  fairUse = { allowed: true, reason: 'ok', used: 0, cap: 500, fairUseAction: 'degrade' as const },
}: {
  generateResponse: jest.Mock;
  analysisIntent?: any;
  conversationMessages?: any[];
  fairUse?: any;
}) {
  const prismaStub = makePrisma(SAMPLE_SERVICES, [], SAMPLE_TENANT);
  const appointmentsStub = {
    getAvailableSlots: jest.fn().mockResolvedValue([{ time: '10:00' }]),
  };
  const salonTools = new SalonToolsService(prismaStub, appointmentsStub as any);

  const conversationService = {
    findOrCreateConversation: jest.fn().mockResolvedValue({
      id: 'c-1',
      salonId: TENANT_ID,
      channel: 'web',
      context: {},
      messages: conversationMessages,
    }),
    addMessage: jest.fn().mockResolvedValue(undefined),
    updateConversation: jest.fn().mockResolvedValue(undefined),
  };

  const analysisService = {
    analyzeMessage: jest.fn().mockResolvedValue({
      intent: analysisIntent,
      entities: [],
      keywords: [],
      language: 'es',
    }),
  };

  const llmService = {
    generateResponse: jest.fn().mockImplementation(generateResponse),
  };

  const channelRegistry = {
    send: jest.fn().mockResolvedValue(undefined),
  };

  const svc = new VirtualReceptionistService(
    prismaStub as any,
    llmService as any,
    conversationService as any,
    { findFAQMatch: jest.fn().mockResolvedValue(null) } as any,
    { getCachedAnswer: jest.fn().mockResolvedValue(null), cacheAnswer: jest.fn() } as any,
    { suggest: jest.fn().mockResolvedValue(null) } as any,
    {} as any, // bookingService
    analysisService as any,
    {} as any, // professionalsService
    { get: jest.fn().mockImplementation((k: string) => ({ LLM_TEMPERATURE: '1', LLM_MAX_TOKENS: '1500', LLM_TOP_P: '0.95' }[k])) } as any,
    { evaluate: jest.fn().mockResolvedValue(fairUse), increment: jest.fn().mockResolvedValue(undefined) } as any,
    channelRegistry as any,
    { getContext: jest.fn().mockResolvedValue(null) } as any,
    { resolveEffectiveAiCap: jest.fn().mockReturnValue(500) } as any,
    salonTools,
    appointmentsStub as any,
  );

  return { svc, salonTools, llmService, conversationService, channelRegistry };
}

describe('VirtualReceptionistService orchestrator (L-2)', () => {
  describe('tool wiring', () => {
    it('passes SALON_TOOLS and an executeTool closure to the LLM service', async () => {
      const { svc, llmService } = buildService({
        generateResponse: jest.fn().mockResolvedValue({
          id: 'r-1',
          text: 'Hola, ¿en qué puedo ayudarte?',
          provider: LLMProvider.MiniMax,
          model: 'MiniMax-M3',
          usage: { promptTokens: 5, completionTokens: 8, totalTokens: 13 },
          timestamp: new Date(),
          latency: 10,
          finishReason: 'stop',
        }),
        analysisIntent: ChatIntent.OTHER,
      });

      await svc.sendMessage({
        salonId: TENANT_ID,
        clientId: 'client-anon',
        channel: 'web',
        message: 'hola',
      });

      expect(llmService.generateResponse).toHaveBeenCalledTimes(1);
      const [prompt, history, salonIdArg, , options] = llmService.generateResponse.mock.calls[0];
      expect(prompt).toBeDefined();
      expect(salonIdArg).toBe(TENANT_ID);
      expect(options).toBeDefined();
      expect(Array.isArray(options.tools)).toBe(true);
      expect(options.tools.length).toBe(5);
      expect(options.tools.map((t: any) => t.name).sort()).toEqual([
        'check_availability',
        'get_salon_info',
        'get_service',
        'list_professionals',
        'list_services',
      ]);
      expect(typeof options.executeTool).toBe('function');
      expect(options.maxToolIterations).toBe(5);
    });

    it('executor closure runs the real SalonToolsService against the stubbed Prisma', async () => {
      const { svc, llmService } = buildService({
        generateResponse: jest.fn().mockImplementation(
          async (_p: string, _h: any, _sid: any, _fb: any, opts: any) => {
            // Simulate the LLM calling list_services once and then
            // returning text. The provider normally runs the loop,
            // but here we short-circuit by invoking executeTool
            // ourselves to verify the wiring.
            const result = await opts.executeTool('list_services', {});
            expect((result as any).services.length).toBe(3);
            return {
              id: 'r-1',
              text: 'Aquí tienes el catálogo.',
              provider: LLMProvider.MiniMax,
              model: 'MiniMax-M3',
              usage: { promptTokens: 5, completionTokens: 8, totalTokens: 13 },
              timestamp: new Date(),
              latency: 10,
              finishReason: 'stop',
            };
          },
        ),
        analysisIntent: ChatIntent.OTHER,
      });

      const reply = await svc.sendMessage({
        salonId: TENANT_ID,
        clientId: 'client-anon',
        channel: 'web',
        message: 'Pies',
      });

      expect(reply.content).toBe('Aquí tienes el catálogo.');
      expect(reply.provider).toBe(LLMProvider.MiniMax);
    });

    it('executor returns a structured error envelope when an unknown tool is called', async () => {
      const { svc, llmService } = buildService({
        generateResponse: jest.fn().mockImplementation(
          async (_p: string, _h: any, _sid: any, _fb: any, opts: any) => {
            const result = await opts.executeTool('nope_tool', {});
            expect(result).toEqual({ error: 'unknown_tool:nope_tool' });
            return {
              id: 'r-1',
              text: 'ok',
              provider: LLMProvider.MiniMax,
              model: 'MiniMax-M3',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              timestamp: new Date(),
              latency: 0,
              finishReason: 'stop',
            };
          },
        ),
        analysisIntent: ChatIntent.OTHER,
      });

      await svc.sendMessage({
        salonId: TENANT_ID,
        clientId: 'client-anon',
        channel: 'web',
        message: 'hola',
      });
    });
  });

  describe('persistence + dispatch', () => {
    it('persists the assistant message returned by the LLM', async () => {
      const { svc, conversationService } = buildService({
        generateResponse: jest.fn().mockResolvedValue({
          id: 'r-1',
          text: 'El Corte de Cabello Hombre cuesta 18.00 EUR.',
          provider: LLMProvider.MiniMax,
          model: 'MiniMax-M3',
          usage: { promptTokens: 5, completionTokens: 8, totalTokens: 13 },
          timestamp: new Date(),
          latency: 10,
          finishReason: 'stop',
        }),
        analysisIntent: ChatIntent.SERVICE_INFO,
      });

      const reply = await svc.sendMessage({
        salonId: TENANT_ID,
        clientId: 'client-anon',
        channel: 'web',
        message: 'precio corte de pelo hombre',
      });

      // User message first, assistant message second.
      expect(conversationService.addMessage).toHaveBeenCalledTimes(2);
      expect(conversationService.addMessage.mock.calls[1][1]).toMatchObject({
        role: 'assistant',
        content: 'El Corte de Cabello Hombre cuesta 18.00 EUR.',
        provider: LLMProvider.MiniMax,
      });
      expect(reply.content).toBe('El Corte de Cabello Hombre cuesta 18.00 EUR.');
    });

    it('dispatches the reply through the channel registry', async () => {
      const { svc, channelRegistry } = buildService({
        generateResponse: jest.fn().mockResolvedValue({
          id: 'r-1',
          text: 'Hola, ¿en qué puedo ayudarte?',
          provider: LLMProvider.MiniMax,
          model: 'MiniMax-M3',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          timestamp: new Date(),
          latency: 0,
          finishReason: 'stop',
        }),
        analysisIntent: ChatIntent.OTHER,
      });

      await svc.sendMessage({
        salonId: TENANT_ID,
        clientId: 'client-anon',
        channel: 'web',
        message: 'hola',
      });

      expect(channelRegistry.send).toHaveBeenCalledTimes(1);
      expect(channelRegistry.send.mock.calls[0][0]).toBe(TENANT_ID);
      expect(channelRegistry.send.mock.calls[0][1]).toBe('web');
    });
  });

  describe('fair-use short-circuit', () => {
    it('returns the fair-use fallback without calling the LLM when the cap is exceeded (action=degrade)', async () => {
      const { svc, llmService } = buildService({
        generateResponse: jest.fn(),
        analysisIntent: ChatIntent.OTHER,
        fairUse: {
          allowed: false,
          reason: 'cap_exceeded',
          used: 500,
          cap: 500,
          fairUseAction: 'degrade',
        },
      });

      const reply = await svc.sendMessage({
        salonId: TENANT_ID,
        clientId: 'client-anon',
        channel: 'web',
        message: 'hola',
      });

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      // Fallback contains some explanation and a CTA; we don't pin the
      // exact text because it's locale-driven.
      expect(typeof reply.content).toBe('string');
      expect(reply.content.length).toBeGreaterThan(0);
    });
  });
});