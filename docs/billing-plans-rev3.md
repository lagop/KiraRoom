# Planes de KiraRoom â€” Rev 3 (fuente Ãºnica de verdad)

> Documento de referencia para **ingenierÃ­a, producto y marketing**. Si algo
> entra en conflicto entre cÃ³digo, web de marketing y este documento, gana
> este `.md` y se abren PRs para alinear.

## 1. Planes y precios

| Plan       | Precio (EUR/mes)       | MÃ­nimo | Target                                |
|------------|------------------------|--------|---------------------------------------|
| Esencial   | 49                     | â€”      | PeluquerÃ­as y centros de 1 sede       |
| Pro        | 79                     | â€”      | Centros con marketing, loyalty, IA     |
| Empresa    | 149 Ã— N locales        | 2      | Cadenas con panel centralizado        |

- 14 dÃ­as de prueba Pro incluidos en todos los tenants nuevos.
- Sin coste de alta / setup. Sin free tier perpetuo.
- Multi-idioma (ES / EN) en el producto. Web de marketing debe reflejarlo.

## 2. Matriz plan â†” feature

Definida como fuente Ãºnica en:

- Backend: `packages/backend/src/payments/services/subscriptions.service.ts` (`PLAN_MATRIX` + `plans` registry)
- Frontend: `packages/frontend/src/lib/plans.ts` (`PLAN_MATRIX`)

> **LÃ©yendÃ¡:** âœ… = incluido en el plan,  âž• = disponible como add-on, âŒ = no disponible.

| Feature                      | Esencial | Pro | Empresa | Notas                                               |
|------------------------------|:--------:|:---:|:-------:|-----------------------------------------------------|
| whatsapp_notifications       |   âœ…    | âœ…  |   âœ…    | Reminders + WhatsApp masivo, todos los planes       |
| virtual_receptionist         |   âœ…    | âœ…  |   âœ…    | Chat web IA (base). Cap 500 conv/mes en Esencial   |
| virtual_receptionist_advanced|   âž•    | âœ…  |   âœ…    | Add-on `ai_expansion` para Esencial (24 €/mes)     |
| **multichannel** (H-4)       |   âž•    | âœ…  |   âœ…    | Add-on `multichannel` para Esencial (19 €/mes)     |
| sms_notifications            |   âŒ    | âœ…  |   âœ…    |                                                     |
| email_marketing              |   âž•    | âœ…  |   âœ…    | Add-on `email_marketing` para Esencial (12 €/mes)  |
| loyalty                      |   âž•    | âœ…  |   âœ…    | Add-on `loyalty_giftcards` para Esencial (12 €/mes)|
| promotions                   |   âž•    | âœ…  |   âœ…    | (incluido en `loyalty_giftcards`)                  |
| gift_cards                   |   âž•    | âœ…  |   âœ…    | (incluido en `loyalty_giftcards`)                  |
| wallet                       |   âž•    | âœ…  |   âœ…    | Add-on `wallet_comissions` prÃ³ximamente            |
| commissions                  |   âž•    | âœ…  |   âœ…    | (junto a wallet)                                    |
| advanced_analytics           |   âž•    | âœ…  |   âœ…    | Add-on `advanced_analytics` (prÃ³ximamente)          |
| agenda_shifts                |   âž•    | âœ…  |   âœ…    | (turnos + horarios)                                 |
| multi_location               |   âž•    | âž• |   âœ…    | Empresa (mÃ­n. 1 local, scaling por local)          |
| consolidated_reports         |   âž•    | âž• |   âœ…    | (requiere multi_location)                           |
| api_access                   |   âž•    | âž• |   âž• | **Aparcado** â€” ocultos en catÃ¡logo y UI (rev 3)   |
| white_label                  |   âž•    | âž• |   âž• | **Aparcado** â€” ocultos en catÃ¡logo y UI (rev 3)   |
| custom_branding              |   âž•    | âž• |   âž• | **Aparcado** â€” ocultos en catÃ¡logo y UI (rev 3)   |

