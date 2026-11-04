import { HttpException } from "@nestjs/common";
import { BUG_REPORT_LIMITS, BugReportService } from "./bug-report.service";

function makeService() {
  const counters = new Map<string, number>();
  const redis = {
    increment: jest.fn(async (key: string) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n;
    }),
  };
  const rows: any[] = [];
  const prisma = { bugReport: { create: jest.fn(async ({ data }: any) => rows.push(data)) } };
  const email = {
    sendEmail: jest.fn(async () => ({ success: true })),
    sendBugReportAck: jest.fn(async () => ({ success: true })),
  };
  const service = new BugReportService(email as any, prisma as any, redis as any);
  return { service, rows, email };
}

const report = { subject: "No carga la agenda", description: "Sale en blanco." };

describe("BugReportService.submit", () => {
  it("stores the row with the id it returns and puts in the acknowledgement (D9)", async () => {
    const { service, rows, email } = makeService();
    const id = await service.submit({ ...report, tenantId: "t1", authorId: "u1", accountEmail: "owner@salon.test" });
    expect(rows[0].id).toBe(id);
    expect(email.sendBugReportAck).toHaveBeenCalledWith(expect.objectContaining({ reportId: id }));
  });

  it("acknowledges only to the account's own email, never to the one in the body (D2)", async () => {
    const { service, rows, email } = makeService();
    await service.submit({
      ...report,
      email: "someone@else.test",
      tenantId: "t1",
      authorId: "u1",
      accountEmail: "owner@salon.test",
    });
    expect(email.sendBugReportAck).toHaveBeenCalledTimes(1);
    expect(email.sendBugReportAck).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@salon.test" }));
    expect(rows[0].email).toBe("owner@salon.test");
  });

  it("sends no acknowledgement without a session, whatever email the body carries", async () => {
    const { service, email } = makeService();
    await service.submit({ ...report, email: "someone@else.test" });
    expect(email.sendBugReportAck).not.toHaveBeenCalled();
    expect(email.sendEmail).toHaveBeenCalledTimes(1); // the founder's copy
  });

  it("caps reports per user per hour", async () => {
    const { service, email } = makeService();
    const input = { ...report, tenantId: "t1", authorId: "u1", accountEmail: "owner@salon.test" };
    for (let i = 0; i < BUG_REPORT_LIMITS.perUserPerHour; i++) await service.submit(input);
    await expect(service.submit(input)).rejects.toBeInstanceOf(HttpException);
    expect(email.sendEmail).toHaveBeenCalledTimes(BUG_REPORT_LIMITS.perUserPerHour);
  });

  it("caps reports per salon per hour, across its team", async () => {
    const { service } = makeService();
    for (let i = 0; i < BUG_REPORT_LIMITS.perTenantPerHour; i++) {
      await service.submit({ ...report, tenantId: "t1", authorId: `u${i}` });
    }
    await expect(service.submit({ ...report, tenantId: "t1", authorId: "u-new" })).rejects.toMatchObject({
      status: 429,
    });
  });
});
