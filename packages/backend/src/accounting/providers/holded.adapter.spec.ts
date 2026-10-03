/**
 * Holded client + adapter, against a mock transport (never the real API).
 *
 * Why these tests exist: the previous "Holded adapter" returned an id it
 * computed itself and never made a request. These pin the real contract
 * from Holded's v2 reference: Bearer auth, the URLs and body fields we send,
 * that the id we keep is the one Holded answered with, that failures carry
 * Holded's own message, and the decisions the adapter makes (which contact,
 * which tax, no duplicate on retry).
 */

import { FetchLike, HoldedApiError, HoldedClient } from "./holded.client";
import {
  HoldedAdapter,
  HoldedCancelRefused,
  HoldedInvoiceInput,
  HoldedSetupError,
  pickSalesTaxId,
} from "./holded.adapter";

type Route = { status?: number; body?: unknown; headers?: Record<string, string> };

/** Records every call; answers by "METHOD path-without-query". */
function mockFetch(routes: Record<string, Route | Route[]>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: any }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      method: init.method,
      url,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const path = url.replace("https://api.holded.com", "").split("?")[0];
    const key = `${init.method} ${path}`;
    let route = routes[key];
    if (Array.isArray(route)) route = route.shift();
    if (!route) throw new Error(`unexpected call ${key}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => route!.headers?.[n.toLowerCase()] ?? null },
      text: async () => (route!.body === undefined ? "" : JSON.stringify(route!.body)),
    };
  };
  return { fetchImpl, calls };
}

class TestAdapter extends HoldedAdapter {
  constructor(f: FetchLike) {
    super();
    this.fetchImpl = f;
  }
}

const TAXES = {
  items: [
    { id: "tax-p21", key: "p_iva_21", name: "IVA 21% compras", amount: "21", status: true },
    { id: "tax-s21", key: "s_iva_21", name: "IVA 21%", amount: "21", status: true },
    { id: "tax-s10", key: "s_iva_10", name: "IVA 10%", amount: "10", status: true },
    { id: "tax-ret15", key: "s_ret_15", name: "Retención IRPF 15%", amount: "15", status: true },
    { id: "tax-igic15", key: "s_igic_15", name: "IGIC 15%", amount: "15", status: true },
    { id: "tax-igic7", key: "s_igic_7", name: "IGIC 7%", amount: "7", status: true },
  ],
};

function input(overrides: Partial<HoldedInvoiceInput> = {}): HoldedInvoiceInput {
  return {
    documentNumber: "A000042",
    issueDate: "2026-09-15",
    currency: "EUR",
    customerName: "Lucía Ejemplo",
    customerTaxId: "12345678-z",
    notes: null,
    regime: "iva",
    lines: [{ description: "Corte y peinado", quantity: 1, unitPriceCents: 3500, discountPct: 0, taxRate: 21 }],
    ...overrides,
  };
}

describe("HoldedClient", () => {
  it("authenticates with a Bearer key and asks for JSON", async () => {
    const { fetchImpl, calls } = mockFetch({ "GET /api/v2/taxes": { body: TAXES } });
    const taxes = await new HoldedClient("test-key-123", fetchImpl).listTaxes();
    expect(taxes).toHaveLength(6);
    expect(calls[0].url).toBe("https://api.holded.com/api/v2/taxes");
    expect(calls[0].headers.Authorization).toBe("Bearer test-key-123");
    expect(calls[0].headers.Accept).toBe("application/json");
  });

  it("surfaces Holded's problem detail and Retry-After", async () => {
    const { fetchImpl } = mockFetch({
      "POST /api/v2/invoices": {
        status: 429,
        headers: { "retry-after": "60" },
        body: { type: "x", title: "Rate limit exceeded", status: 429, detail: "Retry in 60 seconds." },
      },
    });
    const err = await new HoldedClient("k", fetchImpl)
      .createInvoice({ contact_id: "c", date: "2026-01-01", items: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HoldedApiError);
    expect(err.status).toBe(429);
    expect(err.detail).toBe("Retry in 60 seconds.");
    expect(err.retryAfterSeconds).toBe(60);
    expect(err.transient).toBe(true);
  });

  it("treats a network failure as transient (status 0)", async () => {
    const err = await new HoldedClient("k", async () => {
      throw new Error("ECONNRESET");
    })
      .listTaxes()
      .catch((e) => e);
    expect(err).toBeInstanceOf(HoldedApiError);
    expect(err.status).toBe(0);
    expect(err.transient).toBe(true);
  });

  it("refuses a 2xx without an id instead of inventing one", async () => {
    const { fetchImpl } = mockFetch({ "POST /api/v2/invoices": { status: 201, body: {} } });
    await expect(
      new HoldedClient("k", fetchImpl).createInvoice({ contact_id: "c", date: "2026-01-01", items: [] }),
    ).rejects.toThrow(/without a document id/);
  });
});

describe("pickSalesTaxId", () => {
  it("picks the sales tax, not the purchase one, at the same rate", () => {
    expect(pickSalesTaxId(TAXES.items, 21, "iva")).toBe("tax-s21");
  });

  it("does not land an IGIC 15 % line on a 15 % IRPF retention", () => {
    expect(pickSalesTaxId(TAXES.items, 15, "igic")).toBe("tax-igic15");
    expect(pickSalesTaxId(TAXES.items, 15, "iva")).toBeNull();
  });

  it("returns null when the account has no such tax", () => {
    expect(pickSalesTaxId(TAXES.items, 4, "iva")).toBeNull();
    expect(pickSalesTaxId([{ id: "x", key: "s_iva_21", amount: "21", status: false }], 21, "iva")).toBeNull();
  });
});

describe("HoldedAdapter.pushInvoice", () => {
  it("reuses the contact found by NIF and creates the invoice with the salon's number", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /api/v2/taxes": { body: TAXES },
      "GET /api/v2/contacts": { body: { items: [{ id: "contact-1", name: "Lucía Ejemplo" }] } },
      "POST /api/v2/invoices": { status: 201, body: { id: "65f0c0ffee0000000000abcd" } },
    });
    const r = await new TestAdapter(fetchImpl).pushInvoice("k", input(), { checkExisting: false });

    expect(r).toEqual({ externalId: "65f0c0ffee0000000000abcd", alreadyInHolded: false });
    const contactLookup = calls.find((c) => c.url.includes("/api/v2/contacts"))!;
    expect(contactLookup.url).toContain("code=12345678Z");
    const create = calls.find((c) => c.method === "POST")!;
    expect(create.url).toBe("https://api.holded.com/api/v2/invoices");
    expect(create.headers["Content-Type"]).toBe("application/json");
    expect(create.body).toEqual({
      contact_id: "contact-1",
      contact_name: "Lucía Ejemplo",
      date: "2026-09-15",
      number: "A000042",
      currency: "EUR",
      notes: "Factura emitida en KiraRoom.",
      items: [{ name: "Corte y peinado", units: 1, price: 35, taxes: ["tax-s21"] }],
    });
    // No approve call: the invoice stays a draft in Holded (see adapter doc).
    expect(calls.some((c) => c.url.includes("/approve"))).toBe(false);
  });

  it("creates the contact with NIF in code and vat_number when Holded has none", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /api/v2/taxes": { body: TAXES },
      "GET /api/v2/contacts": { body: { items: [] } },
      "POST /api/v2/contacts": { status: 201, body: { id: "contact-new" } },
      "POST /api/v2/invoices": { status: 201, body: { id: "inv-holded-1" } },
    });
    await new TestAdapter(fetchImpl).pushInvoice("k", input(), { checkExisting: false });
    const contact = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/v2/contacts"))!;
    expect(contact.body).toEqual({
      name: "Lucía Ejemplo",
      code: "12345678Z",
      vat_number: "12345678Z",
      type: "client",
    });
    expect(calls.find((c) => c.url.endsWith("/api/v2/invoices"))!.body.contact_id).toBe("contact-new");
  });

  it("without a NIF, reuses an exact-name contact that has no NIF", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /api/v2/taxes": { body: TAXES },
      "GET /api/v2/contacts/search": {
        body: {
          items: [
            { id: "other", name: "Lucía Ejemplo Pérez" },
            { id: "with-nif", name: "Lucia Ejemplo", code: "X1234567L" },
            { id: "same", name: "lucia  ejemplo" },
          ],
        },
      },
      "POST /api/v2/invoices": { status: 201, body: { id: "inv-holded-2" } },
    });
    await new TestAdapter(fetchImpl).pushInvoice("k", input({ customerTaxId: null }), {
      checkExisting: false,
    });
    expect(calls.find((c) => c.method === "POST")!.body.contact_id).toBe("same");
  });

  it("on a retry, links an invoice Holded already has instead of duplicating it", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /api/v2/invoices/find-by-number": {
        body: {
          items: [
            { id: "fuzzy", document_number: "A0000421" },
            { id: "exact", document_number: "A000042" },
          ],
        },
      },
    });
    const r = await new TestAdapter(fetchImpl).pushInvoice("k", input(), { checkExisting: true });
    expect(r).toEqual({ externalId: "exact", alreadyInHolded: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("document_number=A000042");
  });

  it("a fuzzy-only match is not the same invoice", async () => {
    const { fetchImpl } = mockFetch({
      "GET /api/v2/invoices/find-by-number": { body: { items: [{ id: "fuzzy", document_number: "A0000421" }] } },
      "GET /api/v2/taxes": { body: TAXES },
      "GET /api/v2/contacts": { body: { items: [{ id: "c1" }] } },
      "POST /api/v2/invoices": { status: 201, body: { id: "new-one" } },
    });
    const r = await new TestAdapter(fetchImpl).pushInvoice("k", input(), { checkExisting: true });
    expect(r.externalId).toBe("new-one");
  });

  it("stops before writing anything when a rate has no tax in the account", async () => {
    const { fetchImpl, calls } = mockFetch({ "GET /api/v2/taxes": { body: TAXES } });
    const err = await new TestAdapter(fetchImpl)
      .pushInvoice("k", input({ regime: "igic", lines: [{ description: "x", quantity: 1, unitPriceCents: 100, discountPct: 0, taxRate: 3 }] }), {
        checkExisting: false,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HoldedSetupError);
    expect(err.message).toMatch(/IGIC del 3 %/);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("sends the line discount and caches the tax list between invoices", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /api/v2/taxes": { body: TAXES },
      "GET /api/v2/contacts": [{ body: { items: [{ id: "c1" }] } }, { body: { items: [{ id: "c1" }] } }],
      "POST /api/v2/invoices": [{ status: 201, body: { id: "a" } }, { status: 201, body: { id: "b" } }],
    });
    const adapter = new TestAdapter(fetchImpl);
    const discounted = input({
      lines: [{ description: "Tinte", quantity: 2, unitPriceCents: 4000, discountPct: 10, taxRate: 10 }],
    });
    await adapter.pushInvoice("k", discounted, { checkExisting: false });
    await adapter.pushInvoice("k", discounted, { checkExisting: false });
    expect(calls.filter((c) => c.url.endsWith("/api/v2/taxes"))).toHaveLength(1);
    expect(calls.find((c) => c.method === "POST")!.body.items[0]).toEqual({
      name: "Tinte",
      units: 2,
      price: 40,
      discount: 10,
      taxes: ["tax-s10"],
    });
  });
});

describe("HoldedAdapter.verifyKey", () => {
  it("probes taxes, contacts and invoices with the pasted key", async () => {
    const { fetchImpl, calls } = mockFetch({
      "GET /api/v2/taxes": { body: TAXES },
      "GET /api/v2/contacts": { body: { items: [] } },
      "GET /api/v2/invoices": { body: { items: [] } },
    });
    await new TestAdapter(fetchImpl).verifyKey("pasted-key");
    expect(calls.map((c) => c.url.split("?")[0])).toEqual([
      "https://api.holded.com/api/v2/taxes",
      "https://api.holded.com/api/v2/contacts",
      "https://api.holded.com/api/v2/invoices",
    ]);
  });

  it("rejects a key Holded does not accept", async () => {
    const { fetchImpl } = mockFetch({
      "GET /api/v2/taxes": { status: 401, body: { title: "Unauthorized", status: 401, detail: "Invalid API key" } },
    });
    const err = await new TestAdapter(fetchImpl).verifyKey("bad").catch((e) => e);
    expect(err).toBeInstanceOf(HoldedApiError);
    expect(err.credentialProblem).toBe(true);
  });
});

/**
 * A cancellation in KiraRoom of an invoice already in Holded left it there as
 * a live sale. Holded's v2 reference documents POST /invoices/{id}/cancel
 * (200; 422 when the state does not allow it) and GET /invoices/{id} with a
 * `status` that can be "cancelled".
 */
describe("HoldedAdapter.cancelInvoice", () => {
  const ID = "65f0aa0000000000000000aa";

  it("POSTs Holded's cancel action on the linked invoice", async () => {
    const { fetchImpl, calls } = mockFetch({ [`POST /api/v2/invoices/${ID}/cancel`]: { status: 200, body: {} } });
    expect(await new TestAdapter(fetchImpl).cancelInvoice("k", ID)).toBe("cancelled");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers.Authorization).toBe("Bearer k");
  });

  it("counts an invoice already cancelled in Holded as done (idempotent)", async () => {
    const { fetchImpl } = mockFetch({
      [`POST /api/v2/invoices/${ID}/cancel`]: { status: 422, body: { detail: "Invoice cannot be cancelled" } },
      [`GET /api/v2/invoices/${ID}`]: { body: { id: ID, status: "cancelled", draft: false } },
    });
    expect(await new TestAdapter(fetchImpl).cancelInvoice("k", ID)).toBe("already_cancelled");
  });

  it("reports a refusal it cannot resolve (e.g. already paid in Holded)", async () => {
    const { fetchImpl } = mockFetch({
      [`POST /api/v2/invoices/${ID}/cancel`]: { status: 422, body: { detail: "Invoice is paid" } },
      [`GET /api/v2/invoices/${ID}`]: { body: { id: ID, status: "completed", draft: false } },
    });
    const err = await new TestAdapter(fetchImpl).cancelInvoice("k", ID).catch((e) => e);
    expect(err).toBeInstanceOf(HoldedCancelRefused);
    expect(err.message).toBe("Invoice is paid");
  });

  it("treats an invoice deleted in Holded as nothing left to cancel", async () => {
    const { fetchImpl } = mockFetch({ [`POST /api/v2/invoices/${ID}/cancel`]: { status: 404, body: { detail: "Not found" } } });
    expect(await new TestAdapter(fetchImpl).cancelInvoice("k", ID)).toBe("not_in_holded");
  });

  it("lets transient failures through, for the caller to retry", async () => {
    const { fetchImpl } = mockFetch({ [`POST /api/v2/invoices/${ID}/cancel`]: { status: 503 } });
    const err = await new TestAdapter(fetchImpl).cancelInvoice("k", ID).catch((e) => e);
    expect(err).toBeInstanceOf(HoldedApiError);
    expect(err.transient).toBe(true);
  });

  it("finds a never-linked invoice by its exact number only", async () => {
    const { fetchImpl } = mockFetch({
      "GET /api/v2/invoices/find-by-number": {
        body: { items: [{ id: "x1", document_number: "A0000420" }, { id: "x2", document_number: "A000042" }] },
      },
    });
    expect(await new TestAdapter(fetchImpl).findInvoiceId("k", "A000042")).toBe("x2");
  });
});
