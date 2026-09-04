import { FiscalService } from "./fiscal.service";

/**
 * Tests for the transient-error classifier. The dispatch retry queue
 * depends on this to decide whether to schedule a retry (5xx / network)
 * or permanently mark error (4xx validation).
 */
function buildService(): FiscalService {
  // FiscalService constructor needs a PrismaService — we never call any
  // prisma method in isRetryableError so we can pass a stub.
  return new FiscalService(
    /* prisma */ {
      invoice: { findUnique: async () => null, findMany: async () => [] },
    } as any,
    /* verifactu */ null as any,
    /* ticketBai */ null as any,
    /* sii */ null as any,
    /* retryQueue */ null,
  );
}

describe("FiscalService.isRetryableError (via private path)", () => {
  it("flags AEAT 5xx as retryable", () => {
    const svc = buildService();
    expect((svc as any).isRetryableError("AEAT 503: upstream timeout")).toBe(
      true,
    );
    expect(
      (svc as any).isRetryableError("bizkaia 502 Bad Gateway"),
    ).toBe(true);
  });

  it("flags network errors as retryable", () => {
    const svc = buildService();
    expect((svc as any).isRetryableError("ECONNRESET on socket")).toBe(true);
    expect((svc as any).isRetryableError("ETIMEDOUT")).toBe(true);
  });

  it("does NOT retry on 4xx validation errors", () => {
    const svc = buildService();
    expect((svc as any).isRetryableError("AEAT 400: bad request body")).toBe(
      false,
    );
    expect((svc as any).isRetryableError("AEAT 422: invalid NIF")).toBe(false);
  });

  it("returns false for empty / undefined errors", () => {
    const svc = buildService();
    expect((svc as any).isRetryableError(undefined)).toBe(false);
    expect((svc as any).isRetryableError("")).toBe(false);
  });
});