> **Cambios recientes (rev 3.5):**
> - `virtual_receptionist` (chat web IA) **bajado a Esencial** (antes Pro+).
> - `virtual_receptionist_advanced` (cancelaciones, reschedules, escalations) sigue Pro+; Esencial lo compra como add-on `ai_expansion`.
> - `multichannel` (H-4) sigue Pro+; Esencial lo compra como add-on `multichannel` (19 €/mes). Detalles en Â§17.

## 3. LÃ­mites por plan

| Plan     | Clientas | Profesionales | Citas / mes | Local | AI recepcionista / mes |
|----------|---------:|--------------:|------------:|------:|----------------------:|
| Esencial |        âˆž |             4 |          âˆž |     1 |                   500 |
| Pro      |        âˆž |            10 |          âˆž |     1 |                  âˆž (ilimitado) |
| Empresa  |        âˆž |          âˆž |          âˆž |   1-N |                  âˆž (ilimitado) |

> **Cambios recientes (rev 3.5):** los lÃ­mites de Esencial se han relajado
> (clientas y citas ahora ilimitadas; profesionales subidos de 3 a 4) para
> que el plan de entrada siga siendo atractivo frente a la competencia.
> El cap real de Esencial es la IA recepcionista (500 conv/mes) y los
> canales disponibles (web sÃ³lo por defecto; multichannel via add-on).

## 4. Add-ons

CatÃ¡logo sembrado en `add_ons` por la migration
`20260721100000_plans_v2_addons` (base) + `20260722230000_addon_multichannel`
(multichannel). Todos con facturaciÃ³n mensual recurrente vÃ­a Stripe
Checkout, excepto `message_bundles` (metered, top-up programÃ¡tico).

| Add-on                  | Precio (EUR/mes) | Desbloquea (FeatureKey)             | Disponible para | Notas                                                                              |
|-------------------------|-----------------:|-------------------------------------|-----------------|------------------------------------------------------------------------------------|
| `ai_expansion`          |               24 | `virtual_receptionist_advanced`     | esencial        | Quita el cap de 500 conv/mes + capacidades avanzadas (cancelaciones, escalations)   |
| `loyalty_giftcards`     |               12 | `loyalty` + `promotions` + `gift_cards` | esencial     | Programa de puntos, promos y gift cards (3 en 1)                                   |
| `email_marketing`       |               12 | `email_marketing`                   | esencial        | CampaÃ±as segmentadas por audiencia                                                  |
| **`multichannel` (H-4)**|           **19**| **`multichannel`**                 | **esencial**    | **Messenger + Instagram + Telegram. Detalles en Â§17**                              |
| `google_reviews_auto`   |               19 | (sin unlocks; funciÃ³n independiente)| esencial        | Automatiza invitaciones a dejar reseÃ±a en Google Business Profile                   |
| `web_domain`            |               15 | (sin unlocks; funciÃ³n independiente)| esencial        | Dominio propio (citas.tunegocio.com) con SSL + SEO                                  |
| `deposits_antinoshow`   |                5 | (sin unlocks; funciÃ³n independiente)| esencial        | SeÃ±al al reservar para reducir no-shows                                             |
| `message_bundles`       |  metered (top-up) | (sin unlocks; consumo de crÃ©ditos)  | todos           | CrÃ©ditos para WhatsApp masivo / SMS marketing. No aparece en la lista; se top-up desde "Bonos" |

**Reglas del catÃ¡logo:**

- **Esencial:** ve los 6 add-ons con `unlocks` (ai_expansion, loyalty_giftcards,
  email_marketing, multichannel) + los 3 sin unlocks (google_reviews_auto,
  web_domain, deposits_antinoshow) = **7 add-ons visibles**.
- **Pro:** ve loyalty_giftcards, email_marketing (los demÃ¡s `unlocks` ya
  estÃ¡n en el plan) + los 3 sin unlocks = **4 add-ons visibles**.
  `ai_expansion` y `multichannel` se ocultan (ya incluidos).
- **Empresa:** idÃ©ntico a Pro. `multi_location` y `consolidated_reports` ya
  incluidos en el plan.
- **Plan upgrade vs add-on:** si un add-on desbloquea algo que ya estÃ¡ en
  el plan del tenant, el catÃ¡logo lo oculta. Implementado en
  `AddOnsService.isRelevantForPlan()` y reflejado en
  `upsellableAddOnsForPlan()`.
