import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProvider, LLMGenerationConfig, LLMCompletion, ChatMessage } from '@kira/shared';
import Anthropic from '@anthropic-ai/sdk';

@Injectable()
export class AnthropicProvider {
  private readonly logger = new Logger(AnthropicProvider.name);
  private anthropic: Anthropic | null = null;
  // P2A-platform-llm: cache last env key so a hot-reload fires only on change.
  private lastInitKey: string | null = null;
  private lastInitWorkspaceId: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initializeClient();
  }

  private initializeClient(): void {
    const apiKey = this.configService.get('ANTHROPIC_API_KEY');
    // P2A-platform-llm: Anthropic keys created in console.anthropic.com
    // since late 2025 are "identity-linked" — they require an
    // `anthropic-workspace-id` header in addition to the API key,
    // otherwise the API returns 400. The SDK v0.78 doesn't expose this
    // option directly, so we inject it via `defaultHeaders`.
    const workspaceId = this.configService.get('ANTHROPIC_WORKSPACE_ID');

    if (
      apiKey &&
      (apiKey !== this.lastInitKey || workspaceId !== this.lastInitWorkspaceId)
    ) {
      this.anthropic = new Anthropic({
        apiKey,
        ...(workspaceId
          ? { defaultHeaders: { 'anthropic-workspace-id': String(workspaceId) } }
          : {}),
      });
      this.lastInitKey = apiKey;
      this.lastInitWorkspaceId = workspaceId ?? null;
      this.logger.log(
        `Anthropic client initialized${workspaceId ? ' (with workspace header)' : ''}`,
      );
    } else if (!apiKey && !this.anthropic) {
      this.logger.warn('Anthropic API key not configured');
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
      toolChoice?: 'auto' | 'any' | { type: 'tool'; name: string };
    },
  ): Promise<LLMCompletion> {
    // P2A-platform-llm: pick up env-injected key changes (admin UI).
    this.initializeClient();
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    const startTime = Date.now();
    const tools = options?.tools;
    const executeTool = options?.executeTool;
    const maxIter = options?.maxToolIterations ?? 5;

    try {
      const messages = this.buildConversationHistory(
        conversationHistory,
        currentUserMessage,
      );

      // P2A-anthropic-params: newer Anthropic models (Haiku 4.5,
      // Sonnet 4.5, Opus 4.1) reject requests that specify BOTH
      // `temperature` and `top_p` — they return 400. We prefer
      // `temperature` and only fall back to `top_p` when temperature
      // is not provided.
      const useTopP =
        config.temperature === undefined && config.topP !== undefined;
      const temperature = config.temperature;
      const topP = config.topP;

      // Prompt caching. The system prompt is the largest part of the input
      // and is stable per salon, so it is the natural cache prefix: a read
      // costs roughly a tenth of a fresh input token. This only works
      // because the current datetime was moved out of the system prompt and
      // onto the user turn -- while it was in here the prompt differed on
      // every request and nothing could ever be cached.
      //
      // Caching is a prefix match, so anything volatile must stay AFTER
      // this block. Verify with usage.cache_read_input_tokens: if it stays
      // zero across repeated requests, something upstream is invalidating
      // the prefix.
      const cacheableSystem = [
        {
          type: "text" as const,
          text: systemPrompt,
          cache_control: { type: "ephemeral" as const },
        },
      ];
      let response = await this.anthropic.messages.create({
        model: config.model,
        system: cacheableSystem,
        messages,
        max_tokens: config.maxTokens,
        ...(useTopP
          ? { top_p: topP }
          : { temperature }),
        ...(tools && tools.length > 0
          ? { tools: tools as any, tool_choice: { type: 'auto' as const } }
          : {}),
      });

      // Tool-execution loop. The model can emit `tool_use` blocks; we
      // run the corresponding DB-backed tool, append `tool_result`
      // blocks and ask again until the model returns a final `text`
      // block (or we hit `maxIter`).
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

        // Execute every tool call and append tool_result blocks. The
        // Anthropic / MiniMax API requires tool_result.content to be a
        // JSON-encoded string, not a raw object.
        const toolResultBlocks: Array<{
          type: 'tool_result';
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];
        for (const tu of toolUseBlocks) {
          try {
            const result = await executeTool(tu.name, tu.input);
            executedTools.push({ name: tu.name, input: tu.input, result });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(result),
            });
          } catch (err) {
            const e = err as Error;
            const message = e?.message ?? String(err);
            this.logger.warn(
              `Tool execution failed name=${tu.name} err=${message}`,
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

        response = await this.anthropic.messages.create({
          model: config.model,
          system: cacheableSystem,
          messages,
          max_tokens: config.maxTokens,
          ...(useTopP
            ? { top_p: topP }
            : { temperature }),
          ...(tools && tools.length > 0
            ? { tools: tools as any, tool_choice: { type: 'auto' as const } }
            : {}),
        });
      }

      const latency = Date.now() - startTime;
      // Concatenate every text block so multi-block responses render as
      // a single reply.
      const completion = (response.content ?? [])
        .filter((b: any) => b && b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim();

      return {
        id: response.id,
        text:
          completion ||
          'Lo siento, no he podido generar una respuesta. ¿Puedes reformular tu pregunta?',
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          cachedInputTokens: (response.usage as any).cache_read_input_tokens ?? 0,
          cacheWriteTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
        },
        model: config.model,
        provider: LLMProvider.ANTHROPIC,
        timestamp: new Date(),
        latency,
        finishReason: (response as any).stop_reason ?? undefined,
        // P2A-platform-llm: surface the tools the LLM actually ran so
        // the orchestrator can put them in the assistant message and
        // the L-1 harness can verify "did the model call the right
        // tool?".
        ...({ toolsExecuted: executedTools } as any),
      };
    } catch (error) {
      this.logger.error('Error generating Anthropic completion:', error);
      throw new Error(`Anthropic API error: ${(error as Error).message}`);
    }
  }

  async getAvailableModels(): Promise<any[]> {
    return [
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        provider: LLMProvider.ANTHROPIC,
        contextWindow: 200000,
        costPerToken: 0.015,
        features: ['Very high intelligence', 'Complex reasoning', 'Creative generation'],
        isEnabled: true,
      },
      {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        provider: LLMProvider.ANTHROPIC,
        contextWindow: 200000,
        costPerToken: 0.003,
        features: ['Great intelligence', 'Balanced performance', 'Fast responses'],
        isEnabled: true,
      },
      {
        id: 'claude-3-haiku-20240307',
        name: 'Claude 3 Haiku',
        provider: LLMProvider.ANTHROPIC,
        contextWindow: 200000,
        costPerToken: 0.0008,
        features: ['Fastest performance', 'High efficiency', 'Cost-effective'],
        isEnabled: true,
      },
    ];
  }

  async testConnection(apiKey: string, model?: string): Promise<any> {
    const testClient = new Anthropic({ apiKey });

    try {
      const response = await testClient.messages.create({
        model: model || 'claude-3-sonnet-20240229',
        messages: [{ role: 'user', content: 'Hello, world!' }],
        max_tokens: 10,
      });

      return {
        success: true,
        message: response.content[0].type === 'text' ? response.content[0].text : '',
        model: response.model,
      };
    } catch (error) {
      this.logger.error('Anthropic connection test failed:', error);
      throw new Error(`Connection test failed: ${error.message}`);
    }
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
}