-- WhatsApp campaigns pause on account-level Meta errors (expired token,
-- payment, paused template, restricted number) instead of failing everyone.
ALTER TYPE "WhatsAppCampaignStatus" ADD VALUE IF NOT EXISTS 'paused';
