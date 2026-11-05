-- The AI pack in conversations too, as kiraroom.com and the plan texts say it
-- (about 7 client messages per conversation: see aiConversationsApprox).
UPDATE "add_ons"
SET "description" = '1.000 mensajes más al mes (unas 140 conversaciones) para la recepcionista IA, en cualquier plan.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'ai_messages_1000';
