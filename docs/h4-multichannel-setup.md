# H-4 Multichannel — Operational runbook

How to provision, configure, and support the Facebook Messenger + Instagram
+ Telegram channels for tenants. Intended audience: SREs, support engineers,
and the SaaS admin.

## 1. Architecture in 60 seconds

- Tenant configuration lives on `Tenant.features.multichannel` (JSON column).
- `GET/PUT /virtual-receptionist/channels/config` (under `FeatureGuard`
  with `@Feature('multichannel')`) reads / writes the config and redacts
  secrets on read.
- Public webhooks `POST /api/v1/channels/webhooks/{meta,telegram}` receive
  inbound messages from Meta + Telegram. The handler looks up the tenant
  by pageId / chat_id, then **re-checks the `multichannel` feature** —
  if the tenant is not entitled, the message is silently dropped and
  logged at WARN. The drop is fail-closed: any error in the feature check
  also drops the message.
- The orchestrator uses `ChannelRegistry.send(tenantId, channel, ...)`
  to dispatch outbound replies. Each provider (`FacebookMessengerProvider`,
  `InstagramChannelProvider`, `TelegramChannelProvider`) is responsible
  for serialising its own API call.

## 2. Stripe — provisioning the add-on

The `multichannel` add-on is sold to **Esencial** tenants at **€19/month**
(Pro / Empresa get the feature in their plan; the add-on is hidden in the
catalog for them).

### 2.1 One-time Stripe dashboard setup

1. Open the Stripe dashboard → **Products** → **Add product**.
2. Name: `Multicanal`, Statement descriptor: `KIRA MULTICANAL`.
3. Pricing model: **Recurring**, price `19 EUR`, billing period `Monthly`.
4. Save and copy the **API ID** (`price_…`). This is the
   `stripePriceId` we need to persist.
5. Open the SQLite `add_ons` table in the backend DB (or use Prisma
   Studio) and update the row:

   ```sql
   UPDATE add_ons
      SET "stripePriceId" = 'price_XXXXXXX'
    WHERE key = 'multichannel';
   ```

   After this, `POST /api/v1/payments/add-ons/multichannel/checkout`
   will create a live Stripe Checkout session.

### 2.2 Webhook events to subscribe

Already wired in the existing `stripe-webhook.controller.ts`:

- `customer.subscription.created` — provisions `TenantAddOn` row.
- `customer.subscription.updated` — updates status (active / past_due /
  cancelled).
- `customer.subscription.deleted` — marks `cancelled`.
- `invoice.paid` — confirms payment, re-activates if previously past_due.

The `AddOnsService.provisionFromStripe` reads `metadata.kind === 'addon'`
plus `metadata.add_on_key === 'multichannel'` to know which row to write.
No additional wiring needed for the multichannel add-on specifically.

## 3. Meta — App Review for `pages_messaging`

### 3.1 One-time Meta App setup

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My
   Apps** → **Create App** → type **Business**.
2. Add products: **Messenger** + **Instagram** (use the same Facebook
   App for both; the wizard handles both with one token).
3. In **Messenger → Settings**, link the Facebook Page that will receive
   the messages.
4. In **Instagram → API setup with Instagram Business**, link the
   Instagram Business account (must be a Business / Professional account,
   not Personal — see wizard step 2).
5. Generate a **Page access token** (long-lived):
   - User Token → Page Token → "Add permanent permissions":
     `pages_messaging`, `pages_manage_metadata`, `instagram_basic`,
     `instagram_manage_messages`.

### 3.2 App Review

The default token only works for the App admin + Developer + Tester
roles. For real salon tenants, the App needs **`pages_messaging`**
approved by Meta.

1. Submit the App for review: **App Review → Permissions and Features →
   Request advanced access for `pages_messaging`**.
2. Provide a screencast walkthrough showing the salon owner
   - pasting their `pageId` + token in `/dashboard/settings/channels`
   - sending a test message from a non-admin Facebook account
   - receiving an AI reply
