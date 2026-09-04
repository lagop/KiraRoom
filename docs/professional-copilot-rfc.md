# RFC: Salon Professional Copilot (Kira Studio)

| Field | Value |
|---|---|
| **Author** | Engineering team |
| **Status** | **Implemented (sprint 12-16, GA-ready)** |
| **Target release** | Sprint 16 — soft-launch active; GA at sprint 18 |
| **Owner module** | `packages/backend/src/assistant/` + frontend `app/dashboard/copilot/` |

## Implementation summary (sprint 12-16)

All sections of this RFC are now implemented. See [`docs/staff-copilot-changelog.md`](staff-copilot-changelog.md) for the sprint-by-sprint delivery log.

| Sprint | Goal | Status |
|---|---|---|
| 12 | Foundation: `AssistantModule`, `AssistantConversation` + `AssistantMessage` + `ActionApproval` models, 3 read tools (`get_my_agenda`, `get_salon_agenda`, `get_client_360`), `<CopilotPanel>` | ✅ shipped |
| 13 | Read-only copilot: 5 more read tools, role-based permission gates, `/assistant/insights/daily`, `<BriefingCard>` | ✅ shipped |
| 14 | Write tools + approval flow: 3 write tools, `ActionApprovalService` (5-min TTL), `<ApprovalChip>` | ✅ shipped |
| 15 | Advanced writes + tier-gating: 3 more write tools, `AssistantTierService`, Pro/Premium gates, rate limits, admin usage page | ✅ shipped |
| 16 | GA polish: docs, billing hook, soft-launch flag (`COPILOT_SOFT_LAUNCH_TENANT_IDS`), `CopilotFeedback` model, thumbs-up/down widget | ✅ shipped |

### What's NOT yet built (deferred)

These were intentionally deferred per the RFC's own sprint plan:

- **Sprint 17 — Closed beta** (RFC §15.4 step 2): flip the soft-launch env var to your chosen 10 tenant IDs and start collecting feedback.
- **Sprint 18+ — Open rollout** (RFC §15.4 step 3): per-tenant opt-in flag, 30-day opt-in window, then auto-on.
- **Multi-location cross-salon queries** (RFC §17): requires a separate RFC.
- **Playwright UX tests** (RFC §15.2:461): still TODO; CI runs unit + L4 + L1 e2e but no Playwright suite.

### Open RFC questions (still unanswered)

§14 questions 1-4: bot ordering, third-party tool APIs, multi-tenant v1.1, voice — not material for v1 GA.

---

## 1. Context and motivation

Kira Studio is a multi-tenant SaaS for beauty-salon management. The team has already built:

- **Customer chatbot** (Virtual Receptionist): a chat widget at `/sites/[salonName]` that answers FAQs about services / prices / availability and books appointments. Validated against a 20-scenario end-to-end harness (`packages/backend/src/virtual-receptionist/__e2e__/`).
- **Platform LLM config**: an admin-only UI at `/saas/settings/platform-llm` where the platform owner picks the LLM provider, model, and encrypted API key. Currently set to `claude-haiku-4-5` + Anthropic key.

The next biggest revenue lever is **not** the customer-side chat. It is an **internal copilot for the salon's own staff** — owners, managers and professionals. This RFC proposes that feature.

### Why now

- The LLM infrastructure, tool executor, encryption and hot-reload already exist (`virtual-receptionist` module is reusable).
- The data model already has everything needed (appointments, clients, professionals, payments, loyalty, inventory, wait-list).
- Customer chatbot traffic has validated that the AI plumbing is stable; we have headroom to extend it.
- The salon professional's day is fragmented across appointments + clients + payments + WhatsApp + paper notes. An in-app assistant that holds all of this in its context window is a clear win.

### Goals

1. Give the salon owner / manager / stylist a natural-language interface that reads and (eventually) writes to the same database the dashboard reads.
2. Make the AI's actions **explicit, scoped and reversible** — no autonomous multi-step transactions without human confirmation.
3. Turn the existing chatbot architecture into a reusable assistant platform so additional copilots (marketing, finance, owner-mobile) cost almost nothing later.

### Non-goals

