# Gift Cards module

HTTP API for the `gift_cards` plan feature. Closes the gap in the Kind-sailor (Rev. 3) plan §18.1.

## Source of truth

- Plan matrix: `packages/backend/src/payments/services/subscriptions.service.ts` (`PLAN_MATRIX`, `FeatureKey = 'gift_cards'`)
- Feature gate: `packages/backend/src/common/guards/feature.guard.ts` + decorator `@Feature('gift_cards')`
- Source-of-truth doc: `docs/billing-plans-rev3.md` §18.1

## Endpoints

| Method | Path                          | Roles               | `@Feature` gate        | Notes                                              |
|--------|-------------------------------|---------------------|------------------------|----------------------------------------------------|
| GET    | `/gift-cards`                 | owner, admin, staff | (none, read)           | `?page=&limit=&isActive=`                          |
| GET    | `/gift-cards/lookup/:code`    | owner, admin, staff | (none, read)           | For client-facing redeem flow                      |
| GET    | `/gift-cards/:id`             | owner, admin, staff | (none, read)           | Includes transaction ledger                        |
| POST   | `/gift-cards`                 | owner, admin        | `gift_cards`           | Auto-writes `GiftCardTransaction` type `created`   |
| PATCH  | `/gift-cards/:id`             | owner, admin        | `gift_cards`           | Only `isActive`, `expiresAt`, `message` mutable    |
| POST   | `/gift-cards/redeem`          | owner, admin, staff | `gift_cards`           | Atomic; writes `applied` transaction; auto-deactivates at 0 |
| DELETE | `/gift-cards/:id`             | owner, admin        | `gift_cards`           | Soft delete (`isActive=false`)                     |

Behaviour:

- `code` is generated server-side: 12-char hex uppercase, globally unique.
- `redeem` is atomic (`prisma.$transaction`): rejects if `!isActive`, `currentBalance < amount`, or `expiresAt < now`.
- Cross-tenant isolation via `findFirst({ id, tenantId })` — no leakage.

## Plan distribution

| Plan     | `gift_cards`                          |
|----------|---------------------------------------|
| esencial | ❌ — but available via add-on `loyalty_giftcards` (12 €/mes) |
| pro      | ✅                                    |
| empresa  | ✅                                    |

A tenant on `esencial` with the `loyalty_giftcards` add-on active will see the endpoints working because the add-on unlocks the feature key in `FeatureFlagService.evaluate()`.

## curl examples

```bash
# Create a 50 € gift card that expires in 30 days
curl -X POST http://localhost:3001/gift-cards \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "initialAmount": 5000,
    "recipientName": "Ana",
    "recipientEmail": "ana@example.com",
    "message": "Feliz cumple 🎉",
    "expiresAt": "2026-09-12"
  }'

# List active cards
curl http://localhost:3001/gift-cards?isActive=true \
  -H "Authorization: Bearer $JWT"

# Apply 12,50 € to a payment
curl -X POST http://localhost:3001/gift-cards/redeem \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "giftCardId": "...", "amount": 1250, "note": "Pago 2026-08-13" }'
```

## Tests

`gift-cards.service.spec.ts` covers:

1. Create → `currentBalance = initialAmount`, `created` transaction row.
2. Redeem over-balance → `BadRequestException`.
3. Redeem non-existent card → `NotFoundException`.
4. Partial redeem → balance decrements.
5. Balance reaches 0 → `isActive` flips to `false`.
6. Expired card → `BadRequestException`.
7. Cross-tenant redemption → `NotFoundException`.

Run with:

```bash
npm test -- gift-cards
```

## Frontend

`packages/frontend/app/dashboard/gift-cards/page.tsx` provides the UI. Wrapped in `<PlanGate feature="gift_cards">` so Esencial tenants see the upgrade CTA.
