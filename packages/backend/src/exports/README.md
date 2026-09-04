# Exports module

Streaming CSV / XLSX export of tenant data. Closes the gap in the Kind-sailor (Rev. 3) plan §18.2.

## Source of truth

- Source-of-truth doc: `docs/billing-plans-rev3.md` §18.2
- Uses no `@Feature()` guard — reachable in **any** `subscriptionStatus` (including `cancelled` and `archived`). This is the deliberate replacement for the read-only export window described in the cancellation lifecycle (rev 3 §6).

## Endpoints

| Method | Path                                          | Format          |
|--------|-----------------------------------------------|-----------------|
| GET    | `/exports/clients.csv` / `.xlsx`              | papaparse / exceljs |
| GET    | `/exports/appointments.csv` / `.xlsx`         | both            |
| GET    | `/exports/payments.csv` / `.xlsx`             | both            |
| GET    | `/exports/services.csv` / `.xlsx`             | both            |
| GET    | `/exports/professionals.csv` / `.xlsx`        | both            |
| GET    | `/exports/wallet-transactions.csv` / `.xlsx`  | both            |
| GET    | `/exports/gift-cards.csv` / `.xlsx`           | both            |

## Streaming

- **CSV**: rows are streamed with `papaparse.unparse` chunk-by-chunk into the `Response`. No full-dataset buffering.
- **XLSX**: `exceljs.stream.xlsx.WorkbookWriter` with `stream: res` — direct streaming to the wire.
- Pagination: cursor-based (`take: 1000`, `cursor: { id: lastId }`, `skip: 1`).
- XLSX safety cap: 100 000 rows. Above that, the client gets a 413 (or a forced CSV fallback — TBD).

## Isolation

Every query is scoped by `req.user.tenantId`. The controller never accepts a tenantId from the query or body. A unit test must assert no cross-tenant rows can leak.

## Headers

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="clients-2026-08-13.csv"
```

```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="clients-2026-08-13.xlsx"
```

## Adding a new entity

1. Add a new case in `ExportsService.fetchPage()` returning a paginated query scoped to `tenantId`.
2. Map the rows to a stable column shape.
3. Add two routes in the controller (`<entity>.csv` + `<entity>.xlsx`).
4. Update `docs/billing-plans-rev3.md` §18.2 table.

## Dependencies

- `papaparse` ^5.5.4 (already in `package.json`).
- `exceljs` ^4.4.0 (added in this sprint; install with `npm install`).
