# SMS module

Owner/admin endpoint for sending a single test SMS. Closes the gap in the Kind-sailor (Rev. 3) plan §18.3.

## Source of truth

- Source-of-truth doc: `docs/billing-plans-rev3.md` §18.3
- Plan matrix: `FeatureKey = 'sms_notifications'` in `PLAN_MATRIX.pro` / `PLAN_MATRIX.empresa`
- Underlying service: `packages/backend/src/notifications/services/sms.service.ts` (was already exposed via Twilio)
- WABA setup: `docs/h4-multichannel-setup.md`

## Endpoints

| Method | Path          | Roles          | `@Feature` gate        |
|--------|---------------|----------------|------------------------|
| GET    | `/sms/status` | authenticated  | (none)                 |
| POST   | `/sms/test`   | owner, admin   | `sms_notifications`    |

### `GET /sms/status`

Returns `{ configured: boolean }` — whether the Twilio env vars are present. Intentionally ungated so an Esencial tenant can verify wiring before deciding to upgrade.

### `POST /sms/test`

Sends a single SMS to the address in the body. Gated by `sms_notifications` so an Esencial tenant without the add-on gets a 403.

Request:
```json
{ "to": "+34612345678", "body": "Test desde KiraStudio" }
```

Response:
```json
{
  "success": true,
  "id": "SMxxxxxxxxxxxx",
  "tenantId": "..."
}
```

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
