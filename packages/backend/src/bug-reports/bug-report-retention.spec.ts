import { BugReportRetentionScheduler, bugReportRetentionCutoff, strippedBugReportData } from "./bug-report-retention";

describe("bug-report retention (audit 8 D14)", () => {
  it("the cutoff is 12 months back", () => {
    expect(bugReportRetentionCutoff(new Date("2026-11-04T10:00:00Z")).toISOString()).toBe("2025-11-04T10:00:00.000Z");
  });

  it("strips subject, description, email, URL and context, and dates it", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    expect(strippedBugReportData(now)).toEqual({
      subject: "[eliminado]",
      description: "[eliminado]",
      email: null,
      currentUrl: null,
      context: {},
      anonymizedAt: now,
    });
  });

  it("only touches closed reports past the cutoff that still hold personal data", async () => {
    const updateMany = jest.fn(async (_args: any) => ({ count: 3 }));
    const scheduler = new BugReportRetentionScheduler({ bugReport: { updateMany } } as any);
    const now = new Date("2026-11-04T10:00:00Z");
    await expect(scheduler.purge(now)).resolves.toBe(3);
    const args = updateMany.mock.calls[0][0];
    expect(args.where).toEqual({
      status: { in: ["resolved", "wont_fix", "duplicate"] },
      resolvedAt: { lt: new Date("2025-11-04T10:00:00Z") },
      anonymizedAt: null,
    });
    expect(args.data.anonymizedAt).toEqual(now);
  });
});
