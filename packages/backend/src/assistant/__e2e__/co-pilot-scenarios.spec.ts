import { CO_PILOT_SCENARIOS } from './co-pilot-scenarios';
import {
  buildCopilotHarness,
  closeApp,
  resetCopilotTenant,
  runCopilotScenario,
  SKIP_E2E,
  type ScenarioResult,
} from '../../virtual-receptionist/__e2e__/harness';

/**
 * P2A-staff-copilot — L-1 end-to-end tests against the real LLM. Gated
 * behind RUN_LLM_E2E_TESTS=1 and a configured platform LLM key. Each
 * scenario is a `describe` block so failures show up individually in
 * the Jest report.
 *
 *   RUN_LLM_E2E_TESTS=1 MINIMAX_API_KEY=... npm test -- \
 *     src/assistant/__e2e__/co-pilot-scenarios.spec.ts
 *
 *   E2E_ONLY=cp-draft-follow-up   # run a single scenario by id
 *   E2E_BAIL=0                    # keep going past failures
 */
describe('P2A-staff-copilot L-1 scenarios (real LLM)', () => {
  if (SKIP_E2E) {
    it.skip('L-1 scenarios skipped — set RUN_LLM_E2E_TESTS=1 with a valid MINIMAX_API_KEY to run', () => {});
    return;
  }

  let assistantService: Awaited<ReturnType<typeof buildCopilotHarness>>['assistantService'];
  let prisma: Awaited<ReturnType<typeof buildCopilotHarness>>['prisma'];
  let tenantId: string;
  let users: Awaited<ReturnType<typeof buildCopilotHarness>>['users'];
  let fixtures: Awaited<ReturnType<typeof buildCopilotHarness>>['fixtures'];

  beforeAll(async () => {
    const harness = await buildCopilotHarness();
    assistantService = harness.assistantService;
    prisma = harness.prisma;
    tenantId = harness.tenantId;
    users = harness.users;
    fixtures = harness.fixtures;
    await resetCopilotTenant(prisma, tenantId);
  }, 60_000);

  afterAll(async () => {
    await closeApp();
  }, 30_000);

  for (const scenario of CO_PILOT_SCENARIOS) {
    it(`${scenario.name}`, async () => {
      const result: ScenarioResult = await runCopilotScenario(
        assistantService,
        prisma,
        tenantId,
        users,
        scenario,
        fixtures,
      );
      if (!result.passed) {
        const reasons = result.failedAssertions
          .map((f) => `      - ${f.reason}`)
          .join('\n');
        const reply = result.reply
          ? `\n      reply: ${JSON.stringify(result.reply.slice(0, 240))}${result.reply.length > 240 ? '…' : ''}`
          : '';
        const tools = result.toolsExecuted.length
          ? `\n      tools: ${result.toolsExecuted.map((t) => t.name).join(', ')}`
          : '';
        const approvals = result.pendingApprovals.length
          ? `\n      approvals: ${result.pendingApprovals
              .map((p) => `${p.toolName} → ${p.preview.slice(0, 80)}`)
              .join(' | ')}`
          : '';
        throw new Error(
          `Scenario "${scenario.id}" failed:\n${reasons}${reply}${tools}${approvals}`,
        );
      }
    }, 60_000);
  }
});
