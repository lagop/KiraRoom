import { z } from 'zod';

/**
 * DTOs for the staff-side Copilot (separate from the customer-side
 * Virtual Receptionist). The copilot reads salon data and (in later
 * sprints) writes with explicit human approval.
 */

// ---------- Conversation & messages ----------

export const AssistantMessageRoleSchema = z.enum([
  'user',       // the salon staff typed something
  'assistant',  // the LLM replied
  'tool',       // tool-call result attached to the assistant message
  'approval',   // a pending-action card; points to ActionApproval
  'system',     // reserved for future system injections
]);
export type AssistantMessageRole = z.infer<typeof AssistantMessageRoleSchema>;

export const SendAssistantMessageSchema = z.object({
  content: z.string().min(1, 'Message cannot be empty').max(4000),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),  // null/undefined = use the persistent thread
});
export type SendAssistantMessageDto = z.infer<typeof SendAssistantMessageSchema>;

export const CreateAssistantConversationSchema = z.object({
  sessionId: z.string().optional(),
  title: z.string().max(120).optional(),
});
export type CreateAssistantConversationDto = z.infer<typeof CreateAssistantConversationSchema>;

// ---------- Approval actions ----------

export const ApprovalActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('reject'), reason: z.string().max(500).optional() }),
]);
export type ApprovalActionDto = z.infer<typeof ApprovalActionSchema>;

// ---------- Public response shapes ----------

export const AssistantMessagePublicSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: AssistantMessageRoleSchema,
  content: z.string(),
  toolName: z.string().nullable().optional(),
  toolInput: z.unknown().nullable().optional(),
  toolResult: z.unknown().nullable().optional(),
  pendingActionId: z.string().nullable().optional(),
  createdAt: z.string(),  // ISO 8601
});
export type AssistantMessagePublic = z.infer<typeof AssistantMessagePublicSchema>;

export const AssistantConversationPublicSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  sessionId: z.string().nullable(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantConversationPublic = z.infer<typeof AssistantConversationPublicSchema>;

export const AssistantSendResponseSchema = z.object({
  conversation: AssistantConversationPublicSchema,
  message: AssistantMessagePublicSchema,
  pendingApprovals: z.array(
    z.object({
      id: z.string(),
      toolName: z.string(),
      preview: z.string().nullable().optional(),
      expiresAt: z.string(),
    }),
  ).default([]),
  toolsExecuted: z.array(
    z.object({
      name: z.string(),
      input: z.unknown().optional(),
      result: z.unknown().optional(),
    }),
  ).default([]),
});
export type AssistantSendResponse = z.infer<typeof AssistantSendResponseSchema>;

export const AssistantConversationListSchema = z.array(AssistantConversationPublicSchema);

export const AssistantPendingApprovalsSchema = z.array(
  z.object({
    id: z.string(),
    toolName: z.string(),
    toolInput: z.unknown(),
    preview: z.string().nullable().optional(),
    expiresAt: z.string(),
    createdAt: z.string(),
  }),
);

// ---------- Daily briefing (P2A-copilot-sprint13) ----------

export const DailyBriefingSchema = z.object({
  date: z.string(),
  role: z.enum(['owner', 'admin', 'manager', 'staff', 'receptionist', 'saas_owner']),
  appointments: z.object({
    total: z.number(),
    confirmed: z.number(),
    pending: z.number(),
    items: z.array(
      z.object({
        id: z.string(),
        time: z.string(),
        status: z.string(),
        clientFirstName: z.string().nullable(),
        professionalFirstName: z.string().nullable(),
      }),
    ),
  }),
  pendingConfirmations: z.object({
    total: z.number(),
    items: z.array(
      z.object({
        id: z.string(),
        time: z.string(),
        clientFirstName: z.string().nullable(),
        professionalFirstName: z.string().nullable(),
      }),
    ),
  }),
  gaps: z.object({
    total: z.number(),
    items: z.array(
      z.object({ start: z.string(), end: z.string(), minutes: z.number() }),
    ),
  }),
  lowStock: z.object({
    total: z.number(),
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        quantity: z.number(),
        lowStockAlert: z.number(),
      }),
    ),
  }),
  clientsAtRisk: z.object({
    total: z.number(),
    items: z.array(
      z.object({
        id: z.string(),
        firstName: z.string(),
        daysSinceLastVisit: z.number().nullable(),
      }),
    ),
  }),
  generatedAt: z.string(),
});
export type DailyBriefing = z.infer<typeof DailyBriefingSchema>;
