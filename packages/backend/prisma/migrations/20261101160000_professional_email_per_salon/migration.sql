-- A professional's email is unique within a salon ("professionals_tenantId_email_key"),
-- not across the platform: someone who works in two salons can be on both teams.
DROP INDEX IF EXISTS "professionals_email_key";
