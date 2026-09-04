import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProvider, LLMGenerationConfig, LLMCompletion, ChatMessage } from '@kira/shared';
import OpenAI from 'openai';



@Injectable()
export class OpenAIProvider {
  private readonly logger = new Logger(OpenAIProvider.name);
  private openai: OpenAI | null = null;
  // P2A-platform-llm: cache the last env values the client was built
  // with so a hot-reload fires only when something actually changed.
  private lastInitKey: string | null = null;
  private lastInitBaseUrl: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initializeClient();
  }

  private initializeClient(): void {
    const apiKey = this.configService.get('OPENAI_API_KEY');
    const baseUrl = this.configService.get('OPENAI_BASE_URL') || 'https://api.openai.com/v1';

    if (
      apiKey &&
      (apiKey !== this.lastInitKey || baseUrl !== this.lastInitBaseUrl)
    ) {
      this.openai = new OpenAI({ apiKey, baseURL: baseUrl });
      this.lastInitKey = apiKey;
      this.lastInitBaseUrl = baseUrl;
      this.logger.log('OpenAI client initialized successfully');
    } else if (!apiKey && !this.openai) {
      this.logger.warn('OpenAI API key not configured');
    }
  }

  async generateCompletion(
    systemPrompt: string,
    conversationHistory: ChatMessage[],
    config: LLMGenerationConfig,
    currentUserMessage: string,
  ): Promise<LLMCompletion> {
    // P2A-platform-llm: pick up env-injected key changes (admin UI).
    this.initializeClient();
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const startTime = Date.now();

    try {
      const messages = this.buildConversationHistory(
        conversationHistory,
        systemPrompt,
        currentUserMessage,
      );

      const response = await this.openai.chat.completions.create({
        model: config.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
        top_p: config.topP,
        frequency_penalty: config.frequencyPenalty,
        presence_penalty: config.presencePenalty,
      });

      const latency = Date.now() - startTime;
      const completion = response.choices[0].message.content || '';
      const finishReason = response.choices[0].finish_reason ?? undefined;

      return {
        id: response.id,
        text: completion,
        usage: {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        },
        model: config.model,
        provider: LLMProvider.OPENAI,
        timestamp: new Date(),
        latency,
        finishReason,
      };
    } catch (error) {
      this.logger.error('Error generating OpenAI completion:', error);
      throw new Error(`OpenAI API error: ${error.message}`);
    }
  }

  async getAvailableModels(): Promise<any[]> {
    if (!this.openai) {
      return [];
    }

    try {
      const models = await this.openai.models.list();
      return models.data
        .filter((model) => model.id.includes('gpt-'))
        .map((model) => ({
          id: model.id,
          name: model.id,
          provider: LLMProvider.OPENAI,
          contextWindow: this.getModelContextWindow(model.id),
          costPerToken: this.getModelCostPerToken(model.id),
          features: this.getModelFeatures(model.id),
          isEnabled: true,
        }));
    } catch (error) {
      this.logger.error('Error getting OpenAI models:', error);
      return [];
    }
  }

  async testConnection(apiKey: string, model?: string): Promise<any> {
    const testClient = new OpenAI({
      apiKey,
      baseURL: this.configService.get('OPENAI_BASE_URL') || 'https://api.openai.com/v1',
    });

    try {
      const response = await testClient.chat.completions.create({
        model: model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Hello, world!' }],
        max_tokens: 10,
      });

      return {
        success: true,
        message: response.choices[0].message.content,
        model: response.model,
      };
    } catch (error) {
      this.logger.error('OpenAI connection test failed:', error);
      throw new Error(`Connection test failed: ${error.message}`);
    }
  }

  private buildConversationHistory(
    history: ChatMessage[],
    systemPrompt: string,
    currentUserMessage: string,
  ): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

    // System prompt is built upstream in LLMService.buildSystemPrompt
    // using the shared templates (templates.ts). Keeping it here
    // means every provider responds consistently to the same input.
    messages.push({ role: 'system', content: systemPrompt });

    // Add conversation history (skip any stray 'system' entries).
    history.forEach((msg) => {
      if (msg.role !== 'system') {
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    });

    // Add the current user message (the orchestrator's prompt).
    messages.push({ role: 'user', content: currentUserMessage });

    return messages;
  }

  private getModelContextWindow(modelId: string): number {
    if (modelId.includes('gpt-4o-mini')) return 128000;
    if (modelId.includes('gpt-4o')) return 128000;
    if (modelId.includes('gpt-4')) return 8192;
    if (modelId.includes('gpt-3.5')) return 4096;
    return 4096;
  }

  private getModelCostPerToken(modelId: string): number {
    if (modelId.includes('gpt-4o-mini')) return 0.00015;
    if (modelId.includes('gpt-4o')) return 0.005;
    if (modelId.includes('gpt-4')) return 0.03;
    if (modelId.includes('gpt-3.5')) return 0.002;
    return 0.002;
  }

  private getModelFeatures(modelId: string): string[] {
    const features: string[] = [];

    if (modelId.includes('gpt-4o-mini')) features.push('Cheapest OpenAI model', '128k context', 'Fast');
    if (modelId.includes('gpt-4o')) features.push('Vision', 'Audio', 'Code');
    if (modelId.includes('gpt-4')) features.push('Advanced reasoning', 'Code generation');
    if (modelId.includes('gpt-3.5')) features.push('Fast response', 'General purpose');

    return features;
  }
}