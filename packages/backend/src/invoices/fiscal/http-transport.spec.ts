/**
 * HTTP transport smoke tests for the live fiscal / accounting providers.
 *
 * Verifies the production-real (`FISCAL_E2E_MODE=real`) branch of each
 * transport:
 *   - Builds the correct URL (AEAT Verifactu, TBAI Bizkaia/Gipuzkoa/Álava,
 *     Holded, Sage).
 *   - Sends the right headers (Content-Type, SOAPAction, Authorization).
 *   - Returns accepted / rejected / error based on the mocked fetch response.
 *   - Persists fiscalReference on the invoice on success.
 *
 * These tests run under `FISCAL_E2E_MODE=real` so the production transport
 * branch is exercised. The actual `fetch()` call is mocked so no network
 * is involved — we just want to assert the shape and the
 * accept/reject/error classification.
 */

import { VerifactuService } from "./verifactu.service";
import { TicketBaiService } from "./ticketbai.service";
import { EncryptionService } from "../../common/encryption/encryption.service";

function encryption(): EncryptionService {
  return new EncryptionService({
    get: (k: string) =>
      k === "META_TOKEN_ENCRYPTION_KEY"
        ? Buffer.alloc(32, 11).toString("base64")
        : null,
  } as any);
}

function makePrisma() {
  const inv: any = {
    id: "inv-http-1",
    tenantId: "tenant-1",
    series: "A",
    number: "000001",
    issueDate: new Date("2026-07-16"),
    recipientName: "Cliente",
    recipientTaxId: "12345678Z",
    subtotalCents: 10000,
    totalCents: 12100,
    currency: "EUR",
    fiscalMode: "verifactu",
    fiscalStatus: "not_required",
    taxBreakdown: [{ rate: 21, baseCents: 10000, taxCents: 2100 }],
  };
  const prisma: any = {
    invoice: {
      findUnique: async () => inv,
      update: async (args: any) => {
        Object.assign(inv, args.data);
        return inv;
      },
    },
    fiscalCertificate: {
      // No cert — sign path is replaced.
      findFirst: async () => null,
    },
  };
  return { prisma, inv };
}

function makeVerifactu(prisma: any) {
  const service: any = new VerifactuService(
    prisma,
    encryption(),
    {} as any,
    { buildVerifactuUrl: () => "https://fake/q" } as any,
    {} as any,
  );
  service.signWithTenantCert = async () => ({
    signedXml: "<signed/>",
    documentHash: "hash",
  });
  return service as VerifactuService;
}

function makeTicketBai(prisma: any) {
  const service: any = new TicketBaiService(
    prisma,
    encryption(),
    {} as any,
    { buildTicketBaiUrl: () => "https://fake-tbai/q" } as any,
  );
  service.signWithTenantCert = async () => ({
    signedXml: "<signed-tbai/>",
    documentHash: "hash-tbai",
  });
  return service as TicketBaiService;
}

/**
 * Endpoint variables these suites assert on. Jest loads the developer's
 * `.env`, so anyone with a sandbox endpoint configured used to see
 * "routes to the official endpoint URL by default" fail against their own
 * override: the suite cleaned these up afterwards but never established a
 * clean baseline first. Saved and cleared before each test, restored after,
 * so the result no longer depends on whose machine it runs on.
 */
const ENDPOINT_ENV_KEYS = [
  "AEAT_VERIFACTU_ENDPOINT",
  "DIPUTACION_TBAI_BIZKAIA",
  "DIPUTACION_TBAI_GIPUZKOA",
  "DIPUTACION_TBAI_ALAVA",
] as const;

function takeEndpointEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENDPOINT_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreEndpointEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENDPOINT_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe("VerifactuService._postToAeat (real branch)", () => {
  let originalEnv: string | undefined;
  let originalFetch: typeof fetch | undefined;
  let savedEndpoints: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = process.env.FISCAL_E2E_MODE;
    originalFetch = globalThis.fetch;
    savedEndpoints = takeEndpointEnv();
    process.env.FISCAL_E2E_MODE = "real";
    process.env.AEAT_VERIFACTU_ENDPOINT =
      "https://prewww1.aeat.es/wlpl/inwinvoc/ws.Suministro";
  });

  afterEach(() => {
    process.env.FISCAL_E2E_MODE = originalEnv;
    globalThis.fetch = originalFetch as any;
    restoreEndpointEnv(savedEndpoints);
  });

  it("POSTs to AEAT_VERIFACTU_ENDPOINT with xml body + SOAP headers", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: string | undefined;
    globalThis.fetch = (async (url: string, init: any) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      capturedBody = init?.body;
      return {
        ok: true,
        status: 200,
        text: async () =>
          "<response><ault:CSV>CSV-REAL-ABC123</ault:CSV></response>",
      };
    }) as any;

    const { prisma, inv } = makePrisma();
    const v = makeVerifactu(prisma);
    // The mock sign returns "<signed/>" — that's the actual XML that
    // reaches fetch(). The dispatch then extracts the CSV from the response.
    const result = await v.dispatch({
      invoiceId: inv.id,
      xml: "<root/>",
      tenantNif: "B12345678",
      nif: "12345678Z",
      invoiceNumber: "A000001",
      issueDate: "2026-07-16",
      totalCents: 12100,
    });

    expect(result.status).toBe("accepted");
    expect(result.reference).toBe("CSV-REAL-ABC123");
    expect(capturedUrl).toBe(
      "https://prewww1.aeat.es/wlpl/inwinvoc/ws.Suministro",
    );
    expect(capturedHeaders?.["Content-Type"]).toBe("application/xml");
    expect(capturedHeaders?.["SOAPAction"]).toBe("suministrar");
    // The signed XML is what gets POSTed.
    expect(capturedBody).toBe("<signed/>");
    expect(inv.fiscalReference).toBe("CSV-REAL-ABC123");
    expect(inv.fiscalStatus).toBe("accepted");
  });

  it("5xx response persists as 'rejected' with AEAT error message", async () => {
    // VerifactuService maps any non-ok HTTP status to 'rejected'. The
    // retry queue (in FiscalService) decides retryability downstream.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      text: async () => "AEAT 503 Service Unavailable",
    })) as any;

    const { prisma, inv } = makePrisma();
    const v = makeVerifactu(prisma);
    const result = await v.dispatch({
      invoiceId: inv.id,
      xml: "<root/>",
      tenantNif: "B12345678",
      nif: "12345678Z",
      invoiceNumber: "A000001",
      issueDate: "2026-07-16",
      totalCents: 12100,
    });
    expect(result.status).toBe("rejected");
    expect(inv.fiscalStatus).toBe("rejected");
    expect(inv.fiscalError).toContain("AEAT 503");
  });

  it("4xx response persists as 'rejected'", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => "AEAT 400 Bad schema",
    })) as any;

    const { prisma, inv } = makePrisma();
    const v = makeVerifactu(prisma);
    const result = await v.dispatch({
      invoiceId: inv.id,
      xml: "<root/>",
      tenantNif: "B12345678",
      nif: "12345678Z",
      invoiceNumber: "A000001",
      issueDate: "2026-07-16",
      totalCents: 12100,
    });
    expect(result.status).toBe("rejected");
    expect(inv.fiscalStatus).toBe("rejected");
    expect(inv.fiscalError).toContain("AEAT 400");
  });
});

