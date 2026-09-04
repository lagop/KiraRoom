import { z } from 'zod';
import { LLMProvider, ChatIntent, EntityType, BookingStage } from '../types/virtual-receptionist';

/**
 * Virtual Receptionist DTOs for API validation
 * These schemas validate incoming API requests and outgoing responses
 */

// LLM Provider Configuration DTOs
export const CreateLLMProviderConfigSchema = z.object({
  name: z.string().min(1, 'Provider name is required'),
  provider: z.nativeEnum(LLMProvider),
  apiKey: z.string().min(1, 'API key is required'),
  baseUrl: z.string().url().optional(),
  defaultModel: z.string().min(1, 'Default model is required'),
  supportedModels: z.array(z.string()).min(1, 'At least one supported model is required'),
  maxTokens: z.number().min(100).max(8000).default(4000),
  temperature: z.number().min(0).max(2).default(0.7),
  rateLimit: z.number().min(1).default(60),
  isActive: z.boolean().default(true)
});

export const UpdateLLMProviderConfigSchema = CreateLLMProviderConfigSchema.partial();

// Virtual Receptionist Configuration DTOs
export const CreateVirtualReceptionistConfigSchema = z.object({
  salonId: z.string().uuid('Invalid salon ID'),
  isActive: z.boolean().default(true),
  provider: z.nativeEnum(LLMProvider),
  model: z.string().min(1, 'Model name is required'),
  greetingMessage: z.string().min(1, 'Greeting message is required'),
  fallbackMessage: z.string().min(1, 'Fallback message is required'),
  responseDelay: z.number().min(0).max(10000).default(1000),
  workingHours: z.object({
    monday: z.object({
      start: z.string().min(1, 'Start time is required'),
      end: z.string().min(1, 'End time is required')
    }),
    tuesday: z.object({
      start: z.string().min(1, 'Start time is required'),
      end: z.string().min(1, 'End time is required')
    }),
    wednesday: z.object({
      start: z.string().min(1, 'Start time is required'),
      end: z.string().min(1, 'End time is required')
    }),
    thursday: z.object({
      start: z.string().min(1, 'Start time is required'),
      end: z.string().min(1, 'End time is required')
    }),
    friday: z.object({
      start: z.string().min(1, 'Start time is required'),
      end: z.string().min(1, 'End time is required')
    }),
    saturday: z.object({
      start: z.string().min(1, 'Start time is required'),
      end: z.string().min(1, 'End time is required')
    }),
    sunday: z.object({
      start: z.string().min(1, 'Start time is required'),
      end: z.string().min(1, 'End time is required')
    })
  }),
  excludedKeywords: z.array(z.string()).default([]),
  faqTopics: z.array(z.string()).default([]),
  maxConversationLength: z.number().min(1).max(100).default(20),
  allowAppointmentBooking: z.boolean().default(true),
  appointmentTimeSlots: z.array(z.string()).default(['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'])
});

export const UpdateVirtualReceptionistConfigSchema = CreateVirtualReceptionistConfigSchema.partial();

// Chat Message DTOs
export const SendMessageSchema = z.object({
  clientId: z.string().uuid('Invalid client ID'),
  salonId: z.string().uuid('Invalid salon ID'),
  tenantId: z.string().uuid('Invalid tenant ID').optional(),
  message: z.string().min(1, 'Message content is required'),
  channel: z.enum(['whatsapp', 'web']),
  metadata: z.record(z.any()).optional()
});

export const MessageResponseSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  provider: z.nativeEnum(LLMProvider),
  model: z.string(),
  responseTime: z.number(),
  requiresHandoff: z.boolean(),
  intent: z.nativeEnum(ChatIntent),
  // P2A-receptionist-fairuse -- populated only when the AI cap short-circuited
  // this turn. The frontend uses it to surface a soft "AI rollback" banner.
  limitInfo: z
    .object({
      cap: z.number().nullable(),
      used: z.number(),
      action: z.enum(['degrade', 'notify', 'allow']),
    })
    .optional(),
  // P2A-receptionist-v2 H-4: true when the outbound message was
  // successfully dispatched through a chat channel provider
  // (Facebook / Instagram / Telegram). False for the Web channel or
  // when the channel is disabled for the tenant.
  channelDispatched: z.boolean().optional(),
  // Debug-only: populated when the orchestrator falls back after an
  // unhandled exception. The frontend surfaces this next to the
  // fallback message so the actual underlying cause is visible.
  error: z.string().optional(),
  // P2A-receptionist-tools: passthrough of the tools the LLM actually
  // executed (e.g. list_services, check_availability) for this turn.
  // Surfaced in the widget debug bubble and consumed by the L-1
  // harness to verify "did the model call the right tool?".
  toolsExecuted: z
    .array(
      z.object({
        name: z.string(),
        input: z.unknown(),
        result: z.unknown().optional(),
      }),
    )
    .optional(),
});

// Conversation DTOs
export const CreateConversationSchema = z.object({
  clientId: z.string().uuid('Invalid client ID'),
  salonId: z.string().uuid('Invalid salon ID'),
  tenantId: z.string().uuid('Invalid tenant ID').optional(),
  channel: z.enum(['whatsapp', 'web']),
  metadata: z.record(z.any()).optional()
});

export const UpdateConversationSchema = z.object({
  status: z.enum(['active', 'completed', 'handoff']).optional(),
  handoffUserId: z.string().uuid('Invalid user ID').optional(),
  handoffAt: z.date().optional()
});

