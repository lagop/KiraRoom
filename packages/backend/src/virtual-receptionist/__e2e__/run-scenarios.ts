#!/usr/bin/env ts-node
/**
 * L-1 end-to-end runner for the Virtual Receptionist.
 *
 *   RUN_LLM_E2E_TESTS=1 npx ts-node src/virtual-receptionist/__e2e__/run-scenarios.ts
 *
 * Required env:
 *   - RUN_LLM_E2E_TESTS=1
 *   - MINIMAX_API_KEY       (a fresh key, NOT the one shared in chat)
 *   - DATABASE_URL          (Postgres reachable from this shell)
 *   - E2E_TENANT_ID         (optional; defaults to "e2e-tenant")
 *
 * Optional:
 *   - E2E_ONLY              (comma-separated scenario ids to run)
 *   - E2E_BAIL              (1 = stop on first failure, default 1)
 *   - E2E_TIMEOUT_MS        (per-scenario timeout, default 30s)
 */
import { SCENARIOS } from './scenarios';
import {
  buildHarness,
  closeApp,
  runScenario,
  SKIP_E2E,
  type Scenario,
  type ScenarioResult,
} from './harness';

function color(s: string, code: number): string {
  return `\x1b[${code}m${s}\x1b[0m`;
}
const green = (s: string) => color(s, 32);
const red = (s: string) => color(s, 31);
const yellow = (s: string) => color(s, 33);
const dim = (s: string) => color(s, 90);
const bold = (s: string) => color(s, 1);

function pickScenarios(): Scenario[] {
  const only = process.env.E2E_ONLY;
  if (!only) return SCENARIOS;
  const ids = new Set(only.split(',').map((s) => s.trim()).filter(Boolean));
  const filtered = SCENARIOS.filter((s) => ids.has(s.id));
  if (filtered.length === 0) {
    console.error(
      `${red('No scenarios matched E2E_ONLY=' + only)}. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`,
    );
    process.exit(2);
  }
  return filtered;
}

async function main() {
  if (SKIP_E2E) {
    console.log(
      yellow(
        'L-1 scenarios skipped. Set RUN_LLM_E2E_TESTS=1 with a valid MINIMAX_API_KEY to run them.',
      ),
    );
    process.exit(0);
  }

  const only = pickScenarios();
  console.log(
    bold(`\nRunning ${only.length} L-1 scenario${only.length === 1 ? '' : 's'} against MiniMax-M3\n`),
  );

  const { orchestrator, prisma, salonId, catalogIndex } = await buildHarness();
  console.log(dim(`  tenant=${salonId}`));
  console.log(dim(`  catalog size=${catalogIndex.size}\n`));

  const bail = process.env.E2E_BAIL !== '0';
  const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 30_000);

  const results: ScenarioResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const scenario of only) {
    process.stdout.write(`  ${dim('·')} ${scenario.name} ... `);
    let result: ScenarioResult;
    try {
      result = await Promise.race([
        runScenario(orchestrator, prisma, salonId, catalogIndex, scenario),
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
      console.log(
        `${green('PASS')} ${dim(`(${result.durationMs}ms)`)}`,
      );
    } else {
      failed++;
      console.log(red('FAIL'));
      for (const f of result.failedAssertions) {
        console.log(`        ${red('·')} ${f.reason}`);
      }
    }
    // Always print reply + tools so we can diff providers post-hoc.
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
    if (!result.passed && bail) break;
  }

  await closeApp();

  console.log('');
  console.log(bold('Summary'));
  console.log(`  total : ${results.length}`);
  console.log(`  ${green('passed')} : ${passed}`);
  console.log(`  ${failed ? red('failed') : dim('failed')} : ${failed}`);

  if (failed > 0) {
    console.log(red('\nL-1 scenarios FAILED.'));
    process.exit(1);
  } else {
    console.log(green('\nAll L-1 scenarios passed.'));
  }
}

main().catch(async (err) => {
  console.error(red('L-1 runner crashed:'), err);
  await closeApp();
  process.exit(2);
});