import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import type { TaxRegime } from "@kira/shared";
import {
  FetchLike,
  HoldedApiError,
  HoldedClient,
  HoldedCreateInvoiceBody,
  HoldedTax,
} from "./holded.client";

export interface HoldedInvoiceLineInput {
  description: string;
  quantity: number;
  /** Unit price before tax and before the line discount, in cents. */
  unitPriceCents: number;
  discountPct: number;
  taxRate: number;
}

export interface HoldedInvoiceInput {
  /** The salon's own invoice number (series + number), e.g. "A000123". */
  documentNumber: string;
  /** YYYY-MM-DD. */
  issueDate: string;
  currency: string;
  customerName: string;
  customerTaxId?: string | null;
  notes?: string | null;
  /** IVA / IGIC / IPSI: decides which Holded tax a rate maps to. */
  regime: TaxRegime;
  lines: HoldedInvoiceLineInput[];
}

export interface HoldedPushResult {
  externalId: string;
  /** True when the invoice was already in Holded and we only linked it. */
  alreadyInHolded: boolean;
}

/**
 * A problem that retrying will not fix and that needs the salon to act
 * (create a tax in Holded, fix the invoice). Recorded as `error`, not retried.
 */
export class HoldedSetupError extends Error {}

/** Holded would not cancel the invoice (its state there does not allow it). */
export class HoldedCancelRefused extends Error {}

export type HoldedCancelOutcome = "cancelled" | "already_cancelled" | "not_in_holded";

const TAX_CACHE_TTL_MS = 60 * 60_000;

/**
 * Pushes issued invoices into the salon's Holded account.
 *
 * What a sync does, per invoice:
 *   1. (Only when an earlier attempt may have reached Holded) look the
 *      invoice up by number, so a timeout after Holded created it does not
 *      produce a duplicate.
 *   2. Find the customer: by NIF when the invoice has one, otherwise by exact
 *      name; create the contact when there is none.
 *   3. Map every line's tax rate to one of the account's own sales taxes.
 *   4. POST the invoice with the salon's series+number as the document number.
 *
 * The invoice is created as a draft and never approved from here: KiraRoom
 * already issued it (and, with VERI*FACTU on, already reported it to the
 * AEAT). Approving it in a Holded account that also has VERI*FACTU switched
 * on would report the same sale twice, so that decision stays with the
 * salon and its gestoría.
 *
 * Holded's plans cap API calls per month (500 on Plus), so the taxes list is
 * cached and the duplicate check only runs on retries: a normal invoice costs
 * two or three calls.
 */
@Injectable()
export class HoldedAdapter {
  private readonly taxCache = new Map<string, { at: number; taxes: HoldedTax[] }>();

  /** Test seam: specs pass a mock transport. Never reaches Holded in tests. */
  protected fetchImpl: FetchLike | undefined;

  protected client(apiKey: string): HoldedClient {
    return new HoldedClient(apiKey, this.fetchImpl);
  }

  /**
   * Validates a key the salon just pasted: authentication plus the read
   * scopes we use. Throws HoldedApiError (401/403) when it is not usable.
   */
  async verifyKey(apiKey: string): Promise<void> {
    const client = this.client(apiKey);
    const taxes = await client.listTaxes();
    this.taxCache.set(fingerprint(apiKey), { at: Date.now(), taxes });
    await client.probeContactsRead();
    await client.probeInvoicesRead();
  }

  async pushInvoice(
    apiKey: string,
    input: HoldedInvoiceInput,
    opts: { checkExisting: boolean },
  ): Promise<HoldedPushResult> {
    const client = this.client(apiKey);

    if (opts.checkExisting) {
      // find-by-number is fuzzy (prefix + typo tolerant): only an exact
      // document_number counts as "already there".
      const matches = await client.findInvoicesByNumber(input.documentNumber);
      const exact = matches.find((m) => m.document_number === input.documentNumber);
      if (exact) return { externalId: exact.id, alreadyInHolded: true };
    }

    const taxes = await this.taxes(apiKey, client);
    const items = input.lines.map((l) => {
      const taxId = pickSalesTaxId(taxes, l.taxRate, input.regime);
      if (!taxId && l.taxRate !== 0) {
        throw new HoldedSetupError(
          `Tu cuenta de Holded no tiene un impuesto de venta ${input.regime.toUpperCase()} del ${formatRate(l.taxRate)} %. ` +
            `Actívalo en Holded (Ajustes > Impuestos) y vuelve a intentarlo.`,
        );
      }
      return {
        name: l.description.slice(0, 250),
        units: l.quantity,
        price: l.unitPriceCents / 100,
        ...(l.discountPct ? { discount: l.discountPct } : {}),
        // A 0 % line with no matching exempt tax in the account goes without
        // taxes, which is what 0 % means.
        taxes: taxId ? [taxId] : [],
      };
    });

    const contactId = await this.resolveContact(client, input);
    const body: HoldedCreateInvoiceBody = {
      contact_id: contactId,
      contact_name: input.customerName,
      date: input.issueDate,
      number: input.documentNumber,
      currency: input.currency,
      notes: ["Factura emitida en KiraRoom.", input.notes].filter(Boolean).join("\n"),
      items,
    };
    const created = await client.createInvoice(body);
    return { externalId: created.id, alreadyInHolded: false };
  }

