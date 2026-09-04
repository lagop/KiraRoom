# Kira Copilot — Guía para administradores del salón

> Audiencia: **dueños y managers** del salón. Cubre el panel de uso, las
> decisiones de coste, y la integración con tu plan.

## Dónde está el panel de uso

`Dashboard → Copiloto → Uso` (ruta: `/dashboard/copilot/usage`). Lo verás
siempre que estés en el plan Pro o Premium.

La página muestra el mes en curso:

- **Mes** (`YYYY-MM`) — el mes que estás consultando.
- **Mensajes usuario / Respuestas IA** — total del mes.
- **Acciones ejecutadas** — total de Aprobar que resultaste en una escritura
  real (mover cita, mandar WhatsApp, etc.).
- **Aprobaciones** — barra apilada con `executed / approved / rejected / expired`.
- **Top 5 conversaciones más activas** — conversaciones con más mensajes.
- **Tope de coste** — banner ámbar si has superado el 3× de la cuota Premium
  ese mes.

## Modelo de pricing

| Plan | Lo que incluye el copiloto |
|---|---|
| **Free / Esencial** | No disponible. |
| **Pro (49 €/mes)** | **Solo lectura.** Briefing + 8 herramientas de lectura. |
| **Premium / Empresa (99 €/mes)** | Lectura + 6 acciones con aprobación humana. |

El copiloto **es el ancla del plan Premium** — la mayoría de las subidas de
plan Pro → Premium vienen motivadas por querer automatizar tareas con el chat
interno (mover citas sin abrir el detalle, mandar recordatorios sin entrar en
WhatsApp Business, etc.).

## Coste real vs. cuota

Cada **turno de conversación** cuenta como 1 uso (no cada tool). Cada
**acción aprobada** cuenta como 1 uso extra. Una conversación típica usa
1-3 turnos. Un equipo de 3 personas que chatee 30 minutos consume
~30-60 turnos ese día.

**Límite duro** (RFC §15.7): cuando el consumo mensual supera **3× la cuota
Premium** (≈ 297 € al precio actual), el copiloto se pausa automáticamente y
se reanuda el día 1 del mes siguiente. Esto es para que un bug nuestro no te
genere una factura sorpresa.

Si llegas a ese límite, el copiloto sigue disponible para responder con la
tarjeta de billing alert; solo no puede hacer nuevas llamadas al LLM.

## Decisiones operativas que puedes tomar

### Promover el copiloto entre tu equipo

1. Comparte la [guía para el equipo](staff-copilot-guide.md).
2. Pide a cada persona que abra el panel al llegar (`Ctrl/Cmd + K`).
3. El briefing diario se auto-carga — no hay que configurar nada.

### Limitar permisos por rol

Los permisos están definidos en el código y son inmutables desde el panel
(la razón: están auditados). Lo que sí puedes controlar:

- **Quién tiene cuenta en el salón**: `Ajustes → Equipo → Usuarios`.
- **Quién puede usar el copiloto**: todos los usuarios con rol distinto de
  `client`. No hay forma de desactivar el copiloto por usuario; si necesitas
  hacerlo, escríbenos y lo añadimos en un sprint.

### Auditoría de acciones

Cada acción queda registrada en:

- `assistant_messages` (rol `approval`) — el texto del preview.
- `action_approvals` — el input completo, el resultado, y quién aprobó.
- `audit_log` — vía `AuditLogService` (ya existe para el resto del panel).

Para una vista rápida: el panel de uso te muestra el desglose por estado
de aprobación.

## Qué monitorizar en el soft-launch

Durante el soft-launch (las primeras 4 semanas con 10 salones), estate atento a:

1. **Tasa de aprobación > 70%** — si baja, las previews son confusas.
   `Uso → Aprobaciones`.
2. **Mensajes / usuario / semana > 25** — engagement real.
3. **Copilot MAU / staff > 60%** — adopción. Si baja del 30% en un salón,
   contacta con esa cuenta.
4. **Errores de tool < 2%** — log en `/saas/admin/assistant/errors`.

## Preguntas frecuentes

**¿Puedo dar Premium solo a una persona de mi equipo?**
No. El copiloto está atado al plan del salón, no al usuario. Si quieres
acceso granular tendrás que esperar a la versión multi-seat (en roadmap).

**¿Y si una clienta pide que no la contacten por WhatsApp?**
El copiloto respeta los consentimientos del cliente (`consentStatus` /
`marketingConsent`). Si la clienta no ha dado consentimiento, el copiloto
ni siquiera propondrá `send_message` para ella.

**¿Puedo exportar las conversaciones?**
Sí: `assistant_conversations` y `assistant_messages` son tablas Prisma
normales. Cualquier admin con acceso a la DB puede exportarlas. Desde el
panel aún no hay UI para esto (lo añadimos en v2).

**¿Puedo cambiar el idioma?**
El copiloto detecta el idioma del usuario (lo que escribe) y responde en
ese idioma. Por defecto sale en español.

---

Si encuentras algo que no funciona como esperabas: `soporte@kirastudio.com`
o pulsa 🐛 en la barra superior del panel — el reporte llega directo a
producto.
