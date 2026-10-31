-- A client is on a campaign's recipient list once.
--
-- Adding recipients created a row per client id sent, with no check: picking
-- some clients and then "Enviar a todos", or a double click, put a client on
-- the list twice and she got the campaign twice.
--
-- Existing duplicates are removed first, keeping one row per client:
-- - for a re-engagement campaign, the latest (its row now follows the latest
--   email sent to her, and the delivery webhooks match its message id);
-- - for any other campaign, the earliest.
-- The campaign's totalRecipients goes down by the rows removed. Rows with no
-- client (deleted clients) are left alone: NULLs never clash in a unique
-- index.

-- Remove duplicates
WITH ranked AS (
    SELECT r."id",
           ROW_NUMBER() OVER (
               PARTITION BY r."campaignId", r."clientId"
               ORDER BY (CASE WHEN c."campaignType" = 'reengagement' THEN r."createdAt" END) DESC,
                        r."createdAt" ASC,
                        r."id" ASC
           ) AS rn
    FROM "email_campaign_recipients" r
    JOIN "email_campaigns" c ON c."id" = r."campaignId"
    WHERE r."clientId" IS NOT NULL
),
removed AS (
    DELETE FROM "email_campaign_recipients" d
    USING ranked
    WHERE d."id" = ranked."id" AND ranked.rn > 1
    RETURNING d."campaignId"
),
per_campaign AS (
    SELECT "campaignId", COUNT(*)::int AS n FROM removed GROUP BY "campaignId"
)
UPDATE "email_campaigns" c
SET "totalRecipients" = GREATEST(c."totalRecipients" - per_campaign.n, 0)
FROM per_campaign
WHERE c."id" = per_campaign."campaignId";

-- CreateIndex
CREATE UNIQUE INDEX "email_campaign_recipients_campaignId_clientId_key" ON "email_campaign_recipients"("campaignId", "clientId");