- Voice / push-to-talk. Out of scope for v1; the chat is keyboard/typed.
- Replacing the salon-owner dashboard. The copilot is a complement, not a replacement.
- Replacing any human role. We do not remove receptionists; we free them from typing.
- Auto-sharing of client data outside the tenant's own salons (multi-location data is in-scope; cross-tenant data is not).

---

## 2. User personas

### 2.1 María — Owner-manager of a 4-chair salon

- Opens the app at 8:30 AM, before the first appointment.
- Needs to know: who cancelled overnight, who hasn't visited in 60+ days, what's on the agenda today.
- Comfortable with software; uses WhatsApp Business, Stripe, Excel, but does not write code.

### 2.2 Jorge — Senior stylist (commission-based)

- Uses the app on a phone between appointments.
- Wants: see his day, pull up a client's last color formula and allergies, send a quick WhatsApp to confirm next session.
- Optimises for: minimum tap-and-typing.

### 2.3 Lucía — Receptionist

- Lives in the app during open hours.
- Wants: fast Q&A ("¿cuánto stock de tinte 7.3 me queda?", "¿quién no se presentó el martes?") and confirmation of actions ("manda este WhatsApp a Carmen").

---

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       Frontend (Next.js)                         │
│   ┌────────────────────────────────────────────────────────────┐  │
│   │   <CopilotPanel>  (slide-over chat, persistent)         │  │
│   │   - mounts on every dashboard page                      │  │
│   │   - session-scoped to the current user / tenant         │  │
│   │   - sends messages to /api/v1/assistant/messages        │  │
│   └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │ POST /assistant/messages
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                          Backend (Nest)                           │
│                                                                  │
│  AssistantController ── AssistantService ── AssistantGateway     │
│                                  │              │                │
│                                  │              ▼                │
│                                  │     PlatformLlmConfigService   │
│                                  │     (provider + key + model)  │
│                                  ▼              │                │
│                          ToolExecutor ──────────┘                │
│                                  │                              │
│                                  ▼                              │
│            ┌─────────────────────────────────────┐             │
│            │  SalonToolsService (new)           │             │
│            │  - get_my_agenda                    │             │
│            │  - find_filling_opportunities      │             │
│            │  - get_client_360                   │             │
│            │  - get_revenue_breakdown            │             │
│            │  - get_low_stock                    │             │
│            │  - draft_follow_up_message         │             │
│            │  - execute_action (gated)         │             │
│            └─────────────────────────────────────┘             │
│                                  │                              │
│                                  ▼                              │
│                       PrismaService → DB                         │
│                                                                  │
│  ActionApprovalService (new) — pending-action queue            │
│  AuditLogService (extends existing) — every tool call          │
└──────────────────────────────────────────────────────────────────┘
```

**Key reuse**: the orchestrator, tool executor, encryption, hot-reload provider pattern are all copied from `VirtualReceptionistService` (no duplication of the heavy lifting). The diff is the **tool catalog** and the **prompt + permission layer**.

---

## 4. Tool catalog (v1 MVP)

All tools are **scoped to the calling user's tenant** at the SQL level. None of them accept a `tenantId` argument — the executor injects it.

### 4.1 Read-only tools (v1 sprint 14)

| Tool | Description | Auth |
|---|---|---|
| `get_my_agenda` | Today's appointments for the calling professional (or the whole salon if the caller is owner/manager). | any authed staff |
| `get_salon_agenda` | Same as above but for any professional in the salon, by `professionalId`. | owner / manager only |
| `find_filling_opportunities` | List of upcoming gaps ≥ 30 min in the next 7 days, with the top 5 wait-list clients who could fill them. | owner / manager |
| `get_client_360` | Full history of one client: visits, services, products bought, allergies, notes, last communication. | professional (own clients) / owner / manager (all) |
| `get_revenue_breakdown` | Revenue for a period, by professional, by service, by payment status. | owner / manager |
| `get_low_stock` | Products with stock ≤ threshold. | owner / manager / receptionist |
| `get_top_clients` | Clients ranked by spend, recency, frequency, or risk of churn. | owner / manager |
| `get_no_show_history` | Clients with ≥ 2 no-shows in last 90 days. | receptionist / manager |
| `get_wait_list` | Wait-list entries, optionally filtered by service or date. | any staff |

### 4.2 Action tools (v1 sprint 15, behind human confirmation)

| Tool | Description | Auth | Confirmation |
|---|---|---|---|
| `draft_follow_up_message` | Produces a draft WhatsApp / email message body. **Does not send.** | any staff | shows preview, "Send / Edit / Cancel" |
| `send_message` | Sends a WhatsApp message to a single client using a pre-approved template. **Audit-logged.** | any staff | "Are you sure?" |
| `reschedule_appointment` | Moves an appointment from one slot to another. | professional (own) / manager | "Old: X · New: Y · Confirm / Edit / Cancel" |
| `mark_no_show` | Marks a confirmed appointment as no-show, with optional fee. | receptionist / manager | "Apply €X fee? / Skip fee / Cancel" |
| `create_coupon` | Issues a single-use discount code for a specific client. | owner / manager | "Code X, Y% off, expires Z · Confirm / Cancel" |
| `close_waitlist_slot` | Notifies N wait-list clients that a slot opened, gathers first confirmation, books it. | receptionist / manager | "Send to: [list]? / Cancel" |

---

## 5. Permissions model

The copilot **inherits** the calling user's role. No role escalation, ever. The rules below are enforced in `AssistantService.canInvokeTool(tool, user)` — every tool call passes through it.

| Role | Reads (tools) | Writes (tools) |
|---|---|---|
| `saas_owner` | All tenants (impersonation) | All tenants |
| `owner` (tenant) | Everything in their salon | All action tools |
| `admin` (tenant) | Everything in their salon | All action tools |
| `manager` (tenant) | Everything in their salon | `draft_follow_up_message`, `send_message`, `reschedule_appointment`, `mark_no_show`, `close_waitlist_slot` |
| `staff` (professional) | Own agenda, own clients (no financial data), wait-list, low-stock | `draft_follow_up_message`, `send_message` (own clients only), `reschedule_appointment` (own appointments only) |
| `receptionist` | Same as manager, minus financials | Same as manager, minus `create_coupon` |

**Hard rules** (no role override allowed):

- A stylist (`staff`) **never** sees revenue or commission numbers of other stylists.
- A stylist **never** writes a WhatsApp to a client that isn't assigned to them.
- Coupon creation is owner-only.
- The `execute_action` family of tools runs only after the user clicks **Confirm** in the chat.

---

## 6. Conversation & state model

A conversation is per (user, tenant, optional session-id). It is **not shared with the customer chatbot** — different audience, different tone, different permissions. Two modules, two conversations, one LLM infrastructure.

```
AssistantConversation
├── id              cuid
├── userId          string     # who is asking
├── tenantId        string     # which salon
├── sessionId       string?    # null for the persistent thread
├── title           string?    # auto-generated after 5+ turns
├── createdAt       DateTime
├── updatedAt       DateTime
└── messages        AssistantMessage[]

