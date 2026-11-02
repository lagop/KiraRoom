import { FiscalCertificateService, CERTIFICATE_PUBLIC_SELECT } from "./fiscal-certificate.service";
import { InvoicesController } from "../invoices.controller";

/**
 * GET /invoices/certificates feeds the certificate list in Ajustes > Fiscal.
 * It used to send whole rows, so the encrypted PKCS#12 and its encrypted
 * password reached the browser. Only the metadata may go.
 */

const fullRow = {
  id: "cert-1",
  tenantId: "tenant-1",
  provider: "p12",
  alias: "Certificado del salón",
  encryptedPem: "ciphertext-of-the-bundle",
  passphraseCipher: "ciphertext-of-the-password",
  fingerprint: "ab".repeat(32),
  issuer: "AC Ejemplo",
  subject: "B12345674",
  notBefore: new Date("2026-01-01T00:00:00Z"),
  notAfter: new Date("2028-01-01T00:00:00Z"),
  isActive: true,
  createdAt: new Date("2026-01-02T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};

/** A findMany that honours `select`, as Prisma does. */
function prismaWith(rows: Array<Record<string, unknown>>) {
  const findMany = jest.fn(async (args: { select?: Record<string, boolean> }) =>
    rows.map((r) =>
      args.select ? Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, r[k]])) : r,
    ),
  );
  return { prisma: { fiscalCertificate: { findMany } }, findMany };
}

describe("certificate list", () => {
  it("the public select has no secret columns", () => {
    expect(CERTIFICATE_PUBLIC_SELECT).not.toHaveProperty("encryptedPem");
    expect(CERTIFICATE_PUBLIC_SELECT).not.toHaveProperty("passphraseCipher");
    expect(Object.keys(CERTIFICATE_PUBLIC_SELECT).sort()).toEqual(
      ["alias", "createdAt", "fingerprint", "id", "isActive", "issuer", "notAfter", "notBefore", "provider", "subject"].sort(),
    );
  });

  it("GET /invoices/certificates sends the metadata, never the key or its password", async () => {
    const { prisma, findMany } = prismaWith([fullRow]);
    const certs = new FiscalCertificateService(prisma as any, {} as any);
    const controller = new InvoicesController({} as any, {} as any, certs, {} as any, {} as any);
    const res = await controller.listCertificates({ user: { tenantId: "tenant-1" } } as any);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1", isActive: true }, select: CERTIFICATE_PUBLIC_SELECT }),
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual({
      id: "cert-1",
      alias: "Certificado del salón",
      provider: "p12",
      fingerprint: fullRow.fingerprint,
      issuer: "AC Ejemplo",
      subject: "B12345674",
      notBefore: fullRow.notBefore,
      notAfter: fullRow.notAfter,
      isActive: true,
      createdAt: fullRow.createdAt,
    });
    const json = JSON.stringify(res);
    expect(json).not.toContain("encryptedPem");
    expect(json).not.toContain("passphraseCipher");
    expect(json).not.toContain("ciphertext-of");
  });
});