- **Stripe price id:** los 6 add-ons no-metered tienen su `price_` id
  almacenado en la columna `add_ons.stripePriceId`. Se rellena
  manualmente en el dashboard de Stripe al crear el producto (ver
  `docs/h4-multichannel-setup.md` Â§2.1).

### 4.1 API de add-ons (tenant-facing)

- `GET  /payments/add-ons/available` â€” catalogo filtrado por plan
- `GET  /payments/tenants/current/add-ons` â€” add-ons instalados
- `POST /payments/add-ons/:key/checkout` â€” crea Stripe Checkout session,
  soporta `body.returnTo` (allow-list de paths same-origin)
- `DELETE /payments/tenants/current/add-ons/:key` â€” cancela

### 4.2 Email de bienvenida

`AddOnsService.provisionFromStripe()` envÃ­a automÃ¡ticamente un email HTML
(escape XSS, `List-Unsubscribe` RFC 8058) al primer owner/admin activo del
tenant cuando la suscripciÃ³n de Stripe pasa a `active` por primera vez
(idempotente: no re-envÃ­a en re-activaciones). El email enlaza al wizard
de canales y a la doc operacional.

## 5. Trial 14 dÃ­as

- Activado en `SaaSService.createTenant` (`subscriptionStatus='trialing'`,
  `trialEnd = now + 14d`).
- `FeatureFlagService.effectivePlan` devuelve `pro` mientras dure el trial.
- `BillingScheduler.expireTrials` corre a diario (4 AM): al expirar,
  `subscriptionStatus='cancelled'`, `cancelledAt=now`,
  `readOnlyUntil=now + 30d`.
- Banner `<TrialBanner />` en el dashboard durante el trial.

## 6. CancelaciÃ³n y modo lectura

- `SubscriptionsService.cancelSubscription` (rev 3):
  - `subscriptionStatus='cancelled'`
  - `cancelledAt=now`, `readOnlyUntil=now + 30d`
  - Plan preservado (memoria para reporting / reactivaciÃ³n)
  - SuscripciÃ³n de Stripe cancelada si existe
- `FeatureFlagService.isEnabled` deniega features para tenants cancelados.
- `FeatureGuard` permite GETs (modo lectura) y bloquea writes con cÃ³digo
  `SUBSCRIPTION_CANCELLED` y `reactivateUrl: '/dashboard/billing'`.
- Tras 30 dÃ­as, `BillingScheduler.archiveStaleReadOnly` registra la
  expiraciÃ³n. Datos intactos; exports CSV/Excel siempre disponibles.

## 7. Multi-location (Empresa)

- `Tenant.maxLocations` (default 1). Empresa requiere N >= 2.
- `createCheckoutSession(plan='empresa', locationCount=N)` con `quantity=N` en
  Stripe y prorrateo al aÃ±adir/quitar local.
- Webhook `customer.subscription.updated` lee `items.data[0].quantity` y
  actualiza `Tenant.maxLocations`.
- Bloqueo: bajar Empresa a menos de 2 locales requiere migrar a Pro.
- `MultiLocationService`:
  - `GET /locations`, `POST /locations`, `PATCH /locations/:id`,
    `DELETE /locations/:id` (soft), `GET /locations/:id/stats`.
  - `GET /multi-location/consolidated` (gated por `consolidated_reports`).
- Frontend: `app/dashboard/multi-location/page.tsx`, envuelto en
  `<PlanGate feature="multi_location">`.

## 8. Aparcados (no ofrecer comercialmente)

- `api_access`, `white_label`, `custom_branding` aparecen en la matriz para
  Empresa, pero **no se exponen** en la UI de upgrade ni en la web de
  marketing. Si en el futuro se decide ofrecerlos, basta con incluirlos en
  `public/plans` y en la pÃ¡gina `/dashboard/billing`.

## 9. Endpoints de billing (backend)

