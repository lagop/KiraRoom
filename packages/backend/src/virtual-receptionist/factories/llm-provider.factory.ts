import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProvider } from '@kira/shared';
import { OpenAIProvider } from '../providers/openai.provider';
import { AnthropicProvider } from '../providers/anthropic.provider';
import { GoogleProvider } from '../providers/google.provider';
import { LlamaProvider } from '../providers/llama.provider';
import { MiniMaxProvider } from '../providers/MiniMax.provider';

@Injectable()
export class LLMProviderFactory {
  private readonly logger = new Logger(LLMProviderFactory.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly openAIProvider: OpenAIProvider,
    private readonly anthropicProvider: AnthropicProvider,
    private readonly googleProvider: GoogleProvider,
    private readonly llamaProvider: LlamaProvider,
    private readonly MiniMaxProvider: MiniMaxProvider,
  ) {}

  /**
   * Create LLM provider instance based on provider type
   */
  createProvider(providerType: LLMProvider) {
    this.logger.log(`Creating LLM provider instance: ${providerType}`);

    switch (providerType) {
      case LLMProvider.OPENAI:
        return this.openAIProvider;
      case LLMProvider.ANTHROPIC:
        return this.anthropicProvider;
      case LLMProvider.GOOGLE:
        return this.googleProvider;
      case LLMProvider.LLAMA:
        return this.llamaProvider;
      case LLMProvider.MiniMax:
        return this.MiniMaxProvider;
      default:
        this.logger.warn(`Unknown provider type: ${providerType}, defaulting to OpenAI`);
        return this.openAIProvider;
    }
  }

  /**
   * Get available providers
   */
  getAvailableProviders(): LLMProvider[] {
    return [
      LLMProvider.OPENAI,
      LLMProvider.ANTHROPIC,
      LLMProvider.GOOGLE,
      LLMProvider.LLAMA,
      LLMProvider.MiniMax,
    ];
  }

  /**
   * Get default provider from configuration
   */
  getDefaultProvider(): LLMProvider {
    const defaultProvider = this.configService.get<string>('DEFAULT_LLM_PROVIDER');
     const provider = Object.values(LLMProvider).find(
      (p) => String(p).toLowerCase() === defaultProvider?.toLowerCase(),
    );

    return provider || LLMProvider.OPENAI;
  }

  /**
   * Check if provider is configured and available
   */
  isProviderAvailable(providerType: LLMProvider): boolean {
    switch (providerType) {
      case LLMProvider.OPENAI:
        return !!this.configService.get('OPENAI_API_KEY');
      case LLMProvider.ANTHROPIC:
        return !!this.configService.get('ANTHROPIC_API_KEY');
      case LLMProvider.GOOGLE:
        return !!this.configService.get('GOOGLE_API_KEY');
      case LLMProvider.LLAMA:
        return !!this.configService.get('LLAMA_API_KEY');
      case LLMProvider.MiniMax:
        return !!this.configService.get('MINIMAX_API_KEY');
      default:
        return false;
    }
  }
}