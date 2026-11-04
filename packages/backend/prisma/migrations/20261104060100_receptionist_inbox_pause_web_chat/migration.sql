-- Receptionist inbox (audit D15/D16): pause the assistant per conversation,
-- mark the conversations the salon was told about, and the web chat switch.
-- All additive; existing rows read as not paused, nothing pending, chat on.
ALTER TABLE "chat_conversations"
  ADD COLUMN "assistantPausedAt" TIMESTAMP(3),
  ADD COLUMN "assistantPausedById" TEXT,
  ADD COLUMN "attentionReason" TEXT,
  ADD COLUMN "attentionAt" TIMESTAMP(3);

CREATE INDEX "chat_conversations_tenantId_lastActivityAt_idx"
  ON "chat_conversations"("tenantId", "lastActivityAt");

ALTER TABLE "tenants" ADD COLUMN "webChatEnabled" BOOLEAN NOT NULL DEFAULT true;
