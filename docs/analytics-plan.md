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
presets from `maxMonths` and says "Tu plan muestra hasta N meses" below 12.

## Periods and the location filter

- **Period presets** (S2): "Este mes", "Mes pasado", "Últimos 30 días" and
  "Últimos 3 / 6 / 12 meses" (`this_month`, `last_month`, `last_30_days`,
  `3_months`, `6_months`, `12_months`), the same ids as Multi-local's
  consolidated report (`ANALYTICS_RANGES` in `lib/analytics-format.ts`, the
  API's `rangePeriod`). Every plan has the short ones and 3 months; Pro adds
  6, Empresa 12. The API takes them as `range` on `overview`,
  `client-insights` and `professional-performance`; an unknown range is a
  400, and an "N_months" range longer than the plan is cut to it. `months`
  still works where it did (the dashboard home asks `overview?months=1`).
- **Compared with** (`comparisonPeriod`): this month so far against the same
  days of last month; last month against the whole month before; N months
  against the same days N months earlier; a week against the same weekdays a
  week earlier; today and the last 30 days against the equally long run of
  days just before.
- The status evolution and the monthly rates follow the preset's months (3 for
  the short presets), cut to the plan.
- **Location filter** (Empresa, D12): `locationId` on `overview`,
  `appointment-statuses-evolution`, `appointment-status-by-days`,
  `appointment-rates`, `professional-performance` and `client-insights`.
  It must be one of the salon's own locations: a malformed id is a 400, a plan
  without `consolidated_reports` a 403, another salon's location (or an
  unknown one) a 404. With it:
  - appointments are those booked at the location, plus those with no location
    whose professional works there (their only active location, or their
    primary one): the consolidated report's rule (`analytics-location.ts`,
    `homeLocations`), so both screens agree;
  - occupancy counts that location's professionals only;
  - `tillSales` holds only the services its professionals did at the till
    without an appointment: till sales have no location, so products are left
    out (the card says so);
  - new and recurring clients: served at the location, and "had come before"
    is still asked of the whole salon (a client new to this location who had
    been served at another is not new).
  The overview answers `location: { id, name }` (null for the whole salon)
  and `range` (null when asked by months). The page lists the salon's
  locations (`GET /locations`, closed ones marked) and keeps the "Ver por
  local" link to Multi-local. A "Multi-local" entry sits in Ajustes with the
  Empresa badge.
- **Exportar** (S3): the period's appointments
  (`/api/exports/appointments.csv?dateFrom&dateTo`, by visit day) and payments
  (`/api/exports/payments.csv?dateFrom&dateTo`, by the day they were charged),
  for the page's period. Exports are always the whole salon's.

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
  overview `rates`, `GET appointment-rates`, and per professional. The page
  reads them as they come ("Sobre citas cerradas hasta ayer"): Datos clave
  uses overview `rates`, the percentage chart `appointment-rates?months=`
  `byMonth`, and Profesionales each row's rates ("—" when null); it no longer
  divides counts itself.
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
| `GET overview?range=` or `?months=`, `&locationId=` | owner, admin | any | stats (incl. `totalRevenueWithTill`), `rates`, `tillSales`, occupancy, revenue by month ("YYYY-MM"), service popularity, `range`, `location` |
| `GET appointment-statuses-evolution?months=&locationId=` | owner, admin | any | per-status counts per month |
| `GET appointment-status-by-days?days=&locationId=` | owner, admin | any | status breakdown of the last N days (max 366) |
| `GET appointment-rates?days=` or `?months=`, `&locationId=` | owner, admin | any | closing rates (see above); with `months`, also `byMonth` |
| `GET professional-performance?range=&locationId=` | owner, admin | Pro / Empresa | `range`: today, this_week, last_week, this_month, last_month, last_30_days, 3_months, 6_months, 12_months (default 3_months) |
| `GET client-insights?range=` or `?months=`, `&locationId=` | owner, admin | Pro / Empresa | new, served, recurring clients and retention |

`locationId` needs Empresa (`consolidated_reports`) and one of the salon's
locations; see "Periods and the location filter".

Pro-only endpoints are gated by `@Feature("advanced_analytics")`; a refusal is
the guard's 403 with `code: "FEATURE_NOT_IN_PLAN"` and `upgradeUrl:
"/dashboard/billing"`.

The old `revenue`, `appointments`, `appointment-status-evolution` and
`detailed-report` endpoints were removed: nothing called them, and they took
unbounded date ranges. Any future endpoint that takes explicit dates must
validate them with `explicitPeriod()` (real days, 2000–2100, end ≥ start, at
most the plan's months and 366 days).
