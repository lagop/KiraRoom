import { Injectable, Logger } from '@nestjs/common';
import { CreateConversationDto, UpdateConversationDto } from '@kira/shared';
import type { ChatConversation, ChatMessage } from '@kira/shared';
import { ConversationMemoryRepository } from '../repositories/conversation-memory.repository';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private readonly memoryRepository: ConversationMemoryRepository) {}

  /**
   * Find or create a conversation for the given client
   */
  async findOrCreateConversation(data: CreateConversationDto): Promise<ChatConversation> {
    const tenantId = data.tenantId || data.salonId;
    const existingConversation = await this.findActiveConversation(data.clientId, tenantId);
    
    if (existingConversation) {
      this.logger.log(`Found active conversation for client ${data.clientId}`);
      return this.convertToSharedType(existingConversation);
    }

    const newConversation = await this.createConversation(data);
    this.logger.log(`Created new conversation for client ${data.clientId}`);
    return newConversation;
  }

  /**
   * Find active conversation for client
   */
  private async findActiveConversation(clientId: string, tenantId: string): Promise<any | null> {
    return this.memoryRepository.findActiveConversationByClientId(clientId, tenantId);
  }

  /**
   * Create a new conversation
   */
  async createConversation(data: CreateConversationDto): Promise<ChatConversation> {
    const tenantId = data.tenantId || data.salonId;
    const conversationData = await this.memoryRepository.createConversation({
      tenantId: tenantId,
      clientId: data.clientId,
      salonId: data.salonId,
      conversationId: this.generateId(),
      channel: data.channel,
      status: 'active',
      lastActivityAt: new Date(),
      context: data.metadata || {},
    });

    return this.convertToSharedType(conversationData);
  }

  /**
   * Get conversation by ID
   */
  async getConversation(id: string): Promise<ChatConversation | null> {
    const conversation = await this.memoryRepository.findConversationById(id);
    if (!conversation) {
      this.logger.warn(`Conversation not found: ${id}`);
    }
    return conversation ? this.convertToSharedType(conversation) : null;
  }

  /**
   * Get all conversations
   */
  async getConversations(salonId?: string): Promise<ChatConversation[]> {
    const conversations = await this.memoryRepository.getConversationsByTenantId(salonId || '');
    return conversations.map(this.convertToSharedType);
  }

  /**
   * Update conversation
   */
  async updateConversation(id: string, data: UpdateConversationDto): Promise<ChatConversation | null> {
    const updatedConversation = await this.memoryRepository.updateConversation(id, data);
    if (!updatedConversation) {
      this.logger.warn(`Conversation not found: ${id}`);
      return null;
    }
    this.logger.log(`Conversation updated: ${id}`);
    
    return this.convertToSharedType(updatedConversation);
  }

  /**
   * Delete conversation
   */
  async deleteConversation(id: string): Promise<boolean> {
    // For now, we'll just update status to completed
    const updatedConversation = await this.memoryRepository.updateConversation(id, {
      status: 'completed',
    });

    if (updatedConversation) {
      this.logger.log(`Conversation deleted: ${id}`);
      return true;
    } else {
      this.logger.warn(`Conversation not found: ${id}`);
      return false;
    }
  }

  /**
   * Add message to conversation
   */
  async addMessage(conversationId: string, message: Omit<ChatMessage, 'id'>): Promise<ChatMessage> {
    const messageData = await this.memoryRepository.addMessage(conversationId, {
      ...message,
    });
    this.logger.log(`Message added to conversation: ${conversationId}`);
    
    return this.convertMessageToSharedType(messageData);
  }

   /**
   * Get conversation messages
   */
  async getConversationMessages(conversationId: string): Promise<ChatMessage[]> {
    const conversation = await this.memoryRepository.findConversationById(conversationId);
    if (!conversation) {
      this.logger.warn(`Conversation not found: ${conversationId}`);
      return [];
    }
    // Check if messages exist before mapping
    if (!('messages' in conversation) || !Array.isArray(conversation.messages)) {
      return [];
    }
    return conversation.messages.map(this.convertMessageToSharedType);
  }

  /**
   * Get conversation count
   */
  async getConversationCount(): Promise<{ total: number; active: number }> {
    const stats = await this.memoryRepository.getConversationStatistics('');
    return {
      total: stats.total,
      active: stats.active,
    };
  }

  /**
   * Get message count
   */
  async getMessageCount(): Promise<{ total: number; user: number; assistant: number }> {
    // This would require a separate query, but for now we'll approximate
    const conversations = await this.memoryRepository.getConversationsByTenantId('');
    let total = 0;
    let user = 0;
    let assistant = 0;

    conversations.forEach(conversation => {
      if ('messages' in conversation && Array.isArray(conversation.messages)) {
        conversation.messages.forEach(message => {
          total++;
          if (message.role === 'user') user++;
          if (message.role === 'assistant') assistant++;
        });
      }
    });

    return { total, user, assistant };
  }

  /**
   * Get active conversation for client
   */
  async getActiveConversation(clientId: string, salonId: string): Promise<ChatConversation | null> {
    const conversation = await this.findActiveConversation(clientId, salonId);
    return conversation ? this.convertToSharedType(conversation) : null;
  }

  /**
   * Convert Prisma conversation type to shared type
   */
  private convertToSharedType(conversation: any): ChatConversation {
    return {
      id: conversation.id,
      clientId: conversation.clientId,
      salonId: conversation.salonId,
      messages: (conversation.messages || []).map(this.convertMessageToSharedType),
      status: conversation.status,
      lastActivityAt: new Date(conversation.lastActivityAt),
      totalMessages: conversation.totalMessages || 0,
      hasHandoff: conversation.hasHandoff || false,
      // P2A-receptionist-v2 H-4: surface channel + context to the
      // dispatcher so it can route the outbound reply.
      channel: (conversation.channel ?? 'web') as any,
      context: (conversation.context as any) ?? {},
      createdAt: new Date(conversation.createdAt),
      updatedAt: new Date(conversation.updatedAt),
    };
  }

  /**
   * Convert Prisma message type to shared type
   */
  private convertMessageToSharedType(message: any): any {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      provider: message.provider,
      model: message.model,
      responseTime: message.responseTime,
      intent: message.intent,
      requiresHandoff: message.requiresHandoff || false,
      timestamp: new Date(message.createdAt),
    };
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
  }
}
