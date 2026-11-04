-- Audit 7 D17: the day-2 onboarding reminder, once per salon, and its unsubscribe.
ALTER TABLE "tenants" ADD COLUMN "onboardingNudgeSentAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "productTipsOptOutAt" TIMESTAMP(3);
