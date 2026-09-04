import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { createHash } from "crypto";

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

  async listActiveCertificates(tenantId: string) {
    return this.prisma.fiscalCertificate.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: "desc" },
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
    notBefore?: Date;
    notAfter?: Date;
  }): Promise<{ id: string; fingerprint: string }> {
    // Convert base64 → raw DER bytes; we persist the DER binary so
    // XadesService.parsePkcs12 doesn't need to do it on every read.
    const rawDer = Buffer.from(input.pkcs12Base64, "base64").toString("binary");
    const fingerprint = this.fingerprintFromPkcs12(input.pkcs12Base64);
    const cert = this.prisma.fiscalCertificate.create({
      data: {
        tenantId: input.tenantId,
        alias: input.alias,
        provider: input.provider,
        encryptedPem: this.encryption.encrypt(rawDer),
        passphraseCipher: this.encryption.encrypt(input.passphrase),
        fingerprint,
        notBefore: input.notBefore,
        notAfter: input.notAfter,
        isActive: true,
      },
    });
    return { id: (await cert).id, fingerprint };
  }

  async deactivate(id: string, tenantId: string) {
    return this.prisma.fiscalCertificate.updateMany({
      where: { id, tenantId },
      data: { isActive: false },
    });
  }

  /**
   * Extract the SHA-256 fingerprint of the certificate contained in a
   * PKCS#12 bundle, without exposing the private key.
   */
  private fingerprintFromPkcs12(pkcs12Base64: string): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const forge = require("node-forge");
    const der = Buffer.from(pkcs12Base64, "base64").toString("binary");
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), "");
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = certBags[forge.pki.oids.certBag]?.[0];
    if (!certBag?.cert) {
      throw new Error("PKCS#12 is missing the certificate bag");
    }
    const pem = forge.pki.certificateToPem(certBag.cert);
    return createHash("sha256").update(pem).digest("hex");
  }
}
