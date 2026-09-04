# Kira Copilot — Runbook SaaS

> Audiencia: **equipo de plataforma** (saas_owner). Cubre la operativa:
> soft-launch, métricas, alertas, kill-switch, incidentes.

## Estado actual

| Métrica | Valor objetivo (30 días post-GA) | Tracking |
|---|---|---|
| MAU / total staff | > 60% | `/saas/admin/assistant/usage` |
| Mensajes / usuario / semana | > 25 | idem |
| Aprobaciones ejecutadas | > 70% de pendientes | idem |
| Coste medio por salón/mes | < 30 € | billing events |
| Errores de tool | < 2% | log + Sentry |
| p95 first-token latency | < 1.5 s | `/api/metrics` |

## Soft-launch

### Cómo funciona

Por defecto (sin flag), el copiloto está controlado por las feature keys
`copilot_read` / `copilot_write` — los planes Free no lo ven, Pro ven
lectura, Premium ven todo.

Para el **soft-launch** (sprint 16) sobre 10 salones controlados, hay una
variable de entorno:

```bash
# CSV de tenantIds permitidos durante el soft-launch.
# Si está vacía o no se define, todos los tenants con el plan
# adecuado pueden usar el copiloto.
COPILOT_SOFT_LAUNCH_TENANT_IDS=tenant_a,tenant_b,tenant_c
```

- Si la env var está definida y el tenant NO está en la lista → 403 con
  `code: COPILOT_NOT_IN_SOFT_LAUNCH`.
- Si la env var está vacía → comportamiento normal (todos los planes).
- El equipo de plataforma puede rotar la lista sin redeploy (lectura en
  cada request, sin caché).

### Salir del soft-launch

1. Confirmar que las métricas del sprint 16 están en verde (ver §"Métricas").
2. Vaciar `COPILOT_SOFT_LAUNCH_TENANT_IDS` y redeploy.
3. Anunciar el GA en el changelog público.

## Endpoints internos

| Método | Ruta | Auth | Para qué sirve |
|---|---|---|---|
| `GET` | `/api/v1/assistant/insights/daily` | JWT (panel) | Briefing del día para un usuario |
| `GET` | `/api/v1/assistant/tier` | JWT (panel) | Tier efectivo del tenant |
| `GET` | `/api/v1/assistant/usage` | JWT (panel) | Stats del mes para el tenant |
| `GET` | `/api/v1/saas/admin/assistant/usage` | saas_owner | Stats de TODOS los tenants |
| `POST` | `/api/v1/assistant/feedback` | JWT (panel) | Feedback 👍/👎 de un usuario |
| `GET` | `/api/v1/saas/admin/assistant/feedback` | saas_owner | Aggregated feedback del mes |

## Kill switches

| Flag | Efecto | Default |
|---|---|---|
| `COPILOT_SOFT_LAUNCH_TENANT_IDS` | Whitelist de tenants (vacío = todos) | vacío |
| `COPILOT_DISABLED` (en plan_matrix) | Desactiva `copilot_read` globalmente | false |
| `COPILOT_WRITE_DISABLED` (en plan_matrix) | Desactiva `copilot_write` globalmente | false |
| Tenant `aiFairUseAction='block'` | Auto-pausa el LLM cuando se supera el cap | degrade |

Para pausar TODO el copiloto de emergencia: poner `aiFairUseAction='block'`
en TODOS los tenants con un script:

```sql
UPDATE tenants SET "aiFairUseAction" = 'block' WHERE "aiConversationsUsed" > 0;
```

Y revertirlo:

```sql
UPDATE tenants SET "aiFairUseAction" = 'degrade' WHERE true;
```

## Alertas

| Señal | Umbral | Acción |
|---|---|---|
| Error rate de tool calls | > 5% en 1h | Sentry → oncall |
| p95 latency | > 3 s en 1h | PagerDuty → oncall |
| Coste diario agregado | > 50 € | Slack `#platform-alerts` |
| Conversaciones nuevas / día | < 5 (lunes) | Revisar onboarding |
| Feedback negativo diario | > 10% | Slack `#copilot-quality` |

## Debug

### "¿Por qué este tenant no ve el copiloto?"

1. ¿Está en Free? → No lo verá nunca. Upgrade a Pro.
2. ¿Está en soft-launch whitelist? → Comprobar `COPILOT_SOFT_LAUNCH_TENANT_IDS`.
3. ¿Tiene `subscriptionStatus='cancelled'` o `'suspended'`? → El
   `FeatureGuard` lo bloquea. Reactivar la suscripción.
4. ¿Tiene `aiFairUseAction='block'`? → Limpiar el campo.

### "¿Por qué el copiloto responde en otro idioma?"

El idioma se detecta de la última frase del usuario. Si empieza la
conversación con palabras en otro idioma (ej. inglés), el copiloto cambia.
Se puede forzar a español añadiendo `defaultLocale: 'es'` en el prompt —
no implementado en v1.

### "¿Por qué el copiloto dice 'no sé quién eres'?"

Normalmente: el JWT no trae `userId` o `tenantId`. Comprobar en
`packages/backend/src/auth/strategies/`. Si todo está bien, el staff user
no tiene `Professional` mapeado → `get_my_agenda` devuelve vacío → el
LLM se confunde.

## Incidentes

### 2026-09-XX: el copiloto repetía la misma respuesta

**Síntoma**: usuarios reportan que el copiloto copiaba y pegaba respuestas
de turnos anteriores.
**Causa**: `assistant_messages` con `role: 'approval'` se enviaban al
LLM en el historial. Anthropic rechaza con 400, pero la app devolvía el
último mensaje válido como respuesta.
**Fix**: filtrar `approval`/`system` en `assistant.service.ts:114-138`
(sprint 16).
**Prevención**: el spec de L1 `cp-reschedule-manager` ahora valida que
el segundo turno del manager también funciona.

### 2026-09-XX: el coste se disparó

**Síntoma**: un solo tenant consumió 1000 turnos en 2 horas.
**Causa**: loop infinito entre `get_low_stock` y `get_client_360`.
**Fix**: max-tool-iterations = 5 en `llmService.generateResponse`. Si
vuelve a pasar, bajar a 3.
**Prevención**: cost-protection RFC §15.7 ya está activa.

## Métricas de sprint 16

| Día | MAU | Msgs | Aprobaciones | Coste | Notas |
|---|---|---|---|---|---|
| D+0 | - | - | - | - | Soft-launch activado |
| D+1 | 8 | 240 | 18 | 0.84 € | Salones explorando |
| D+7 | 24 | 1,200 | 145 | 4.20 € | Adopción inicial |
| D+14 | 35 | 2,800 | 412 | 9.80 € | Engagement subiendo |
| D+28 | 52 | 8,500 | 1,400 | 28.00 € | Objetivo: ≥ 30€/salón ok si MAU ≥ 60% |

## Contacto

- **Producto**: `#copilot-product` (Slack interno)
- **Ingeniería**: `#assistant-eng` (Slack interno)
- **On-call**: PagerDuty `kira-platform`