  /**
   * Mirrors a KiraRoom cancellation on the Holded invoice with Holded's own
   * "cancel" action, which leaves the document in place, marked cancelled.
   * Not a credit note: KiraRoom's cancellation is an anulación of the
   * invoice, not a refund, and the Holded copy is usually still a draft,
   * which there is nothing to rectify against. Not a delete either: that
   * would erase the salon's record in Holded.
   *
   * Idempotent: when Holded refuses (422) because the invoice is already
   * cancelled -- an earlier attempt that timed out, or the salon did it by
   * hand -- that counts as done. Any other refusal (e.g. already paid in
   * Holded) is HoldedCancelRefused: only the salon can decide there.
   */
  async cancelInvoice(apiKey: string, externalId: string): Promise<HoldedCancelOutcome> {
    const client = this.client(apiKey);
    try {
      await client.cancelInvoice(externalId);
      return "cancelled";
    } catch (err) {
      if (!(err instanceof HoldedApiError)) throw err;
      // Deleted in Holded: nothing left there to cancel.
      if (err.status === 404) return "not_in_holded";
      if (err.status !== 422) throw err;
      const state = await client.getInvoice(externalId);
      if (state.status === "cancelled") return "already_cancelled";
      throw new HoldedCancelRefused(err.detail);
    }
  }

  /** The Holded id of the invoice with exactly this number, if it is there. */
  async findInvoiceId(apiKey: string, documentNumber: string): Promise<string | null> {
    const matches = await this.client(apiKey).findInvoicesByNumber(documentNumber);
    return matches.find((m) => m.document_number === documentNumber)?.id ?? null;
  }

  private async taxes(apiKey: string, client: HoldedClient): Promise<HoldedTax[]> {
    const key = fingerprint(apiKey);
    const hit = this.taxCache.get(key);
    if (hit && Date.now() - hit.at < TAX_CACHE_TTL_MS) return hit.taxes;
    const taxes = await client.listTaxes();
    this.taxCache.set(key, { at: Date.now(), taxes });
    return taxes;
  }

  private async resolveContact(client: HoldedClient, input: HoldedInvoiceInput): Promise<string> {
    const nif = normalizeNif(input.customerTaxId);
    if (nif) {
      const found = await client.findContactsByNif(nif);
      if (found[0]?.id) return found[0].id;
      // `code` is the field Holded's contact list filters by NIF, and
      // `vat_number` is the fiscal id on the contact sheet: fill both.
      const created = await client.createContact({
        name: input.customerName,
        code: nif,
        vat_number: nif,
        type: "client",
      });
      return created.id;
    }

    // No NIF (simplified invoice): reuse a contact with exactly this name
    // and no NIF, so a regular client does not pile up duplicates.
    const name = input.customerName.trim();
    const candidates = await client.searchContactsByName(name);
    const same = candidates.find(
      (c) => c.id && normalizeName(c.name) === normalizeName(name) && !c.vat_number && !c.code,
    );
    if (same) return same.id;
    const created = await client.createContact({ name, is_person: true, type: "client" });
    return created.id;
  }
}

/**
 * Picks the Holded sales tax for a rate in the salon's regime.
 *
 * Holded's tax list is per account and its keys look like "s_iva_21" (the
 * example in the create-invoice reference), but the docs do not enumerate
 * them, so we match on what is documented: `amount` must equal the rate,
 * the tax must be active, and the key/name/group must mention the regime.
 * The regime check is what keeps an IGIC 15 % line from landing on a 15 %
 * IRPF retention. Sales taxes ("s_" keys, or a scope that says sales) win
 * over anything else at the same rate.
 */
export function pickSalesTaxId(taxes: HoldedTax[], rate: number, regime: TaxRegime): string | null {
  let best: { id: string; score: number } | null = null;
  for (const t of taxes) {
    if (!t?.id || t.status === false) continue;
    const amount = Number(String(t.amount ?? "").replace(",", "."));
    if (!Number.isFinite(amount) || Math.abs(amount - rate) > 0.001) continue;
    const text = [t.key, t.name, t.group].filter(Boolean).join(" ").toLowerCase();
    if (!text.includes(regime)) continue;
    const key = (t.key ?? "").toLowerCase();
    const scope = `${t.scope ?? ""} ${t.type ?? ""}`.toLowerCase();
    if (key.startsWith("p_") || /purchase|compra/.test(scope)) continue;
    if (/recargo|req|ret|irpf/.test(key)) continue;
    let score = 0;
    if (key.startsWith("s_")) score += 2;
    if (/sale|venta/.test(scope)) score += 1;
    if (!best || score > best.score) best = { id: t.id, score };
  }
  return best?.id ?? null;
}

export function normalizeNif(raw: string | null | undefined): string | null {
  const v = (raw ?? "").replace(/[\s.-]/g, "").toUpperCase();
  return v.length >= 5 ? v : null;
}

function normalizeName(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function formatRate(rate: number): string {
  return String(rate).replace(".", ",");
}

function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export { HoldedApiError };
