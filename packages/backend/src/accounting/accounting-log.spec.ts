import { AccountingService } from "./accounting.service";

/** The Holded log on the settings page names each invoice by its number. */
describe("AccountingService.recentLogs", () => {
  it("adds the invoice number, read in the salon only; connection rows have none", async () => {
    const prisma: any = {
      accountingSyncLog: {
        findMany: jest.fn(async () => [
          { id: "l1", invoiceId: "inv-1", action: "sync", status: "ok" },
          { id: "l2", invoiceId: "connection", action: "connect", status: "ok" },
          { id: "l3", invoiceId: "inv-1", action: "cancel", status: "error" },
          { id: "l4", invoiceId: "gone", action: "sync", status: "error" },
        ]),
      },
      invoice: { findMany: jest.fn(async () => [{ id: "inv-1", series: "A", number: "000007" }]) },
    };
    const svc = new AccountingService(prisma, {} as any, {} as any);
    const logs = await svc.recentLogs("tenant-1", 50);
    expect(prisma.invoice.findMany.mock.calls[0][0].where).toEqual({ tenantId: "tenant-1", id: { in: ["inv-1", "gone"] } });
    expect(logs.map((l) => l.invoiceNumber)).toEqual(["A000007", null, "A000007", null]);
  });
});