| MÃ©todo | Ruta                                       | Plan / feature gate                |
|--------|--------------------------------------------|------------------------------------|
| GET    | `/payments/subscription/current`           | â€”                                  |
| POST   | `/payments/subscription/checkout`          | â€”                                  |
| POST   | `/payments/subscription/change-plan`       | â€”                                  |
| POST   | `/payments/subscription/cancel`            | â€”                                  |
| POST   | `/payments/subscription/reactivate`        | â€”                                  |
| POST   | `/payments/subscription/update-locations`  | Empresa                            |
| GET    | `/payments/subscription/usage`             | â€”                                  |
| GET    | `/payments/subscription/trial-status`      | â€”                                  |
| GET    | `/payments/subscription/plans`             | â€”                                  |
| GET    | `/locations`                               | `multi_location`                   |
| POST   | `/locations`                               | `multi_location`                   |
| GET    | `/locations/:id`                           | `multi_location`                   |
| PATCH  | `/locations/:id`                           | `multi_location`                   |
| DELETE | `/locations/:id`                           | `multi_location`                   |
| GET    | `/locations/:id/stats`                     | `multi_location`                   |
| GET    | `/multi-location/consolidated`             | `consolidated_reports`             |
| GET    | `/web-domain`                              | â€”                                  |
| POST   | `/web-domain/check-availability`           | â€”                                  |
| POST   | `/web-domain/purchase`                     | â€”                                  |
| POST   | `/web-domain/configure`                    | requiere `web_domain` add-on activo |

## 10. Web de marketing (kairikos.com/peluquerias)

Copy recomendado (ver plan Â§6):

- Sustituir columna "Advanced" por **Empresa / Multi-local** con copy
  "mÃ­n. 2 locales, â‚¬149/local/mes".
- AÃ±adir badge "**14 dÃ­as gratis**" en las 3 cards de plan.
- Mover **WhatsApp** a Esencial.
- Mover "Web con dominio propio + SEO" a secciÃ³n **Add-ons opcionales**.
- **Retirar** menciones a inventario (Esencial), TPV / facturaciÃ³n retail
  (Pro), `setup` / `alta` / `coste de activaciÃ³n`, white-label, API.
- Banner superior: "Plataforma disponible en espaÃ±ol e inglÃ©s".

## 11. P0 â€” Features Prioridad 0 (Roadmap 2026-07-15)

Cinco features shipped en este roadmap; reflejarlas en la web de marketing
(landing principal + secciÃ³n "Funcionalidades"):

| Feature | Plan mÃ­nimo | Tagline corta |
|---|---|---|
| Widget de reserva + QR | Esencial | "Reservas sin salir de tu web: iframe + QR imprimible" |
| ImportaciÃ³n CSV + .ics | Esencial | "MigraciÃ³n en 30 segundos + feeds para tus agendas" |
| Formularios de consentimiento RGPD | Pro | "Cumplimiento legal sin fricciÃ³n para el cliente" |
| ReseÃ±as + Google deep-link | Pro | "MÃ¡s 5â˜… en Google con un clic post-servicio" |
| WhatsApp masivo por tenant | Pro | "CampaÃ±as masivas con tu propio nÃºmero verificado" |

CTA recomendado en cada card: "Ver demo" â†’ enlace al widget pÃºblico `/embed/<demo>`.

## 12. P1 â€” Features Prioridad 1 (Roadmap 2026-07-15)

| Feature | Plan mÃ­nimo | Tagline corta |
|---|---|---|
| Onboarding wizard (3 pasos lineales + checklist persistente) | Esencial | "Configura tu salÃ³n y empieza a recibir reservas en 5 minutos" |
| Rebooking proactivo por cadencia | Pro | "Recordatorios inteligentes que reactivan clientas dormidas sin spam" |
| Fiscal EspaÃ±a (TicketBAI / Verifactu / SII) | Empresa | PrÃ³ximo sprint |
| IntegraciÃ³n contable (Holded / A3 / Sage / NCS) | Empresa | PrÃ³ximo sprint |

P1.3 + P1.4 shipped en este sprint. El onboarding reduce el churn de los primeros 7 dÃ­as y el rebooking aumenta el LTV reactivando clientas con cadencia estable (â‰¥3 visitas previas al mismo servicio).

