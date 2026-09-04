import { SCENARIOS } from './scenarios';
import { buildHarness, closeApp, runScenario, SKIP_E2E } from './harness';

/**
 * Jest wrapper around the L-1 scenario suite.
 *
 * Skipped by default. Opt-in with:
 *   RUN_LLM_E2E_TESTS=1 npm test -- virtual-receptionist/__e2e__/scenarios
 *
 * The suite runs sequentially against a real MiniMax-M3. Each
 * scenario produces one Jest `it()` so failures show up individually
 * in the test report with the failed assertions printed inline.
 */

const describeFn = SKIP_E2E ? describe.skip : describe;

describeFn('Virtual Receptionist L-1 scenarios (real MiniMax)', () => {
  let harness: Awaited<ReturnType<typeof buildHarness>>;

  beforeAll(async () => {
    if (SKIP_E2E) return;
    harness = await buildHarness();
  }, 60_000);

  afterAll(async () => {
    if (SKIP_E2E) return;
    await closeApp();
  }, 30_000);

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}`, async () => {
      if (SKIP_E2E) {
        // describe.skip should suppress this, but be defensive.
        pending('L-1 scenarios skipped (RUN_LLM_E2E_TESTS not set)');
        return;
      }
      const result = await runScenario(
        harness.orchestrator,
        harness.prisma,
        harness.salonId,
        harness.catalogIndex,
        scenario,
      );
      if (!result.passed) {
        const reasons = result.failedAssertions
          .map((f) => `      - ${f.reason}`)
          .join('\n');
        const replyExcerpt = result.reply
          ? `\n      reply: ${JSON.stringify(result.reply.slice(0, 240))}${result.reply.length > 240 ? '…' : ''}`
          : '';
        const toolsExcerpt = result.toolsExecuted.length
          ? `\n      tools: ${result.toolsExecuted.map((t) => t.name).join(', ')}`
          : '';
        throw new Error(
          `Scenario "${scenario.id}" failed:\n${reasons}${replyExcerpt}${toolsExcerpt}`,
        );
      }
    }, 60_000);
  }
});