3. **Common rejection reasons and fixes:**
   - "We couldn't verify the feature works end-to-end" → include a
     live screencast with a real second account, not just curl.
   - "Screenshots don't show the user role" → put the test account
     in the role header on every screen.
   - "Privacy policy missing" → point to your app's privacy URL
     (KiraRoom's privacy page is fine).
4. Average review time: **3-7 business days**. Plan ahead.
5. Once approved, all salons can paste their own `pageId` + long-lived
   token in the wizard without further per-tenant review.

### 3.3 Webhook configuration in Meta

1. In the App Dashboard → **Messenger → Settings → Webhooks**.
2. **Callback URL**: `https://<your-api-host>/api/v1/channels/webhooks/meta`
   (the wizard shows this exact URL on the page).
3. **Verify token**: any random string the tenant pastes in the wizard
   (stored as `multichannel.meta.webhookSecret`). The backend reads it
   and includes it in the `X-Hub-Signature-256` check.
4. **Webhook fields** to subscribe:
   - `messages` (text inbound)
   - `messaging_postbacks` (button responses, future-proofing)
   - `message_deliveries` (delivery receipts, no-op)
   - `message_reads` (read receipts, no-op)

## 4. Telegram — BotFather flow

1. Open Telegram, search for `@BotFather`, send `/start`.
2. Send `/newbot`, follow prompts:
   - Bot name: e.g. `Mi Salón Recepcionista`.
   - Username: must end in `bot`, e.g. `mi_salon_recepcionista_bot`
     (globally unique; 5-32 chars, alphanumeric + underscores).
3. BotFather replies with the **bot token** in the format
   `1234567890:ABCDEFGHIJKLMNOPQRSTUVWXyz12345`.
4. Tenant pastes the token in `/dashboard/settings/channels → Telegram`.
5. Backend validates it (`^\d{6,12}:[A-Za-z0-9_-]{30,}$`), persists to
   `multichannel.telegram.botToken` (encrypted at rest by the DB column
   policy; never echoed back through the GET endpoint).
6. Optionally register the webhook via `@BotFather /setwebhook`:
   - URL: `https://<your-api-host>/api/v1/channels/webhooks/telegram`
   - The bot token is used as the secret token (`X-Telegram-Bot-Api-Secret-Token`).

> **Don't skip this**: if you forget `/setwebhook`, Telegram uses long
> polling instead and you'll see `409 Conflict: terminated by other
> getUpdates` in the logs.

## 5. Operational runbook

### 5.1 "My tenant's Telegram messages are not received"

1. Check the bot token is valid: `curl https://api.telegram.org/bot<TOKEN>/getMe`
   → expect `{"ok":true, ...}`.
2. Check the webhook is set: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
   → expect `"url": "https://.../api/v1/channels/webhooks/telegram"`.
3. Check the tenant's `multichannel.telegram.linkedChats` array in the
   DB. The very first message from a chat ID is what writes it
   (see Paso 7 of the H-4 plan: `linkedChats` runtime population).
4. Check the backend logs for `Telegram webhook: tenant <id> lacks the
   'multichannel' feature` — if present, the tenant's plan has been
   downgraded or the add-on was cancelled.

### 5.2 "My tenant's Meta messages are not received"

1. Check the webhook is healthy in the Meta App dashboard
   (Webhooks → Active fields, Recent deliveries).
2. If Meta reports redeliveries with HTTP 403, the `FeatureGuard` is
   rejecting the request → check the tenant's entitlement.
3. If Meta reports `400 invalid_page_id` → the pageId pasted in the
   wizard is wrong; ask the tenant to re-paste from
   developers.facebook.com → their App → Messenger → Settings.

### 5.3 "Tenant paid for the add-on but the wizard still shows the lock"

1. Check the Stripe webhook was delivered (dashboard → Webhooks →
   Logs). The relevant event is `customer.subscription.created` or
   `invoice.paid`.
2. Check the `TenantAddOn` row was created:
   ```sql
   SELECT * FROM tenant_add_ons
    WHERE "tenantId" = '<tenant-id>'
      AND "addOnId" = (SELECT id FROM add_ons WHERE key = 'multichannel');
   ```
   If absent, the Stripe webhook handler didn't run. Check the
   `metadata.kind === 'addon'` and `metadata.add_on_key === 'multichannel'`
   fields on the Stripe SubscriptionItem.
3. If the row exists but the wizard is still locked, the
   `addonsUnlocked` array on `FeatureFlagContext` is stale → ask the
   user to hard-refresh. The feature flag is read on every request so
   there is no cache to invalidate.

## 6. Local dev quickstart

For engineers running KiraRoom locally:

```bash
# 1. Apply the multichannel migration
cd packages/backend
npx prisma migrate deploy

# 2. (optional) Grant the multichannel add-on manually for dev
psql -d kiraroom -c "INSERT INTO tenant_add_ons (id, \"tenantId\", \"addOnId\", status, \"startedAt\")
  SELECT 'dev-grant', t.id, a.id, 'active', now()
  FROM tenants t, add_ons a WHERE t.slug = 'dev-salon' AND a.key = 'multichannel';"

# 3. Test the wizard end-to-end:
#    - Login as the dev salon owner.
#    - Visit /dashboard/settings/channels.
#    - For Meta: paste any 15-digit pageId + a fake EAA… token; the
#      outbound Graph call will fail but the wizard will save.
#    - For Telegram: paste a fake token; the wizard accepts the format
#      without hitting the Bot API.

# 4. To simulate a real webhook, ngrok your local server:
ngrok http 3001
# Then set the ngrok URL as the webhook URL in Meta / Telegram.
```