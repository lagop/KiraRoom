# Copilot Discovery — Simulated Salon Owner Interview

| Field | Value |
|---|---|
| **Date** | 2026-09-03 |
| **Method** | Simulated interview (no live customer available in the dev environment) |
| **Interviewee persona** | **María**, 38, owner-manager of *Estudio Menta* (a 4-chair salon in Madrid) |
| **Interviewer** | Product engineer (Kira Room) |
| **Status** | **DRAFT** — must be re-run with 5 real salon owners before sprint 12 starts |

> **Important note:** this document is a single simulated response, **not a substitute for the 5 real interviews** the RFC recommends. The team should still run real interviews before committing tool priorities. This document seeds the discussion and gives a first-draft persona to react against.

---

## 1. Salon context (as told by María)

> "Mira, llevo 8 años con el salón. Empecé yo sola y ahora somos cuatro: yo, Lucía que es la recepcionista, y dos chicas más. Atendemos unas 25-30 clientas al día. La mayoría son fijas, vienen cada 4-6 semanas. El ticket medio anda por los 45€. La competencia son tres peluquerías más en la misma calle."

- **Average daily appointments:** ~25-30
- **Average ticket:** ~45€
- **Recurring clients:** majority
- **Tools currently used:** WhatsApp Business for everything (literally everything), Excel for commissions, the salon management app for bookings
- **Pain point #1 (unprompted):** "WhatsApp me come la vida. Por la noche me llegan 15 mensajes, y por la mañana tengo que contestarlos uno por uno. Si alguien me cancela, me toca re-bookear a mano, y muchas veces se queda el hueco vacío."

---

## 2. The interview (in Spanish, lightly edited for clarity)

> **Q1. Cuéntame un día normal en el salón. ¿Qué tareas te consumen más tiempo?**
>
> "Lo más pesado es por la mañana. Abro la app, miro quién viene hoy, y luego miro WhatsApp para ver si alguien ha cancelado. Si ha cancelado, llamo a la lista de espera — manualmente, una por una. Y la mayoría de las veces nadie coge. Luego, a media tarde, miro qué productos me quedan, y a veces me llevo un disgusto porque se me ha acabado el tinte 7.3 justo cuando tengo una coloración."
>
> "Y luego al final del día, Lucía me pasa las comandillas en una hoja. Yo las meto en el sistema a mano. Eso son 30 minutos más."

> **Q2. ¿Qué decisiones te gustaría tomar más rápido o con más información?**
>
> "Si alguien cancela con 2 días, ¿qué hueco se me queda libre? ¿Hay alguien en lista de espera que le encaje? Ahora lo miro y es un caos. A veces la clienta que quería ese hueco ni está en la lista, pero la tengo en el móvil porque vino hace 6 meses."
>
> "Y cuando voy a comprar producto, muchas veces compro por costumbre y acabo con stock que no necesito. Si supiera qué uso de verdad cada mes, compraría mejor."

> **Q3. Si pudieras escribirle un mensaje a tu salón ideal y que la IA te lo resumiera, ¿qué le preguntarías?**
>
> "Todos los días, lo primero. ¿Qué tengo hoy? ¿Quién no ha confirmado? ¿Qué huecos tengo y a quién puedo llamar? Si hay algo urgente, dímelo."
>
> "Y durante el día: '¿qué le hice a Carmen la última vez?', '¿cuánto tinte 7.3 me queda?', 'recuérdale a Marta que viene el jueves'."

> **Q4. ¿Qué cosas harías delegar a la IA pero no te fías de delegar sin ver?**
>
> "Citas. Jamás. Que rebookee, que cambie una hora, vale. Pero que confirme una cita sin que yo la vea, no. La cita es sagrada, si la IA se inventa un horario y la clienta se presenta cuando no es, la pierdo para siempre."
>
> "Mensajes de WhatsApp, los puedo dejar que los escriba, pero los reviso antes de enviar. Que mande un recordatorio automático de 'tu cita es mañana' me parece bien — es impersonal, no me arriesgo."

> **Q5. ¿Tienes clientes que te gustaría reactivar pero no llegas?**
>
> "Sí, montones. Tengo clientas que hace 4-5 meses que no vienen y que antes venían cada 3 semanas. Sé que se han ido a otro sitio o que se han aburrido. Pero no tengo tiempo de mandarles un WhatsApp una por una. Si la IA me dijera 'estas 12 clientas llevan más de 60 días sin venir, ¿les mando este mensaje?', sería oro."

