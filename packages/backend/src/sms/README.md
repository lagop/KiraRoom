# SMS module

Whether the platform SMS provider is configured. The test-send endpoint (`POST /sms/test`) was removed in the channels audit (M8): it let a salon send any text to any number at the platform's cost.

## Source of truth

- Source-of-truth doc: `docs/billing-plans-rev3.md` §18.3
- Plan matrix: `FeatureKey = 'sms_notifications'` in `PLAN_MATRIX.pro` / `PLAN_MATRIX.empresa`
- Underlying service: `packages/backend/src/notifications/services/sms.service.ts` (was already exposed via Twilio)
- WABA setup: `docs/h4-multichannel-setup.md`

## Endpoints

| Method | Path          | Roles          | `@Feature` gate        |
|--------|---------------|----------------|------------------------|
| GET    | `/sms/status` | authenticated  | (none)                 |

### `GET /sms/status`

Returns `{ configured: boolean }` — whether the Twilio env vars are present. Intentionally ungated so an Esencial tenant can verify wiring before deciding to upgrade.

## Pattern note

`SmsService` already lived in `notifications/`. The new `SmsController` imports it via `NotificationsModule.exports` (which already includes `SmsService`). No new exports needed.

## Plan distribution

| Plan     | `sms_notifications`        |
|----------|---------------------------|
| esencial | ❌                        |
| pro      | ✅                        |
| empresa  | ✅                        |

## Related

- WhatsApp campaign endpoints (`packages/backend/src/whatsapp/whatsapp.controller.ts`) are now gated by `@Feature('whatsapp_notifications')` only on the 3 campaign endpoints. The OAuth / connection endpoints remain ungated so tenants can connect before upgrading.
