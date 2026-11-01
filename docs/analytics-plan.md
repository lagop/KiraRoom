# Analítica

How the Analítica page (`/dashboard/analytics`) computes its figures, who sees
what, and which endpoints serve it. The code is the reference:
`packages/backend/src/analytics/analytics-metrics.ts` holds every definition
next to its tests; this page summarises it.

## Who sees it

- Owner and admin only. The menu hides it from staff, and the page sends any
  other role back to `/dashboard` before making a request.
- The backend scopes staff to their own professional on the endpoints open to
  the team (`overview`, `appointment-status-by-days`); a staff account linked
  to no professional gets a 403.

## Plans

The plan is the **effective** plan from `FeatureFlagService` (the same one
`FeatureGuard` uses): a salon on its trial counts as Pro, and legacy names are
normalised (`basic` → Esencial, `professional` → Pro, `advanced` and
`enterprise` → Empresa). An add-on that unlocks `advanced_analytics` counts.

| Plan | History (`maxMonths`) | Profesionales and Clientas tabs |
|------|-----------------------|---------------------------------|
| Esencial | 3 months | locked, with the upgrade card |
| Pro (and trial) | 6 months | yes |
| Empresa | 12 months | yes |

Longer requests are cut to the plan's months. The page builds its period
options (3 / 6 / 12 months) from `maxMonths` and says "Tu plan muestra hasta N
meses" below 12.

## Definitions

- **Periods** are calendar days in the salon's timezone, both ends inclusive.
  "Last N months" is the current month so far plus the N-1 before it. "vs.
  período anterior" compares the same days N months earlier.
- **Ingresos**: `amountPaid` (cents, VAT included, net of partial refunds) of
  appointments marked paid and not cancelled, dated by the appointment day.
  Nothing else: no fallback to the catalogue price. Till sales without an
  appointment are not included.
- **Citas**: appointments dated in the period, cancelled ones excluded.
- **Valor medio por cita**: revenue divided by the paid appointments.
- **Nuevas clientas**: client records created in the period (salon midnight).
- **Clientas recurrentes**: served in the period (at least one completed
  appointment) and either came back within it or had been served before.
  Retention = recurring / served.
- **Ocupación**: booked minutes (non-cancelled) over working minutes from each
  professional's schedule, less approved time off. Professionals without a
  schedule are left out; with none, the rate is "—".
- **Changes** (`revenueChange`, `appointmentsChange`, `clientsChange`,
  `orderValueChange`) are percentages with one decimal, and `null` when the
  previous figure is 0 (the page shows "—, Sin datos del período anterior").

Money is in cents in every response (`currencyUnit: "cents"`); the page formats
it with `formatCents`.

## Endpoints (`/api/analytics/...`)

| Endpoint | Roles | Plan | Notes |
|----------|-------|------|-------|
| `GET features` | team | any | `{ hasAdvancedAnalytics, maxMonths }`; `hasAdvancedAnalytics` is false for staff |
| `GET overview?months=` | team | any | stats, occupancy, revenue by month ("YYYY-MM"), service popularity |
| `GET appointment-statuses-evolution?months=` | owner, admin | any | per-status counts per month |
| `GET appointment-status-by-days?days=` | team | any | status breakdown of the last N days (max 366) |
| `GET professional-performance?range=` | owner, admin | Pro / Empresa | `range`: today, this_week, last_week, this_month, last_month, last_30_days, 3_months, 6_months, 12_months |
| `GET client-insights?months=` | owner, admin | Pro / Empresa | new, served, recurring clients and retention |

Pro-only endpoints are gated by `@Feature("advanced_analytics")`; a refusal is
the guard's 403 with `code: "FEATURE_NOT_IN_PLAN"` and `upgradeUrl:
"/dashboard/billing"`.

The old `revenue`, `appointments`, `appointment-status-evolution` and
`detailed-report` endpoints were removed: nothing called them, and they took
unbounded date ranges. Any future endpoint that takes explicit dates must
validate them with `explicitPeriod()` (real days, 2000–2100, end ≥ start, at
most the plan's months and 366 days).
