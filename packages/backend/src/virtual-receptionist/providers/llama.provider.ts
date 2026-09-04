import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProvider, LLMGenerationConfig, LLMCompletion, ChatMessage } from '@kira/shared';

@Injectable()
export class LlamaProvider {
  private readonly logger = new Logger(LlamaProvider.name);

  constructor(private readonly configService: ConfigService) {}

  async generateCompletion(
    systemPrompt: string,
    conversationHistory: ChatMessage[],
    config: LLMGenerationConfig,
    currentUserMessage: string,
  ): Promise<LLMCompletion> {
    const startTime = Date.now();

    try {
      // This is a mock implementation for Llama 2. The system prompt
      // is built upstream by LLMService; here we only inspect the
      // current user message and try to extract the salon name from
      // the system prompt for greetings.
      const latency = Date.now() - startTime;

      const salonNameMatch = /Nombre:\s*([^\n]+)/i.exec(systemPrompt);
      const salonName = salonNameMatch?.[1]?.trim() || 'el salón';

      const message = currentUserMessage.toLowerCase();
      let responseText: string;

      if (message.includes('reserve') || message.includes('book')) {
        responseText = '¡Claro! ¿Qué día y hora te vendrían bien para tu cita?';
      } else if (message.includes('precio') || message.includes('price')) {
        responseText = 'Nuestros precios varían según el servicio. ¿De qué servicio te gustaría información?';
      } else if (message.includes('horario') || message.includes('hours')) {
        responseText = 'Estamos abiertos de lunes a viernes de 9:00 a 18:00, y sábados de 9:00 a 14:00.';
      } else {
        responseText = `¡Hola! Bienvenido a ${salonName}. ¿En qué puedo ayudarte hoy?`;
      }

      return {
        id: Date.now().toString(),
        text: responseText,
        usage: {
          promptTokens:
            (systemPrompt.length + currentUserMessage.length) / 4,
          completionTokens: responseText.length / 4,
          totalTokens:
            (systemPrompt.length +
              currentUserMessage.length +
              responseText.length) /
            4,
        },
        model: config.model,
        provider: LLMProvider.LLAMA,
        timestamp: new Date(),
        latency,
      };
    } catch (error) {
      this.logger.error('Error generating Llama completion:', error);
      throw new Error(`Llama API error: ${error.message}`);
    }
  }

  async getAvailableModels(): Promise<any[]> {
    return [
      {
        id: 'llama-2-70b-chat',
        name: 'Llama 2 70B Chat',
        provider: LLMProvider.LLAMA,
        contextWindow: 4096,
        costPerToken: 0.0001,
        features: ['High performance', 'Cost-effective', 'Customizable'],
        isEnabled: true,
      },
      {
        id: 'llama-2-13b-chat',
        name: 'Llama 2 13B Chat',
        provider: LLMProvider.LLAMA,
        contextWindow: 4096,
        costPerToken: 0.00005,
        features: ['Fast', 'Lightweight'],
        isEnabled: true,
      },
      {
        id: 'llama-2-7b-chat',
        name: 'Llama 2 7B Chat',
        provider: LLMProvider.LLAMA,
        contextWindow: 4096,
        costPerToken: 0.00002,
        features: ['Smallest', 'Cheapest'],
        isEnabled: true,
      },
    ];
  }

  async testConnection(_apiKey: string, model?: string): Promise<any> {
    // Llama 2 runs locally - no real remote connection to test.
    return {
      success: true,
      message: 'Mock Llama provider ready',
      model: model || 'llama-2-70b-chat',
    };
  }
}