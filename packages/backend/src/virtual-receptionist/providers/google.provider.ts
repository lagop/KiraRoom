import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProvider, LLMGenerationConfig, LLMCompletion, ChatMessage } from '@kira/shared';
import { GoogleGenerativeAI } from '@google/generative-ai';

@Injectable()
export class GoogleProvider {
  private readonly logger = new Logger(GoogleProvider.name);
  private genAI: GoogleGenerativeAI | null = null;
  // P2A-platform-llm: cache last env key for hot-reload.
  private lastInitKey: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initializeClient();
  }

  private initializeClient(): void {
    const apiKey = this.configService.get('GOOGLE_API_KEY');

    if (apiKey && apiKey !== this.lastInitKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.lastInitKey = apiKey;
      this.logger.log('Google AI client initialized successfully');
    } else if (!apiKey && !this.genAI) {
      this.logger.warn('Google API key not configured');
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
    if (!this.genAI) {
      throw new Error('Google AI client not initialized');
    }

    const startTime = Date.now();

    try {
      // Gemini takes the system instruction as part of the model
      // config so the SDK only tokenises it once instead of
      // duplicating it on every history item.
      const model = this.genAI.getGenerativeModel({
        model: config.model,
        systemInstruction: {
          role: 'system',
          parts: [{ text: systemPrompt }],
        },
      });
      const generationConfig = {
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
      };

      const messages = this.buildConversationHistory(
        conversationHistory,
        currentUserMessage,
      );

      const result = await model.generateContent({
        contents: messages,
        generationConfig,
      });

      const latency = Date.now() - startTime;
      const completion = result.response.text();
      // Google GenAI exposes the finish reason on the first candidate.
      // 'MAX_TOKENS' means the response was truncated by maxOutputTokens.
      const finishReason =
        (result.response as any)?.candidates?.[0]?.finishReason ??
        (result.response as any)?.candidates?.[0]?.finish_reason ??
        undefined;

      return {
        id: Date.now().toString(),
        text: completion,
        usage: {
          promptTokens: 0, // Not directly available from Google API
          completionTokens: 0,
          totalTokens: 0,
        },
        model: config.model,
        provider: LLMProvider.GOOGLE,
        timestamp: new Date(),
        latency,
        finishReason,
      };
    } catch (error) {
      this.logger.error('Error generating Google AI completion:', error);
      throw new Error(`Google AI API error: ${error.message}`);
    }
  }

  async getAvailableModels(): Promise<any[]> {
    return [
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        provider: LLMProvider.GOOGLE,
        contextWindow: 1048576,
        costPerToken: 0.0001,
        features: ['Fast', 'Cheap', '1M context'],
        isEnabled: true,
      },
      {
        id: 'gemini-1.5-pro',
        name: 'Gemini 1.5 Pro',
        provider: LLMProvider.GOOGLE,
        contextWindow: 2097152,
        costPerToken: 0.00125,
        features: ['High quality', 'Long context'],
        isEnabled: true,
      },
      {
        id: 'gemini-1.5-flash',
        name: 'Gemini 1.5 Flash',
        provider: LLMProvider.GOOGLE,
        contextWindow: 1048576,
        costPerToken: 0.000075,
        features: ['Fastest', 'Cheapest'],
        isEnabled: true,
      },
    ];
  }

  async testConnection(apiKey: string, model?: string): Promise<any> {
    const testClient = new GoogleGenerativeAI(apiKey);
    const testModel = testClient.getGenerativeModel({ model: model || 'gemini-2.0-flash' });

    try {
      const result = await testModel.generateContent('Hello, world!');

      return {
        success: true,
        message: result.response.text(),
        model: (result.response as any).modelVersion ?? model ?? 'gemini-2.0-flash',
      };
    } catch (error) {
      this.logger.error('Google connection test failed:', error);
      throw new Error(`Connection test failed: ${error.message}`);
    }
  }

  private buildConversationHistory(
    history: ChatMessage[],
    currentUserMessage: string,
  ): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
    const messages: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    history.forEach((msg) => {
      if (msg.role !== 'system') {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }],
        });
      }
    });

    messages.push({
      role: 'user',
      parts: [{ text: currentUserMessage }],
    });

    return messages;
  }
}