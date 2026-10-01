import { fiscalSubmissionAvailable } from "./fiscal-availability";
import { FiscalService } from "./fiscal.service";

/**
 * In production the Verifactu / TicketBAI / SII transports are stubs that
 * answer "accepted" (CSV-STUB-…): invoices were marked as accepted by the
 * AEAT when nothing had been sent. Until the real implementation exists,
 * production sends nothing and refuses to switch a fiscal mode on.
 */
describe("fiscal submission availability", () => {
  it("is off in production unless explicitly enabled", () => {
    expect(fiscalSubmissionAvailable({ NODE_ENV: "production" } as any)).toBe(false);
    expect(fiscalSubmissionAvailable({ NODE_ENV: "production", FISCAL_SUBMISSION_ENABLED: "1" } as any)).toBe(true);
    expect(fiscalSubmissionAvailable({ NODE_ENV: "development" } as any)).toBe(true);
    expect(fiscalSubmissionAvailable({ NODE_ENV: "test" } as any)).toBe(true);
  });

  it("does not dispatch an invoice in production, so it is never marked accepted", async () => {
    const saved = { ...process.env };
    process.env.NODE_ENV = "production";
    delete process.env.FISCAL_SUBMISSION_ENABLED;
    try {
      const prisma: any = {
        invoice: {
          findUnique: jest.fn(async () => ({ id: "i1", fiscalStatus: "not_required", tenant: { fiscalMode: "verifactu" } })),
          update: jest.fn(),
        },
      };
      const service = Object.create(FiscalService.prototype) as any;
      service.prisma = prisma;
      service.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
      service.dispatchVerifactu = jest.fn();
      await service.dispatchInvoice("i1");
      expect(service.dispatchVerifactu).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
    }
  });
});
