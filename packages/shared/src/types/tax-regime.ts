/**
 * Indirect tax regime of the tenant's territory.
 *
 * The product assumed peninsular VAT everywhere: `fiscalSettings` defaulted
 * to `defaultTaxRate: 21`, the interface said "IVA" in fixed strings, and the
 * only quarterly report was Modelo 303.
 *
 * Spain has three:
 *
 *   - **IVA** in the peninsula and the Balearics. Rates 21 / 10 / 4.
 *     Quarterly return: Modelo 303.
 *   - **IGIC** in the Canary Islands, which are outside the EU VAT territory.
 *     Rates 0 / 3 / 7 / 9.5 / 15 / 20. Quarterly return: Modelo 420, filed
 *     with the Agencia Tributaria Canaria, not the AEAT.
 *   - **IPSI** in Ceuta and Melilla, whose rates are set by each city.
 *
 * A Canarian salon could already set 7 % — the rate is per tenant and per
 * product — so its invoices came out right. What did not was everything
 * around them: the interface called it IVA, and `aggregateModelo303` read
 * only the buckets for 21, 10 and 4, so a tenant billing at 7 % got a report
 * with zeros in every box and no error. A silently wrong tax return is worse
 * than a missing feature, because someone might file it.
 */
export const TAX_REGIMES = ['iva', 'igic', 'ipsi'] as const;

export type TaxRegime = (typeof TAX_REGIMES)[number];

export const DEFAULT_TAX_REGIME: TaxRegime = 'iva';

/** What the tax is called on an invoice and in the interface. */
export const TAX_REGIME_LABELS: Record<TaxRegime, string> = {
  iva: 'IVA',
  igic: 'IGIC',
  ipsi: 'IPSI',
};

/** Where each regime applies, for the settings screen. */
export const TAX_REGIME_TERRITORIES: Record<TaxRegime, string> = {
  iva: 'Península y Baleares',
  igic: 'Canarias',
  ipsi: 'Ceuta y Melilla',
};

/**
 * Rates a regime actually uses, ordered low to high.
 *
 * IPSI rates are set by each city and change, so the list is the common range
 * rather than an authority: it is used to warn, never to block.
 */
export const TAX_REGIME_RATES: Record<TaxRegime, number[]> = {
  iva: [0, 4, 10, 21],
  igic: [0, 3, 7, 9.5, 15, 20],
  ipsi: [0, 4, 6, 8, 10],
};

/** The rate a new tenant starts with. */
export const TAX_REGIME_DEFAULT_RATE: Record<TaxRegime, number> = {
  iva: 21,
  igic: 7,
  ipsi: 10,
};

/**
 * The quarterly return that belongs to each regime.
 *
 * `null` for IPSI: Ceuta and Melilla file with their own city councils on
 * their own forms, and inventing one would be worse than offering none.
 */
export const TAX_REGIME_QUARTERLY_REPORT: Record<TaxRegime, string | null> = {
  iva: 'modelo_303',
  igic: 'modelo_420',
  ipsi: null,
};

export function isTaxRegime(value: unknown): value is TaxRegime {
  return typeof value === 'string' && (TAX_REGIMES as readonly string[]).includes(value);
}

/** Reads the regime out of a tenant's `fiscalSettings`, defaulting to IVA. */
export function taxRegimeOf(fiscalSettings: unknown): TaxRegime {
  const raw = (fiscalSettings as { taxRegime?: unknown } | null)?.taxRegime;
  return isTaxRegime(raw) ? raw : DEFAULT_TAX_REGIME;
}

export function taxLabelOf(fiscalSettings: unknown): string {
  return TAX_REGIME_LABELS[taxRegimeOf(fiscalSettings)];
}

/**
 * True when `rate` is one this regime uses. Callers warn on false rather than
 * refuse: a rate can be historic, or a city can change an IPSI one.
 */
export function isKnownRateFor(regime: TaxRegime, rate: number): boolean {
  return TAX_REGIME_RATES[regime].includes(rate);
}
