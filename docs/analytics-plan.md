# Analítica

How the Analítica page (`/dashboard/analytics`) computes its figures, who sees
what, and which endpoints serve it. The code is the reference:
`packages/backend/src/analytics/analytics-metrics.ts` holds every definition
next to its tests; this page summarises it.

## Who sees it

- Owner and admin only (owner decision 4a). The menu hides it from staff, and
  the page sends any other role back to `/dashboard` before making a request.
- Every `/analytics` endpoint is `SALON_MANAGERS` (also the controller's
  default), so a staff account gets a 403 everywhere. The per-professional staff
  scoping is gone; the dashboard home (`/dashboard`) no longer asks staff for
  the overview or the status counts and hides those cards for them.

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
- **Ingresos** (`revenueCents`): money charged, cents, VAT included, dated by
  the appointment day.
  - A paid, non-cancelled appointment counts its `amountPaid` (net of partial
    refunds) **less what a loyalty reward covered**
    (`discount.loyalty.moneyCents`): points are not revenue, as in Caja and on
    the invoice (D4).
  - A cancelled or no-show appointment counts what the salon **kept** of what
    was paid for it (`amountPaid` still on it, not refunded), less the reward
    (D9).
  - Nothing else: no fallback to the catalogue price; still-open, partly paid
    visits are not revenue yet.
  - Till sales without an appointment are reported apart as `tillSales`
    (products and services, net of refunds); `stats.totalRevenueWithTill` adds
    them to Ingresos.
- **Citas**: appointments dated in the period, cancelled ones excluded.
- **Valor medio por cita**: revenue of the paid appointments divided by them
  (money kept on cancelled visits is revenue, not a ticket).
- **Nuevas clientas**: clients whose **first completed visit** falls in the
  period (salon calendar), compared the same way with the previous period.
  Client records created in the period (imports, contacts, bookings that never
  happened) do not count until the client comes (D7).
- **Multi-service visits** (D5): a visit with two or more services
  (`appointment_services` rows, processing time aside) has its revenue split
  over them in proportion to the list price each was booked at; each part, and
  one booking, goes to its own service and professional. Occupancy charges each
  professional only their own minutes (the agenda's busy blocks, without the
  cleanup).
- **Profesionales** (`professional-performance`, overview `topProfessionals`):
  `revenue` is their share of appointment revenue; `tillServicesCents` the
  services they did that the till sold without an appointment (sale lines of
  kind `service`, net of refunds); `revenueCents` is both ("cobrado, IVA
  incluido", D6). A visit charged at the till is a line of kind
  `appointment`, so nothing is counted twice. Comisiones uses the commission
  base instead (catalogue price, completed visits), so the two can differ.
  Each row also has closing counts and rates (S7).
- **Closing rates** (U9): completion, cancellation and no-show rates are over
  appointments with a closed status (completed, cancelled, no-show) scheduled
  up to yesterday in the salon's calendar; today's and still-open ones are left
  out. Percent with one decimal, `null` when nothing closed. Served as
  overview `rates`, `GET appointment-rates`, and per professional.
- **Clientas recurrentes**: served in the period (at least one completed
  appointment) and either came back within it or had been served before.
  Retention = recurring / served.
- **Ocupación**: booked minutes (non-cancelled) over working minutes from each
  professional's schedule, less approved time off. Professionals without a
  schedule are left out; with none, the rate is "—".
- **Changes** (`revenueChange`, `appointmentsChange`, `clientsChange`,
  `orderValueChange`) are percentages with one decimal, and `null` when the
  previous figure is 0 (the page shows "—, Sin datos del período anterior").

The appointments export (`GET /api/exports/appointments.csv` or `.xlsx`) takes
optional `dateFrom` / `dateTo` salon days, both inclusive; the payments export
already took the Pagos filters.

Money is in cents in every response (`currencyUnit: "cents"`); the page formats
it with `formatCents`.

## Endpoints (`/api/analytics/...`)

| Endpoint | Roles | Plan | Notes |
|----------|-------|------|-------|
| `GET features` | owner, admin | any | `{ hasAdvancedAnalytics, maxMonths }` |
| `GET overview?months=` | owner, admin | any | stats (incl. `totalRevenueWithTill`), `rates`, `tillSales`, occupancy, revenue by month ("YYYY-MM"), service popularity |
| `GET appointment-statuses-evolution?months=` | owner, admin | any | per-status counts per month |
| `GET appointment-status-by-days?days=` | owner, admin | any | status breakdown of the last N days (max 366) |
| `GET appointment-rates?days=` or `?months=` | owner, admin | any | closing rates (see above); with `months`, also `byMonth` |
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