## 13. P2A â€” Features Prioridad 2 / Fase A (Roadmap 2026-07-16)

| Feature | Plan mÃ­nimo | Tagline corta |
|---|---|---|
| FacturaciÃ³n Verifactu (nacional AEAT) | Pro | "Cumplimiento fiscal automÃ¡tico con AEAT: firma XAdES-BES y QR verificable" |
| FacturaciÃ³n TicketBAI (PaÃ­s Vasco) | Pro | "Compatible con las 3 diputaciones vascas (Bizkaia, Gipuzkoa, Ãlava)" |
| SII â€” Suministro Inmediato de InformaciÃ³n | Empresa | "IVA reportado en tiempo real a la AEAT" |
| Certificados digitales cifrados | Pro | "Sube tu .p12 una vez, lo ciframos en reposo y lo usamos para firmar" |

P2A es la primera mitad de P2. P2B (integraciÃ³n contable con Holded, A3, Sage, NCS) queda para el sprint siguiente.

## 14. P2B â€” Features Prioridad 2 / Fase B (Roadmap 2026-07-16)

| Feature | Plan mÃ­nimo | Tagline corta |
|---|---|---|
| Holded sync | Pro | "Tus facturas sincronizadas automÃ¡ticamente con Holded" |
| Sage Despachos Connected sync | Pro | "Sincroniza con Sage Despachos Connected (EspaÃ±a)" |
| OAuth por tenant con tokens cifrados | Pro | "Tus tokens OAuth nunca se loggean ni se exponen" |

P2B shipped con Holded y Sage REST. A3 (Wolters Kluwer) y NCS quedan diferidos â€” son SOAP con WS-Security, requieren un adapter adicional.


## 15. P2A-hardening — Fiscal Spain production-ready (Roadmap 2026-07-16)

| Feature | Plan minimo | Tagline corta |
|---|---|---|
| XAdES-BES signing real (node-forge + xml-crypto) | Pro | Firma digital AEAT-compatible con PKCS#12 cifrado en reposo |
| Cadena de huella (HuellaAnterior) | Pro | Cada envio encadena el hash del anterior |
| Anulacion AEAT (RegistroAnulacion) | Pro | Anular facturas respeta la trazabilidad fiscal |
| Facturacion rectificativa (serie R) | Pro | Serie R para descuentos y devoluciones parciales |
| Retry queue con backoff 5min/30min/2h | Pro | Los AEAT 503 se reintentan automaticamente |
| Validacion NIF/CIF/NIE (modulo 23) | Pro | El emisor nunca emite con NIF invalido |
| FISCAL_E2E_MODE=stub para CI | Pro | Los E2E corren sin credenciales de sandbox AEAT |

P2A-hardening completa el gap regulatorio que impedia vender el modulo fiscal a un tenant real. El firmador XAdES es **real** (las pruebas E2E verifican que el <ds:Signature> se inserta con SignatureValue no-stub y el cert se embebe en <X509Certificate>). Las stubs HTTP (verifactu, ticketbai, sii, holded, sage) estan **gateadas** tras FISCAL_E2E_MODE=real + endpoint configurado.

## 16. Production-readiness hardening (Roadmap 2026-07-16)

| Feature | Plan minimo | Tagline corta |
|---|---|---|
| Anulacion fiscal real (RegistroAnulacion POST) | Pro | Anular facturas se reporta a AEAT - sin facturas zombie |
| SaaS-admin NIF endpoint + audit log | Pro | SaaS puede setear el NIF emisor desde el panel admin |
| HTTP transport smoke tests (fetch mockeado) | Pro | FISCAL_E2E_MODE=real tiene cobertura en CI aunque use sandbox |
| Frontend NIF input en form create + edit | Pro | Captura NIF/CIF/NIE con validacion de formato |
| Tenant identity badge en dashboard header | Pro | El owner ve el NIF configurado en todo momento |
| Runbook Facturas rechazadas por AEAT | - | El equipo de soporte sabe diagnosticar y recuperar |

