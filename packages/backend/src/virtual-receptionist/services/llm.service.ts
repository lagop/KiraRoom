import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMProviderFactory } from '../factories/llm-provider.factory';
import { PlatformLlmConfigService } from '../../platform/platform-llm-config.service';
import { LLMProvider, LLMGenerationConfig, LLMCompletion } from '@kira/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FAQService } from './faq.service';
import { FeatureFlagService } from '../../common/feature-flags/feature-flag.service';
import { LlmUsageService } from '../../common/telemetry/llm-usage.service';
import {
  getSystemPrompt,
  getDynamicContext,
  getBookingFlowPrompt,
  getEscalationPrompt,
  getIntentClassifierPrompt,
} from '../prompts/templates';

/**
 * Render a workingHours map as a short human-readable line list
 * for inclusion in the system prompt. Days are localised so the LLM
 * reads them naturally in the salon's primary language.
 */
function formatWorkingHours(
  hours: Record<string, { start: string; end: string }>,
  language: string,
): string {
  if (!hours || Object.keys(hours).length === 0) {
    return 'Not available';
  }
  const dayLabelsES = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
  const dayLabelsEN = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const labels = language === 'en' ? dayLabelsEN : dayLabelsES;
  const order = language === 'en'
    ? ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
    : ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
  return order
    .map((key) => {
      const h = hours[key] ?? hours[key.toLowerCase()];
      if (!h) return null;
      const idx = language === 'en'
        ? ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].indexOf(key)
        : ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'].indexOf(key);
      const label = labels[idx] ?? key;
      return `- ${label}: ${h.start}–${h.end}`;
    })
    .filter(Boolean)
    .join('\\n');
}

// Retry configuration interface
interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// Error types that are retryable
const RETRYABLE_ERROR_CODES = [
  '503', // Service Unavailable
  '429', // Too Many Requests / Rate Limit
  '500', // Internal Server Error
  '502', // Bad Gateway
  '504', // Gateway Timeout
];

const RETRYABLE_ERROR_MESSAGES = [
  'Service Unavailable',
  'high demand',
  'rate limit',
  'too many requests',
  'temporarily unavailable',
  'timeout',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
];

interface SalonContext {
  name: string;
  assistantName?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  timezone?: string;
  language?: string;
  cancellationPolicy?: string;
  minCancelHours?: number;
  openingHours?: Record<string, { start: string; end: string }>;
  // Populated by FAQService (in-memory default set today). Capped
  // in buildSystemPrompt() to keep the prompt under ~2k tokens.
  faqs?: Array<{ question: string; answer: string }>;
  services: Array<{ name: string; duration: number; price: number; category: string }>;
  professionals: Array<{ firstName: string; lastName: string; position?: string; specialties: string[] }>;
  workingHours: Record<string, { start: string; end: string }>;
  // P2A-receptionist-advanced -- persona settings (voice, tone,
  // signature phrases). The base system prompt already gives a default
  // voice; when `virtual_receptionist_advanced` is unlocked AND a
  // persona is configured here, the buildSystemPrompt() override
  // appends a localized tone block.
  persona?: {
    voice?: string;
    tone?: 'friendly' | 'formal' | 'playful' | 'concise';
    signature?: string;
    localeAdaptations?: string;
  };
}

@Injectable()
export class LLMService {
  private readonly logger = new Logger(LLMService.name);
  private readonly retryConfig: RetryConfig;

  constructor(
    private readonly providerFactory: LLMProviderFactory,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly faqService: FAQService,
    private readonly flags: FeatureFlagService,
    private readonly platformLlmConfig: PlatformLlmConfigService,
    private readonly llmUsage: LlmUsageService,
  ) {
    // Initialize retry configuration from environment
    this.retryConfig = {
      maxRetries: this.configService.get<number>('LLM_MAX_RETRIES') || 3,
      baseDelayMs: this.configService.get<number>('LLM_RETRY_BASE_DELAY_MS') || 1000,
      maxDelayMs: this.configService.get<number>('LLM_RETRY_MAX_DELAY_MS') || 10000,
    };
  }