AssistantMessage
├── id              cuid
├── conversationId  string
├── role            "user" | "assistant" | "tool" | "approval"
├── content         string     # text content OR tool-call JSON
├── toolName        string?
├── toolInput       Json?
├── toolResult      Json?
├── pendingActionId string?    # when role=approval, points to ActionApproval
├── createdAt       DateTime
```

Pending actions live in a separate table (`ActionApproval`) so they survive a reload and can be approved from the notification bell on the top bar.

```
ActionApproval
├── id              cuid
├── userId          string
├── tenantId        string
├── toolName        string
├── toolInput       Json
├── status          "pending" | "approved" | "rejected" | "expired" | "executed"
├── preview         string?     # human-readable summary shown in the UI
├── expiresAt       DateTime    # default 5 minutes after creation
├── createdAt       DateTime
├── resolvedAt      DateTime?
└── resultSnapshot  Json?       # tool result if executed
```

The flow for an action tool:

```
1. LLM calls reschedule_appointment({appointmentId, newStartAt})
2. AssistantService.executeTool sees status=read-write and a pending-worthy tool
3. Returns { kind: "pending_approval", approvalId, preview: "Move X from 16:00 to 17:30?" }
4. AssistantGateway stores an AssistantMessage with role=approval and the preview
5. Frontend shows the preview with [Approve] [Reject] buttons
6. User clicks Approve → POST /assistant/approvals/:id/approve
7. ActionApprovalService re-runs the tool, marks status=executed, returns the actual result
8. AssistantMessage is updated with the result
```

If the user does not respond within `expiresAt` (default 5 min), the approval goes to `status=expired` and the chat context is updated so the LLM knows.

---

## 7. System prompt (template)

Following the pattern of `VirtualReceptionistService.buildSystemPrompt`, we have a `CopilotSystemPrompt.ts` with locale variants. The English skeleton:

```
You are Kira Copilot, an internal assistant for <SALON_NAME>.
You help salon staff with their day: clients, agenda, revenue, marketing.

