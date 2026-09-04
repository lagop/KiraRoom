import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChatConversation, ChatMessage, IntentHistoryItem, ClientProfile, Tenant } from '@prisma/client';

@Injectable()
export class ConversationMemoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get or create a default tenant
   */
  async getOrCreateDefaultTenant(): Promise<Tenant> {
    let tenant = await this.prisma.tenant.findFirst();
    
    if (!tenant) {
      tenant = await this.prisma.tenant.create({
        data: {
          name: 'Kira Studio',
          slug: 'kira-studio',
          description: 'Premium beauty and wellness salon',
          email: 'info@kira-studio.com',
          phone: '+34 600 123 456',
          whatsapp: '+34 600 123 456',
          street: 'Calle Gran Vía 42',
          city: 'Madrid',
          state: 'Community of Madrid',
          postalCode: '28013',
          country: 'ES',
          timezone: 'Europe/Madrid',
          currency: 'EUR',
          language: 'es',
          dateFormat: 'DD/MM/YYYY',
          timeFormat: '24h',
          plan: 'professional',
          subscriptionStatus: 'active',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
          features: {
            onlineBooking: true,
            smsNotifications: true,
            emailMarketing: true,
            loyaltyProgram: true,
            multiStaff: true,
            inventory: true,
            reports: true,
          },
        },
      });
    }
    
    return tenant;
  }

  /**
   * Create a new chat conversation
   */
  async createConversation(data: Partial<ChatConversation>): Promise<ChatConversation> {
    // Ensure we have a valid tenant
    let tenantId = data.tenantId;

    // If tenantId is provided but might be invalid (e.g., salon name instead of UUID),
    // or if no tenantId is provided, use default tenant
    if (!tenantId || !this.isValidUUID(tenantId)) {
      // First, check if it's a salon slug (like "kirastudio")
      let tenant = await this.prisma.tenant.findFirst({
        where: {
          OR: [
            { slug: tenantId?.toLowerCase() },
            { name: { contains: tenantId || '', mode: 'insensitive' } }
          ]
        }
      });

      // If not found, use default tenant
      if (!tenant) {
        tenant = await this.getOrCreateDefaultTenant();
      }

      tenantId = tenant.id;
    }

    // Also validate salonId - if it's not a valid UUID, don't use it (or use default)
    const validSalonId = data.salonId && this.isValidUUID(data.salonId) ? data.salonId : tenantId;

    // ChatConversation.clientId has a FK to Client. The chat widget
    // sends "anonymous" (or any non-UUID) for unauthenticated visitors,
    // and even a valid UUID that doesn't match a Client row will fail
    // the FK. Only attach `clientId` when it points to an existing
    // Client; otherwise leave the FK null.
    let validClientId: string | undefined = undefined;
    if (data.clientId && this.isValidUUID(data.clientId)) {
      const client = await this.prisma.client.findUnique({
        where: { id: data.clientId },
        select: { id: true },
      });
      if (client) {
        validClientId = client.id;
      }
    }

    return this.prisma.chatConversation.create({
      data: {
        tenantId: tenantId!,
        clientId: validClientId,
        salonId: validSalonId,
        conversationId: data.conversationId,
        channel: data.channel || 'web',
        status: data.status || 'active',
        totalMessages: data.totalMessages || 0,
        hasHandoff: data.hasHandoff || false,
        handoffUserId: data.handoffUserId,
        handoffAt: data.handoffAt,
        lastActivityAt: data.lastActivityAt || new Date(),
        context: data.context || {},
      },
    });
  }

  private isValidUUID(str: string): boolean {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidPattern.test(str);
  }

  /**
   * Find a conversation by ID
   */
  async findConversationById(id: string): Promise<ChatConversation | null> {
    return this.prisma.chatConversation.findFirst({
      where: { id },
      include: {
        messages: true,
        intentHistory: true,
      },
    });
  }

  /**
   * Find active conversation for client
   */
  async findActiveConversationByClientId(clientId: string, tenantId: string): Promise<ChatConversation | null> {
    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    return this.prisma.chatConversation.findFirst({
      where: {
        clientId,
        tenantId,
        status: 'active',
        lastActivityAt: {
          gte: oneHourAgo,
        },
      },
      include: {
        messages: true,
        intentHistory: true,
      },
    });
  }

  /**
   * Update a conversation
   */
  async updateConversation(id: string, data: Partial<ChatConversation>): Promise<ChatConversation> {
    return this.prisma.chatConversation.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date(),
      },
      include: {
        messages: true,
        intentHistory: true,
      },
    });
  }

  /**
   * Add a message to a conversation
   */
  async addMessage(conversationId: string, message: Partial<ChatMessage>): Promise<ChatMessage> {
    const messageData = await this.prisma.chatMessage.create({
      data: {
        conversationId,
        role: message.role || 'user',
        content: message.content,
        provider: message.provider,
        model: message.model,
        responseTime: message.responseTime,
        intent: message.intent,
        requiresHandoff: message.requiresHandoff || false,
        metadata: message.metadata || {},
      },
    });

    // Update conversation message count and last activity time
    await this.prisma.chatConversation.update({
      where: { id: conversationId },
      data: {
        totalMessages: {
          increment: 1,
        },
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      },
    });

    return messageData;
  }

  /**
   * Add an intent to conversation history
   */
  async addIntentHistory(conversationId: string, intent: Partial<IntentHistoryItem>): Promise<IntentHistoryItem> {
    return this.prisma.intentHistoryItem.create({
      data: {
        conversationId,
        intent: intent.intent!,
        confidence: intent.confidence || 0.8,
        context: intent.context || {},
      },
    });
  }

  /**
   * Create or update client profile
   */
  async upsertClientProfile(
    tenantId: string,
    clientId: string,
    data: Partial<ClientProfile>,
  ): Promise<ClientProfile> {
    return this.prisma.clientProfile.upsert({
      where: { tenantId_clientId: { tenantId, clientId } },
      update: {
        ...data,
        updatedAt: new Date(),
      },
      create: {
        tenantId,
        clientId,
        name: data.name!,
        email: data.email,
        phone: data.phone,
        preferences: data.preferences || {},
        interactionHistory: data.interactionHistory || [],
        bookingHistory: data.bookingHistory || [],
        servicePreferences: data.servicePreferences || [],
        communicationPreferences: data.communicationPreferences || {},
      },
    });
  }

  /**
   * Find client profile
   */
  async findClientProfile(tenantId: string, clientId: string): Promise<ClientProfile | null> {
    return this.prisma.clientProfile.findFirst({
      where: { tenantId, clientId },
    });
  }

  /**
   * Update client profile interaction history
   */
  async addInteractionToClientProfile(
    tenantId: string,
    clientId: string,
    interaction: any,
  ): Promise<ClientProfile | null> {
    const profile = await this.findClientProfile(tenantId, clientId);
    if (!profile) return null;

    // Ensure interactionHistory is an array before modifying
    const interactionHistory = Array.isArray(profile.interactionHistory) 
      ? [...profile.interactionHistory] 
      : [];
    
    interactionHistory.push({
      id: Date.now().toString(),
      type: interaction.type,
      details: interaction.details,
      timestamp: new Date().toISOString(),
    });

    return this.prisma.clientProfile.update({
      where: { tenantId_clientId: { tenantId, clientId } },
      data: {
        interactionHistory,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Get all conversations for a tenant
   */
  async getConversationsByTenantId(
    tenantId: string,
    filters?: { status?: string; channel?: string; dateRange?: { start: Date; end: Date } },
  ): Promise<ChatConversation[]> {
    const where: any = { tenantId };

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.channel) {
      where.channel = filters.channel;
    }

    if (filters?.dateRange) {
      where.createdAt = {
        gte: filters.dateRange.start,
        lte: filters.dateRange.end,
      };
    }

    return this.prisma.chatConversation.findMany({
      where,
      include: {
        messages: true,
        intentHistory: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * Get conversation statistics for a tenant
   */
  async getConversationStatistics(tenantId: string): Promise<{
    total: number;
    active: number;
    completed: number;
    handoff: number;
    byChannel: { web: number; whatsapp: number };
    avgMessages: number;
  }> {
    const [total, active, completed, handoff, byChannel, avgMessages] = await Promise.all([
      this.prisma.chatConversation.count({ where: { tenantId } }),
      this.prisma.chatConversation.count({
        where: { tenantId, status: 'active', lastActivityAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
      }),
      this.prisma.chatConversation.count({ where: { tenantId, status: 'completed' } }),
      this.prisma.chatConversation.count({ where: { tenantId, status: 'handoff' } }),
      this.prisma.chatConversation.groupBy({
        by: ['channel'],
        where: { tenantId },
        _count: { id: true },
      }),
      this.prisma.$queryRaw`
        SELECT AVG(totalMessages) as avgMessages
        FROM chat_conversations
        WHERE tenantId = ${tenantId}
      `,
    ]);

    const channelStats = { web: 0, whatsapp: 0 };
    byChannel.forEach((stat) => {
      if (stat.channel === 'web') {
        channelStats.web = stat._count.id;
      } else if (stat.channel === 'whatsapp') {
        channelStats.whatsapp = stat._count.id;
      }
    });

    return {
      total,
      active,
      completed,
      handoff,
      byChannel: channelStats,
      avgMessages: Array.isArray(avgMessages) && avgMessages.length > 0 ? Number(avgMessages[0].avgMessages) : 0,
    };
  }

  /**
   * Delete old conversations (older than 30 days)
   */
  async deleteOldConversations(daysToKeep: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const conversationsToDelete = await this.prisma.chatConversation.findMany({
      where: {
        createdAt: { lt: cutoffDate },
        status: 'completed',
      },
    });

    const conversationIds = conversationsToDelete.map((conv) => conv.id);

    await Promise.all([
      this.prisma.chatMessage.deleteMany({
        where: { conversationId: { in: conversationIds } },
      }),
      this.prisma.intentHistoryItem.deleteMany({
        where: { conversationId: { in: conversationIds } },
      }),
      this.prisma.chatConversation.deleteMany({
        where: { id: { in: conversationIds } },
      }),
    ]);

    return conversationsToDelete.length;
  }
}