  /**
   * Convert a ConfigService value (string from env, number from override,
   * or undefined) to a finite number, falling back to `fallback` when the
   * value is missing or NaN. The Anthropic / MiniMax SDK rejects numeric
   * params sent as strings, so every env-driven numeric field must pass
   * through here.
   */
  private coerceNumber(value: unknown, fallback: number): number {
    if (value === null || value === undefined || value === '') return fallback;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

/**
   * Generate response using configured LLM provider with retry logic.
   *
   * `tools` + `executeTool` enable tool-calling: every time the model
   * emits a `tool_use` block, `executeTool` is invoked and the result is
   * appended to the conversation as a `tool_result` block until the model
   * produces a final text reply. Pass neither to keep the legacy single-
   * shot behaviour.
   */
  async generateResponse(
    prompt: string,
    conversationHistory: any[],
    salonId?: string,
    fallbackProviderType?: LLMProvider,
    options?: {
      tools?: ReadonlyArray<any>;
      executeTool?: (name: string, input: unknown) => Promise<unknown>;
      maxToolIterations?: number;
      /**
       * Anthropic tool_choice override. Pass `'any'` to force at
       * least one tool call, or `{ type: 'tool', name: 'foo' }` to
       * force a specific tool. Use this for intents that MUST be
       * grounded in DB data (e.g. CHECK_AVAILABILITY) where allowing
       * the model to "answer from memory" produces hallucinations.
       */
      toolChoice?: 'auto' | 'any' | { type: 'tool'; name: string };
      /**
       * P2A-staff-copilot-sprint16: when set, this string replaces
       * the default customer-chatbot prompt. Used by the staff
       * copilot to keep the model from impersonating the customer
       * receptionist (`¡Hola! Soy Kira, puedo ayudarte con…`).
       */
      systemPromptOverride?: string;
    },
  ): Promise<LLMCompletion> {
    const providerType =
      fallbackProviderType || (await this.getProviderForSalon(salonId));
    const provider = this.providerFactory.createProvider(providerType);

    this.logger.log(`Generating response with ${providerType} for salon ${salonId}`);

    const config: LLMGenerationConfig = {
      model: await this.getModelForSalon(salonId),
      // ConfigService.get() returns env vars as strings. The Anthropic
      // / MiniMax SDK requires numeric fields to be actual numbers,
      // so coerce here. Sending "1" / "1500" / "0.95" as strings
      // makes MiniMax reject the request with "invalid params".
      temperature: this.coerceNumber(this.configService.get('LLM_TEMPERATURE'), 0.7),
      // 500 was too low -- with the system prompt + service catalog
      // the model would hit the cap mid-word ("Corte de Cab...").
      // 1500 comfortably fits a full reply with the price list.
      maxTokens: this.coerceNumber(this.configService.get('LLM_MAX_TOKENS'), 1500),
      topP: this.coerceNumber(this.configService.get('LLM_TOP_P'), 1),
      frequencyPenalty: this.coerceNumber(this.configService.get('LLM_FREQUENCY_PENALTY'), 0),
      presencePenalty: this.coerceNumber(this.configService.get('LLM_PRESENCE_PENALTY'), 0),
    };

    // Fetch salon context for personalized responses
    const salonContext = salonId ? await this.getSalonContext(salonId) : null;
    const systemPrompt = options?.systemPromptOverride ?? this.buildSystemPrompt(salonContext);

    const startTime = Date.now();

    // The current date and time used to live inside the system prompt, which
    // made that prompt byte-different on every single request and meant
    // provider-side prompt caching could never hit -- the system prompt is
    // otherwise stable per salon and is the largest part of the input. It now
    // rides on the user turn instead: same information for the model, full
    // precision, cacheable prefix. Sent, not persisted, so the stored
    // conversation stays clean.
    const promptWithClock = `[${new Date().toISOString()}]\n${prompt}`;

    try {
      // Try with retry logic for transient errors
      const completion = await this.executeWithRetry(
        () =>
          provider.generateCompletion(systemPrompt, conversationHistory, config, promptWithClock, {
            tools: options?.tools,
            executeTool: options?.executeTool,
            maxToolIterations: options?.maxToolIterations ?? 5,
            toolChoice: options?.toolChoice,
          }),
        providerType,
      );

      const latency = Date.now() - startTime;

      this.logger.log(
        `Generated response with ${providerType} in ${latency}ms` +
          (completion.finishReason
            ? ` (finishReason=${completion.finishReason})`
            : '') +
          ((completion as any).toolsExecuted
            ? ` tools=${((completion as any).toolsExecuted as unknown[]).length}`
            : ''),
      );

      // Surface truncation in the logs so the issue is visible even
      // when the user only sees a half-finished reply in the chat.
      if (completion.finishReason === 'length' || completion.finishReason === 'MAX_TOKENS') {
        this.logger.warn(
          `LLM response truncated by maxTokens for salon ${salonId} (provider=${providerType}, model=${completion.model}). ` +
            `Increase LLM_MAX_TOKENS or shorten the system prompt.`,
        );
      }

      // Cost attribution. Without this the only measure of LLM spend is a
      // count of answered messages, which says nothing about cost: that
      // depends on context length and on how much of it the prompt cache
      // served. Fire-and-forget on purpose.
      if (salonId && completion.usage) {
        const u = completion.usage as {
          promptTokens?: number;
          completionTokens?: number;
          cachedInputTokens?: number;
          cacheWriteTokens?: number;
        };
        this.llmUsage.record({
          tenantId: salonId,
          provider: String(providerType),
          model: completion.model ?? config.model,
          inputTokens: u.promptTokens ?? 0,
          outputTokens: u.completionTokens ?? 0,
          cachedInputTokens: u.cachedInputTokens ?? 0,
          cacheWriteTokens: u.cacheWriteTokens ?? 0,
        });

        // Cache effectiveness is the one number that tells you whether the
        // prefix is still stable. A run of zeroes means something started
        // varying inside the system prompt again.
        const cached = u.cachedInputTokens ?? 0;
        const fresh = u.promptTokens ?? 0;
        if (cached + fresh > 0) {
          this.logger.debug(
            `prompt cache: ${cached}/${cached + fresh} input tokens served from cache ` +
              `(salon ${salonId}, model ${completion.model ?? config.model})`,
          );
        }
      }

      return {
        ...completion,
        provider: providerType,
        latency,
      };
    } catch (error) {
      this.logger.error(`Error generating response with ${providerType}:`, error);

      // Try fallback provider if primary fails
      const fallbackProviderType = this.getFallbackProvider();
      if (fallbackProviderType && fallbackProviderType !== providerType) {
        this.logger.warn(`Falling back to ${fallbackProviderType} provider`);
        return this.generateResponse(prompt, conversationHistory, salonId, fallbackProviderType, options);
      }

      throw error;
    }
  }

  /**
   * Execute a function with exponential backoff retry logic
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    providerType: string,
    attempt: number = 0,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const isRetryable = this.isRetryableError(error);
      const shouldRetry = isRetryable && attempt < this.retryConfig.maxRetries;

      if (shouldRetry) {
        // Calculate exponential backoff delay with jitter
        const delay = this.calculateBackoffDelay(attempt);
        
        this.logger.warn(
          `[${providerType}] Retryable error (attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1}). ` +
          `Retrying in ${delay}ms. Error: ${error.message}`,
        );

        // Wait before retrying
        await this.sleep(delay);

        // Retry with incremented attempt counter
        return this.executeWithRetry(fn, providerType, attempt + 1);
      }

      // No more retries or non-retryable error
      if (isRetryable) {
        this.logger.error(
          `[${providerType}] Max retries (${this.retryConfig.maxRetries}) exceeded. Giving up.`,
        );
      }

      throw error;
    }
  }

  /**
   * Check if an error is retryable based on error code or message
   */
  private isRetryableError(error: any): boolean {
    const errorMessage = error.message?.toLowerCase() || '';
    const errorCode = error.code || '';

    // Check for retryable HTTP status codes in the error
    for (const code of RETRYABLE_ERROR_CODES) {
      if (errorMessage.includes(code) || errorCode.includes(code)) {
        return true;
      }
    }

    // Check for retryable error messages
    for (const msg of RETRYABLE_ERROR_MESSAGES) {
      if (errorMessage.includes(msg.toLowerCase())) {
        return true;
      }
    }

    // Check for specific Google AI error patterns
    if (errorMessage.includes('generativelanguage.googleapis.com') || 
        errorMessage.includes('googlegenerativeai')) {
      // Retry on any Google API error that mentions availability or demand
      if (errorMessage.includes('503') || 
          errorMessage.includes('unavailable') || 
          errorMessage.includes('high demand')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateBackoffDelay(attempt: number): number {
    // Exponential backoff: baseDelay * 2^attempt
    const exponentialDelay = this.retryConfig.baseDelayMs * Math.pow(2, attempt);
    
    // Add jitter (random factor between 0 and 1)
    const jitter = Math.random() * 0.3 * exponentialDelay;
    
    // Cap at max delay
    const delay = Math.min(exponentialDelay + jitter, this.retryConfig.maxDelayMs);
    
    return Math.floor(delay);
  }

  /**
   * Sleep for a specified number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Fetch salon context from database
   */
  private async getSalonContext(salonId: string): Promise<SalonContext | null> {
    try {
      // Try to find tenant by id, slug, or name
      // Also try normalized versions (add/remove hyphens)
      const normalizedSalonId = salonId.replace(/-/g, '');
      const withHyphen = salonId.includes('-') ? salonId : salonId.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
      
      const tenant = await this.prisma.tenant.findFirst({
        where: {
          OR: [
            { id: salonId },
            { slug: salonId },
            { name: { contains: salonId, mode: 'insensitive' } },
            // Try normalized versions (add/remove hyphens)
            { slug: withHyphen },
            { slug: { contains: normalizedSalonId, mode: 'insensitive' } },
          ],
        },
        include: {
          services: {
            where: { isActive: true },
            select: {
              name: true,
              duration: true,
              price: true,
              category: true,
            },
          },
          professionals: {
            where: { isActive: true },
            select: {
              firstName: true,
              lastName: true,
              position: true,
              specialties: true,
            },
          },
        },
      });

      if (!tenant) {
        this.logger.warn(`Tenant not found for salonId: ${salonId}`);
        return null;
      }

      return {
        name: tenant.name,
        email: tenant.email || undefined,
        phone: tenant.phone || undefined,
        whatsapp: tenant.whatsapp || undefined,
        address: tenant.street || undefined,
        city: tenant.city || undefined,
        state: tenant.state || undefined,
        country: tenant.country || undefined,
        timezone: tenant.timezone || undefined,
        language: tenant.language || 'es',
        // @ts-ignore - New fields from migration
        assistantName: (tenant as any).assistantName || 'Kira',
        // @ts-ignore - New fields from migration
        cancellationPolicy: (tenant as any).cancellationPolicy || undefined,
        // @ts-ignore - New fields from migration
        minCancelHours: (tenant as any).minCancelHours || 24,
        // @ts-ignore - New fields from migration
        openingHours: (tenant as any).openingHours || undefined,
        // P2A-receptionist-advanced -- persona is gated on the advanced
        // feature. The base system prompt already gives Kira a default
        // voice; only when the tenant has advanced unlocked AND a
        // persona is configured do we lift to the personalised voice.
        persona: (await this.flags.isFeatureUnlocked(
          tenant.id,
          'virtual_receptionist_advanced',
        ))
          ? ((): SalonContext['persona'] => {
              const f = (tenant as any).features as
                | { persona?: SalonContext['persona'] }
                | undefined;
              return f?.persona ?? undefined;
            })()
          : undefined,
        services: tenant.services.map(s => ({
          name: s.name,
          duration: s.duration,
          price: Number(s.price),
          category: s.category,
        })),
        professionals: tenant.professionals.map(p => ({
          firstName: p.firstName,
          lastName: p.lastName,
          position: p.position || undefined,
          specialties: p.specialties as string[],
        })),
        // FAQs are currently in-memory (FAQService seeds a default set).
        // Once they move to Prisma, query them in the same transaction.
        faqs: (await this.faqService
          .getFAQs(tenant.id)
          .catch(() => [])) as Array<{ question: string; answer: string }>,
        workingHours: {
          monday: { start: '09:00', end: '18:00' },
          tuesday: { start: '09:00', end: '18:00' },
          wednesday: { start: '09:00', end: '18:00' },
          thursday: { start: '09:00', end: '18:00' },
          friday: { start: '09:00', end: '18:00' },
          saturday: { start: '09:00', end: '14:00' },
          sunday: { start: 'closed', end: 'closed' },
        },
      };
    } catch (error) {
      this.logger.error(`Error fetching salon context for ${salonId}:`, error);
      return null;
    }
  }

  /**
   * Get provider configuration for a salon
   */
  private async getProviderForSalon(salonId?: string): Promise<LLMProvider> {
    // P2A-platform-llm: prefer the platform DB config so the saas_owner
    // can change the provider/model from the admin UI without a deploy.
    // We also sync the relevant env vars (key, base URL, workspace id)
    // so the existing provider hot-reload picks up the new credentials
    // on the next request — without restarting the backend.
    try {
      const platform = await this.platformLlmConfig.resolveEffective();
      if (platform?.provider) {
        this.syncEnvForProvider(platform.provider, platform.apiKey, platform.baseUrl, platform.workspaceId ?? undefined);
        return platform.provider;
      }
    } catch (err) {
      this.logger.warn(
        `Platform LLM config lookup failed (${(err as Error).message}); falling back to env defaults`,
      );
    }
    return this.providerFactory.getDefaultProvider();
  }

  /**
   * P2A-platform-llm: mirror the current DB config into process.env so
   * the existing provider hot-reload (`initializeClient` reading the
   * env) picks up the new key without a backend restart. We clear the
   * other providers' keys so a stale key from a previous provider
   * doesn't leak into the next request.
   */
  private syncEnvForProvider(
    provider: LLMProvider,
    apiKey: string | undefined,
    baseUrl: string | undefined,
    workspaceId: string | undefined,
  ): void {
    process.env.ANTHROPIC_API_KEY = '';
    process.env.OPENAI_API_KEY = '';
    process.env.GOOGLE_API_KEY = '';
    process.env.MINIMAX_API_KEY = '';
    process.env.ANTHROPIC_WORKSPACE_ID = '';

    if (!apiKey) return;
    switch (provider) {
      case LLMProvider.ANTHROPIC:
        process.env.ANTHROPIC_API_KEY = apiKey;
        if (workspaceId) process.env.ANTHROPIC_WORKSPACE_ID = workspaceId;
        break;
      case LLMProvider.OPENAI:
        process.env.OPENAI_API_KEY = apiKey;
        break;
      case LLMProvider.GOOGLE:
        process.env.GOOGLE_API_KEY = apiKey;
        break;
      case LLMProvider.MiniMax:
        process.env.MINIMAX_API_KEY = apiKey;
        if (baseUrl) process.env.MINIMAX_BASE_URL = baseUrl;
        break;
    }
  }

  /**
   * Get model configuration for a salon. See `getProviderForSalon` for
   * the DB-vs-env precedence.
   */
  private async getModelForSalon(salonId?: string): Promise<string> {
    try {
      const platform = await this.platformLlmConfig.resolveEffective();
      if (platform?.model) return platform.model;
    } catch {
      // fall through to env default
    }
    return this.configService.get('DEFAULT_LLM_MODEL') || 'gpt-4o-mini';
  }

  /**
   * Build the system prompt for the LLM call by composing the
   * locale-specific identity (getSystemPrompt) with the salon's
   * live data (getDynamicContext). One source of truth shared by
   * every provider, so an OpenAI reply reads identically to an
   * Anthropic or Google one for the same salon + message.
   *
   * FAQs are capped at 20 entries with truncated Q/A so a salon
   * with hundreds of them cannot blow the prompt beyond ~2k tokens
   * with gpt-4o-mini.
   */
  private buildSystemPrompt(context: SalonContext | null): string {
    if (!context) {
      return getSystemPrompt('es', 'el salón', 'Kira');
    }

    const language = context.language === 'en' ? 'en' : 'es';
    const salonName = context.name || 'el salón';
    const assistantName = context.assistantName || 'Kira';

    const baseSystem = getSystemPrompt(language, salonName, assistantName);

    const workingHours: Record<string, { start: string; end: string }> =
      context.workingHours ?? context.openingHours ?? {};

    const faqs = (context.faqs ?? [])
      .slice(0, 20)
      .map((f) => ({
        question: f.question.slice(0, 200),
        answer: f.answer.slice(0, 200),
      }));

const dynamicContext = getDynamicContext(language, {
      salonName,
      salonAddress:
        [context.address, context.city, context.state, context.country]
          .filter(Boolean)
          .join(', ') || undefined,
      salonPhone: context.phone || undefined,
      salonWhatsapp: context.whatsapp || undefined,
      salonEmail: context.email || undefined,
      salonTimezone: context.timezone || undefined,
      salonHours: formatWorkingHours(workingHours, language),
      cancellationPolicy: context.cancellationPolicy,
      minCancelHours: context.minCancelHours ?? 24,
      // P2A-receptionist-tools: services and professionals are NOT
      // inlined in the system prompt. The model must use the salon
      // tools to look them up — otherwise it answers from stale
      // prompt data and bypasses the tool-calling architecture
      // (which the L-1 e2e suite catches as "tool not called").
      services: [],
      professionals: [],
      faqs: [],
    });

    return baseSystem + this.personaSuffix(context.persona) + '\n\n' + dynamicContext;
  }
  /**
   * Get fallback provider
   */
  private getFallbackProvider(): LLMProvider | null {
    const fallback = this.configService.get<string>('LLM_FALLBACK_PROVIDER');
    if (fallback) {
      return fallback as LLMProvider;
    }
    return null;
  }

  /**
   * Test LLM provider connection
   */
  async testProvider(data: { provider: string; apiKey: string; model?: string }): Promise<any> {
    const providerType = data.provider.toLowerCase() as LLMProvider;
    const provider = this.providerFactory.createProvider(providerType);
    
    this.logger.log(`Testing ${providerType} provider connection`);

    try {
      const response = await provider.testConnection(data.apiKey, data.model);
      return {
        success: true,
        provider: providerType,
        model: data.model,
        response: response,
      };
    } catch (error) {
      this.logger.error(`Error testing ${providerType} provider:`, error);
      return {
        success: false,
        provider: providerType,
        model: data.model,
        error: error.message,
      };
    }
  }

  /**
   * Get available LLM models
   */
  async getAvailableModels(): Promise<any[]> {
    const providers = this.providerFactory.getAvailableProviders();
    const availableProviders = providers.filter((p) => 
      this.providerFactory.isProviderAvailable(p)
    );

    const models: any[] = [];
    
    for (const providerType of availableProviders) {
      const provider = this.providerFactory.createProvider(providerType);
      try {
        const providerModels = await provider.getAvailableModels();
        models.push(...providerModels);
      } catch (error) {
        this.logger.error(`Error getting models from ${providerType}:`, error);
      }
    }

    return models;
  }

  /**
   * Create LLM provider configuration
   */
  async createProviderConfig(config: any): Promise<any> {
    this.logger.log(`Creating LLM provider configuration: ${config.provider}`);
    return config;
  }

  /**
   * Get LLM provider configurations
   */
  async getProviderConfigs(): Promise<any[]> {
    return [
      {
        id: 'openai-config',
        name: 'OpenAI',
        provider: LLMProvider.OPENAI,
        apiKey: '********',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        supportedModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4', 'gpt-3.5-turbo'],
        isActive: true,
        maxTokens: 8000,
        temperature: 0.7,
        rateLimit: 60,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'anthropic-config',
        name: 'Anthropic',
        provider: LLMProvider.ANTHROPIC,
        apiKey: '********',
        baseUrl: 'https://api.anthropic.com/v1',
        defaultModel: 'claude-3-opus-20240229',
        supportedModels: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'],
        isActive: true,
        maxTokens: 8192,
        temperature: 0.7,
        rateLimit: 50,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'google-config',
        name: 'Google AI',
        provider: LLMProvider.GOOGLE,
        apiKey: '********',
        baseUrl: 'https://generativelanguage.googleapis.com/v1',
        defaultModel: 'gemini-pro',
        supportedModels: ['gemini-pro', 'gemini-ultra', 'gemini-nano'],
        isActive: true,
        maxTokens: 4096,
        temperature: 0.7,
        rateLimit: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  }

  /**
   * Get LLM provider configuration
   */
  async getProviderConfig(id: string): Promise<any> {
    const configs = await this.getProviderConfigs();
    return configs.find((c) => c.id === id) || null;
  }

  /**
   * Update LLM provider configuration
   */
  async updateProviderConfig(id: string, config: any): Promise<any> {
    this.logger.log(`Updating LLM provider configuration: ${id}`);
    return { id, ...config };
  }

  /**
   * Delete LLM provider configuration
   */
  async deleteProviderConfig(id: string): Promise<any> {
    this.logger.log(`Deleting LLM provider configuration: ${id}`);
    return { success: true };
  }

  /**
   * P2A-receptionist-advanced — append the per-tenant persona block to
   * the system prompt when the tenant has configured a custom voice
   * and the advanced feature is unlocked (the gate is applied at
   * getSalonContext so a non-advanced tenant can never reach this
   * path even by manipulating the LLM call).
   *
   * Returns an empty string if no persona is configured.
   */
  private personaSuffix(
    persona: SalonContext['persona'] | undefined,
  ): string {
    if (!persona) return '';
    const parts: string[] = [];
    if (persona.voice) parts.push(`VOICE: ${persona.voice}`);
    if (persona.tone) {
      parts.push(
        `TONE: ${persona.tone}. Your sentences, vocabulary, and pacing must reflect this.`,
      );
    }
    if (persona.signature) {
      parts.push(`SIGNATURE: end messages naturally with: ${persona.signature}`);
    }
    if (persona.localeAdaptations) {
      parts.push(`LOCALE: ${persona.localeAdaptations}`);
    }
    if (parts.length === 0) return '';
    return (
      '\n\n=== Salon voice (advanced) ===\n' + parts.join('\n')
    );
  }
}