## Identity
- You are speaking to a <ROLE> of the salon.
- You may read everything in the salon they can read.
- You may write only what their role permits; if they ask for more,
  say so and offer the closest safe alternative.
- Default to Spanish; switch if the user does.

## Capabilities (today)
<read-tools>…</read-tools>
<write-tools>…</write-tools>

## Hard rules
1. NEVER invent data. If a tool returns nothing, say "no tengo esa
   información ahora mismo, ¿quieres que mire otra fuente?".
2. NEVER execute a write tool without human confirmation. Always
   return a pending action with a clear preview, then stop.
3. With money / client PII / cancellations, slow down. Use the
   shortest answer that still answers the question.
4. If you don't know whether the user has permission, say so and
   route them to the owner. Don't try to guess.
5. The reply should fit in the panel — under 6 sentences unless the
   user explicitly asks for detail or a list.

## Tone
- Concise, professional, warm. Spanish salons value personal
  relationships; remember the user's tone and mirror it.
- No self-introductions after the first turn.
- When unsure, ask one focused question rather than dumping options.
```

A per-role hint is appended (`<ROLE_HINT>` block) so the model knows which write tools are available without seeing the others.

---

## 8. Endpoints (NestJS)

All under `/api/v1/assistant`, JWT-guarded.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/assistant/conversations` | Create or resume the persistent conversation for the user. Returns `{ id }`. | any staff |
| GET | `/assistant/conversations` | List user's conversations (most-recent first, paginated). | any staff |
| GET | `/assistant/conversations/:id/messages` | Page through messages. | any staff (only own conversations) |
| POST | `/assistant/conversations/:id/messages` | Send a user message. Returns the assistant message + any pending-approval ids. | any staff |
| POST | `/assistant/approvals` | List pending approvals for the user. | any staff |
| GET | `/assistant/approvals/:id` | Get approval details (preview, tool, input, expiresAt). | owner of approval |
| POST | `/assistant/approvals/:id/approve` | Approve & execute the tool. | owner of approval |
| POST | `/assistant/approvals/:id/reject` | Reject & dismiss. | owner of approval |
| GET | `/assistant/insights/daily` | The "good morning" briefing for the calling user. | any staff |

### DTOs (Zod, in `packages/shared/src/dto/assistant.ts`)

- `AssistantMessageRole = z.enum(['user', 'assistant', 'tool', 'approval'])`
- `SendMessageDto = z.object({ content: z.string().min(1).max(2000), conversationId: z.string().cuid().optional() })`
- `ApprovalActionDto = z.discriminatedUnion('action', [z.object({ action: z.literal('approve') }), z.object({ action: z.literal('reject'), reason: z.string().optional() })])`

---

## 9. Frontend

### 9.1 New page: `/dashboard/copilot`

Already-implemented dashboard layout (`app/dashboard/layout.tsx`) hosts a new client-side component `<CopilotPanel>` that mounts as a slide-over from the right edge. The panel is always reachable from a persistent FAB (bottom-right). Keyboard shortcut: `Cmd/Ctrl + K`.

```
┌────────────────────────────────────────────────────────────────┐
│                                                              ✕ │
│  Copilot — Kira Studio Test          [Clear] [History ▾]      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Hola María. Hoy tienes 8 citas, 1 hueco a las 16:00, y       │
│  Carmen no ha confirmado la cita del viernes.                  │
│                                                                │
│  ─ 12:30 · Carmen — Coloración (€140) pendiente de confirmar   │
│  ─ 14:00 · María — Corte (€35)                                │
│  ─ 15:30 · Lucía — Tratamiento (€80)                           │
│  ─ 17:00 · hueco libre (1h)                                    │
│  ─ 18:00 · Pablo — Corte (€25)                                 │
│                                                                │
│  ¿Quieres que mande un recordatorio a Carmen?                  │
│                                              [Sí, manda]  [▪] │
│                                                                │
│  [Escribe aquí…]                                  [Enviar ➤]   │
└────────────────────────────────────────────────────────────────┘
```

