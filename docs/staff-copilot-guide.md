# Kira Copilot — Guía para el equipo del salón

> **P2A-staff-copilot** · Sprint 12-16 · Estado: **GA (soft-launch)**
> Audiencia: dueños, managers, recepcionistas y profesionales del salón.

## Qué es

Kira Copilot es un asistente de IA dentro del panel de tu salón (el icono morado
en la esquina inferior derecha). Te ayuda con preguntas del día a día sobre la
agenda, las clientas, el stock y los huecos libres — y, en el plan Premium,
también ejecuta acciones por ti (mover citas, enviar WhatsApp, crear cupones).

No es el chatbot de la página web (eso es la *Recepcionista Virtual*, que habla
con tus clientas). El copiloto habla **contigo, el equipo**.

## Cómo abrirlo

1. Inicia sesión en el panel (`/dashboard`).
2. Pulsa el botón **✨** flotante de la esquina inferior derecha, o el atajo
   `Ctrl/Cmd + K`.
3. El panel se desliza desde la derecha. La primera vez que lo abres cada día
   verás la **tarjeta de briefing** con un resumen de la jornada.

## Qué puede hacer

### Lectura (todos los planes Pro+)

| Pregunta de ejemplo | Lo que hace |
|---|---|
| *"¿Qué tengo hoy?"* | Muestra tu agenda + huecos + citas por confirmar |
| *"¿Qué le hice a Carmen la última vez?"* | Historial completo de la clienta (sin importes — los estilistas no ven revenue) |
| *"¿Qué huecos tengo esta semana?"* | Lista huecos ≥ 30 min + clientas en lista de espera que podrían llenarlos |
| *"¿Qué tengo que reponer?"* | Productos con stock bajo el umbral |
| *"¿Quién no se presenta?"* | Clientas con ≥ 2 no-shows en los últimos 90 días |
| *"¿Cuáles son mis mejores clientas?"* | Top 10 por gasto / visitas / recencia |

### Acciones (plan Premium)

Todas las acciones **requieren tu confirmación** — el copiloto nunca ejecuta
nada sin que pulses **Aprobar** en la tarjeta que aparece en el chat. Tienes
5 minutos para aprobar; si no, la tarjeta caduca.

| Acción | Quién puede | Para qué sirve |
|---|---|---|
| **Redactar un WhatsApp** | dueño, manager, recepcionista, profesional | Te prepara el texto. Tú lo apruebas y se envía. |
| **Enviar un WhatsApp** | mismo | Igual, pero sin paso de borrador. Requiere WhatsApp conectado. |
| **Mover una cita** | manager / recepcionista (cualquier cita) o el propio profesional (sus citas) | Cambia fecha/hora sin abrir el detalle. |
| **Marcar como no-show** | manager / recepcionista | Marca la cita como ausente, opcionalmente con penalización. |
| **Crear un cupón** | **solo dueño** | Genera un código único (ej. `KIRA-AB12CD`, 1 uso, X% descuento). |
| **Avisar a la lista de espera** | manager / recepcionista | Cuando se libera un hueco, el copiloto propone a quién llamar primero. |

## La tarjeta de briefing

Aparece automáticamente la primera vez que abres el panel cada día. Muestra:

- Tu agenda del día (confirmadas + pendientes)
- Citas por confirmar (con el nombre de la clienta)
- Huecos ≥ 30 min
- Stock bajo (solo manager+)
- Clientas en riesgo (sin venir en 60+ días)

**No se puede descartar para el resto del día.** El objetivo es que siempre
sepas qué pasa antes de empezar a responder preguntas.

## Permisos y privacidad

- **Nadie ve datos que no le corresponden.** Un estilista **nunca** ve revenue
  de otras estilistas, ni puede escribir a clientas que no son suyas.
- **Las acciones pasan siempre por aprobación humana.** Ningún tool se ejecuta
  sin tu clic en "Aprobar". Si el copiloto se equivoca, simplemente rechaza la
  tarjeta.
- **Las conversaciones se eliminan a los 90 días** (salvo que las fijes).
  El log de auditoría de tools se conserva 1 año para compliance.

## Límites de uso

- **60 mensajes/minuto** por usuario (rate limit).
- **5 acciones/minuto** por usuario (los Aprobar/Rechazar cuentan).
- **Tope mensual**: si tu salón consume más de 3× la cuota Premium, el copiloto
  se pausa automáticamente hasta el día 1 del mes siguiente. Si llegas a ese
  límite, escríbenos a soporte.

## Atajos y tips

- `Ctrl/Cmd + K` — abre/cierra el panel.
- `Esc` — cierra el panel.
- **Borra la conversación** con el icono de papelera arriba a la derecha cuando
  quieras empezar de cero (no afecta a la auditoría).
- **Historial** — el panel siempre te muestra los últimos mensajes; para ver
  más, desplázate hacia arriba.

## Si el copiloto se equivoca

1. Pulga **👎** debajo de la respuesta y dinos qué esperaba. Esto llega al
   equipo de producto y acelera las mejoras.
2. Si la respuesta no es segura o te preocupa algo: el botón **🐛 Reportar
   problema** arriba a la derecha abre un formulario con contexto técnico.
3. Para soporte inmediato: `soporte@kiraroom.com`.

## Limitaciones actuales

- **No envía mensajes fuera de plantillas de WhatsApp aprobadas por Meta.** Si
  necesitas algo más libre, edítalo en tu WhatsApp Business antes.
- **No modifica precios, descuentos ni comisiones directamente.** Te sugiere,
  pero la acción final la haces tú desde la pantalla correspondiente.
- **No contesta sobre citas de otros profesionales** (a menos que seas manager).
  Es por privacidad.

## Preguntas frecuentes

**¿Ve mis conversaciones el dueño?**
No. La conversación es por usuario. El dueño puede ver métricas agregadas
(cuántos mensajes, cuántas acciones) en el panel de uso, pero no el contenido.

**¿Y si no tengo WhatsApp conectado?**
El copiloto detecta la falta de conexión y te lo dice. Puedes conectar WhatsApp
en `Ajustes → WhatsApp Business`. Mientras tanto, las herramientas de
redacción siguen funcionando — solo no se pueden enviar.

**¿Puedo desactivar el copiloto para mi usuario?**
Sí, contacta al dueño del salón. Puede hacerlo desde `Ajustes → Equipo →
Permisos`.

---

¿Algo no funciona como esperabas? Pulsa 👎 en cualquier respuesta — tu feedback
llega al equipo y se prioriza en cada sprint.
