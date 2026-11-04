import { ForbiddenException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { TERMS_VERSION } from "./legal-terms";

/** D3: owners of salons without an acceptance of the current terms are asked once. */
describe("updated terms acceptance", () => {
  function make(opts: { role?: string; accepted?: number } = {}) {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ tenantId: "t1", role: opts.role ?? "owner" }) },
      legalAcceptance: {
        count: jest.fn().mockResolvedValue(opts.accepted ?? 0),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const auth = new AuthService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { auth, prisma };
  }

  it("asks an owner whose salon has not accepted this version", async () => {
    const { auth, prisma } = make({ accepted: 0 });
    await expect(auth.termsStatus({ id: "u1", role: "owner" })).resolves.toEqual(
      expect.objectContaining({ required: true, version: TERMS_VERSION }),
    );
    expect(prisma.legalAcceptance.count).toHaveBeenCalledWith({ where: { tenantId: "t1", termsVersion: TERMS_VERSION } });
  });

  it("does not ask once accepted, nor the team, nor support signed in as the salon", async () => {
    expect((await make({ accepted: 1 }).auth.termsStatus({ id: "u1", role: "owner" })).required).toBe(false);
    expect((await make().auth.termsStatus({ id: "u1", role: "admin" })).required).toBe(false);
    expect((await make().auth.termsStatus({ id: "u1", role: "owner", impersonatedBy: "s1" })).required).toBe(false);
  });

  it("records the acceptance once per version, as login_prompt", async () => {
    const { auth, prisma } = make({ accepted: 0 });
    await expect(auth.acceptCurrentTerms("u1", "203.0.113.5")).resolves.toEqual({ accepted: true, version: TERMS_VERSION });
    expect(prisma.legalAcceptance.create).toHaveBeenCalledWith({
      data: { tenantId: "t1", acceptedByUserId: "u1", termsVersion: TERMS_VERSION, ip: "203.0.113.5", source: "login_prompt" },
    });
    const again = make({ accepted: 1 });
    await again.auth.acceptCurrentTerms("u1", null);
    expect(again.prisma.legalAcceptance.create).not.toHaveBeenCalled();
  });

  it("only an owner accepts", async () => {
    await expect(make({ role: "staff" }).auth.acceptCurrentTerms("u1", null)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
