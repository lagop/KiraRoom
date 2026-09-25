import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { LLMProvider } from '@kira/shared';
import { LLMProviderFactory } from './llm-provider.factory';

/**
 * Environment variable names are case-sensitive on Linux, and two reads
 * here were spelled `MiniMax_API_KEY` / `MiniMax_BASE_URL` while the whole
 * rest of the repo -- the operator template, the compose, the admin-UI
 * override in platform-llm-config.service.ts, the e2e harnesses -- uses
 * `MINIMAX_API_KEY` / `MINIMAX_BASE_URL`.
 *
 * Confirmed in the running production container:
 *
 *   MINIMAX_API_KEY: presente      <- what the operator sets
 *   MiniMax_API_KEY: AUSENTE       <- what the code read
 *
 * MiniMax was the only LLM provider with a key configured, so the effect
 * was that the virtual receptionist could not reach any model at all, and
 * the only trace was one "MiniMax API key not configured" line at startup.
 * The admin-UI override was dead for the same reason: it assigns
 * process.env.MINIMAX_API_KEY, which the provider was not reading.
 *
 * Two guards: the behaviour, and the whole class of typo.
 */

function stubConfig(env: Record<string, string>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function factoryWith(env: Record<string, string>): LLMProviderFactory {
  const noop = {} as never;
  return new LLMProviderFactory(stubConfig(env), noop, noop, noop, noop, noop);
}

describe('LLM provider environment variable names', () => {
  it('reports MiniMax available from the MINIMAX_API_KEY the operator sets', () => {
    const factory = factoryWith({ MINIMAX_API_KEY: 'sk-minimax-test' });

    expect(factory.isProviderAvailable(LLMProvider.MiniMax)).toBe(true);
  });

  it('does not report MiniMax available from the old mixed-case name', () => {
    // If someone reintroduces the mixed-case read, this is the test that
    // says the operator's variable is the one that counts.
    const factory = factoryWith({ MiniMax_API_KEY: 'sk-minimax-test' });

    expect(factory.isProviderAvailable(LLMProvider.MiniMax)).toBe(false);
  });

  it('reports each other provider available from its documented name', () => {
    const cases: Array<[LLMProvider, string]> = [
      [LLMProvider.OPENAI, 'OPENAI_API_KEY'],
      [LLMProvider.ANTHROPIC, 'ANTHROPIC_API_KEY'],
      [LLMProvider.GOOGLE, 'GOOGLE_API_KEY'],
      [LLMProvider.LLAMA, 'LLAMA_API_KEY'],
    ];

    for (const [provider, key] of cases) {
      expect(factoryWith({ [key]: 'k' }).isProviderAvailable(provider)).toBe(true);
      expect(factoryWith({}).isProviderAvailable(provider)).toBe(false);
    }
  });

  it('never reads an environment variable spelled in mixed case', () => {
    // The class of bug, not just the instance. An env name is
    // SCREAMING_SNAKE_CASE; anything else is a typo that fails silently
    // on Linux and works on a developer's Windows machine.
    const dir = path.resolve(__dirname, '..');
    const offenders: string[] = [];

    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.spec.')) continue;

        const src = fs.readFileSync(p, 'utf8');
        const reads = [
          ...src.matchAll(/\.get(?:<[^>]*>)?\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/g),
          ...src.matchAll(/process\.env\.([A-Za-z][A-Za-z0-9_]*)/g),
          ...src.matchAll(/process\.env\[\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]\s*\]/g),
        ].map((m) => m[1]);

        for (const name of reads) {
          // Only judge names that look like env vars: they contain an
          // underscore. `configService.get('someNestedKey')` is not one.
          if (!name.includes('_')) continue;
          if (name !== name.toUpperCase()) {
            offenders.push(`${path.relative(dir, p)}: ${name}`);
          }
        }
      }
    };
    walk(dir);

    expect(offenders).toEqual([]);
  });
});
