import { BugReportController } from "./bug-report.controller";
import { BugReportDto } from "./bug-report.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

describe("POST /bug-reports body", () => {
  const parse = bodyParser(BugReportController, "submit");

  /** What app/dashboard/components/bug-report-modal.tsx sends. */
  const modal = {
    subject: "No carga la agenda",
    description: "Al abrir la agenda del lunes sale en blanco.",
    email: "ana@example.com",
    currentUrl: "http://localhost:3000/dashboard/appointments",
    appVersion: "dev",
  };

  it("is the validated class, not an interface", () => {
    expect(bodyMetatype(BugReportController, "submit")).toBe(BugReportDto);
  });

  it("keeps the modal's report and drops the tenant and author", async () => {
    const out = await parse({ ...modal, tenantId: "t-other", authorId: "u-other" });
    expect(out).toEqual(modal);
  });

  it("refuses bad emails and oversized text", async () => {
    await expect(parse({ ...modal, email: "not-an-email" })).rejects.toBeDefined();
    await expect(parse({ ...modal, description: "x".repeat(5001) })).rejects.toBeDefined();
    await expect(parse({ ...modal, subject: "" })).rejects.toBeDefined();
    await expect(parse({ ...modal, context: "text" })).rejects.toBeDefined();
  });

  it("passes only the report's fields to the service, with the session's tenant", async () => {
    const submit = jest.fn(async () => "id-1");
    const controller = new BugReportController({ submit } as any);
    await controller.submit(Object.assign(new BugReportDto(), modal), { user: { tenantId: "t1", id: "u1" } });
    expect(submit).toHaveBeenCalledWith({ ...modal, context: undefined, tenantId: "t1", authorId: "u1", accountEmail: null });
    await expect(
      controller.submit(Object.assign(new BugReportDto(), { ...modal, context: { log: "x".repeat(30_000) } })),
    ).rejects.toThrow(/too large/);
  });

  it("keeps only http(s) page addresses (the console links to them)", async () => {
    // Other schemes are assembled here so no ready-made payload sits in the repo.
    const other = (s: string) => `${s}:${"void(0)"}`;
    await expect(parse({ ...modal, currentUrl: other("java" + "script") })).rejects.toBeDefined();
    await expect(parse({ ...modal, currentUrl: other("JavaScript") })).rejects.toBeDefined();
    await expect(parse({ ...modal, currentUrl: other("data") })).rejects.toBeDefined();
    await expect(parse({ ...modal, currentUrl: "/dashboard" })).rejects.toBeDefined();
    await expect(parse({ ...modal, currentUrl: `https://app.kiraroom.net/${"a".repeat(2000)}` })).rejects.toBeDefined();
    const ok = await parse({ ...modal, currentUrl: "https://app.kiraroom.net/dashboard?x=1" });
    expect(ok.currentUrl).toBe("https://app.kiraroom.net/dashboard?x=1");
    const empty = await parse({ ...modal, currentUrl: "" });
    expect(empty.currentUrl).toBeUndefined();
  });

  it("passes the session's own email for the acknowledgement", async () => {
    const submit = jest.fn(async () => "id-1");
    const controller = new BugReportController({ submit } as any);
    await controller.submit(Object.assign(new BugReportDto(), { ...modal, email: "someone@else.test" }), {
      user: { tenantId: "t1", id: "u1", email: "owner@salon.test" },
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ accountEmail: "owner@salon.test" }));
  });

  it("is throttled to 5 an hour per address", () => {
    const meta = Reflect.getMetadata("THROTTLER:LIMITdefault", BugReportController.prototype.submit);
    const ttl = Reflect.getMetadata("THROTTLER:TTLdefault", BugReportController.prototype.submit);
    expect(meta).toBe(5);
    expect(ttl).toBe(3_600_000);
  });
});
