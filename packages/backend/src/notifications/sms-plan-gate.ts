import type { Logger } from "@nestjs/common";

/** The plan check (FeatureFlagService.isFeatureUnlocked) the automatic SMS need. */
export interface SmsPlanGate {
  isFeatureUnlocked(tenantId: string, key: "sms_notifications"): Promise<boolean>;
}

/**
 * Whether the salon's plan includes the automatic appointment SMS
 * (confirmation, cancellation, change of date, the 24 h and 1 h reminders).
 * They are paid by the platform, so a salon without `sms_notifications`
 * (Esencial) gets the email instead where there is one (audit 7 N8).
 *
 * Without the gate (a unit test that does not wire FeatureFlagModule) the
 * SMS goes as before; a failed check sends none.
 */
export async function salonHasSmsNotices(
  gate: SmsPlanGate | undefined | null,
  tenantId: string | undefined | null,
  logger?: Pick<Logger, "warn" | "log">,
): Promise<boolean> {
  if (!gate) return true;
  if (!tenantId) return false;
  try {
    const included = await gate.isFeatureUnlocked(tenantId, "sms_notifications");
    if (!included) logger?.log(`No automatic SMS for salon ${tenantId}: its plan has no SMS notifications`);
    return included;
  } catch (err) {
    logger?.warn(`SMS plan check failed for salon ${tenantId}: ${(err as Error).message}`);
    return false;
  }
}
