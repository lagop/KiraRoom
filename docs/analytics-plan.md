# Analytics Service Implementation Plan

## Overview

> **Status (rev 3):** This document predates the unified plan / feature gating
> rewrite. The current plan matrix lives in
> `packages/backend/src/payments/services/subscriptions.service.ts` and
> `packages/frontend/src/lib/plans.ts`. The `analytics-flags.service.ts` is
> kept in sync as a defence-in-depth check on the analytics endpoints.

This document outlines the plan to implement Basic (Esencial) and Advanced (Pro / Empresa) analytics for the KiraStudio dashboard.

---

## Current State Analysis

### Backend (`packages/backend/src/analytics/`)
- **analytics.service.ts**: Already has comprehensive real data queries from database
- **analytics.controller.ts**: Exposes endpoints for overview, revenue, and appointments reports
- **Existing data points**:
  - Dashboard stats (revenue, appointments, new clients, avg order value)
  - Revenue by month
  - Service popularity
  - Appointment status breakdown
  - Top services and professionals
  - Daily metrics

### Frontend (`packages/frontend/app/dashboard/analytics/page.tsx`)
- Already calls `apiClient.getAnalyticsOverview()`
- Falls back to mock data on API failure (lines 58-99)
- Displays: stats cards, revenue chart, service popularity, appointment status, key insights

### Subscription Model
- **Plans (rev 3)**: `esencial` (€49), `pro` (€79), `empresa` (€149 × locales)
- Legacy aliases `basic` / `professional` / `advanced` / `enterprise` are
  accepted everywhere and mapped to the new plan via
  `SubscriptionsService.normalizePlan`.
- **Plan field**: On `Tenant` model in database
- **JWT**: Already includes `plan` and `subscriptionStatus` (see
  `auth/strategies/jwt.strategy.ts:91-93`).

---

## Proposed Feature Split

### Basic Analytics (Esencial plan)

| Feature | Description |
|---------|-------------|
| **Overview Stats** | Total revenue, appointments, new clients, avg order value |
| **Revenue Chart** | Last 3 months bar chart |
| **Service Popularity** | Top 5 services by appointments |
| **Appointment Status** | Status breakdown (completed, pending, cancelled, no-show) |
| **Time Range** | Last 3 months only |
| **Key Insights** | Basic auto-generated insights |

### Advanced Analytics (Pro & Empresa plans)

| Feature | Description |
|---------|-------------|
| **All Basic Features** | Everything from free tier |
| **Extended Time Range** | 6 months, 12 months options |
| **Revenue Report** | Detailed revenue by day/service/professional |
| **Appointments Report** | Detailed appointment analytics |
| **Trend Analysis** | Month-over-month comparisons |
| **Top Professionals** | Revenue and appointments by staff |
| **Daily Metrics** | Day-by-day performance |
| **Export Features** | Export reports as CSV (future) |
| **Forecasting** | Simple revenue predictions (future) |

---

## Implementation Plan

### Phase 1: Backend Changes

#### 1.1 Update JWT Strategy
**File**: `packages/backend/src/auth/strategies/jwt.strategy.ts`
- Add `plan` field to user object returned from validation
- Include subscription status for feature gating

```typescript
// Add to select in jwt.strategy.ts
select: {
  // ... existing fields
  tenant: {
    select: {
      plan: true,
      subscriptionStatus: true,
    },
  },
}
```

#### 1.2 Create Analytics Feature Flags Service
**File**: `packages/backend/src/analytics/analytics-flags.service.ts` (new)
- Check user's plan eligibility for features
- Methods: `hasAdvancedAnalytics(user)`, `getMaxMonths(user)`

#### 1.3 Update Analytics Controller
**File**: `packages/backend/src/analytics/analytics.controller.ts`
- Add plan check for advanced endpoints
- New endpoints for advanced features:
  - `GET /analytics/revenue-detailed` (paid)
  - `GET /analytics/appointments-detailed` (paid)
  - `GET /analytics/forecasts` (paid - future)

