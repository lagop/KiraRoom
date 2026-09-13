// P2A-receptionist-v2 Phase 12 -- the fiscal compliance path
// (Verifactu / TicketBAI / SII / QR / Xades / tax reports / accounting
// sync) is a legal obligation in Spain. Per the v2 spec note #12, no
// fiscal module may be gated by plan or add-on -- entitlement must
// always be true regardless of subscription state.
//
// This test scans the source files at runtime and fails if any
// fiscal module imports or calls the FeatureFlagService /
// assertEnabled / isFeatureUnlocked API. It also asserts the
// canonical source-of-truth (the gating matrix in
// subscriptions.service.ts) does not contain any fiscal key.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const FISCAL_HINTS = [
  'invoices/fiscal',
  'invoices/tax-reports',
  'invoices/invoice-calculator',
  'invoices/invoice-pdf',
  'invoices/invoices.service',
  'invoices/invoices.module',
  'accounting/',
];

// Anything that would gate fiscal behind plan/add-on. The dispatcher
// call is `fiscal.dispatchInvoice(...)` -- if any fiscal file starts
// to take a flags dep, this test will fail loudly.
const FORBIDDEN = [
  'FeatureFlagService',
  'assertEnabled',
  'isFeatureUnlocked',
  'isEnabled(',
  'isMultiLocationActive',
  'FeatureKey.',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'coverage' || e === 'dist' || e === '.next') {
      continue;
    }
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (e.endsWith('.ts') && !e.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

describe('Phase 12 invariant: fiscal compliance is NEVER gated by plan or add-on', () => {
  // __dirname = .../src/common/feature-flags -- walk from packages/backend
  // so we can scan the whole tree (in particular src/invoices, which
  // is 2 levels up from the spec file).
  const root = join(__dirname, '..', '..', '..');
  const files = walk(root);

  // Skip the test file itself and the gating matrix (which can
  // legitimately talk about *plan* features, just not about fiscal).
  const fiscalFiles = files.filter((f) => {
    if (f.endsWith('fiscal-invariant.spec.ts')) return false;
    if (f.endsWith('subscriptions.service.ts') && f.includes('payments')) return false;
    if (f.endsWith('feature-flag.service.ts')) return false;
    return FISCAL_HINTS.some((h) => {
      // Compare on a separator-normalized form so the test passes on
      // both Windows (\\ in paths) and Linux/Mac (/ in paths).
      const normalized = f.replace(/\\/g, '/');
      return normalized.includes(h);
    });
  });

  it(`forbids ${FORBIDDEN.length} gating symbols in ${fiscalFiles.length} fiscal files`, () => {
    const offenders: Array<{ file: string; symbol: string; line: number }> = [];
    for (const f of fiscalFiles) {
      const text = readFileSync(f, 'utf-8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const sym of FORBIDDEN) {
          // Skip comment lines so the test's own docstring doesn't
          // pollute the scan.
          if (line.trim().startsWith('//')) continue;
          // Skip strings (e.g. error messages, log lines).
          const stripped = line.replace(/"[^"]*"/g, '');
          if (stripped.includes(sym)) {
            offenders.push({ file: f, symbol: sym, line: i + 1 });
          }
        }
      });
    }
    if (offenders.length > 0) {
      const summary = offenders
        .map((o) => `  ${o.file.replace(/^.*src\\/, 'src/')}:${o.line}  (${o.symbol})`)
        .slice(0, 25)
        .join('\n');
      throw new Error(
        `Fiscal modules must NOT depend on FeatureFlagService. ` +
          `Found ${offenders.length} offence(s):\n${summary}`,
      );
    }
    expect(fiscalFiles.length).toBeGreaterThan(0);
  });

  it('gating matrix (subscriptions.service.ts) does not contain any fiscal key', () => {
    const sub = readFileSync(join(root, 'src/payments/services/subscriptions.service.ts'), 'utf-8');
    // The matrix uses `whatsapp_notifications`, `virtual_receptionist`,
    // The matrix uses `whatsapp_notifications`, `virtual_receptionist`,
    // `multi_location`, etc. None of these should ever become a
    // fiscal feature. The test runs every time so any accidental
    // addition is caught.
    const offenders: string[] = [];
    for (const fiscal of [
      'verifactu',
      'ticketbai',
      'ticket_bai',
      'sii',
      'aeat',
      'invoice_qr',
      'fiscal_certificate',
      'xades',
    ]) {
      if (new RegExp(`['"\`]${fiscal}['"\`]`).test(sub)) {
        offenders.push(fiscal);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the canonical FeatureKey union does not include any fiscal identifier', () => {
    // The FeatureKey union lives in subscriptions.service.ts. If anyone
    // adds a fiscal key there by mistake, the compile-time test
    // catches it before runtime.
    const sub = readFileSync(join(root, 'src/payments/services/subscriptions.service.ts'), 'utf-8');
    const unionMatch = sub.match(/type FeatureKey =([\s\S]+?);/);
    expect(unionMatch).not.toBeNull();
    const union = (unionMatch as RegExpMatchArray)[1];
    for (const fiscal of [
      'verifactu',
      'ticketbai',
      'sii',
      'aeat',
      'invoice_qr',
      'fiscal',
      'xades',
    ]) {
      expect(union).not.toMatch(new RegExp(`'${fiscal}'`));
    }
  });
});
