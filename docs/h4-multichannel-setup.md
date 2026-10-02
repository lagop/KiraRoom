# H-4 Multichannel — Operational runbook

How to provision, configure, and support the Facebook Messenger + Instagram
+ Telegram channels for tenants. Intended audience: SREs, support engineers,
and the SaaS admin.

## 1. Architecture in 60 seconds

- Tenant configuration lives on `Tenant.features.multichannel` (JSON column).
- `GET/PUT /virtual-receptionist/channels/config` (under `FeatureGuard`
  with `@Feature('multichannel')`) reads / writes the config and redacts
  secrets on read.
- Public webhooks `POST /api/v1/channels/webhooks/meta` and
  `.../telegram/:tenantId` receive inbound messages from Meta + Telegram.
  The handler verifies the signature, looks up the tenant by Page id /
  Instagram account id / URL, then **re-checks the `multichannel` feature** —
  if the tenant is not entitled, the message is silently dropped and
  logged at WARN. The drop is fail-closed: any error in the feature check
  also drops the message.
- Accepted messages go to `ChannelReceptionistService` (per-sender queue,
  dedup by message id, 30 messages/sender/hour), which calls the same
  `VirtualReceptionistService.sendMessage` as the web chat.
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

## 3. Meta — Messenger + Instagram (one-time platform setup)

Salons do not paste tokens. In `/dashboard/settings/channels` they click
**Conectar con Facebook**, sign in with Facebook Login (KiraRoom's Meta app),
pick their Page, and the backend:

1. exchanges the code for a long-lived user token and lists the Pages
   (`GET /me/accounts`, Page tokens obtained this way do not expire);
2. subscribes the Page to the app webhook
   (`POST /{page-id}/subscribed_apps?subscribed_fields=messages`);
3. stores the Page token encrypted (`multichannel.meta.pageAccessTokenEnc`)
   and the linked Instagram professional account id, if any.

### 3.1 Meta app (KiraRoom's, once)

1. developers.facebook.com → the KiraRoom app (the same one as WhatsApp).
2. Add products **Messenger** and **Instagram** (Messenger API for Instagram).
3. Facebook Login → Settings → Valid OAuth Redirect URIs:
   `https://api.kiraroom.net/api/v1/channels/meta/callback`
   (`API_BASE_URL` + `/api/v1/channels/meta/callback`).
4. Webhooks: object **Page** and object **Instagram**, callback URL
   `https://api.kiraroom.net/api/v1/channels/webhooks/meta`, verify token =
   `META_WEBHOOK_VERIFY_TOKEN`, field `messages`. Deliveries are signed with
   `META_APP_SECRET` (X-Hub-Signature-256); unsigned ones are refused.
5. Env: `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`,
   `API_BASE_URL`, `OAUTH_STATE_SECRET`. Without `META_APP_ID`/`SECRET` or
   `API_BASE_URL` the settings page says Messenger/Instagram are not
   available yet.

### 3.2 App Review (required before real salons can connect)

Until Meta grants **advanced access** to `pages_show_list`,
`pages_messaging`, `pages_manage_metadata`, `instagram_basic` and
`instagram_manage_messages`, only people with a role in the app (admins,
developers, testers) can complete Facebook Login. Submit the app with a
screencast: owner connects the Page in the channels page, a second account
writes to the Page, the receptionist answers. Business Verification of the
company that owns the app is also required. Typical review time: days.

## 4. Telegram — BotFather flow

1. The salon creates a bot with `@BotFather` (`/newbot`) and copies the token.
2. It pastes the token in `/dashboard/settings/channels → Telegram`.
3. The backend calls `getMe` (rejects unknown tokens), then `setWebhook` with
   `url = API_BASE_URL/api/v1/channels/webhooks/telegram/<tenantId>`,
   a fresh random `secret_token` and `allowed_updates=["message"]`, and stores
   the token encrypted (`multichannel.telegram.botTokenEnc`).
4. Every update must carry `X-Telegram-Bot-Api-Secret-Token` equal to that
   secret; anything else gets 401. Only private chats are answered.

Bots or Pages saved by the first version (clear-text tokens, no webhook) are
shown as "vuelve a conectarla" in the settings page.

## 5. Operational runbook

### 5.1 "My tenant's Telegram messages are not received"

1. `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` → `url` must be
   `.../channels/webhooks/telegram/<tenantId>`; `last_error_message` tells
   why deliveries fail (401 = secret mismatch: reconnect the bot).
2. Logs: `Telegram webhook: tenant <id> lacks the 'multichannel' feature`
   means the plan was downgraded or the add-on cancelled.

### 5.2 "My tenant's Meta messages are not received"

1. Meta App dashboard → Webhooks → recent deliveries. 401 = signature
   (check `META_APP_SECRET`).
2. Logs: `Meta webhook: facebook account <id> is not connected to any salon`
   → the Page in the webhook is not the one stored for the salon; reconnect.
3. For Instagram: the account must be professional, linked to the Page, and
   "Allow access to messages" must be on (Instagram → Settings → Messages).


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