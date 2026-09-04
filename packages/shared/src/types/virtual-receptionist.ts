/**
 * Virtual Receptionist types and interfaces
 * This file defines the core types for the AI-powered virtual receptionist system
 */

// LLM Provider Configuration
export enum LLMProvider {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  LLAMA = 'llama',
  MiniMax = 'MiniMax',
  CUSTOM = 'custom',
  SYSTEM = 'system'
}

export interface LLMProviderConfig {
  id: string;
  name: string;
  provider: LLMProvider;
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  supportedModels: string[];
  isActive: boolean;
  maxTokens: number;
  temperature: number;
  rateLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

// LLM Model Configuration
export interface LLMModel {
  id: string;
  name: string;
  provider: LLMProvider;
  contextWindow: number;
  costPerToken: number;
  features: string[];
  isEnabled: boolean;
}

// Virtual Receptionist Configuration
export interface VirtualReceptionistConfig {
  id: string;
  salonId: string;
  isActive: boolean;
  provider: LLMProvider;
  model: string;
  greetingMessage: string;
  fallbackMessage: string;
  responseDelay: number;
  workingHours: {
    monday: { start: string; end: string };
    tuesday: { start: string; end: string };
    wednesday: { start: string; end: string };
    thursday: { start: string; end: string };
    friday: { start: string; end: string };
    saturday: { start: string; end: string };
    sunday: { start: string; end: string };
  };
  excludedKeywords: string[];
  faqTopics: string[];
  maxConversationLength: number;
  allowAppointmentBooking: boolean;
  appointmentTimeSlots: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Chat Conversation Types
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  provider?: LLMProvider;
  model?: string;
  responseTime?: number;
  intent?: string;
  requiresHandoff?: boolean;
}

export type ChatChannel = 'web' | 'whatsapp' | 'facebook' | 'instagram' | 'telegram';

export interface ChatConversation {
  id: string;
  clientId: string;
  salonId: string;
  messages: ChatMessage[];
  status: 'active' | 'completed' | 'handoff';
  lastActivityAt: Date;
  totalMessages: number;
  hasHandoff: boolean;
  handoffUserId?: string;
  handoffAt?: Date;
  /// P2A-receptionist-v2 H-4: channel of origin; the orchestrator reads
  /// this to route the outbound reply to the right channel provider.
  channel?: ChatChannel;
  /// Free-form provider-specific data (e.g. external_user_id for Meta
  /// Messenger / Instagram, chat_id for Telegram). The orchestrator
  /// passes this to the channel provider's `send()` so the right
  /// recipient is addressed.
  context?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// Message Analysis Types
export interface MessageAnalysis {
  intent: ChatIntent;
  entities: MessageEntity[];
  sentiment: 'positive' | 'negative' | 'neutral';
  confidence: number;
  requiresHandoff: boolean;
  keywords: string[];
}

export interface MessageEntity {
  type: EntityType;
  value: string;
  confidence: number;
}

export enum ChatIntent {
  BOOK_APPOINTMENT = 'book_appointment',
  CANCEL_APPOINTMENT = 'cancel_appointment',
  RESCHEDULE_APPOINTMENT = 'reschedule_appointment',
  CHECK_AVAILABILITY = 'check_availability',
  CHECK_APPOINTMENT = 'check_appointment',
  PRICE_QUERY = 'price_query',
  SERVICE_INFO = 'service_info',
  PROFESSIONAL_INFO = 'professional_info',
  HOURS_INFO = 'hours_info',
  LOCATION_INFO = 'location_info',
  CONTACT_INFO = 'contact_info',
  COMPLAINT = 'complaint',
  FEEDBACK = 'feedback',
  OTHER = 'other'
}

export enum EntityType {
  DATE = 'date',
  TIME = 'time',
  SERVICE_TYPE = 'service_type',
  PROFESSIONAL = 'professional',
  PRICE = 'price',
  LOCATION = 'location',
  PHONE = 'phone',
  EMAIL = 'email',
  NAME = 'name'
}



// FAQ Types
export interface FAQItem {
  id: string;
  salonId: string;
  question: string;
  answer: string;
  category: string;
  keywords: string[];
  priority: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFAQItemDto {
  question: string;
  answer: string;
  category: string;
  keywords?: string[];
  priority?: number;
}

export interface UpdateFAQItemDto {
  question?: string;
  answer?: string;
  category?: string;
  keywords?: string[];
  priority?: number;
  isActive?: boolean;
}



export enum BookingStage {
  INITIAL = 'initial',
  SERVICE_TYPE = 'service_type',
  PROFESSIONAL = 'professional',
  DATE = 'date',
  TIME = 'time',
  PERSONAL_INFO = 'personal_info',
  CONFIRMATION = 'confirmation',
  COMPLETED = 'completed'
}


