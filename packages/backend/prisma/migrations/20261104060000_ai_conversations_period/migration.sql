-- The month the AI message count belongs to (YYYY-MM, UTC). A count from
-- another month reads as 0, so a missed monthly reset cannot carry usage
-- over. Until now the count was never reset and ran from signup.
ALTER TABLE "tenants" ADD COLUMN "aiConversationsPeriod" TEXT;

-- Only a salon that signed up this month has a count that is this month's
-- usage; every other count is cumulative and starts again from 0.
UPDATE "tenants"
SET "aiConversationsPeriod" = to_char(timezone('UTC', now()), 'YYYY-MM')
WHERE "createdAt" >= date_trunc('month', timezone('UTC', now()));