P2A + production-hardening deja el modulo fiscal listo para vender a un tenant real en Espana. El firmador XAdES es **real**. Las stubs HTTP (verifactu, ticketbai, sii) estan gateadas tras FISCAL_E2E_MODE=real + endpoints configurados - el plan de despliegue es: instalar sandbox AEAT, setear AEAT_VERIFACTU_ENDPOINT + DIPUTACION_TBAI_*, flip a eal.


## 17. H-4 — Recepcionista virtual multicanal (Roadmap 2026-07-22)

Feature estrella de P2A-receptionist-v2: la recepcionista IA responde a las
clientas en **cuatro canales** (web / Messenger / Instagram DMs / Telegram),
con un solo hilo de conversacion por cliente y persistencia en
`ChatConversation.channel` (enum Postgres `ChatChannel`).

### 17.1 Distribucion por plan

| Canal                       | Esencial | Pro | Empresa |
|-----------------------------|:--------:|:---:|:-------:|
| Web (en la app)             |    âœ…    | âœ…  |   âœ…    |
| Facebook Messenger          |    âž•    | âœ…  |   âœ…    |
| Instagram DMs (Business)     |    âž•    | âœ…  |   âœ…    |
| Telegram (Bot API)          |    âž•    | âœ…  |   âœ…    |

> **Esencial** = solo web (incluido) o los 3 externos vÃ­a add-on
> `multichannel` (19 €/mes).
> **Pro / Empresa** = los 4 canales incluidos en el plan; el add-on estÃ¡
> oculto en el catalogo (ya redundante).

### 17.2 Arquitectura

- `Tenant.features.multichannel` (JSON column) almacena la configuracion:
  - `enabledChannels: string[]` (subset de `web|whatsapp|facebook|instagram|telegram`)
  - `meta: { pageId, pageAccessToken, instagramBusinessAccountId, linkedChats[], webhookSecret? }`
  - `telegram: { botToken, linkedChats[] }`
- `ChannelRegistry` (`packages/backend/src/virtual-receptionist/channels/channel.registry.ts`)
  resuelve `(tenantId, channel) -> ChannelProvider` y enruta el outbound.
- 4 providers: `WebChannelProvider` (no-op), `FacebookMessengerProvider`,
  `InstagramChannelProvider` (misma Graph API, recipient = igsid),
  `TelegramChannelProvider` (Bot API `sendMessage`).
- Webhooks publicos `POST /api/v1/channels/webhooks/{meta,telegram}` con
  verificacion de firma + throttling. **Gate fail-closed**: el controller
  re-chequea el feature `multichannel` para cada mensaje entrante; un
  tenant que pierde el add-on deja de recibir mensajes inmediatamente.
- Persistencia: `ChatConversation.channel` (enum Postgres nuevo en la
  migration `20260722110000_h4_multichannel`) + `linkedChats[]` se rellena
  en runtime al primer mensaje.

### 17.3 Wizard de conexion

UI en `/dashboard/settings/channels` con 3 modales:

- **Meta wizard (4 pasos):** crear Facebook Page â†’ convertir Instagram a
  Business â†’ vincular ambas â†’ pegar `pageId` + `pageAccessToken` + opcional
  `instagramBusinessAccountId` + `webhookSecret`.
- **Telegram wizard (1 paso):** instrucciones de `@BotFather /newbot` +
  paste del token (regex `^\d{6,12}:[A-Za-z0-9_-]{30,}$`).
- **LockedCard:** cuando el plan no incluye multichannel, el wizard se
  sustituye por una CTA ramificada por plan:
  - Esencial â†’ "Comprar add-on Multicanal" (19 €/mes, redirige a
    `/dashboard/billing?buy=multichannel&returnTo=/dashboard/settings/channels`).
  - Otros (defensivo) â†’ "Sube de plan".

### 17.4 Flujo de compra del add-on