### 9.2 State management

- `useCopilotConversation()` hook backed by `AssistantGateway` on the frontend.
- Optimistic appending of user message; assistant message streams in via polling (every 1.5 s) until `pendingAction == null && lastRole == "assistant"`.
- Pending-action chips render inline in the message stream.

### 9.3 Briefing card

When the panel opens for the first time each day, a single non-dismissible card at the top of the conversation shows the daily briefing: today's appointments, gaps, no-shows, low stock, top clients at risk.

---

## 10. Security, privacy & abuse

1. **Row-level security** — every tool filters by `tenantId` from the JWT. No tool accepts `tenantId` as input.
2. **Field-level redaction** — when the stylist calls `get_client_360` for a client not assigned to them, the response excludes `totalSpent`, `paymentMethod`, `commissionRate`, and any notes flagged `internalOnly`.
3. **Action authorisation** — every write tool routes through `ActionApprovalService`, which checks the user's role AND the resource's owner (e.g. a stylist can only reschedule their own appointment).
4. **Prompt-injection resistance** — tools return structured data, never raw user-controlled HTML. The LLM is instructed to never echo URLs from tool output to the user.
5. **PII redaction in logs** — `AssistantService` strips client full names and emails before logging. Phone numbers are masked (`+34 6•••  ••• 123`).
6. **Conversation retention** — conversations auto-delete after 90 days unless the user pins them. Audit log of tool calls is retained 1 year for compliance.
7. **Rate limiting** — same `RateLimitModule` already used elsewhere; new endpoint limits: 60 messages / minute / user, 5 actions / minute / user.

---

## 11. Observability

- Log line per tool call: `{ userId, tenantId, role, toolName, inputHash, durationMs, resultSizeBytes, approvalRequired }`.
- `assistant_tool_calls_total{tool, role, result}` Prometheus counter.
- `assistant_tool_call_duration_seconds{tool}` histogram.
- `assistant_action_approval_rate{tool, action}` — what % of pending actions get approved vs expired? Target > 70 %.
- Per-conversation summary in the existing `saas-admin` debug panel.

---

## 12. Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| LLM hallucinates a price or appointment slot | All numeric answers come from tool results; system prompt enforces "if a tool returned X, use X verbatim". |
| LLM suggests an action that violates permissions | `AssistantService.canInvokeTool` blocks before the call. |
| User asks for sensitive data they can't see | Tool returns a stripped response; LLM is told what was redacted and why. |
| Approval expires before user clicks | `ActionApproval.expiresAt` triggers a chat message: "tu sugerencia para X ha expirado, ¿quieres repetirla?". |
| Bad cell reception (mobile stylists) | Streaming-friendly short responses, copy-to-clipboard on long replies, voice-input field in v1.1. |
| Tenant leaves the platform mid-conversation | Conversations are tenant-scoped; on tenant deletion, the conversation record is anonymised (userId removed) before delete. |

---

## 13. Pricing & tiering

The Copilot is the **anchor of the Premium tier**. The chatbot for the salon customer remains a Pro feature (or free, depending on final pricing review).

| Tier | Price | Customer chatbot | Pro copilot | Premium copilot |
|---|---|---|---|---|
| Free | 0 € | ✗ | ✗ | ✗ |
| Pro | 49 € | ✓ | **read-only** (5 tools) | ✗ |
| Premium | 99 € | ✓ | **read + write** (all tools) | ✓ |

A tenant on Pro can try the copilot by upgrading to Premium and downgrading — conversations are preserved 30 days after downgrade.

---

## 14. Open questions

