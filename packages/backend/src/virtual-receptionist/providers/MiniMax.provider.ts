import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProvider, LLMGenerationConfig, LLMCompletion, ChatMessage } from '@kira/shared';
import Anthropic from '@anthropic-ai/sdk';

/**
 * MiniMax (minimax.io) provider.
 *
 * MiniMax exposes an Anthropic-API-compatible endpoint at
 * https://api.minimax.io/anthropic, so we reuse the official
 * @anthropic-ai/sdk pointed at that base URL. The recommended model
 * is "MiniMax-M3" (1M context, multimodal, agentic).
 *
 * Docs: https://platform.minimax.io/docs/api-reference/text-anthropic-api
 */
@Injectable()
export class MiniMaxProvider {
  private readonly logger = new Logger(MiniMaxProvider.name);
  private client: Anthropic | null = null;

  // MiniMax-specific defaults. The model id is the one we want to use
  // but providers can be overridden via LLMProviderConfig.
  private static readonly DEFAULT_MODEL = 'MiniMax-M3';
  private static readonly BASE_URL = 'https://api.minimax.io/anthropic';
  // MiniMax recommended temperature is 1 and top_p defaults to 0.95
  // for M3. The Anthropic SDK rejects temperature outside [0, 2].
  private static readonly DEFAULT_TEMPERATURE = 1;
  private static readonly DEFAULT_TOP_P = 0.95;

