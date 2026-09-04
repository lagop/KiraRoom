import { Injectable } from '@nestjs/common';

export type SubscriptionPlan =
  | 'esencial'
  | 'pro'
  | 'empresa'
  // legacy aliases kept so the helper still returns sensible values
  // for tenants whose `plan` column hasn't been migrated yet
  | 'basic'
  | 'professional'
  | 'advanced';

const LEGACY_MAP: Record<string, SubscriptionPlan> = {
  basic: 'esencial',
  professional: 'pro',
  advanced: 'empresa',
};

const normalize = (plan: SubscriptionPlan): SubscriptionPlan =>
  LEGACY_MAP[plan] ?? plan;

export interface AnalyticsFeatureFlags {
  hasAdvancedAnalytics: boolean;
  hasDetailedReports: boolean;
  hasForecasting: boolean;
  hasExport: boolean;
  maxMonths: number;
}

@Injectable()
export class AnalyticsFlagsService {
  /**
   * Check if user has advanced analytics access
   */
  hasAdvancedAnalytics(plan: SubscriptionPlan): boolean {
    const p = normalize(plan);
    return p === 'pro' || p === 'empresa';
  }

  /**
   * Check if user has detailed reports access
   */
  hasDetailedReports(plan: SubscriptionPlan): boolean {
    const p = normalize(plan);
    return p === 'pro' || p === 'empresa';
  }

  /**
   * Check if user has forecasting features
   */
  hasForecasting(plan: SubscriptionPlan): boolean {
    const p = normalize(plan);
    return p === 'empresa';
  }

  /**
   * Check if user has export features
   */
  hasExport(plan: SubscriptionPlan): boolean {
    const p = normalize(plan);
    return p === 'pro' || p === 'empresa';
  }

  /**
   * Get maximum months of data allowed for the plan
   */
  getMaxMonths(plan: SubscriptionPlan): number {
    const p = normalize(plan);
    switch (p) {
      case 'empresa':
        return 12;
      case 'pro':
        return 6;
      case 'esencial':
      default:
        return 3;
    }
  }

  /**
   * Get all feature flags for a plan
   */
  getFeatureFlags(plan: SubscriptionPlan): AnalyticsFeatureFlags {
    return {
      hasAdvancedAnalytics: this.hasAdvancedAnalytics(plan),
      hasDetailedReports: this.hasDetailedReports(plan),
      hasForecasting: this.hasForecasting(plan),
      hasExport: this.hasExport(plan),
      maxMonths: this.getMaxMonths(plan),
    };
  }

  /**
   * Ensure months parameter doesn't exceed plan limit
   */
  clampMonths(plan: SubscriptionPlan, requestedMonths: number): number {
    const maxMonths = this.getMaxMonths(plan);
    return Math.min(requestedMonths, maxMonths);
  }
}
