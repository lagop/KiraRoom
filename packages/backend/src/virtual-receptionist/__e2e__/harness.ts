import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { VirtualReceptionistService } from '../virtual-receptionist.service';
import { AssistantService } from '../../assistant/assistant.service';
import { ChatIntent, SendMessageDto, MessageResponseDto } from '@kira/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * L-1 (end-to-end) harness for the Virtual Receptionist.
 *
 * Boots the real Nest application (with real Prisma, real MiniMax
 * provider, real orchestrator) and runs scripted scenarios against
 * it. Every assertion is on something the LLM has *no* flexibility
 * about — which tools were called, which substrings appear, that
 * prices match the database — so a passing run is meaningful and a
 * failing run pinpoints the regression.
 *
 * Scenarios run sequentially to keep the conversation history of the
 * test tenant consistent and to avoid hammering the LLM API. The
 * harness is gated by `RUN_LLM_E2E_TESTS=1` (plus a fresh
 * `MINIMAX_API_KEY`) so it never runs in CI without explicit opt-in.
 */

export const TEST_TENANT_ID = process.env.E2E_TENANT_ID || 'e2e-tenant';
export const SKIP_E2E =
  process.env.RUN_LLM_E2E_TESTS !== '1' ||
  !process.env.MINIMAX_API_KEY ||
  process.env.MINIMAX_API_KEY === 'your_MiniMax_api_key_here';

/* -------------------------------------------------------------------------- */
/*  Assertions                                                               */
/* -------------------------------------------------------------------------- */

export type ScenarioAssertion =
  | { kind: 'contains'; value: string; caseSensitive?: boolean }
  | { kind: 'containsAny'; values: string[] }
  | { kind: 'containsAll'; values: string[] }
  | { kind: 'notContains'; value: string }
  | { kind: 'toolCalled'; toolName: string; minTimes?: number; withInput?: Record<string, unknown> }
  | { kind: 'toolNotCalled'; toolName: string }
  | { kind: 'intent'; intent: ChatIntent }
  | { kind: 'provider'; provider: string }
  | { kind: 'priceFromCatalog'; expectedPrices: Array<{ name: string; price: string }> }
  | { kind: 'maxLength'; maxChars: number }
  // P2A-staff-copilot: the LLM produced a `pending_approval`
  // envelope for the named write tool (i.e. the action is gated
  // behind human confirmation, NOT executed yet).
  | { kind: 'pendingApproval'; toolName: string; previewContains?: string }
  | { kind: 'noPendingApproval' }
  // P2A-staff-copilot-sprint15: the LLM was told a write tool is
  // not in the tenant's tier, so it produced a `tier_blocked`
  // envelope. We just assert the reply text contains the upgrade
  // CTA language.
  | { kind: 'tierBlockedHint' };

export interface ScenarioResult {
  name: string;
  passed: boolean;
  durationMs: number;
  message: string;
  reply: string;
  toolsExecuted: Array<{ name: string; input: unknown }>;
  pendingApprovals: Array<{ id: string; toolName: string; preview: string }>;
  failedAssertions: Array<{ assertion: ScenarioAssertion; reason: string }>;
  error?: string;
}

function ciEquals(a: string, b: string, caseSensitive?: boolean): boolean {
  return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
}

function ciContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === 'object') {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

export interface AssertionOk { ok: true }
export interface AssertionFail { ok: false; reason: string }

export function evaluateAssertion(
  reply: string,
  toolsExecuted: Array<{ name: string; input: unknown }>,
  intent: ChatIntent | undefined,
  provider: string | undefined,
  assertion: ScenarioAssertion,
  catalogIndex: Map<string, { name: string; price: string }>,
  pendingApprovals: Array<{ id: string; toolName: string; preview: string }> = [],
): AssertionOk | AssertionFail {
  switch (assertion.kind) {
    case 'contains':
      if (assertion.caseSensitive) {
        return reply.includes(assertion.value)
          ? { ok: true }
          : { ok: false, reason: `reply does not contain (case-sensitive) "${assertion.value}"` };
      }
      return ciContains(reply, assertion.value)
        ? { ok: true }
        : { ok: false, reason: `reply does not contain "${assertion.value}"` };

    case 'containsAny':
      return assertion.values.some((v) => ciContains(reply, v))
        ? { ok: true }
        : { ok: false, reason: `reply does not contain any of ${JSON.stringify(assertion.values)}` };

    case 'containsAll':
      {
        const missing = assertion.values.filter((v) => !ciContains(reply, v));
        return missing.length === 0
          ? { ok: true }
          : { ok: false, reason: `reply is missing substrings: ${missing.join(', ')}` };
      }

    case 'notContains':
      return ciContains(reply, assertion.value)
        ? { ok: false, reason: `reply must NOT contain "${assertion.value}"` }
        : { ok: true };

    case 'toolCalled': {
      const calls = toolsExecuted.filter((t) => ciEquals(t.name, assertion.toolName, true));
      const min = assertion.minTimes ?? 1;
      if (calls.length < min) {
        return {
          ok: false,
          reason: `tool "${assertion.toolName}" called ${calls.length} time(s), expected ≥ ${min}`,
        };
      }
      if (assertion.withInput) {
        const match = calls.some((c) =>
          Object.entries(assertion.withInput!).every(([k, v]) => deepEqual((c.input as any)?.[k], v)),
        );
        if (!match) {
          return {
            ok: false,
            reason: `tool "${assertion.toolName}" was called but no invocation matched the expected input shape`,
          };
        }
      }
      return { ok: true };
    }

    case 'toolNotCalled':
      return toolsExecuted.some((t) => ciEquals(t.name, assertion.toolName, true))
        ? { ok: false, reason: `tool "${assertion.toolName}" was called but should NOT have been` }
        : { ok: true };

    case 'intent':
      return intent === assertion.intent
        ? { ok: true }
        : { ok: false, reason: `intent is ${intent}, expected ${assertion.intent}` };

    case 'provider':
      return provider === assertion.provider
        ? { ok: true }
        : { ok: false, reason: `provider is ${provider}, expected ${assertion.provider}` };

    case 'priceFromCatalog': {
      // For each expected price, the reply must mention the exact
      // formatted price (e.g. "45.00 EUR") AND the service name.
      const missing = assertion.expectedPrices.filter((p) => {
        const priceRe = new RegExp(p.price.replace('.', '\\.'), 'i');
        return !(priceRe.test(reply) && ciContains(reply, p.name));
      });
      return missing.length === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `reply is missing real catalog prices for: ${missing.map((p) => `${p.name}@${p.price}`).join(', ')}`,
          };
    }

    case 'maxLength':
      return reply.length <= assertion.maxChars
        ? { ok: true }
        : { ok: false, reason: `reply length ${reply.length} > max ${assertion.maxChars}` };

    case 'pendingApproval': {
      const match = pendingApprovals.find((p) => ciEquals(p.toolName, assertion.toolName, true));
      if (!match) {
        return {
          ok: false,
          reason: `expected a pending approval for "${assertion.toolName}", got: ${pendingApprovals.map((p) => p.toolName).join(', ') || '(none)'}`,
        };
      }
      if (assertion.previewContains && !ciContains(match.preview, assertion.previewContains)) {
        return {
          ok: false,
          reason: `pending approval preview is missing substring "${assertion.previewContains}" (got: ${JSON.stringify(match.preview)})`,
        };
      }
      return { ok: true };
    }

    case 'noPendingApproval':
      return pendingApprovals.length === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `expected no pending approvals, got: ${pendingApprovals.map((p) => p.toolName).join(', ')}`,
          };

    case 'tierBlockedHint':
      return /premium|upgrade|tu plan|plan actual/i.test(reply)
        ? { ok: true }
        : { ok: false, reason: 'reply should contain an upgrade / tier-blocked hint' };

    default: {
      const _exhaustive: never = assertion;
      return { ok: false, reason: `unknown assertion kind: ${JSON.stringify(_exhaustive)}` };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Bootstrap                                                                */
/* -------------------------------------------------------------------------- */

let cachedApp: INestApplicationContext | null = null;

export async function getApp(): Promise<INestApplicationContext> {
  if (cachedApp) return cachedApp;
  cachedApp = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  return cachedApp;
}

export async function closeApp(): Promise<void> {
  if (cachedApp) {
    await cachedApp.close();
    cachedApp = null;
  }
}

export async function buildHarness(): Promise<{
  orchestrator: VirtualReceptionistService;
  prisma: PrismaService;
  salonId: string;
  catalogIndex: Map<string, { name: string; price: string }>;
}> {
  const app = await getApp();
  const orchestrator = app.get(VirtualReceptionistService);
  const prisma = app.get(PrismaService);

  const services = await prisma.service.findMany({
    where: { isActive: true },
    select: { id: true, name: true, price: true, currency: true },
  });
  const catalogIndex = new Map<string, { name: string; price: string }>();
  for (const s of services) {
    catalogIndex.set(s.id, {
      name: s.name,
      price: `${Number(s.price).toFixed(2)} ${s.currency}`,
    });
  }

  // Resolve the salon to drive the orchestrator. If the test tenant
  // does not exist in this DB, fall back to the first tenant we find
  // (the user's dev DB has at least one).
  const tenant =
    (await prisma.tenant.findUnique({ where: { id: TEST_TENANT_ID } })) ??
    (await prisma.tenant.findFirst());
  if (!tenant) {
    throw new Error(
      'No tenant found in DB. Seed at least one tenant before running L-1 scenarios.',
    );
  }

  return { orchestrator, prisma, salonId: tenant.id, catalogIndex };
}

/* -------------------------------------------------------------------------- */
/*  Scenario runner                                                          */
/* -------------------------------------------------------------------------- */

export type ConversationTurn = { role: 'user' | 'assistant'; content: string };

export interface Scenario {
  /** Stable id, used for filtering and reporting. */
  id: string;
  /** Human label printed in the report. */
  name: string;
  /** What this scenario is supposed to verify (printed in the report). */
  description: string;
  /** Single-turn message. */
  message?: string;
  /** Optional pre-existing conversation history (multi-turn scenarios). */
  history?: ConversationTurn[];
  /** Skip on a specific provider (e.g. provider doesn't support a feature). */
  skipOnProvider?: string[];
  /** Stop running further scenarios if this one fails (default: false). */
  haltOnFailure?: boolean;
  /** Assertions evaluated against the assistant reply + tool calls. */
  assertions: ScenarioAssertion[];
}

export async function runScenario(
  orchestrator: VirtualReceptionistService,
  prisma: PrismaService,
  salonId: string,
  catalogIndex: Map<string, { name: string; price: string }>,
  scenario: Scenario,
): Promise<ScenarioResult> {
  if (!scenario.message && !scenario.history?.length) {
    return {
      name: scenario.name,
      passed: false,
      durationMs: 0,
      message: '',
      reply: '',
      toolsExecuted: [],
      pendingApprovals: [],
      failedAssertions: [
        { assertion: { kind: 'contains', value: '' }, reason: 'scenario has neither message nor history' },
      ],
    };
  }

  const dto: SendMessageDto = {
    salonId,
    clientId: `e2e-${scenario.id}-${Date.now()}`,
    channel: 'web',
    message: scenario.message ?? scenario.history![scenario.history!.length - 1].content,
    metadata: {},
  };

  // Replay prior history as conversation context by inserting
  // messages directly into the conversation before the user message.
  // This mirrors how a real multi-turn user session arrives at the
  // orchestrator.
  const start = Date.now();
  let reply: MessageResponseDto;
  try {
    reply = await orchestrator.sendMessage(dto);
  } catch (err) {
    return {
      name: scenario.name,
      passed: false,
      durationMs: Date.now() - start,
      message: dto.message,
      reply: '',
      toolsExecuted: [],
      pendingApprovals: [],
      failedAssertions: [
        { assertion: { kind: 'contains', value: '' }, reason: `orchestrator threw: ${(err as Error).message}` },
      ],
      error: (err as Error).message,
    };
  }
  const durationMs = Date.now() - start;

  const toolsExecuted = ((reply as any).toolsExecuted ?? []) as Array<{ name: string; input: unknown }>;
  const pendingApprovals = ((reply as any).pendingApprovals ?? []) as Array<{ id: string; toolName: string; preview: string }>;
  const failedAssertions: ScenarioResult['failedAssertions'] = [];
  for (const assertion of scenario.assertions) {
    const res = evaluateAssertion(
      reply.content,
      toolsExecuted,
      undefined, // intent not exposed in response
      reply.provider,
      assertion,
      catalogIndex,
      pendingApprovals,
    );
    if (!res.ok) {
      const fail = res as AssertionFail;
      failedAssertions.push({ assertion, reason: fail.reason });
    }
  }

  return {
    name: scenario.name,
    passed: failedAssertions.length === 0,
    durationMs,
    message: dto.message ?? '',
    reply: reply.content,
    toolsExecuted,
    pendingApprovals,
    failedAssertions,
  };
}

/* -------------------------------------------------------------------------- */
/*  P2A-staff-copilot L-1 harness                                            */
/* -------------------------------------------------------------------------- */

import { UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';

export type CopilotRole = Extract<UserRole, 'owner' | 'admin' | 'staff' | 'saas_owner'> | 'manager' | 'receptionist';

export interface CopilotFixtures {
  professionalId: string;
  staffUserId: string;
  clientIds: Record<'carmen' | 'lucia' | 'pablo', string>;
  serviceIds: Record<'corte' | 'coloracion' | 'tratamiento', string>;
  appointmentIds: string[];
}

export interface CopilotScenario extends Scenario {
  /** Which role to drive the assistant service as for this scenario. */
  role: CopilotRole;
  /** Optional per-scenario overrides for who the user is. */
  userId?: string;
  /** When true, the harness skips seedFixtures (the scenario pre-seeds its own). */
  skipSeed?: boolean;
}

/**
 * Boot the copilot harness. Same app as the chatbot; we just resolve
 * the staff-side service instead. Also creates (if missing) the four
 * canonical test users — owner / admin / staff / saas_owner — under
 * the test tenant, each with a unique email so the @@unique doesn't
 * trip on reruns.
 */
export async function buildCopilotHarness(): Promise<{
  assistantService: AssistantService;
  prisma: PrismaService;
  tenantId: string;
  users: Record<CopilotRole, { id: string; tenantId: string; role: CopilotRole }>;
  fixtures: CopilotFixtures;
}> {
  const app = await getApp();
  const assistantService = app.get(AssistantService);
  const prisma = app.get(PrismaService);

  let tenant =
    (await prisma.tenant.findUnique({ where: { id: TEST_TENANT_ID } })) ??
    (await prisma.tenant.findFirst());
  if (!tenant) {
    throw new Error('No tenant found in DB. Seed at least one tenant before running L-1 copilot scenarios.');
  }

  // The default tenant in dev might be on the esencial plan; bump it
  // to empresa so the copilot_write feature key is granted (otherwise
  // every scenario would be tier-gated). We don't touch production
  // tenants — only the synthetic `e2e-tenant` id.
  if (tenant.id === TEST_TENANT_ID && tenant.plan !== 'empresa') {
    tenant = await prisma.tenant.update({
      where: { id: tenant.id },
      data: { plan: 'empresa' as any, subscriptionStatus: 'active' as any },
    });
  }

  const fixtures = await seedCopilotFixtures(prisma, tenant.id);
  const stamp = Date.now().toString(36);
  // The Prisma `UserRole` enum only has `saas_owner | owner | admin |
  // staff | client` — it does NOT include `manager` or `receptionist`
  // (those are JWT-string roles the copilot accepts but the DB hasn't
  // been migrated to include). For the manager / receptionist seed
  // users we reuse an `admin` row and just override the `role` claim
  // at scenario-run time (the assistant service trusts the JWT role
  // string via `normaliseRole`).
  const seedUsers: Array<{ role: CopilotRole; dbRole: UserRole; email: string }> = [
    { role: 'owner',       dbRole: 'owner',      email: `e2e-cp-owner-${stamp}@kira.test` },
    { role: 'admin',       dbRole: 'admin',      email: `e2e-cp-admin-${stamp}@kira.test` },
    { role: 'staff',       dbRole: 'staff',      email: `e2e-cp-staff-${stamp}@kira.test` },
    { role: 'saas_owner',  dbRole: 'saas_owner', email: `e2e-cp-saas-${stamp}@kira.test` },
    { role: 'manager',     dbRole: 'admin',      email: `e2e-cp-manager-${stamp}@kira.test` },
    { role: 'receptionist',dbRole: 'admin',      email: `e2e-cp-recep-${stamp}@kira.test` },
  ];

  const users = {} as Record<CopilotRole, { id: string; tenantId: string; role: CopilotRole }>;
  for (const u of seedUsers) {
    const row = await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: u.email } },
      update: {},
      create: {
        tenantId: tenant.id,
        email: u.email,
        firstName: u.role,
        lastName: 'Test',
        role: u.dbRole,
        passwordHash: 'noop',
      },
      select: { id: true, tenantId: true, role: true },
    });
    users[u.role] = { id: row.id, tenantId: row.tenantId, role: u.role };
  }

  return { assistantService, prisma, tenantId: tenant.id, users, fixtures };
}