  // P2A-platform-llm: remember which env values the client was last
  // built with so we can hot-reload when the admin updates the DB key.
  private lastInitKey: string | null = null;
  private lastInitBaseUrl: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initializeClient();
  }

  /**
   * P2A-platform-llm: re-read process.env and re-init the SDK client
   * if either the API key or the base URL has changed. Cheap (one
   * short-circuit check per call).
   */
  private initializeClient(): void {
    const apiKey = this.configService.get('MINIMAX_API_KEY');
    const baseURL =
      this.configService.get('MINIMAX_BASE_URL') || MiniMaxProvider.BASE_URL;

    if (apiKey && (apiKey !== this.lastInitKey || baseURL !== this.lastInitBaseUrl)) {
      this.client = new Anthropic({ apiKey, baseURL });
      this.lastInitKey = apiKey;
      this.lastInitBaseUrl = baseURL;
      this.logger.log(`MiniMax client initialized (baseURL=${baseURL})`);
    } else if (!apiKey && !this.client) {
      this.logger.warn('MiniMax API key not configured (set MINIMAX_API_KEY in .env or via the admin UI)');
    }
  }

  async generateCompletion(
    systemPrompt: string,
    conversationHistory: ChatMessage[],
    config: LLMGenerationConfig,
    currentUserMessage: string,
    options?: {
      tools?: ReadonlyArray<any>;
      executeTool?: (name: string, input: unknown) => Promise<unknown>;
      /**
       * Hard cap on the number of round-trips when the model emits
       * `tool_use` blocks. Defaults to 5; 0 means "single shot".
       */
      maxToolIterations?: number;
      /**
       * Anthropic tool_choice override. Default `auto` lets the model
       * decide. `'any'` forces at least one tool call (used for
       * intents that must be grounded in DB data, e.g. CHECK_AVAILABILITY).
       */
      toolChoice?: 'auto' | 'any' | { type: 'tool'; name: string };
    },
  ): Promise<LLMCompletion> {
    if (!this.client) {
      throw new Error('MiniMax client not initialized');
    }

    const startTime = Date.now();
    // P2A-platform-llm: pick up any new env-injected key/baseUrl set by
    // PlatformLlmConfigService.onApplicationBootstrap (or by a
    // subsequent admin save via process.env).
    this.initializeClient();
    if (!this.client) throw new Error('MiniMax client not initialized');

    const tools = options?.tools;
    const executeTool = options?.executeTool;
    const maxIter = options?.maxToolIterations ?? 5;
    const toolChoice = options?.toolChoice ?? 'auto';

    try {
      const messages = this.buildConversationHistory(
        conversationHistory,
        currentUserMessage,
      );

      const model = config.model || MiniMaxProvider.DEFAULT_MODEL;
      const temperature = this.clampTemperature(config.temperature);

      // P2A-anthropic-params: newer Anthropic models (Haiku 4.5,
      // Sonnet 4.5, Opus 4.1) reject requests that specify BOTH
      // `temperature` and `top_p` — the API returns 400. We prefer
      // `temperature` and only fall back to `top_p` when the caller
      // didn't set one (and even then we don't send both).
      const useTopP =
        config.temperature === undefined &&
        config.topP !== undefined;

      let response = await this.client.messages.create({
        model,
        system: systemPrompt,
        messages,
        temperature,
        max_tokens: config.maxTokens,
        ...(useTopP
          ? { top_p: config.topP }
          : {}),
        ...(tools && tools.length > 0
          ? { tools: tools as any, tool_choice: this.buildToolChoice(toolChoice) }
          : {}),
      });

      // Tool-execution loop. The model can emit `tool_use` blocks; we
      // run the corresponding DB-backed tool, append `tool_result`
      // blocks to the conversation and ask again until the model
      // returns a final `text` block (or we hit maxIter).
      let iter = 0;
      const executedTools: Array<{ name: string; input: unknown; result: unknown }> = [];
      while (
        executeTool &&
        (response.content ?? []).some((b: any) => b && b.type === 'tool_use') &&
        iter < maxIter
      ) {
        iter++;
        const toolUseBlocks = (response.content ?? []).filter(
          (b: any) => b && b.type === 'tool_use',
        ) as Array<{ id: string; name: string; input: unknown }>;

        // Append the model's tool_use blocks to the conversation so the
        // next request can pair them with our tool_result blocks.
        messages.push({
          role: 'assistant',
          content: toolUseBlocks.map((tu) => ({
            type: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: tu.input,
          })) as any,
        });

        // Execute every tool call in parallel and append tool_result blocks.
        const toolResultBlocks: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];
        for (const tu of toolUseBlocks) {
          try {
            const result = await executeTool(tu.name, tu.input);
            executedTools.push({ name: tu.name, input: tu.input, result });
            // The Anthropic / MiniMax API requires tool_result.content
            // to be a JSON-encoded string, not a raw object. Sending an
            // object produces "invalid tool_result content (2013)".
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(result),
            });
          } catch (err) {
            const e = err as Error;
            const message =
              e?.message ||
              (typeof err === 'string' ? err : null) ||
              (() => {
                try {
                  return JSON.stringify(err);
                } catch {
                  return String(err);
                }
              })();
            this.logger.warn(
              `Tool execution failed name=${tu.name} err=${message} rawType=${typeof err} rawConstructor=${(err as any)?.constructor?.name} stack=${e?.stack?.split('\n').slice(0, 3).join(' | ')}`,
            );
            executedTools.push({
              name: tu.name,
              input: tu.input,
              result: { error: message },
            });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify({ error: message }),
              is_error: true,
            });
          }
        }

        messages.push({
          role: 'user',
          content: toolResultBlocks as any,
        });

        response = await this.client.messages.create({
          model,
          system: systemPrompt,
          messages,
          temperature,
          max_tokens: config.maxTokens,
          ...(useTopP
            ? { top_p: config.topP }
            : {}),
          ...(tools && tools.length > 0
            ? { tools: tools as any, tool_choice: this.buildToolChoice(toolChoice) }
            : {}),
        });
      }

      const latency = Date.now() - startTime;

      // The response may contain a mix of text / thinking / tool_use
      // blocks. For the chatbot we only want the visible text. If the
      // model still ends in a tool_use (e.g. iter cap hit) we use an
      // empty string so the fallback flow takes over.
      const completion = (response.content ?? [])
        .filter((b: any) => b && b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim();

      const stopReason = (response as any).stop_reason ?? undefined;

      // If the model never produced text but did execute tools, build
      // a deterministic fallback from the tool results so the user
      // still gets a useful answer instead of an empty bubble.
      const finalText =
        completion ||
        (executedTools.length > 0 ? this.fallbackFromTools(executedTools) : '');

      return {
        id: response.id,
        text:
          finalText ||
          'I can help you with your beauty salon inquiries.',
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        },
        model,
        provider: LLMProvider.MiniMax,
        timestamp: new Date(),
        latency,
        finishReason: stopReason,
        // Expose the tools that actually ran so the orchestrator / widget
        // can surface them in the debug bubble. Attached as a non-typed
        // extra so existing LLMCompletion consumers don't break.
        ...({ toolsExecuted: executedTools } as any),
      };
    } catch (error) {
      this.logger.error('Error generating MiniMax completion:', error);
      throw new Error(`MiniMax API error: ${error.message}`);
    }
  }

  async getAvailableModels(): Promise<any[]> {
    return [
      {
        id: 'MiniMax-M3',
        name: 'MiniMax M3',
        provider: LLMProvider.MiniMax,
        contextWindow: 1000000,
        costPerToken: 0,
        features: [
          '1M context window',
          'Multimodal (text/image/video)',
          'Agentic reasoning',
          'Tool use',
          'Long-context tasks',
        ],
        isEnabled: true,
      },
      {
        id: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        provider: LLMProvider.MiniMax,
        contextWindow: 204800,
        costPerToken: 0,
        features: ['Recursive self-improvement', '60 tps'],
        isEnabled: true,
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax M2.7 Highspeed',
        provider: LLMProvider.MiniMax,
        contextWindow: 204800,
        costPerToken: 0,
        features: ['Same as M2.7', '100 tps'],
        isEnabled: true,
      },
      {
        id: 'MiniMax-M2',
        name: 'MiniMax M2',
        provider: LLMProvider.MiniMax,
        contextWindow: 204800,
        costPerToken: 0,
        features: ['Agentic capabilities', 'Advanced reasoning'],
        isEnabled: true,
      },
    ];
  }

  async testConnection(apiKey: string, model?: string): Promise<any> {
    const testClient = new Anthropic({
      apiKey,
      baseURL: this.configService.get('MINIMAX_BASE_URL') || MiniMaxProvider.BASE_URL,
    });

    try {
      const response = await testClient.messages.create({
        model: model || MiniMaxProvider.DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'Hello, world!' }],
        max_tokens: 10,
      });

      const textBlock = (response.content ?? []).find(
        (b: any) => b && b.type === 'text' && typeof (b as any).text === 'string',
      ) as any;
      const text = (textBlock?.text as string) ?? '';

      return {
        success: true,
        message: text,
        model: response.model,
      };
    } catch (error) {
      this.logger.error('MiniMax connection test failed:', error);
      throw new Error(`Connection test failed: ${error.message}`);
    }
  }

  private clampTemperature(value: number | undefined): number {
    const t = value ?? MiniMaxProvider.DEFAULT_TEMPERATURE;
    // MiniMax / Anthropic range is [0, 2]. Anything outside gets
    // clamped so a misconfigured tenant doesn't fail every request.
    if (t < 0) return 0;
    if (t > 2) return 2;
    return t;
  }

  private buildConversationHistory(
    history: ChatMessage[],
    currentUserMessage: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    history.forEach((msg) => {
      if (msg.role !== 'system') {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    });

    messages.push({ role: 'user', content: currentUserMessage });

    return messages;
  }

  /**
   * Translate the orchestrator's tool-choice directive into the
   * Anthropic/MiniMax wire format. `auto` lets the model decide; `any`
   * forces at least one tool call; `tool` forces a specific tool.
   */
  private buildToolChoice(
    choice: 'auto' | 'any' | { type: 'tool'; name: string },
  ): { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string } {
    if (choice === 'any') return { type: 'any' };
    if (choice === 'auto') return { type: 'auto' };
    return { type: 'tool', name: choice.name };
  }

  /**
   * Build a minimal, data-grounded fallback message when the model
   * hit `maxToolIterations` without emitting a final text block. We
   * only know how to format a small subset; anything else falls back
   * to a generic acknowledgement.
   */
  private fallbackFromTools(
    executed: Array<{ name: string; input: unknown; result: unknown }>,
  ): string {
    for (const call of executed) {
      if (call.name === 'list_services') {
        const r = call.result as { services?: Array<{ name: string; price: string; currency: string; durationMinutes: number }>; totalMatching?: number };
        const list = r?.services ?? [];
        if (!list.length) {
          return 'No he encontrado servicios que coincidan con tu búsqueda.';
        }
        const lines = list
          .slice(0, 12)
          .map((s) => `• ${s.name} — ${s.price} ${s.currency} (${s.durationMinutes} min)`)
          .join('\n');
        return `Estos son los servicios disponibles:\n${lines}\n¿Cuál te interesa?`;
      }
      if (call.name === 'get_service') {
        const s = call.result as { name?: string; price?: string; currency?: string; durationMinutes?: number };
        if (s?.name) {
          return `${s.name}: ${s.price} ${s.currency} (${s.durationMinutes} min). ¿Quieres reservar?`;
        }
      }
      if (call.name === 'check_availability') {
        const r = call.result as { slots?: string[]; date?: string };
        if (Array.isArray(r?.slots) && r.slots.length > 0) {
          return `Huecos disponibles el ${r.date}: ${r.slots.slice(0, 8).join(', ')}.`;
        }
        return 'No hay huecos disponibles para esa fecha.';
      }
      if (call.name === 'get_salon_info') {
        const t = call.result as { name?: string; street?: string; city?: string; phone?: string };
        if (t?.name) {
          const addr = [t.street, t.city].filter(Boolean).join(', ');
          return `${t.name}${addr ? ` — ${addr}` : ''}${t.phone ? ` — Tel: ${t.phone}` : ''}.`;
        }
      }
      if (call.name === 'list_professionals') {
        const r = call.result as { professionals?: Array<{ fullName: string; position?: string }> };
        const list = r?.professionals ?? [];
        if (list.length > 0) {
          return `Nuestro equipo: ${list.map((p) => `${p.fullName}${p.position ? ` (${p.position})` : ''}`).join(', ')}.`;
        }
      }
    }
    return '';
  }
}
