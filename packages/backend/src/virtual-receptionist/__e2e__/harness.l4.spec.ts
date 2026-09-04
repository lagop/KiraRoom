import { evaluateAssertion } from './harness';
import { ChatIntent } from '@kira/shared';

/**
 * L-4 unit tests for the L-1 harness's assertion helpers. Every
 * assertion kind used in `scenarios.ts` has a positive and negative
 * case here so that bugs in the runner itself surface as a failed
 * L-4 test rather than as a misleading L-1 failure.
 */

const noTools: Array<{ name: string; input: unknown }> = [];
const emptyCatalog = new Map<string, { name: string; price: string }>();

describe('L-1 harness assertions (L-4)', () => {
  describe('contains', () => {
    it('matches case-insensitively by default', () => {
      const ok = evaluateAssertion(
        'Corte de Cabello Hombre 18 EUR',
        noTools,
        undefined,
        'MiniMax',
        { kind: 'contains', value: 'corte de cabello' },
        emptyCatalog,
      );
      expect(ok).toEqual({ ok: true });
    });

    it('reports a clear reason when missing', () => {
      const res = evaluateAssertion(
        'Hola',
        noTools,
        undefined,
        'MiniMax',
        { kind: 'contains', value: 'precio' },
        emptyCatalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('precio');
    });

    it('respects caseSensitive flag', () => {
      const res = evaluateAssertion(
        'Corte',
        noTools,
        undefined,
        'MiniMax',
        { kind: 'contains', value: 'corte', caseSensitive: true },
        emptyCatalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
    });
  });

  describe('containsAny / containsAll', () => {
    it('containsAny passes when one value matches', () => {
      const res = evaluateAssertion(
        'no tenemos ese servicio',
        noTools,
        undefined,
        'MiniMax',
        { kind: 'containsAny', values: ['no tenemos', 'sí tenemos'] },
        emptyCatalog,
      );
      expect(res).toEqual({ ok: true });
    });

    it('containsAll reports every missing value', () => {
      const res = evaluateAssertion(
        'hola',
        noTools,
        undefined,
        'MiniMax',
        { kind: 'containsAll', values: ['precio', 'disponible', 'masaje'] },
        emptyCatalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('precio');
      expect(res.reason).toContain('masaje');
    });
  });

  describe('notContains', () => {
    it('fails when the forbidden substring is present', () => {
      const res = evaluateAssertion(
        'Soy la asistente virtual de Kira',
        noTools,
        undefined,
        'MiniMax',
        { kind: 'notContains', value: 'Soy la asistente virtual' },
        emptyCatalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
    });
  });

  describe('toolCalled / toolNotCalled', () => {
    const tools = [
      { name: 'list_services', input: { audience: 'male' } },
      { name: 'get_service', input: { serviceId: 's-1' } },
    ];

    it('passes when the tool ran', () => {
      expect(
        evaluateAssertion(
          '',
          tools,
          undefined,
          'MiniMax',
          { kind: 'toolCalled', toolName: 'list_services' },
          emptyCatalog,
        ),
      ).toEqual({ ok: true });
    });

    it('enforces minTimes', () => {
      const res = evaluateAssertion(
        '',
        [{ name: 'list_services', input: {} }],
        undefined,
        'MiniMax',
        { kind: 'toolCalled', toolName: 'list_services', minTimes: 2 },
        emptyCatalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('2');
    });

    it('enforces input shape when withInput is supplied', () => {
      const res = evaluateAssertion(
        '',
        [{ name: 'list_services', input: { audience: 'female' } }],
        undefined,
        'MiniMax',
        {
          kind: 'toolCalled',
          toolName: 'list_services',
          withInput: { audience: 'male' },
        },
        emptyCatalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
    });

    it('toolNotCalled fails when the tool was called', () => {
      const res = evaluateAssertion(
        '',
        [{ name: 'list_services', input: {} }],
        undefined,
        'MiniMax',
        { kind: 'toolNotCalled', toolName: 'list_services' },
        emptyCatalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
    });
  });

  describe('intent / provider', () => {
    it('matches intent', () => {
      expect(
        evaluateAssertion(
          '',
          noTools,
          ChatIntent.SERVICE_INFO,
          'MiniMax',
          { kind: 'intent', intent: ChatIntent.SERVICE_INFO },
          emptyCatalog,
        ),
      ).toEqual({ ok: true });
    });

    it('matches provider exactly', () => {
      expect(
        evaluateAssertion(
          '',
          noTools,
          undefined,
          'MiniMax',
          { kind: 'provider', provider: 'MiniMax' },
          emptyCatalog,
        ),
      ).toEqual({ ok: true });
    });
  });

  describe('priceFromCatalog', () => {
    it('passes when the price AND the name are present', () => {
      const catalog = new Map([
        ['s-1', { name: 'Corte de Cabello Hombre', price: '18.00 EUR' }],
      ]);
      expect(
        evaluateAssertion(
          'El Corte de Cabello Hombre cuesta 18.00 EUR.',
          noTools,
          undefined,
          'MiniMax',
          {
            kind: 'priceFromCatalog',
            expectedPrices: [
              { name: 'Corte de Cabello Hombre', price: '18.00 EUR' },
            ],
          },
          catalog,
        ),
      ).toEqual({ ok: true });
    });

    it('fails when the price is fabricated', () => {
      const catalog = new Map([
        ['s-1', { name: 'Corte de Cabello Hombre', price: '18.00 EUR' }],
      ]);
      const res = evaluateAssertion(
        'El Corte de Cabello Hombre cuesta 12.50 EUR.',
        noTools,
        undefined,
        'MiniMax',
        {
          kind: 'priceFromCatalog',
          expectedPrices: [
            { name: 'Corte de Cabello Hombre', price: '18.00 EUR' },
          ],
        },
        catalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
      expect(res.reason).toContain('18.00 EUR');
    });
  });

  describe('maxLength', () => {
    it('passes when under the limit', () => {
      expect(
        evaluateAssertion(
          'corto',
          noTools,
          undefined,
          'MiniMax',
          { kind: 'maxLength', maxChars: 10 },
          emptyCatalog,
        ),
      ).toEqual({ ok: true });
    });
    it('fails when over the limit', () => {
      const res = evaluateAssertion(
        'a'.repeat(100),
        noTools,
        undefined,
        'MiniMax',
        { kind: 'maxLength', maxChars: 50 },
        emptyCatalog,
      ) as { ok: false; reason: string };
      expect(res.ok).toBe(false);
    });
  });
});