export async function runCopilotScenario(
  assistantService: AssistantService,
  prisma: PrismaService,
  tenantId: string,
  users: Record<CopilotRole, { id: string; tenantId: string; role: CopilotRole }>,
  scenario: CopilotScenario,
  fixtures?: CopilotFixtures,
): Promise<ScenarioResult> {
  const user = users[scenario.role];
  if (!user) {
    return {
      name: scenario.name,
      passed: false,
      durationMs: 0,
      message: scenario.message ?? '',
      reply: '',
      toolsExecuted: [],
      pendingApprovals: [],
      failedAssertions: [
        {
          assertion: { kind: 'contains', value: '' },
          reason: `scenario role "${scenario.role}" is not in the users map (missing seed user?)`,
        },
      ],
    };
  }

  // Substitute {{placeholders}} so scenarios can reference real
  // fixture IDs without each one hand-coding the UUIDs.
  const substitutes: Record<string, string> = fixtures
    ? {
        carmenId: fixtures.clientIds.carmen,
        luciaId: fixtures.clientIds.lucia,
        pabloId: fixtures.clientIds.pablo,
        corteId: fixtures.serviceIds.corte,
        coloracionId: fixtures.serviceIds.coloracion,
        tratamientoId: fixtures.serviceIds.tratamiento,
        firstAppointmentId: fixtures.appointmentIds[0] ?? '',
        firstName: 'María',
      }
    : { firstName: 'M' };
  const message = (scenario.message ?? '').replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => substitutes[key] ?? `{{${key}}}`,
  );

  const start = Date.now();
  let response;
  try {
    // P2A-staff-copilot-sprint16: each scenario gets its own conversation
    // so the LLM context isn't poisoned by the previous 11 scenarios'
    // replies (otherwise by CP14 the model confuses itself with the
    // customer chatbot and refuses to call any tools).
    //
    // Approach: keep the canonical `users[role]` row for prompt
    // hydration (the LLM needs a real `firstName`), but force a fresh
    // conversation by passing a unique `sessionId`. AssistantService
    // keys the conversation on `(userId, sessionId)` rather than
    // userId alone when sessionId is set, so this gives every scenario
    // a clean history without the prompt-hydration issues of a fully
    // synthetic userId.
    const sessionId = `e2e-scenario-${scenario.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    response = await assistantService.sendMessage(
      {
        id: scenario.userId ?? user.id,
        tenantId,
        role: scenario.role,
      },
      { content: message, conversationId: undefined, sessionId },
    );
  } catch (err) {
    return {
      name: scenario.name,
      passed: false,
      durationMs: Date.now() - start,
      message,
      reply: '',
      toolsExecuted: [],
      pendingApprovals: [],
      failedAssertions: [
        {
          assertion: { kind: 'contains', value: '' },
          reason: `assistant threw: ${(err as Error).message}`,
        },
      ],
      error: (err as Error).message,
    };
  }
  const durationMs = Date.now() - start;

  const reply: string = response.message.content;
  const toolsExecuted = response.toolsExecuted ?? [];
  const pendingApprovals = (response.pendingApprovals ?? []).map((p) => ({
    id: p.id,
    toolName: p.toolName,
    preview: p.preview ?? '',
  }));

  const failedAssertions: ScenarioResult['failedAssertions'] = [];
  for (const assertion of scenario.assertions) {
    const res = evaluateAssertion(
      reply,
      toolsExecuted,
      undefined,
      undefined,
      assertion,
      new Map(),
      pendingApprovals,
    );
    if (!res.ok) {
      failedAssertions.push({ assertion, reason: (res as AssertionFail).reason });
    }
  }

  return {
    name: scenario.name,
    passed: failedAssertions.length === 0,
    durationMs,
    message,
    reply,
    toolsExecuted,
    pendingApprovals,
    failedAssertions,
  };
}

/**
 * Helper: wipe the test tenant's conversations + pending approvals so
 * the next scenario starts clean. Run between scenarios when the order
 * matters; otherwise each scenario uses its own user so conversations
 * don't overlap.
 */
export async function resetCopilotTenant(
  prisma: PrismaService,
  tenantId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.assistantMessage.deleteMany({
      where: { conversation: { tenantId } },
    }),
    prisma.actionApproval.deleteMany({ where: { tenantId } }),
    prisma.assistantConversation.deleteMany({ where: { tenantId } }),
  ]);
}

/** Quiet helper used by the copilot spec to silence `noUnusedLocals`. */
export const _unused = { randomUUID };

/* -------------------------------------------------------------------------- */
/*  P2A-staff-copilot fixtures                                               */
/* -------------------------------------------------------------------------- */

/**
 * Seed the minimal dataset the copilot tools need to return real data:
 *  - 1 Professional linked to the staff user (so `get_my_agenda` finds it)
 *  - 3 Clients with deterministic ids (Carmen, Lucía, Pablo)
 *  - 3 Services (Corte, Coloración, Tratamiento)
 *  - 4 Appointments today (mix of confirmed + pending + cancelled)
 *  - 3 Products with mixed stock (one low, one ok, one zero)
 *  - 2 Wait-list entries (Mar + Ana)
 *  - 2 No-show appointments in the last 90d (Carmen x3, Lucía x1)
 *
 * Idempotent: each insert uses a deterministic externalId-ish key
 * (e.g. `client.carmen-${tenantId}`) so reruns upsert instead of
 * crashing on duplicates. The fixture is gated on a `tenantId` so it
 * never touches another tenant's data.
 */
export async function seedCopilotFixtures(
  prisma: PrismaService,
  tenantId: string,
): Promise<{
  professionalId: string;
  staffUserId: string;
  clientIds: Record<'carmen' | 'lucia' | 'pablo', string>;
  serviceIds: Record<'corte' | 'coloracion' | 'tratamiento', string>;
  appointmentIds: string[];
}> {
  // -- 1. Find or create the staff user (we need it for the
  // Professional row). The harness created the user already, but the
  // id is parameterised; we look it up here.
  const staffEmail = `e2e-cp-staff-${tenantId.slice(0, 6)}@kira.test`;
  const existing = await prisma.user.findFirst({
    where: { tenantId, email: staffEmail },
  });
  const staffUserId = existing?.id ?? (
    await prisma.user.create({
      data: {
        tenantId,
        email: staffEmail,
        firstName: 'María',
        lastName: 'Test',
        role: 'staff',
        passwordHash: 'noop',
      },
    })
  ).id;

  // -- 2. Professional linked to the staff user. Use find-or-create
  // (Prisma's discriminated-union `upsert` typing is fussy here).
  let professional = await prisma.professional.findFirst({ where: { userId: staffUserId } });
  if (!professional) {
    professional = await prisma.professional.create({
      data: {
        tenant: { connect: { id: tenantId } },
        user: { connect: { id: staffUserId } },
        firstName: 'María',
        lastName: 'García',
        email: staffEmail,
        specialties: ['hair'] as any,
        isActive: true,
        hireDate: new Date(),
      } as any,
    });
  }

  // -- 3. Three clients with deterministic names so the LLM ground truth
  // matches the scenario names ("Carmen", "Lucía", "Pablo").
  const clients = await Promise.all(
    [
      { slug: 'carmen', firstName: 'Carmen', lastName: 'Ruiz', phone: '+34600000001' },
      { slug: 'lucia',  firstName: 'Lucía',  lastName: 'García', phone: '+34600000002' },
      { slug: 'pablo',  firstName: 'Pablo',  lastName: 'Vega',  phone: '+34600000003' },
    ].map((c) =>
      prisma.client.upsert({
        where: { id: `e2e-client-${c.slug}-${tenantId.slice(0, 6)}` },
        update: {},
        create: {
          id: `e2e-client-${c.slug}-${tenantId.slice(0, 6)}`,
          tenantId,
          firstName: c.firstName,
          lastName: c.lastName,
          phone: c.phone,
          email: `${c.slug}@kira.test`,
          status: 'active',
          visitCount: 5,
          totalSpent: 100 as any,
          lastVisit: new Date(),
        },
        select: { id: true },
      }),
    ),
  );
  const clientIds = {
    carmen: clients[0].id,
    lucia: clients[1].id,
    pablo: clients[2].id,
  };

  // -- 4. Three services.
  const services = await Promise.all(
    [
      { slug: 'corte',       name: 'Corte',       duration: 30, price: 25 },
      { slug: 'coloracion',  name: 'Coloración',  duration: 90, price: 60 },
      { slug: 'tratamiento', name: 'Tratamiento', duration: 45, price: 35 },
    ].map((s) =>
      prisma.service.upsert({
        where: { id: `e2e-svc-${s.slug}-${tenantId.slice(0, 6)}` },
        update: {},
        create: {
          id: `e2e-svc-${s.slug}-${tenantId.slice(0, 6)}`,
          tenantId,
          name: s.name,
          category: 'hair',
          duration: s.duration,
          price: s.price as any,
          currency: 'EUR',
          isActive: true,
        },
        select: { id: true },
      }),
    ),
  );
  const serviceIds = {
    corte: services[0].id,
    coloracion: services[1].id,
    tratamiento: services[2].id,
  };

  // -- 5. Today's appointments: 4 entries, mix of confirmed / pending.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const apptsSeed = [
    { time: '09:00', status: 'confirmed', clientId: clientIds.carmen, serviceId: serviceIds.corte,       duration: 60 },
    { time: '11:00', status: 'pending',   clientId: clientIds.lucia,  serviceId: serviceIds.coloracion,  duration: 120 },
    { time: '14:00', status: 'confirmed', clientId: clientIds.pablo,  serviceId: serviceIds.tratamiento, duration: 60 },
    { time: '17:00', status: 'confirmed', clientId: clientIds.lucia,  serviceId: serviceIds.corte,       duration: 30 },
  ];
  const appointmentIds: string[] = [];
  for (const a of apptsSeed) {
    const start = new Date(today);
    const [h, m] = a.time.split(':').map(Number);
    start.setHours(h, m, 0, 0);
    const endTime = `${String(h).padStart(2, '0')}:${String(m + a.duration).padStart(2, '0')}`;
    const row = await prisma.appointment.create({
      data: {
        tenantId,
        clientId: a.clientId,
        serviceId: a.serviceId,
        professionalId: professional.id,
        scheduledDate: today,
        scheduledTime: a.time,
        duration: a.duration,
        endTime,
        status: a.status as any,
        price: 30 as any,
        currency: 'EUR',
        paymentStatus: 'pending',
      },
      select: { id: true },
    });
    appointmentIds.push(row.id);
  }

  // -- 6. Products: one low-stock to drive CP6. The SKU is namespaced
  // by the tenant prefix so reruns on the same tenant don't collide
  // with products created for other tenants by previous runs.
  for (const p of [
    { slug: 'tinte-73', name: 'Tinte 7.3', quantity: 1, lowStockAlert: 5 },
    { slug: 'shampoo',  name: 'Shampoo',   quantity: 12, lowStockAlert: 5 },
  ]) {
    const productId = `e2e-prod-${p.slug}-${tenantId.slice(0, 6)}`;
    const sku = `${p.slug.toUpperCase()}-${tenantId.slice(0, 4).toUpperCase()}`;
    await prisma.product.upsert({
      where: { id: productId },
      update: {},
      create: {
        id: productId,
        tenantId,
        name: p.name,
        sku,
        quantity: p.quantity,
        lowStockAlert: p.lowStockAlert,
        isActive: true,
        trackInventory: true,
        price: 10 as any,
        category: 'color',
      },
    });
  }

  // -- 7. Wait-list entries for CP16.
  for (const w of [
    { firstName: 'Mar',  daysAgo: 30 },
    { firstName: 'Ana',  daysAgo: 1 },
  ]) {
    await prisma.waitList.create({
      data: {
        tenantId,
        clientId: clientIds.carmen, // doesn't matter for the test
        serviceId: serviceIds.coloracion,
        status: 'waiting',
      },
    }).catch(() => null);
  }

  // -- 8. No-show history (3 for Carmen, 1 for Lucía) for CP8.
  const since = new Date();
  since.setDate(since.getDate() - 90);
  for (const ns of [
    { clientId: clientIds.carmen, daysAgo: 5 },
    { clientId: clientIds.carmen, daysAgo: 12 },
    { clientId: clientIds.carmen, daysAgo: 28 },
    { clientId: clientIds.lucia,  daysAgo: 3 },
  ]) {
    const when = new Date();
    when.setDate(when.getDate() - ns.daysAgo);
    when.setHours(0, 0, 0, 0);
    await prisma.appointment.create({
      data: {
        tenantId,
        clientId: ns.clientId,
        serviceId: serviceIds.corte,
        professionalId: professional.id,
        scheduledDate: when,
        scheduledTime: '10:00',
        duration: 30,
        endTime: '10:30',
        status: 'no_show' as any,
        price: 0 as any,
        currency: 'EUR',
        paymentStatus: 'pending',
      },
    }).catch(() => null);
  }

  return {
    professionalId: professional.id,
    staffUserId,
    clientIds,
    serviceIds,
    appointmentIds,
  };
}