// FAQ Management DTOs
export const CreateFAQItemSchema = z.object({
  question: z.string().min(1, 'Question is required'),
  answer: z.string().min(1, 'Answer is required'),
  category: z.string().min(1, 'Category is required'),
  keywords: z.array(z.string()).default([]),
  priority: z.number().min(1).max(10).default(5)
});

export const UpdateFAQItemSchema = CreateFAQItemSchema.partial();

export const FAQItemResponseSchema = z.object({
  id: z.string().uuid(),
  question: z.string(),
  answer: z.string(),
  category: z.string(),
  keywords: z.array(z.string()),
  priority: z.number(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date()
});

// Booking Context DTOs
export const BookingContextSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid('Invalid client ID'),
  salonId: z.string().uuid('Invalid salon ID'),
  serviceType: z.string().optional(),
  professional: z.string().optional(),
  preferredDate: z.string().optional(),
  preferredTime: z.string().optional(),
  phoneNumber: z.string().optional(),
  email: z.string().email('Invalid email format').optional(),
  name: z.string().optional(),
  stage: z.nativeEnum(BookingStage),
  createdAt: z.date(),
  updatedAt: z.date()
});

export const BookingRequestSchema = z.object({
  serviceType: z.string().min(1, 'Service type is required'),
  professional: z.string().optional(),
  date: z.string().min(1, 'Date is required'),
  time: z.string().min(1, 'Time is required'),
  clientInfo: z.object({
    name: z.string().min(1, 'Client name is required'),
    phone: z.string().min(1, 'Phone number is required'),
    email: z.string().email('Invalid email format').optional()
  })
});

export const BookingResponseSchema = z.object({
  success: z.boolean(),
  appointmentId: z.string().uuid().optional(),
  message: z.string(),
  confirmationUrl: z.string().url().optional(),
  nextStep: z.nativeEnum(BookingStage).optional()
});

// Message Analysis DTOs
export const MessageAnalysisSchema = z.object({
  intent: z.nativeEnum(ChatIntent),
  entities: z.array(z.object({
    type: z.nativeEnum(EntityType),
    value: z.string(),
    confidence: z.number().min(0).max(1)
  })),
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  confidence: z.number().min(0).max(1),
  requiresHandoff: z.boolean(),
  keywords: z.array(z.string())
});

// LLM Generation Configuration DTOs
export const LLMGenerationConfigSchema = z.object({
  model: z.string().min(1, 'Model name is required'),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().min(100).max(8000).default(4000),
  topP: z.number().min(0).max(1).default(1),
  frequencyPenalty: z.number().min(0).max(2).default(0),
  presencePenalty: z.number().min(0).max(2).default(0)
});

export const LLMCompletionSchema = z.object({
  id: z.string().uuid(),
  text: z.string(),
  usage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number()
  }),
  model: z.string(),
  provider: z.nativeEnum(LLMProvider),
  timestamp: z.date(),
  latency: z.number(),
  // 'stop' (normal), 'length' (truncated by max_tokens), 'safety' etc.
  // When 'length' the caller knows the text is incomplete and should
  // either retry with more tokens or surface a warning.
  finishReason: z.string().optional(),
});

// Webhook Event DTOs for WhatsApp integration
export const WhatsAppWebhookEventSchema = z.object({
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({
      value: z.object({
        messaging_product: z.literal('whatsapp'),
        metadata: z.object({
          display_phone_number: z.string(),
          phone_number_id: z.string()
        }),
        contacts: z.array(z.object({
          profile: z.object({ name: z.string() }),
          wa_id: z.string()
        })),
        messages: z.array(z.object({
          from: z.string(),
          id: z.string(),
          timestamp: z.string(),
          type: z.string(),
          text: z.object({ body: z.string() }).optional(),
          interactive: z.object({
            type: z.string(),
            button_reply: z.object({
              id: z.string(),
              title: z.string()
            }).optional(),
            list_reply: z.object({
              id: z.string(),
              title: z.string(),
              description: z.string().optional()
            }).optional()
          }).optional()
        }))
      })
    }))
  }))
});

// Export types from schemas
export type CreateLLMProviderConfig = z.infer<typeof CreateLLMProviderConfigSchema>;
export type UpdateLLMProviderConfig = z.infer<typeof UpdateLLMProviderConfigSchema>;
export type CreateVirtualReceptionistConfig = z.infer<typeof CreateVirtualReceptionistConfigSchema>;
export type UpdateVirtualReceptionistConfig = z.infer<typeof UpdateVirtualReceptionistConfigSchema>;
export type SendMessageDto = z.infer<typeof SendMessageSchema>;
export type MessageResponseDto = z.infer<typeof MessageResponseSchema>;
export type CreateConversationDto = z.infer<typeof CreateConversationSchema>;
export type UpdateConversationDto = z.infer<typeof UpdateConversationSchema>;
export type CreateFAQItem = z.infer<typeof CreateFAQItemSchema>;
export type UpdateFAQItem = z.infer<typeof UpdateFAQItemSchema>;
export type FAQItemResponse = z.infer<typeof FAQItemResponseSchema>;
export type BookingRequest = z.infer<typeof BookingRequestSchema>;
export type BookingResponse = z.infer<typeof BookingResponseSchema>;
export type BookingContext = z.infer<typeof BookingContextSchema>;
export type LLMGenerationConfig = z.infer<typeof LLMGenerationConfigSchema>;
export type LLMCompletion = z.infer<typeof LLMCompletionSchema>;
export type WhatsAppWebhookEvent = z.infer<typeof WhatsAppWebhookEventSchema>;