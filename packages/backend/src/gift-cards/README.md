# Gift Cards module

HTTP API for the `gift_cards` plan feature. Closes the gap in the Kind-sailor (Rev. 3) plan §18.1.

## Source of truth

- Plan matrix: `packages/backend/src/payments/services/subscriptions.service.ts` (`PLAN_MATRIX`, `FeatureKey = 'gift_cards'`)
- Feature gate: `packages/backend/src/common/guards/feature.guard.ts` + decorator `@Feature('gift_cards')`
- Source-of-truth doc: `docs/billing-plans-rev3.md` §18.1

## Endpoints

| Method | Path                          | Roles               | `@Feature` gate | Notes |
|--------|-------------------------------|---------------------|-----------------|-------|
| GET    | `/gift-cards`                 | owner, admin        | `gift_cards`    | `?page=&limit=&isActive=` validated (int, limit ≤ 100): a bad value is a 400 |
| GET    | `/gift-cards/lookup/:code`    | owner, admin, staff | (none)          | The till: code as typed (case, spaces, dashes ignored) |
| GET    | `/gift-cards/:id`             | owner, admin        | `gift_cards`    | Detail with the movements and who made each |
| POST   | `/gift-cards`                 | owner, admin        | `gift_cards`    | Writes a `created` movement; emails the recipient unless `sendEmail: false` |
| PATCH  | `/gift-cards/:id`             | owner, admin        | `gift_cards`    | `isActive`, `expiresAt`, `message`; never reactivates a spent or expired card |
| POST   | `/gift-cards/redeem`          | owner, admin, staff | (none)          | The till; one conditional UPDATE, safe under concurrency |
| DELETE | `/gift-cards/:id`             | owner, admin        | `gift_cards`    | Soft delete (`isActive=false`) |

Lookup and redeem carry no plan gate on purpose: clients paid for their
cards, so they can spend them after the salon downgrades.

Behaviour:

- `code` is generated server-side: 12-char hex uppercase, globally unique.
- Redemption takes the balance in ONE `updateMany` conditioned on
  `isActive`, `currentBalance >= amount` and not expired; a miss re-reads the
  card to say why (Spanish 400), or 409 if it lost a race it could have won.
- `isActive` is only the salon's switch. "Agotada" (balance 0) and
  "Caducada" are derived and returned as `status`.
- Expiry is a salon calendar day stored as 23:59:59.999 of that day in the
  salon's timezone (`gift-card-expiry.ts`); `expiresOn` returns that day.
  Default validity 2 years; past days are refused.
- Every movement records `balanceAfter` and `createdById`.
- Cross-tenant isolation: every query filters by `tenantId`.

## For the POS

`GiftCardsService` (exported by `GiftCardsModule`), all inside the caller's
Prisma transaction:

- `redeemInTx(tx, { tenantId, code | giftCardId, amountCents, paymentId?, userId?, note? })`
- `refundToCard(tx, { tenantId, giftCardId, amountCents, paymentId, userId?, note? })` —
  at most what that payment took from the card, net of earlier refunds.
- `sellInTx(tx, { tenantId, amountCents, paymentId, userId?, recipient…, expiresOn? })`
- `sendCardEmail(tenantId, giftCardId)` — after the sale commits; never throws.

## Plan distribution

| Plan     | `gift_cards`                          |
|----------|---------------------------------------|
| esencial | ❌ — but available via add-on `loyalty_giftcards` (12 €/mes) |
| pro      | ✅                                    |
| empresa  | ✅                                    |

A tenant on `esencial` with the `loyalty_giftcards` add-on active will see the endpoints working because the add-on unlocks the feature key in `FeatureFlagService.evaluate()`.

## curl examples

```bash
# Create a 50 € gift card valid until 30 Sep 2027 (left out: 2 years)
curl -X POST http://localhost:3001/gift-cards \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "initialAmount": 5000,
    "recipientName": "Ana",
    "recipientEmail": "ana@example.com",
    "message": "Feliz cumple 🎉",
    "expiresAt": "2027-09-30"
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

- `gift-cards.service.spec.ts`: issue, expiry, email (mocked), redeem/refund/sell, PATCH rules, reads.
- `gift-cards.controller.spec.ts`: roles and plan gates per route; query/body validation.
- `gift-card-expiry.spec.ts`: salon-day expiry across DST and Canarias; email escaping.
- `gift-cards.l2.spec.ts`: concurrent redemptions and refunds against a real database (skipped without one).

```bash
npx jest src/gift-cards
```

## Frontend

`packages/frontend/app/dashboard/gift-cards/page.tsx` provides the UI. Wrapped in `<PlanGate feature="gift_cards">` so Esencial tenants see the upgrade CTA.