```
1. Tenant hace click en CTA
   â†’ GET /dashboard/billing?buy=multichannel&returnTo=/dashboard/settings/channels
2. Billing page (useEffect) detecta el param, valida que el add-on esta
   en el catalogo, auto-abre <ConfirmDialog>
3. Confirmar â†’ POST /payments/add-ons/multichannel/checkout { returnTo }
   (backend sanitises returnTo via allow-list `/dashboard*`)
4. Stripe Checkout session (successUrl/cancelUrl con returnTo)
5. Pago OK â†’ Stripe webhook customer.subscription.created
   â†’ AddOnsService.provisionFromStripe()
   â†’ TenantAddOn row active + COUNTERS.ADDON_PROVISIONED.inc
   â†’ email.sendMultichannelActivated() al owner (idempotente)
6. Stripe redirige a /dashboard/billing?addOn=multichannel&status=success&returnTo=...
   â†’ banner verde 1.2s â†’ redirect al wizard
7. FeatureGuard pasa (multichannel desbloqueado) â†’ wizard funcional
```

### 17.5 Metricas instrumentadas (H-4 counters)

| Counter | Labels | Donde se incrementa |
|---------|--------|---------------------|
| `vrm_channel_inbound_total` | `channel` | `ChannelsWebhookController.handleMeta/handleTelegram` tras el gate |
| `vrm_channel_outbound_total` | `channel`, `result=ok\|skipped\|error` | `ChannelRegistry.send()` |
| `vrm_channel_gate_blocked_total` | `channel`, `reason=no_feature\|lookup_error` | mismo controller cuando el gate falla |

Exposicion:
- **Prometheus** (autoritativa): scrape `GET /internal/metrics`
- **JSON tenant-scoped**: `GET /virtual-receptionist/channels/metrics` (usado
  por la tarjeta live del wizard, polling cada 30s)

### 17.6 Doc operacional

Ver `docs/h4-multichannel-setup.md` para:
- Crear el `multichannel` add-on en Stripe (price + webhooks)
- Aprobar Meta App Review para `pages_messaging` (3-7 dÃ­as habiles)
- Setup de `@BotFather` + `/setwebhook` para Telegram
- Runbook: "messages not received", "paid but wizard still locked"
- ngrok quickstart para dev local

### 17.7 Resumen comercial

- **Esencial** con `multichannel` add-on: 49 + 19 = **68 €/mes** con canales
  → por debajo de Pro (79 €) pero con todo lo demas Esencial.
- **Pro** (79 €/mes): canales incluidos, todo el marketing, loyalty, IA
  avanzada ilimitada.
- **Empresa** (149 €/local/mes): multicanal + multi-local + informes
  consolidados.
- **Margen estimado add-on multichannel:** coste marginal bajo (webhooks
  son publicos; coste de soporte ~5% MRR por App Review de Meta). MRR
  incremental esperado: 8-15% sobre la base Esencial.

## 18. Endpoints nuevos — Sprint 2 / Kind-sailor closeout

Estos endpoints cierran los huecos restantes del plan Kind-sailor (gift-cards
controller, exports module, SMS/WhatsApp gating). Reflejan el estado del
codigo tal como esta en `main`.

### 18.1 Gift Cards (`plan >= pro` o add-on `loyalty_giftcards`)

Controller: `packages/backend/src/gift-cards/`. FeatureKey: `gift_cards`.

| Metodo | Ruta                          | Roles                     | Gate                       |
|--------|-------------------------------|---------------------------|----------------------------|
| GET    | `/gift-cards`                 | owner, admin, staff       | (lectura)                  |
| GET    | `/gift-cards/lookup/:code`    | owner, admin, staff       | (lectura)                  |
| GET    | `/gift-cards/:id`             | owner, admin, staff       | (lectura; ledger incluido) |
| POST   | `/gift-cards`                 | owner, admin              | `@Feature('gift_cards')`   |
| PATCH  | `/gift-cards/:id`             | owner, admin              | `@Feature('gift_cards')`   |
| POST   | `/gift-cards/redeem`          | owner, admin, staff       | `@Feature('gift_cards')`   |
| DELETE | `/gift-cards/:id`             | owner, admin              | `@Feature('gift_cards')`   | (soft delete: `isActive=false`)

Reglas:
- `code` = 12 chars hex (uppercase), unico global.
- `redeem` es atomico (`prisma.$transaction`): escribe `GiftCardTransaction`
  tipo `applied` y decrementa `currentBalance`. Auto-desactiva al llegar a 0.
- Rechaza redeem con `Insufficient balance`, `expired`, `not active`.
- Cancelacion cross-tenant: `findFirst({ id, tenantId })` previene fuga.

