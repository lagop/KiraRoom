import { Injectable } from "@nestjs/common";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { PlanId } from "../payments/services/subscriptions.service";
import { SALON_MANAGERS } from "../auth/decorators/roles.decorator";

/**
 * What the Analítica page may show, per salon and per role.
 *
 * The plan comes from FeatureFlagService, the same source FeatureGuard uses:
 * the effective plan (a trial counts as Pro, legacy names such as
 * "enterprise" are normalised) plus active add-ons. This service used to read
 * the stored plan from the JWT and keep its own alias map, so a salon on its
 * Pro trial got the Esencial page and a 403 from endpoints the guard had just
 * let through, and an "enterprise" row was treated as Esencial.
 */
export interface AnalyticsFeatureFlags {
  /**
   * The Profesionales and Clientas tabs (Pro and Empresa, trial included).
   * Always false for staff: those endpoints are for whoever runs the salon.
   */
  hasAdvancedAnalytics: boolean;
  /** Months of history the plan shows (Esencial 3, Pro 6, Empresa 12). */
  maxMonths: number;
}

/** Months of history per (normalised) plan. */
const MAX_MONTHS: Partial<Record<PlanId, number>> = {
  esencial: 3,
  pro: 6,
  empresa: 12,
};

export function maxMonthsForPlan(plan: PlanId | null | undefined): number {
  return (plan && MAX_MONTHS[plan]) || 3;
}

@Injectable()
export class AnalyticsFlagsService {
  constructor(private readonly featureFlags: FeatureFlagService) {}

  /**
   * The effective plan and whether it (or an add-on) includes advanced
   * analytics. A cancelled or suspended salon keeps its plan's view: the
   * analytics endpoints are reads, and FeatureGuard lets reads through in
   * read-only mode.
   */
  private async entitlement(
    tenantId: string,
  ): Promise<{ plan: PlanId; advanced: boolean }> {
    const ctx = await this.featureFlags.getContext(tenantId);
    if (!ctx) return { plan: "esencial", advanced: false };
    const advanced =
      ctx.planFeatures.includes("advanced_analytics") ||
      ctx.addonsUnlocked.includes("advanced_analytics");
    return { plan: ctx.plan, advanced };
  }

  async getMaxMonths(tenantId: string): Promise<number> {
    return maxMonthsForPlan((await this.entitlement(tenantId)).plan);
  }

  /** `requested` cut to the plan's history; `fallback` when it is not a positive number. */
  async clampMonths(tenantId: string, requested: number, fallback = 6): Promise<number> {
    const months =
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback;
    return Math.min(months, await this.getMaxMonths(tenantId));
  }

  async getFeatureFlags(tenantId: string, role: string): Promise<AnalyticsFeatureFlags> {
    const { plan, advanced } = await this.entitlement(tenantId);
    const manager = (SALON_MANAGERS as string[]).includes(role);
    return {
      hasAdvancedAnalytics: manager && advanced,
      maxMonths: maxMonthsForPlan(plan),
    };
  }
}
