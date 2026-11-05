/**
 * Tests for `FiscalService.anulateInvoice()`.
 *
 * TicketBAI: the anulación is signed and dispatched to the diputación and
 * the result is persisted on the invoice row. VERI*FACTU no longer goes
 * through here: InvoiceService adds an anulación record to the salon's
 * record chain (verifactu/), tested in verifactu-records.spec.ts.
 *
 * The HTTP layer is stubbed by default (FISCAL_E2E_MODE=stub) so no
 * network is involved; tests run in CI without sandbox credentials.
 */

import { TicketBaiService } from "./ticketbai.service";
import { SiiService } from "./sii.service";
import { FiscalService } from "./fiscal.service";
import { EncryptionService } from "../../common/encryption/encryption.service";

function makeEncryption(): EncryptionService {
  return new EncryptionService({
    get: (k: string) =>
      k === "META_TOKEN_ENCRYPTION_KEY"
        ? Buffer.alloc(32, 9).toString("base64")
        : null,
  } as any);
}

interface InMemoryPrisma {
  invoices: Map<string, any>;
  chains: Map<string, any>;
}

function makePrisma(): InMemoryPrisma & { prisma: any } {
  const m: InMemoryPrisma = {
    invoices: new Map(),
    chains: new Map(),
  };

  // The PrismaService exposes scoped clients (m.invoice, m.fiscalCertificate,
  // …). Build the surface FiscalService accesses at runtime.
  const prisma: any = {
    invoice: {
      findUnique: async (args: any) => {
        const inv = m.invoices.get(args.where.id);
        if (!inv) return null;
        if (args.include?.tenant) {
          const t = await prisma.tenant.findUnique({
            where: { id: inv.tenantId },
          });
          return { ...inv, tenant: t };
        }
        return inv;
      },
      update: async (args: any) => {
        const cur = m.invoices.get(args.where.id);
        if (cur) Object.assign(cur, args.data);
        return cur;
      },
    },
    fiscalChainState: {
      findUnique: async (args: any) =>
        m.chains.get(
          `${args.where.tenantId_fiscalMode.tenantId}|${args.where.tenantId_fiscalMode.fiscalMode}`,
        ) ?? null,
      upsert: async (args: any) => {
        const k = `${args.where.tenantId_fiscalMode.tenantId}|${args.where.tenantId_fiscalMode.fiscalMode}`;
        const cur = m.chains.get(k);
        const next = cur
          ? { ...cur, ...args.update }
          : { ...args.create };
        m.chains.set(k, next);
        return next;
      },
    },
    tenant: {
      findUnique: async (args: any) => {
        const id = args.where.id;
        if (id === "tenant-1") {
          return {
            fiscalMode: "verifactu",
            fiscalSettings: { tenantNif: "B12345678" },
            name: "Salon V",
          };
        }
        if (id === "tenant-2") {
          return {
            fiscalMode: "ticketbai",
            fiscalSettings: { tenantNif: "B87654321", diputacion: "gipuzkoa" },
            name: "Salon T",
          };
        }
        return null;
      },
    },
  };
  return { ...m, prisma };
}

/**
 * Build a FiscalService with the inner verifactu/ticketbai services
 * exposing real sign+dispatch bodies, but with HTTP layers stubbed
 * so no network is hit.
 */
function makeFiscalService(m: InMemoryPrisma & { prisma: any }): {
  fiscal: FiscalService;
  ticketBaiDispatch: jest.Mock;
} {
  const enc = makeEncryption();

  const ticketBai: any = new TicketBaiService(
    m.prisma,
    enc,
    {} as any,
    { buildTicketBaiUrl: () => "https://fake-tbai/q" } as any,
  );
  ticketBai.signWithTenantCert = async (_id: string, _xml: string) => ({
    signedXml: "<signed-tbai><real-signature/></signed-tbai>",
    documentHash: "tbai123",
  });
  const ticketBaiDispatch = jest.fn(async (input: any) => ({
    status: "accepted",
    tbaiCode: `TBAI-FAKE-${input.invoiceId}`,
    qrUrl: "https://fake-tbai/q",
  }));
  ticketBai.dispatch = ticketBaiDispatch;

  const fiscal = new FiscalService(
    m.prisma,
    ticketBai,
    new SiiService({} as any),
    /* retryQueue */ undefined,
    /* invoiceServiceRef */ undefined,
  );
  return { fiscal, ticketBaiDispatch };
}

