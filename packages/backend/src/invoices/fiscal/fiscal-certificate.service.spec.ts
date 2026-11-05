import { FiscalCertificateService } from "./fiscal-certificate.service";
import { openPkcs12 } from "./verifactu/certificate";

jest.mock("./verifactu/certificate", () => ({ openPkcs12: jest.fn() }));

/** Uploading a certificate replaces the active one, all or nothing. */
function setup(taxId: string | null = "b-12345674", create: () => Promise<unknown> = async () => ({ id: "new" })) {
  (openPkcs12 as jest.Mock).mockReturnValue({
    keyPem: "key",
    certPem: "cert",
    fingerprint: "ff",
    subject: "s",
    issuer: "i",
    nif: "B12345674",
    notBefore: new Date(),
    notAfter: new Date(),
  });
  const tx = { fiscalCertificate: { updateMany: jest.fn(async () => ({ count: 1 })), create: jest.fn(create) } };
  const prisma = {
    tenant: { findUnique: jest.fn(async () => ({ taxId })) },
    fiscalCertificate: { updateMany: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const encryption = { encrypt: (v: string) => `enc:${v}` };
  const service = new FiscalCertificateService(prisma as any, encryption as any);
  const upload = () =>
    service.saveCertificate({ tenantId: "t1", alias: "a", provider: "p12", pkcs12Base64: "AAAA", passphrase: "p" });
  return { upload, prisma, tx };
}

describe("FiscalCertificateService.saveCertificate", () => {
  it("deactivates the old one and creates the new one in one transaction", async () => {
    const { upload, prisma, tx } = setup();
    await upload();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.fiscalCertificate.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.fiscalCertificate.create).toHaveBeenCalledTimes(1);
    expect(prisma.fiscalCertificate.updateMany).not.toHaveBeenCalled();
    expect(prisma.fiscalCertificate.create).not.toHaveBeenCalled();
  });

  it("a failed save fails inside that transaction, so the old one is kept", async () => {
    const { upload, prisma } = setup("B12345674", async () => {
      throw new Error("no");
    });
    await expect(upload()).rejects.toThrow("no");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.fiscalCertificate.updateMany).not.toHaveBeenCalled();
  });

  it("compares the certificate's NIF with the salon's, normalised the same way", async () => {
    expect(await setup("b-12345674").upload()).toMatchObject({ nifMatchesSalon: true });
    expect(await setup("B99999999").upload()).toMatchObject({ nifMatchesSalon: false });
    expect(await setup(null).upload()).toMatchObject({ nifMatchesSalon: null });
  });
});