#### 1.4 Update Analytics Service
**File**: `packages/backend/src/analytics/analytics.service.ts`
- Add plan-aware methods
- Implement `getDetailedReport(tenantId, plan, options)`

---

### Phase 2: Frontend Changes

#### 2.1 Update API Client
**File**: `packages/frontend/lib/api.ts`
- Add methods to check plan status
- Add methods for advanced analytics endpoints

```typescript
// Add to api.ts
async getPlanStatus(): Promise<{ plan: string; status: string }> {
  return this.request('/auth/plan-status');
}
```

#### 2.2 Create Analytics Hook
**File**: `packages/frontend/src/hooks/useAnalytics.ts` (new)
- Manage analytics data loading
- Handle plan-based feature access
- Provide upgrade prompts

#### 2.3 Update Analytics Page
**File**: `packages/frontend/app/dashboard/analytics/page.tsx`
- Integrate plan checking
- Show upgrade prompt for locked features
- Add UI for advanced features when on paid plan
- Improve error handling (don't default to mock data)

#### 2.4 Create Upgrade Prompt Component
**File**: `packages/frontend/src/components/analytics/UpgradePrompt.tsx` (new)
- Show when free user tries to access advanced features
- Link to subscription upgrade page

---

### Phase 3: UI/UX Improvements

#### 3.1 Add Feature Badges
- Show "Pro" or "Advanced" badges on paid features
- Lock icons on disabled features

#### 3.2 Add Time Range Selector
- Free: 3 months max
- Paid: 6 months, 12 months options

#### 3.3 Add Export Buttons (Future)
- CSV export for reports

---

## Database Changes

No new tables required. Using existing:
- `Tenant.plan` - subscription plan
- `Tenant.subscriptionStatus` - subscription status
- Existing analytics data from appointments, clients, services

---

## API Endpoints

### Existing (keep)
```
GET /api/analytics/overview?months=3|6|12
GET /api/analytics/revenue?startDate=&endDate=
GET /api/analytics/appointments?startDate=&endDate=
```

### New Advanced Endpoints
```
GET /api/analytics/detailed-report?startDate=&endDate=&type=revenue|appointments
GET /api/analytics/professional-performance?months=3|6|12
GET /api/analytics/client-insights?months=3|6|12
```

---

## Implementation Order

1. **Update JWT Strategy** - Add plan to user context
2. **Create Analytics Flags Service** - Feature gating logic
3. **Update Controller** - Add plan checks
4. **Update API Client** - Add plan status method
5. **Update Analytics Page** - Connect to plan-aware endpoints
6. **Add Upgrade UI** - Locked feature prompts
7. **Test** - Verify free vs paid behavior

---

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `packages/backend/src/analytics/analytics-flags.service.ts` | Feature gating |
| `packages/frontend/src/hooks/useAnalytics.ts` | Analytics data hook |
| `packages/frontend/src/components/analytics/UpgradePrompt.tsx` | Upgrade UI |
| `docs/analytics-plan.md` | This document |

### Modified Files
| File | Changes |
|------|---------|
| `packages/backend/src/auth/strategies/jwt.strategy.ts` | Add plan to user |
| `packages/backend/src/analytics/analytics.controller.ts` | Add plan checks, new endpoints |
| `packages/backend/src/analytics/analytics.service.ts` | Plan-aware methods |
| `packages/frontend/lib/api.ts` | Plan status, advanced endpoints |
| `packages/frontend/app/dashboard/analytics/page.tsx` | Plan integration |

---

## Notes

- The backend analytics service already fetches real data - the issue is the frontend is falling back to mock data
- Need to ensure JWT includes plan information
- Analytics settings tab shows "Próximamente" - this should be replaced with actual plan-based access
- Consider adding a "plan status" endpoint that frontend can call to determine UI