> **Q6. ¿Qué te gustaría que la IA NO hiciera?**
>
> "Que no me cambie las cosas sin preguntarme. Que me avise antes. Y sobre todo, que no me invente precios ni productos. El otro día una IA me dijo que un cliente había pagado 200€ por un servicio de 45€ — y casi lo doy por bueno, hasta que vi la transferencia. Menudo susto."

> **Q7. ¿Cómo quieres que te hable la IA?**
>
> "Como Lucía. Directa, sin florituras. Si me tiene que decir que he facturado poco hoy, que me lo diga. Si me dice que María lleva 90 días sin venir, que me diga 'María, 90 días, riesgo de pérdida, ¿le mando este WhatsApp?'. Sin 'espero que estés teniendo un día maravilloso'."

---

## 3. Synthesis — what María's answers imply for the v1 tool set

Each row maps a real pain → the tool that solves it, ranked by **frequency × business impact**.

### Tier 1 — must-have for sprint 12 (read-only)

| # | Tool | Pain it addresses | Why it's first | Frequency |
|---|---|---|---|---|
| 1 | `get_my_agenda` (extended: today's appointments + gaps + unconfirmed) | "abro la app y quiero saber qué tengo hoy" — answered at first daily open | Highest frequency (every working day, first thing) | Daily |
| 2 | `find_filling_opportunities` | "si alguien cancela, llamo a la lista de espera manualmente" | Highest revenue impact (empty chair = lost revenue) | 2-3×/week |
| 3 | `get_client_360` | "qué le hice a Carmen la última vez?" — staff turnover is brutal, owner often doesn't remember | Highest cognitive load; this is the "second brain" use case | Multiple times / day |
| 4 | `get_no_show_history` | "no-shows" is the #1 revenue leak for service businesses | The user can act on this list (call them, send a reminder) | Weekly review |

### Tier 2 — sprint 13 (still read-only, more breadth)

| # | Tool | Pain | Why defer to sprint 13 |
|---|---|---|---|
| 5 | `get_low_stock` | "se me acabó el tinte 7.3 justo con una coloración" | Already served by the daily briefing; can wait |
| 6 | `get_revenue_breakdown` | "cuánto facturé esta semana?" | Owner wants this once a week, not daily |
| 7 | `get_top_clients` | Feed the re-engagement campaign | Needed for tier 2 write actions (sprint 14) |
| 8 | `get_wait_list` (standalone) | Mostly redundant with `find_filling_opportunities` | Keep but lower priority |

### Tier 3 — sprint 15 (write actions, always with human approval)

| # | Tool | Pain | Notes |
|---|---|---|---|
| 9 | `draft_follow_up_message` | "WhatsApp me come la vida" — the LLM drafts, the human sends | Highest-leverage write tool; non-negotiable for v1 |
| 10 | `send_message` | Sends the approved draft; required for the re-engagement use case | Use **pre-approved templates only** (Q4: "que sean impersonales, no me arriesgo") |
| 11 | `reschedule_appointment` | "la cita es sagrada" — needs explicit approval, time window checks | Tier 3 because María said "jamás" for confirmations; reschedule is different though |
| 12 | `mark_no_show` | "no-shows" is high-impact but embarrassing to misclassify | Defer until we have audit log + confidence |
| 13 | `create_coupon` | "regalar un 20% a clientas en riesgo de fuga" | Lowest impact write tool; can wait |
| 14 | `close_waitlist_slot` | Already covered by `find_filling_opportunities` + `send_message` | Probably de-prioritise or merge into a single flow |

### Tier 4 — defer past v1

- `list_professionals` (read) — not in RFC, mention here for completeness: useful when María is covering for Jorge and needs to know "who is free on Tuesday afternoon"
- Voice input / output — v1.1
- Predictive scheduling — v1.1 (the "Carmen usually cancels Tuesdays" pattern)
- Multi-location — v1.1
- Third-party tool API — v2

---

## 4. Prompt design notes for sprint 12

María's answers suggest these system-prompt rules for the **CopilotSystemPrompt.ts** (Section 7 of the RFC):

1. **Tone = Lucía.** "Directa, sin florituras. Si me tiene que decir que he facturado poco hoy, que me lo diga." No self-intro after first turn. No "espero que estés teniendo un día maravilloso".
2. **Spanish-first.** Localise currency (`45€`, not `EUR`), times (`17:30`, not `5:30 PM`), and date format (`15 de septiembre`, not `Sep 15`).
3. **Name the salon's clients by name** when the LLM has them in context. María knows her 200 clientes by first name; the LLM should too.
4. **Surface the daily gap explicitly**, not buried: "tienes un hueco a las 16:00" is more useful than "all looks good".
5. **Suggest the next action**, not just data. After every read, end with "¿hago X?" if X is appropriate.
6. **Never invent prices, products, or appointment times.** María's #1 fear. Repeat this in the prompt *and* in the schema-validation step.
7. **Refuse to confirm a booking without human confirmation.** Explicit absolute rule.
8. **Tier the write tools by risk:** messaging clients = low risk (with approval); rescheduling = medium; marking no-show = high. The prompt should encourage the LLM to prefer low-risk tools first.

---

## 5. Things this simulation can't tell us (must validate with real owners)

1. **Order of the daily briefing card.** Does the owner want the briefing as a pinned card on the dashboard, or as the first chat message when they open the panel? We assumed "pinned card"; owners may prefer the chat-first UX.
2. **Mobile usage share.** The simulation assumed desktop-primary. Spanish salón staff mostly use mobile between clients. The FAB + slide-over should be the primary entry point, but we should confirm.
3. **Spanish regional variants.** We assumed peninsular Spanish. Catalonia, Andalusia, Basque Country have variants. Worth a question.
4. **WhatsApp Business template approval.** Spanish salón owners may not have pre-approved templates with Meta. The `send_message` tool's "use pre-approved templates" assumption needs validation.
5. **Pricing sensitivity.** We assumed Premium tier at 99€/mo. Real owners may baulk at that. Validate with "what's the most you'd pay?" question.

---

## 6. What to take into sprint 12

Concretely, for the foundation sprint, the team should:

1. Build the 3 read-only tools from **Tier 1** above (`get_my_agenda`, `find_filling_opportunities`, `get_client_360`) in the order listed.
2. Set up the daily briefing endpoint to be the *first* tool the panel calls on open — not a separate endpoint, but the briefing IS the answer to "what's up today".
3. Bake the system-prompt rules from Section 4 into `CopilotSystemPrompt.ts` from day 1. Refactoring the prompt later is painful.
4. Set the default panel greeting to the briefing, not to "Hola, ¿en qué puedo ayudarte?" (that wastes a round-trip).

---

## 7. What NOT to take into sprint 12

Defer everything from Tiers 3-4. Specifically:

- No write tools in v1 of the panel (use the **manual** path: chat with the AI, the AI drafts, the human sends via WhatsApp Business directly)
- No no-show marking
- No coupons
- No "send on my behalf" — this is the v1.1 hard problem (it needs template pre-approval from Meta and rate-limit handling)

This is counterintuitive ("but the RFC says write tools in sprint 15!") but the persona's clear answer to Q4 is "jamás" for autonomous actions. The right v1 surface is: **a great daily briefing + great gap-filling + great client recall**, all read-only, all gating on the owner's own thumbs-up before any outbound communication. That alone is a 99€ value proposition.

---

## 8. Open questions to re-ask 5 real owners

Use this list verbatim in the next 5 interviews:

1. "Cuéntame tu día normal. ¿Qué tareas te consumen más tiempo?"
2. "Si alguien cancela con 2 días de antelación, ¿qué haces hoy? ¿Y si cancela con 2 horas?"
3. "¿Qué decisiones te gustaría que la IA te ayudara a tomar más rápido?"
4. "Si tuvieras un botón mágico en la app, ¿cuál sería la primera pregunta que le harías a la IA cada mañana?"
5. "¿Qué cosas delegarías a la IA sin revisarlas? ¿Cuáles revisarías antes?"
6. "¿Hay clientes que te gustaría reactivar pero no llegas? ¿Cuántos? ¿Qué les dirías?"
7. "¿Cómo quieres que te hable la IA? Dame un ejemplo de respuesta que te gustaría recibir."
8. "¿Qué no quieres que haga jamás?"
9. "Del 1 al 10, ¿cuánto pagarías al mes por una IA que te ahorre X horas/semana?"
10. "¿Tienes clientes que no han venido en más de 2 meses? ¿Qué haces con ellos?"

Aggregate the answers. If 4/5 owners mention gap-filling as their #1 pain, ship `find_filling_opportunities` first. If 4/5 mention client recall, ship `get_client_360` first. The persona above is one data point; we need 4 more before committing.

---

## 9. Sign-off

- [ ] Run 4 more interviews (this doc = 1)
- [ ] Aggregate top-3 pain points across 5 owners
- [ ] Confirm Tier 1 tool priority
- [ ] Confirm system-prompt rules (Section 4) with a non-owner reviewer (e.g. Lucía-equivalent receptionist)
- [ ] Update Section 15 of the RFC to reflect confirmed priorities if they differ from this draft
- [ ] THEN start sprint 12

If after 5 interviews the priorities match Tier 1 above, sprint 12 starts as written in the RFC. If they don't, this document + the interview log become the input for a v0.2 RFC revision.
