# Staff Copilot — Changelog

Sprint-by-sprint changelog for the in-app assistant (P2A-staff-copilot).
Affects `/dashboard/copilot`, `/api/v1/assistant/*`, and the platform
admin reporting.

## Sprint 16 — GA + Polish

**Released**: 2026-09-04

### Added
- **Daily briefing endpoint** `GET /assistant/insights/daily` — role-scoped
  UI of today's appointments, gaps, low-stock, at-risk clients, pending
  confirmations. Mounted in `<BriefingCard />` on the panel.
- **Tier-gating**: `copilot_read` (Pro+) and `copilot_write` (Premium+) feature
  keys in `PLAN_MATRIX`. Enforced by `FeatureGuard` (controller) and the
  per-user tool filter (orchestrator).
- **Cost-protection** (RFC §15.7): auto-pause at 3× Premium fee / month,
  driven by `Tenant.aiConversationsUsed`.
- **Rate limits**: 60 messages/min/user, 5 actions/min/user
  (`@Throttle` decorators).
- **Admin usage page** at `/dashboard/copilot/usage` — per-tenant monthly
  stats, approval-rate stacked bar, top-5 active conversations.
- **L1 e2e scenarios**: 17 scenarios covering sprint 12-15 features,
  gated behind `RUN_LLM_E2E_TESTS=1`. New migration
  `20260904085012_add_assistant_enum_types` adds the missing PG enum types
  referenced by Prisma's generated SQL.

### Fixed
- `assistant_messages.role: 'approval'` messages were being sent back to
  the LLM as conversation history. Anthropic returned 400
  `invalid_request_error`, leaving the assistant stuck. Now filtered out
  in `assistant.service.ts:114-138`.
- Role-based tool filter: a Premium manager could see `create_coupon` in
  the schema (RFC §5 reserves it for owners). Now the tool set sent to
  the LLM is the intersection of `{tier-allowed write tools}` and
  `{role-allowed write tools}`.

### Documentation
- `docs/staff-copilot-guide.md` — for salon staff.
- `docs/admin-copilot-guide.md` — for salon owners / managers.
- `docs/saas-copilot-runbook.md` — for the platform team (kill switches,
  alerts, debug procedures).
- `docs/staff-copilot-changelog.md` — this file.

## Sprint 15 — Advanced writes + tier-gating

- 3 new write tools: `mark_no_show`, `create_coupon`, `close_waitlist_slot`.
- `AssistantTierService` (tier resolution + cost cap).
- Role-based tool filtering: write tools only available to their allowed
  roles (e.g. `create_coupon` = owner-only).
- L4 tests: 21 new tests (sprint 15 write tools + tier service).

## Sprint 14 — Write tools + approval flow

- `ActionApprovalService` — 5-minute TTL pending-action queue.
- 3 new write tools: `draft_follow_up_message`, `send_message`,
  `reschedule_appointment`. All gated behind human approval.
- New endpoints: `GET /assistant/approvals`, `GET /assistant/approvals/:id`,
  `POST /assistant/approvals/:id/resolve`.
- `<ApprovalChip />` mounted inline in the chat for pending actions.

## Sprint 13 — Briefing + read-only expansion

- 4 new read tools: `find_filling_opportunities`, `get_low_stock`,
  `get_no_show_history`, `get_top_clients`. (Plus the missing
  `get_revenue_breakdown` deferred to v2.)
- `<BriefingCard />` shows today's briefing on first open per day.

## Sprint 12 — Foundation

- `AssistantModule`, `AssistantController`, `AssistantService`,
  `AssistantGateway`.
- New Prisma models: `AssistantConversation`, `AssistantMessage`,
  `ActionApproval` (+ `ActionApprovalStatus` enum).
- 3 read tools: `get_my_agenda`, `get_salon_agenda`, `get_client_360`.
- Role-based redaction (staff never sees revenue of other stylists).
- `<CopilotPanel />` slide-over + FAB on dashboard + dedicated
  `/dashboard/copilot` page.
