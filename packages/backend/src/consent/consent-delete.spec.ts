import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ConsentService, CONSENT_FORM_HAS_SIGNATURES } from "./consent.service";

/**
 * Deleting a consent form.
 *
 * Signed consents point at their form with onDelete: Restrict, so deleting a
 * form that has signatures used to fail with a 500. It now answers a Spanish
 * 409 and the form (and its signatures) stay.
 */

function makeService(opts: { signatures?: number; deleteError?: unknown } = {}) {
  const prisma: any = {
    consentForm: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === "form-1" && where.tenantId === "t1" ? { id: "form-1", tenantId: "t1", purpose: "custom" } : null,
      ),
      delete: jest.fn(async () => {
        if (opts.deleteError) throw opts.deleteError;
        return { id: "form-1" };
      }),
    },
    consent: { count: jest.fn(async () => opts.signatures ?? 0) },
  };
  const encryption: any = { hashIp: (ip: string) => ip };
  return { service: new ConsentService(prisma, encryption), prisma };
}

describe("ConsentService.deleteForm", () => {
  it("deletes a form nobody has signed", async () => {
    const { service, prisma } = makeService();
    await expect(service.deleteForm("t1", "form-1")).resolves.toEqual({ deleted: true });
    expect(prisma.consent.count).toHaveBeenCalledWith({ where: { formId: "form-1", tenantId: "t1" } });
    expect(prisma.consentForm.delete).toHaveBeenCalled();
  });

  it("refuses with a Spanish 409 when the form has signatures, and keeps it", async () => {
    const { service, prisma } = makeService({ signatures: 2 });
    const err = await service.deleteForm("t1", "form-1").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(CONSENT_FORM_HAS_SIGNATURES);
    expect(err.message).toContain("tiene firmas");
    expect(prisma.consentForm.delete).not.toHaveBeenCalled();
  });

  it("maps a signature recorded meanwhile (foreign key P2003) to the same 409", async () => {
    const fk = new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "5.22.0" });
    const { service } = makeService({ deleteError: fk });
    await expect(service.deleteForm("t1", "form-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not touch another salon's form", async () => {
    const { service, prisma } = makeService();
    await expect(service.deleteForm("t2", "form-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.consentForm.delete).not.toHaveBeenCalled();
  });
});