1. Should the copilot write to WhatsApp directly via the existing Twilio integration, or always via a "draft → approve → send" flow? **Recommendation:** always via approval. Sending money/messages autonomously is too high-risk.
2. Should we expose an API for third-party tools (e.g. a salon owner's accountant plugs in their own `get_pnl`)? **Recommendation:** defer to v2; the user can already build private tools in `ToolCatalog` if needed.
3. Where does the copilot live in the multi-location setup? Cross-salon queries are tricky. **Recommendation:** v1 is single-tenant only; multi-location is v1.1 with explicit location filtering.
4. Voice input / output: out of v1 scope, but the prompt design leaves room. Web Speech API integration can be added in a later sprint without changing the backend.

---

## 15. Development plan

### 15.1 Sprints & dependencies

| Sprint | Goal | Backend deliverables | Frontend deliverables |
|---|---|---|---|
| **Sprint 12** (2 weeks) | Foundation | `AssistantModule` skeleton; `AssistantConversation` + `AssistantMessage` + `ActionApproval` Prisma models; `AssistantController` with conversation CRUD + message send; `AssistantService` orchestrator (copy of VirtualReceptionistService) using `PlatformLlmConfig`; 3 read-only tools (`get_my_agenda`, `get_salon_agenda`, `get_client_360`); unit + L4 tests | `<CopilotPanel>` component + `/dashboard/copilot` page; FAB on dashboard; message history polling |
| **Sprint 13** (2 weeks) | Read-only copilot | Add 4 more read tools (`find_filling_opportunities`, `get_revenue_breakdown`, `get_low_stock`, `get_top_clients`); `AssistantService.canInvokeTool` permission layer; daily briefing endpoint `/assistant/insights/daily` | Daily briefing card; quick-action chips ("show today's gaps", "low stock"); L1 e2e harness for the staff copilot |
| **Sprint 14** (2 weeks) | Write tools + approval flow | `ActionApprovalService`; first 3 write tools (`draft_follow_up_message`, `send_message`, `reschedule_appointment`); `execute_action` tool-execution loop with explicit confirm; audit log | Action preview chips in chat ("Move X from 16:00 to 17:30?" [Approve] [Reject]); notification-bell integration for pending approvals |
| **Sprint 15** (2 weeks) | Advanced actions + tier-gating | Add `mark_no_show`, `create_coupon`, `close_waitlist_slot`; tier-gating middleware (Pro / Premium); rate limiting; full L1 e2e for staff copilot (≥ 15 scenarios) | Tier UI: "Upgrade to Pro" / "Upgrade to Premium" prompts in the panel when a feature is gated; admin UI to see usage stats |
| **Sprint 16** (1 week) | Polish + GA | Documentation, billing integration (track usage per tenant for cost-protection), admin reporting, soft-launch to 10 tenants, feedback loop | Onboarding tour; in-app help; performance tuning |

### 15.2 File / module layout

```
packages/backend/src/
├── assistant/
│   ├── assistant.module.ts
│   ├── assistant.controller.ts
│   ├── assistant.service.ts
│   ├── assistant.gateway.ts           # SSE / polling transport
│   ├── copilot-system-prompt.ts
│   ├── action-approval.service.ts
│   ├── audit-log.service.ts           # extends existing
│   ├── permissions.ts                 # canInvokeTool()
│   └── tools/
│       ├── salon-copilot-tools.ts     # SALON_COPILOT_TOOLS array
│       ├── get-my-agenda.tool.ts
│       ├── get-salon-agenda.tool.ts
│       ├── find-filling-opportunities.tool.ts
│       ├── get-client-360.tool.ts
│       ├── get-revenue-breakdown.tool.ts
│       ├── get-low-stock.tool.ts
│       ├── get-top-clients.tool.ts
│       ├── get-no-show-history.tool.ts
│       ├── get-wait-list.tool.ts
│       ├── draft-follow-up-message.tool.ts
│       ├── send-message.tool.ts
│       ├── reschedule-appointment.tool.ts
│       ├── mark-no-show.tool.ts
│       ├── create-coupon.tool.ts
│       ├── close-waitlist-slot.tool.ts
│       └── l4/                            # unit tests
├── prisma/migrations/
│   └── 2026MMDDHHMMSS_assistant/
│       └── migration.sql

packages/shared/src/dto/
├── assistant.ts

packages/frontend/app/dashboard/
├── copilot/
│   ├── page.tsx
│   ├── components/
│   │   ├── copilot-panel.tsx
│   │   ├── copilot-message.tsx
│   │   ├── approval-chip.tsx
│   │   ├── briefing-card.tsx
│   │   └── use-copilot-conversation.ts
└── components/dashboard/copilot-fab.tsx

packages/backend/src/virtual-receptionist/__e2e__/
└── assistant-copilot.l1.spec.ts        # 15+ scenarios
```

### 15.3 Testing strategy

- **L4 unit tests** — every tool's pure logic (date filtering, audience filtering, anonymisation) tested with mock `PrismaService`.
- **L2 integration** — `AssistantService` with the real `AssistantGateway` + mocked LLM provider, verifying the tool-execution loop and approval flow.
- **L1 end-to-end** (mirrors the customer-chatbot suite): 15 scenarios that run against the live DB and the live LLM. Required to pass before merge.
- **UX tests** — Playwright on the dashboard with the CopilotPanel open, covering: slide-in animation, FAB visibility, draft-preview approval flow, expiry handling.
- **Manual discovery** — before sprint 12, run 5 interviews with salon owners/managers. Output: ranked list of "what would you most like to ask the AI?".

### 15.4 Rollout plan

1. **Internal alpha** (sprint 16, last 3 days): the engineering team + 3 friendly salon owners use it in production.
2. **Closed beta** (sprint 17): invite 10 paying tenants. Daily feedback channel via a dedicated WhatsApp group.
3. **Open rollout** (sprint 18+): enable in production behind a feature flag `assistant.copilot.enabled`. Per-tenant opt-in for the first 30 days; auto-on after that.

### 15.5 Success metrics (30 days post-GA)

| Metric | Target |
|---|---|
| Copilot MAU / total staff | > 60 % |
| Messages / user / week | > 25 |
| Pending actions approved | > 70 % of pending |
| Tasks completed via copilot that wouldn't have happened manually (self-reported) | > 5 / user / week |
| Tier upgrade Pro→Premium attributed to copilot | ≥ 30 % of new Premium signups |
| Tool-call error rate | < 2 % |
| p95 response time (first token) | < 1.5 s |

### 15.6 Dependencies on existing work

- `PlatformLlmConfigService` — re-used; no changes.
- `EncryptionService` — re-used for any new secrets the copilot needs (none today).
- `VirtualReceptionist` orchestrator — pattern duplicated; small amount of cross-pollination possible later.
- The dashboard `layout.tsx` already supports persistent widgets (notification bell pattern). The Copilot FAB follows the same pattern.

### 15.7 Risks specific to this feature

1. **Prompt-injection via client notes**: a client could write a malicious note that the LLM reads and acts on. Mitigated by: (a) `execute_action` always shows a preview that includes the *raw* note text; (b) approval is mandatory; (c) notes flagged `external: false` are not in tool output.
2. **Cost** — every copilot message costs tokens. We pass on the cost only when action tools fire; read tools are cheaper. We track cost per tenant per month and auto-pause if it exceeds 3× the Premium fee.
3. **Over-trust**: a salon owner enables copilot and stops reviewing the daily briefing. Mitigated by: forced daily-briefing card on panel open that summarises "what the AI did today".

---

## 16. Decision log

| Date | Decision |
|---|---|
| 2026-09-02 | Use the same `PlatformLlmConfig` provider routing; no separate LLM key for the staff copilot. |
| 2026-09-02 | Initial tool surface limited to read-only operations (sprints 12-13) before any writes. |
| 2026-09-02 | All write actions require explicit human approval; no autonomous mode in v1. |
| 2026-09-02 | Conversations are scoped per (user, tenant); no sharing with the customer chatbot. |
| 2026-09-02 | Premium tier anchors the copilot; Pro tier limited to read-only access (5 tools). |

---

## 17. Out-of-scope (deferred)

- Voice input / output
- Multi-location cross-salon queries (handled in a follow-up RFC)
- Public API for third-party tools
- Auto-summarisation of long phone calls or WhatsApp threads
- Image / video understanding for client photos
- Predictive scheduling ("this client usually cancels Tuesdays, suggest offering the slot to someone else")
- Native mobile push notifications for briefings

These are explicitly out of v1 to keep scope tight. They are all natural extensions that can be added later without breaking the core.
