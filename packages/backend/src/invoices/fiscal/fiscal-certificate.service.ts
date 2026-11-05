import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { createHash } from "crypto";
import { openPkcs12 } from "./verifactu/certificate";
import { nif } from "./verifactu/format";

/**
 * The columns of a certificate that may be sent to the panel. Never add
 * encryptedPem or passphraseCipher here.
 */
export const CERTIFICATE_PUBLIC_SELECT = {
  id: true,
  alias: true,
  provider: true,
  fingerprint: true,
  issuer: true,
  subject: true,
  notBefore: true,
  notAfter: true,
  isActive: true,
  createdAt: true,
} as const;

/**
 * Helpers around the FiscalCertificate table: storing the encrypted
 * PKCS#12 bundle, fingerprinting the certificate, and detecting expiry.
 *
 * Production note: `pkcs12Cipher` is opaque — EncryptionService is
 * responsible for encrypting/decrypting; this service does NOT handle
 * raw key material.
 */
@Injectable()
export class FiscalCertificateService {
  private readonly logger = new Logger(FiscalCertificateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Compute SHA-256 fingerprint over the DECRYPTED PEM/certificate.
   * Used to detect duplicate uploads + for the `EnrollmentID` cross-check
   * in AEAT / diputación submissions.
   */
  fingerprintPem(decryptedPem: string): string {
    return createHash("sha256").update(decryptedPem).digest("hex");
  }

  /**
   * Heuristic expiry check. We require notAfter > now+30d before allowing
   * a new certificate to be used for sending.
   */
  isExpiringSoon(notAfter: Date | null | undefined): boolean {
    if (!notAfter) return false;
    const days = (notAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return days < 30;
  }

  /**
   * The salon's active certificates, as the settings page lists them: only
   * what describes a certificate. The encrypted PKCS#12 and its encrypted
   * password never leave the server (the signing code reads them itself).
   */
  async listActiveCertificates(tenantId: string) {
    return this.prisma.fiscalCertificate.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: "desc" },
      select: CERTIFICATE_PUBLIC_SELECT,
    });
  }

  /**
   * Save a new certificate. The caller is responsible for base64-encoding
   * the PKCS#12 DER bytes. We encrypt both the bundle and (optionally)
   * the passphrase with EncryptionService before persisting.
   *
   * `notBefore` and `notAfter` are extracted from the certificate's
   * validity period — they live in the column so the AEAT / TicketBAI
   * scheduler can warn about expiring certs without re-parsing PKCS#12.
   */
  async saveCertificate(input: {
    tenantId: string;
    alias: string;
    provider: "p12" | "cloud_dnie";
    pkcs12Base64: string;
    passphrase: string;
    certificateType?: "personal" | "seal";
  }): Promise<{
    id: string;
    fingerprint: string;
    subject: string;
    notAfter: Date;
    /** Whether the certificate's NIF is the salon's (a representative's is not). */
    nifMatchesSalon: boolean | null;
  }> {
    // Opened with its password here: a wrong password or a bundle without
    // its private key is refused now, not at the first submission.
    const opened = openPkcs12(input.pkcs12Base64, input.passphrase);
    // Raw DER kept as well: the XAdES signer (TicketBAI) reads it.
    const rawDer = Buffer.from(input.pkcs12Base64, "base64").toString("binary");
    const tenant = await this.prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { taxId: true } });
    const salonNif = nif(tenant?.taxId);
    const data = {
      tenantId: input.tenantId,
      alias: input.alias,
      provider: input.provider,
      encryptedPem: this.encryption.encrypt(rawDer),
      passphraseCipher: this.encryption.encrypt(input.passphrase),
      encryptedKeyPair: this.encryption.encrypt(JSON.stringify({ keyPem: opened.keyPem, certPem: opened.certPem })),
      certificateType: input.certificateType ?? "personal",
      fingerprint: opened.fingerprint,
      subject: opened.subject,
      issuer: opened.issuer,
      notBefore: opened.notBefore,
      notAfter: opened.notAfter,
      isActive: true,
    };
    // A new certificate replaces the previous one: both or neither, so a
    // failed save never leaves the salon without a certificate to send with.
    const cert = await this.prisma.$transaction(async (tx) => {
      await tx.fiscalCertificate.updateMany({ where: { tenantId: input.tenantId, isActive: true }, data: { isActive: false } });
      return tx.fiscalCertificate.create({ data });
    });
    return {
      id: cert.id,
      fingerprint: opened.fingerprint,
      subject: opened.subject,
      notAfter: opened.notAfter,
      nifMatchesSalon: opened.nif && salonNif ? opened.nif === salonNif : null,
    };
  }

  async deactivate(id: string, tenantId: string) {
    return this.prisma.fiscalCertificate.updateMany({
      where: { id, tenantId },
      data: { isActive: false },
    });
  }
}
