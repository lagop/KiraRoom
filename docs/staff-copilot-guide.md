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
5 minutos para aprobar; si no, la tarjeta caduca. La tarjeta dice siempre qué
pasó (hecho, cancelada, caducada, sin permiso), también al volver más tarde, y
el Copiloto lo sabe en la siguiente pregunta.

**Redactar un mensaje** no es una acción: el Copiloto te escribe el texto en el
chat y tú lo copias y lo envías. No envía borradores; solo puede enviar
WhatsApp con las plantillas aprobadas.

| Acción | Quién puede | Para qué sirve |
|---|---|---|
| **Enviar un WhatsApp** | dueño, manager, recepcionista, profesional (sus clientas) | Con una plantilla aprobada por Meta. Requiere WhatsApp conectado. |
| **Mover una cita** | manager / recepcionista (cualquier cita) o el propio profesional (sus citas) | Cambia fecha/hora sin abrir el detalle. |
| **Marcar como no-show** | manager / recepcionista | Marca la cita como ausente (sin penalización: el Copiloto no cobra nada). |
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
- **Las conversaciones se eliminan a los 90 días sin actividad.** El registro
  de las acciones aprobadas o rechazadas se conserva 1 año.
- **Datos que ve la IA**: la agenda y, de cada clienta, nombre, alergias,
  historial de citas e importes. Nunca su teléfono, email, fecha de nacimiento
  ni sexo.

## Límites de uso

- **20 mensajes/minuto** por persona.
- **5 acciones/minuto** por persona (los Aprobar/Rechazar cuentan).
- **Tope diario**: 300 preguntas al día por salón (30 durante la prueba
  gratuita). Vuelve a estar disponible al día siguiente.
- **Tope mensual de gasto**: si el gasto real de IA del Copiloto en tu salón
  pasa del tope del mes, se pausa hasta el día 1. Si llegas, escríbenos.
- El Copiloto tiene **su propio contador**: no gasta los mensajes de la
  recepcionista virtual de tus clientas.

## Atajos y tips

- `Ctrl/Cmd + K` — abre/cierra el panel.
- `Esc` — cierra el panel.
- **Nueva conversación** con el icono de arriba a la derecha cuando quieras
  empezar de cero. La anterior no se borra.
- **Historial** — el desplegable de arriba te deja volver a una conversación
  anterior. Las conversaciones se borran solas a los 90 días sin usarse.

## Si el copiloto se equivoca

1. Pulga **👎** debajo de la respuesta y dinos qué esperaba. Esto llega al
   equipo de producto y acelera las mejoras.
2. Si la respuesta no es segura o te preocupa algo: el botón **🐛 Reportar
   problema** arriba a la derecha abre un formulario con contexto técnico.
3. Para soporte inmediato: `info@kiraroom.com`.

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