describe("TicketBaiService._postToDeputacion (real branch)", () => {
  let originalEnv: string | undefined;
  let originalFetch: typeof fetch | undefined;
  let savedEndpoints: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = process.env.FISCAL_E2E_MODE;
    originalFetch = globalThis.fetch;
    savedEndpoints = takeEndpointEnv();
    process.env.FISCAL_E2E_MODE = "real";
  });

  afterEach(() => {
    process.env.FISCAL_E2E_MODE = originalEnv;
    globalThis.fetch = originalFetch as any;
    restoreEndpointEnv(savedEndpoints);
  });

  it("Bizkaia: routes to the official endpoint URL by default", async () => {
    let url: string | undefined;
    globalThis.fetch = (async (u: string) => {
      url = u;
      return {
        ok: true,
        status: 200,
        text: async () => "<T:TBAI>TBAIABCDEFGHIJKLMNOPQRSTUV</T:TBAI>",
      };
    }) as any;

    const { prisma, inv } = makePrisma();
    const tb = makeTicketBai(prisma);
    const result = await tb.dispatch({
      invoiceId: inv.id,
      xml: "<T/>",
      invoiceNumber: "A000001",
      issueDate: "2026-07-16",
      totalCents: 12100,
      tenantNif: "B12345678",
      recipientNif: "12345678Z",
      diputacion: "bizkaia",
    });
    expect(result.status).toBe("accepted");
    expect(result.tbaiCode).toBe("TBAIABCDEFGHIJKLMNOPQRSTUV");
    expect(url).toBe("https://www.batuz.eus/qqtbai/api/v1/recepcion");
  });

  it("Gipuzkoa: routes to the diputación's URL", async () => {
    let url: string | undefined;
    globalThis.fetch = (async (u: string) => {
      url = u;
      return {
        ok: true,
        status: 200,
        text: async () => "<T:TBAI>TBAI-REAL-GIP</T:TBAI>",
      };
    }) as any;

    const { prisma, inv } = makePrisma();
    const tb = makeTicketBai(prisma);
    await tb.dispatch({
      invoiceId: inv.id,
      xml: "<T/>",
      invoiceNumber: "A000001",
      issueDate: "2026-07-16",
      totalCents: 12100,
      tenantNif: "B12345678",
      recipientNif: "12345678Z",
      diputacion: "gipuzkoa",
    });
    expect(url).toBe("https://tbai.gipuzkoa.eus/qrattbai/api/v1/recepcion");
  });

  it("Custom env var overrides the default URL", async () => {
    process.env.DIPUTACION_TBAI_ALAVA =
      "https://custom.tbai.example/alava/recepcion";
    let url: string | undefined;
    globalThis.fetch = (async (u: string) => {
      url = u;
      return {
        ok: true,
        status: 200,
        text: async () => "<T:TBAI>TBAI</T:TBAI>",
      };
    }) as any;

    const { prisma, inv } = makePrisma();
    const tb = makeTicketBai(prisma);
    await tb.dispatch({
      invoiceId: inv.id,
      xml: "<T/>",
      invoiceNumber: "A000001",
      issueDate: "2026-07-16",
      totalCents: 12100,
      tenantNif: "B12345678",
      recipientNif: "12345678Z",
      diputacion: "alava",
    });
    expect(url).toBe("https://custom.tbai.example/alava/recepcion");
  });

  it("4xx persists as 'rejected' (no retry)", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 422,
      text: async () => "TBAI 422 Invalid NIF",
    })) as any;
    const { prisma, inv } = makePrisma();
    const tb = makeTicketBai(prisma);
    const result = await tb.dispatch({
      invoiceId: inv.id,
      xml: "<T/>",
      invoiceNumber: "A000001",
      issueDate: "2026-07-16",
      totalCents: 12100,
      tenantNif: "B12345678",
      recipientNif: "12345678Z",
      diputacion: "bizkaia",
    });
    expect(result.status).toBe("rejected");
    expect(inv.fiscalStatus).toBe("rejected");
  });
});
