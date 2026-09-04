#!/usr/bin/env ts-node
/**
 * P2A-staff-copilot — L-1 end-to-end runner.
 *
 *   RUN_LLM_E2E_TESTS=1 MINIMAX_API_KEY=... npx ts-node \
 *     src/assistant/__e2e__/run-copilot-scenarios.ts
 *
 * Same gating as the customer-chatbot e2e runner. The harness is
 * shared; only the scenarios and the targeted service differ.
 *
 *   E2E_ONLY=cp-draft-follow-up   # run a single scenario by id
 *   E2E_BAIL=0                    # keep going past failures
 *   E2E_TIMEOUT_MS=30000          # per-scenario timeout
 */
import { CO_PILOT_SCENARIOS } from './co-pilot-scenarios';
import {
  buildCopilotHarness,
  closeApp,
  resetCopilotTenant,
  runCopilotScenario,
  SKIP_E2E,
  type CopilotScenario,
  type ScenarioResult,
} from '../../virtual-receptionist/__e2e__/harness';

function color(s: string, code: number): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}
const green = (s: string) => color(s, 32);
const red = (s: string) => color(s, 31);
const yellow = (s: string) => color(s, 33);
const dim = (s: string) => color(s, 90);
const bold = (s: string) => color(s, 1);

function pickScenarios(): CopilotScenario[] {
  const only = process.env.E2E_ONLY;
  if (!only) return CO_PILOT_SCENARIOS;
  const ids = new Set(only.split(',').map((s) => s.trim()).filter(Boolean));
  const filtered = CO_PILOT_SCENARIOS.filter((s) => ids.has(s.id));
  if (filtered.length === 0) {
    console.error(
      `${red('No scenarios matched E2E_ONLY=' + only)}. Available: ${CO_PILOT_SCENARIOS.map((s) => s.id).join(', ')}`,
    );
    process.exit(2);
  }
  return filtered;
}

async function main() {
  if (SKIP_E2E) {
    console.log(
      yellow(
        'P2A-staff-copilot L-1 scenarios skipped. Set RUN_LLM_E2E_TESTS=1 with a valid MINIMAX_API_KEY to run them.',
      ),
    );
    process.exit(0);
  }

  const only = pickScenarios();
  console.log(
    bold(`\nRunning ${only.length} staff-copilot L-1 scenario${only.length === 1 ? '' : 's'}\n`),
  );

  const { assistantService, prisma, tenantId, users, fixtures } = await buildCopilotHarness();
  console.log(dim(`  tenant=${tenantId}`));
  console.log(dim(`  users=${Object.keys(users).join(', ')}`));
  console.log(dim(`  clients=${fixtures.clientIds.carmen.slice(0, 8)}…`));
  // Reset the tenant's conversations so the run starts clean.
  await resetCopilotTenant(prisma, tenantId);
  console.log(dim('  (cleared previous conversations + approvals)\n'));

  const bail = process.env.E2E_BAIL !== '0';
  const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 60_000);

  const results: ScenarioResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const scenario of only) {
    process.stdout.write(`  ${dim('·')} ${scenario.name} ... `);
    let result: ScenarioResult;
    try {
      result = await Promise.race([
        runCopilotScenario(assistantService, prisma, tenantId, users, scenario, fixtures),
        new Promise<ScenarioResult>((_, reject) =>
          setTimeout(
            () => reject(new Error(`timeout after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    } catch (err) {
      result = {
        name: scenario.name,
        passed: false,
        durationMs: timeoutMs,
        message: scenario.message ?? '',
        reply: '',
        toolsExecuted: [],
        pendingApprovals: [],
        failedAssertions: [
          {
            assertion: { kind: 'contains', value: '' },
            reason: `runner threw: ${(err as Error).message}`,
          },
        ],
        error: (err as Error).message,
      };
    }
    results.push(result);

    if (result.passed) {
      passed++;
      console.log(`${green('PASS')} ${dim(`(${result.durationMs}ms)`)}`);
    } else {
      failed++;
      console.log(red('FAIL'));
      for (const f of result.failedAssertions) {
        console.log(`        ${red('·')} ${f.reason}`);
      }
    }
    if (result.reply) {
      console.log(
        `        ${dim('reply:')} ${JSON.stringify(result.reply.slice(0, 220))}${result.reply.length > 220 ? '…' : ''}`,
      );
    }
    if (result.toolsExecuted.length) {
      console.log(
        `        ${dim('tools:')} ${result.toolsExecuted.map((t) => t.name).join(', ')}`,
      );
    }
    if (result.pendingApprovals.length) {
      console.log(
        `        ${dim('approvals:')} ${result.pendingApprovals.map((p) => `${p.toolName} (${p.preview.slice(0, 60)}…)`).join(' | ')}`,
      );
    }
    if (!result.passed && bail) break;
  }

  await closeApp();

  console.log('');
  console.log(bold('Summary'));
  console.log(`  total : ${results.length}`);
  console.log(`  ${green('passed')} : ${passed}`);
  console.log(`  ${failed ? red('failed') : dim('failed')} : ${failed}`);

  if (failed > 0) {
    console.log(red('\nP2A-staff-copilot L-1 scenarios FAILED.'));
    process.exit(1);
  } else {
    console.log(green('\nAll P2A-staff-copilot L-1 scenarios passed.'));
  }
}
main().catch(async (err) => {
  console.error(red('P2A-staff-copilot L-1 runner crashed:'), err);
  await closeApp();
  process.exit(2);
});