### 18.2 Exports (`GET` accesibles siempre, incluso en `cancelled`/`archived`)

Controller: `packages/backend/src/exports/`. **No** aplica `FeatureGuard`,
asi que funciona en cualquier `subscriptionStatus` (modo read-only).

| Metodo | Ruta                                  | Streaming | Formato |
|--------|---------------------------------------|-----------|---------|
| GET    | `/exports/clients.csv`                | papaparse | CSV     |
| GET    | `/exports/clients.xlsx`               | exceljs   | XLSX    |
| GET    | `/exports/appointments.csv/.xlsx`     | ambos     | CSV+XLSX|
| GET    | `/exports/payments.csv/.xlsx`         | ambos     | CSV+XLSX|
| GET    | `/exports/services.csv/.xlsx`         | ambos     | CSV+XLSX|
| GET    | `/exports/professionals.csv/.xlsx`    | ambos     | CSV+XLSX|
| GET    | `/exports/wallet-transactions.csv/.xlsx` | ambos  | CSV+XLSX|
| GET    | `/exports/gift-cards.csv/.xlsx`       | ambos     | CSV+XLSX|

Notas:
- Paginacion cursor-based (`take=1000`, `cursor={id}`, `skip=1` cuando hay cursor).
- XLSX usa `WorkbookWriter` con `stream: res` para no cargar todo en memoria.
- Cap defensivo XLSX: 100 000 filas. Por encima de eso, el cliente recibe
  un `text/csv` con conversion automatica (o un 413 segun politica del
  cliente).
- Aislamiento por tenant: la query siempre lleva `where: { tenantId: req.user.tenantId }`.

### 18.3 SMS (`plan >= pro` o add-on `email_marketing` no aplica; feature es `sms_notifications`)

Controller: `packages/backend/src/sms/`. FeatureKey: `sms_notifications`.

| Metodo | Ruta             | Roles          | Gate                       |
|--------|------------------|----------------|----------------------------|
| GET    | `/sms/status`    | autenticado    | (no gate; solo `{configured}`) |
| POST   | `/sms/test`      | owner, admin   | `@Feature('sms_notifications')` |

`sms.service.ts` (en `notifications/`) sigue siendo el entry point de Twilio.
`SmsController` expone un endpoint admin para verificar wiring sin abrir un
ticket de soporte.

### 18.4 WhatsApp gating (feature `whatsapp_notifications`)

Controller: `packages/backend/src/whatsapp/`. Cambios del closeout:

- `JwtAuthGuard` + `RolesGuard` + `FeatureGuard` a nivel de clase.
- `@Feature('whatsapp_notifications')` solo en los 3 endpoints de campana:
  - `POST /whatsapp/campaigns`
  - `POST /whatsapp/campaigns/:id/send`
  - `GET /whatsapp/campaigns/:id/report`
- Endpoints sin gate (necesarios para conectar antes de pagar): `connect/*`,
  `connection`, `templates`, `disconnect`.
- `MetaWebhookController` (en el mismo archivo) sigue sin gate porque su
  handler esta marcado `@Public()` y no lleva tenant context.

## 19. Regla de fuente unica de verdad

- Cualquier PR que toque `FeatureFlagService`, `FeatureGuard`, `@Feature(...)`,
  `subscriptions.service.ts` (`PLAN_MATRIX` / `plans`), `addons.service.ts`,
  `web-domain`, `multi-location`, `gift-cards`, `exports`, `sms`,
  `whatsapp.controller.ts` o `notifications.module.ts` **debe** actualizar
  este `.md` en el mismo PR.
- La matriz de la seccion 2 debe coincidir byte-a-byte con
  `PLAN_MATRIX` en `subscriptions.service.ts` (revisar en code review).
- Los endpoints de las secciones 9 y 18 deben coincidir con los `@Get/@Post/...`
  decorators reales. El numero de fila "Minimo" en la seccion 1 debe coincidir
  con `plans.empresa.minLocations` en `subscriptions.service.ts`.
- Si hay conflicto, gana este `.md` y se abren PRs para alinear el codigo.