function seedAnulatedInvoice(
  m: InMemoryPrisma,
  opts: {
    fiscalMode: "verifactu" | "ticketbai";
    invoiceNumber?: string;
    previousHash?: string | null;
    dispatchResult?: any;
  },
): string {
  const tenantId =
    opts.fiscalMode === "verifactu" ? "tenant-1" : "tenant-2";
  const id = `inv-${m.invoices.size + 1}`;
  m.invoices.set(id, {
    id,
    tenantId,
    series: "A",
    number: opts.invoiceNumber ?? "000001",
    issueDate: new Date("2026-07-16"),
    recipientName: "Cliente",
    recipientTaxId: "12345678Z",
    subtotalCents: 10000,
    totalCents: 12100,
    currency: "EUR",
    fiscalMode: opts.fiscalMode,
    fiscalStatus: "accepted",
    status: "issued",
    issuerTaxIdAtIssue:
      opts.fiscalMode === "verifactu" ? "B12345678" : "B87654321",
  });
  if (opts.previousHash) {
    m.chains.set(`${tenantId}|${opts.fiscalMode}`, {
      tenantId,
      fiscalMode: opts.fiscalMode,
      lastHash: opts.previousHash,
    });
  }
  return id;
}

describe("FiscalService.anulateInvoice", () => {
  it("VERI*FACTU: leaves the anulación to the record chain and dispatches nothing", async () => {
    const m = makePrisma();
    const { fiscal, ticketBaiDispatch } = makeFiscalService(m);
    const id = seedAnulatedInvoice(m, { fiscalMode: "verifactu" });
    expect(await fiscal.anulateInvoice(id, "Cliente canceló")).toBe(true);
    expect(ticketBaiDispatch).not.toHaveBeenCalled();
    expect(m.invoices.get(id).fiscalStatus).toBe("accepted");
  });

  it("TicketBAI: routes to the right diputación", async () => {
    const m = makePrisma();
    const { fiscal, ticketBaiDispatch } = makeFiscalService(m);
    const id = seedAnulatedInvoice(m, {
      fiscalMode: "ticketbai",
    });
    await fiscal.anulateInvoice(id, "Cliente canceló");

    expect(ticketBaiDispatch).toHaveBeenCalledTimes(1);
    const [args] = ticketBaiDispatch.mock.calls[0] as any;
    expect(args.diputacion).toBe("gipuzkoa");
    expect(args.invoiceId).toBe(id);
    const inv = m.invoices.get(id);
    expect(inv.fiscalStatus).toBe("accepted");
    expect(inv.fiscalReference).toBe(`TBAI-FAKE-${id}`);
  });

  it("TicketBAI: a 5xx schedules a retry rather than marking permanent", async () => {
    const m = makePrisma();
    const { fiscal, ticketBaiDispatch } = makeFiscalService(m);
    ticketBaiDispatch.mockResolvedValue({ status: "error", error: "gipuzkoa 503: upstream timeout" });
    const id = seedAnulatedInvoice(m, { fiscalMode: "ticketbai" });
    expect(await fiscal.anulateInvoice(id, "x")).toBe(false);
    // The retry queue is not wired here, so the status is left as it was.
    expect(m.invoices.get(id).fiscalStatus).not.toBe("error");
  });

  it("TicketBAI: a 4xx is permanent (no retry)", async () => {
    const m = makePrisma();
    const { fiscal, ticketBaiDispatch } = makeFiscalService(m);
    ticketBaiDispatch.mockResolvedValue({ status: "rejected", error: "gipuzkoa 400: bad schema" });
    const id = seedAnulatedInvoice(m, { fiscalMode: "ticketbai" });
    expect(await fiscal.anulateInvoice(id, "x")).toBe(true);
    const inv = m.invoices.get(id);
    expect(inv.fiscalStatus).toBe("rejected");
    expect(inv.fiscalError).toContain("400");
  });

  it("TicketBAI: a missing certificate is written to fiscalError instead of crashing", async () => {
    const m = makePrisma();
    const { fiscal } = makeFiscalService(m);
    (fiscal as any).ticketBai.signWithTenantCert = async () => {
      throw new Error("No active fiscal certificate");
    };
    const id = seedAnulatedInvoice(m, { fiscalMode: "ticketbai" });
    expect(await fiscal.anulateInvoice(id, "x")).toBe(false);
    const inv = m.invoices.get(id);
    expect(inv.fiscalStatus).toBe("error");
    expect(inv.fiscalError).toContain("No active fiscal certificate");
  });
});
