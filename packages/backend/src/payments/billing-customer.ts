import { Logger } from '@nestjs/common';
import type Stripe from 'stripe';

/**
 * Who KiraRoom bills: the salon as its Stripe customer, with the identity
 * from Ajustes > Fiscal (B1). The Stripe invoices to the salon carried its
 * trade name (tenant.name) and nothing else; a complete Spanish invoice to
 * a business carries the customer's razón social, NIF and address.
 *
 * Only what the salon has filled in is sent: the trade name stands in for
 * a missing razón social, and an address or NIF that is not there is left
 * out (Checkout then asks for the NIF, see tax_id_collection).
 */
export interface BillingIdentitySource {
  name: string;
  legalName?: string | null;
  taxId?: string | null;
  taxIdType?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export const BILLING_IDENTITY_SELECT = {
  name: true,
  legalName: true,
  taxId: true,
  taxIdType: true,
  street: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
} as const;

export interface BillingCustomerDetails {
  name: string;
  address?: Stripe.AddressParam;
  /** A Spanish NIF, CIF or NIE: Stripe's es_cif covers the three. */
  taxId?: { type: 'es_cif'; value: string };
}

const SPANISH_TAX_ID_TYPES = new Set(['nif', 'cif', 'nie']);

function clean(value: string | null | undefined): string | undefined {
  const v = typeof value === 'string' ? value.trim() : '';
  return v || undefined;
}

export function billingCustomerDetails(t: BillingIdentitySource): BillingCustomerDetails {
  const out: BillingCustomerDetails = { name: clean(t.legalName) ?? t.name };

  const line1 = clean(t.street);
  const city = clean(t.city);
  const postalCode = clean(t.postalCode);
  if (line1 || city || postalCode) {
    out.address = {
      ...(line1 ? { line1 } : {}),
      ...(city ? { city } : {}),
      ...(clean(t.state) ? { state: clean(t.state) } : {}),
      ...(postalCode ? { postal_code: postalCode } : {}),
      country: (clean(t.country) ?? 'ES').toUpperCase(),
    };
  }

  const taxId = clean(t.taxId);
  // A passport or "other" number is not a Spanish tax id: left out, and
  // Checkout asks for one.
  if (taxId && (!t.taxIdType || SPANISH_TAX_ID_TYPES.has(t.taxIdType))) {
    out.taxId = { type: 'es_cif', value: taxId.toUpperCase() };
  }
  return out;
}

/**
 * Brings an existing Stripe customer in line with the salon's identity:
 * its name and address, and its NIF as the only es_cif tax id. Best
 * effort: a failure is logged and never stops the checkout or the save
 * that called it (Stripe refuses a NIF it does not accept, for one).
 */
export async function syncBillingCustomer(
  stripe: Stripe,
  customerId: string,
  identity: BillingIdentitySource,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  const details = billingCustomerDetails(identity);
  try {
    await stripe.customers.update(customerId, {
      name: details.name,
      ...(details.address ? { address: details.address } : {}),
    });
  } catch (err) {
    logger.warn(`Could not update the billing name/address of Stripe customer ${customerId}: ${(err as Error).message}`);
  }
  if (details.taxId) await syncBillingTaxId(stripe, customerId, details.taxId, logger);
}

export async function syncBillingTaxId(
  stripe: Stripe,
  customerId: string,
  wanted: { type: 'es_cif'; value: string },
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  try {
    const existing = await stripe.customers.listTaxIds(customerId, { limit: 20 });
    const rows = existing?.data ?? [];
    const same = (v: string | null | undefined) => (v ?? '').toUpperCase().replace(/[\s.-]/g, '') === wanted.value;
    if (!rows.some((r) => r.type === wanted.type && same(r.value))) {
      await stripe.customers.createTaxId(customerId, { type: wanted.type, value: wanted.value });
    }
    // A NIF the salon has since changed is not left on its invoices.
    for (const r of rows) {
      if (r.type === wanted.type && !same(r.value)) {
        await stripe.customers.deleteTaxId(customerId, r.id);
      }
    }
  } catch (err) {
    logger.warn(`Could not set the NIF of Stripe customer ${customerId}: ${(err as Error).message}`);
  }
}
