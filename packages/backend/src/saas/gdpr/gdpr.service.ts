import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { createGzip } from "zlib";
import { Readable } from "stream";
import { GdprRequest, GdprRequestStatus } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CLIENT_SECRET_COLUMNS } from "../../clients/client-select";
import { anonymizeClients } from "../../clients/client-anonymize";

/**
 * GDPR data export (Art. 15 RGPD) and right-to-erasure (Art. 17 RGPD).
 *
 * Two endpoints:
 *   - `export(tenantId)` — returns a gzip-compressed JSON document
 *     containing every model that references the tenant. The customer
 *     (or the AEPD auditor) can decompress it with any standard tool.
 *   - `anonymize(tenantId)` — soft-deletes PII fields while keeping
 *     invoice records intact (Spain requires 4-year retention of
 *     invoice records under Art. 66 RGGI).
 *
 * Every call writes a `GdprRequest` audit row (Art. 30 RGPD).
 *
 * Note: this service avoids the `archiver` npm dependency to keep the
 * install surface minimal during the zero-budget launch. ZIPs are
 * produced as single-file gzip + JSON; tenants with a single
 * invoicing customer base can extract the bundle with one `gunzip`.
 */

const ANON = "[anonymized]";

/**
 * A user's sign-in credentials: not personal data the export is for, and
 * enough to attack the account offline. The export used to include the
 * password hash; two-step verification added its secrets.
 */
const USER_CREDENTIAL_FIELDS = [
  "passwordHash",
  "passwordResetToken",
  "emailVerificationToken",
  "twoFactorSecret",
  "twoFactorPendingSecret",
  "twoFactorRecoveryCodes",
  "twoFactorLastStep",
  "tokenVersion",
] as const;

/**
 * The salon's own payment-provider secrets. Publishable keys are public by
 * design; the secret keys move money on the salon's Stripe account.
 * gdpr.service.spec.ts fails when a Tenant column that looks like a secret
 * is not listed here.
 */
export const TENANT_SECRET_FIELDS = ["stripeTestSecretKey", "stripeLiveSecretKey"] as const;

function without<T extends Record<string, unknown>, K extends string>(row: T, fields: readonly K[]): Omit<T, K> {
  const out: Record<string, unknown> = { ...row };
  for (const field of fields) delete out[field];
  return out as Omit<T, K>;
}

export function withoutCredentials<T extends Record<string, unknown>>(user: T): Omit<T, (typeof USER_CREDENTIAL_FIELDS)[number]> {
  return without(user, USER_CREDENTIAL_FIELDS);
}

/** A client's sign-in secrets (password hash, reset token, session version). */
export function withoutClientCredentials<T extends Record<string, unknown>>(client: T): Omit<T, (typeof CLIENT_SECRET_COLUMNS)[number]> {
  return without(client, CLIENT_SECRET_COLUMNS);
}

export function withoutTenantSecrets<T extends Record<string, unknown>>(tenant: T): Omit<T, (typeof TENANT_SECRET_FIELDS)[number]> {
  return without(tenant, TENANT_SECRET_FIELDS);
}

@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Data export for a single tenant. Returns a Buffer of gzipped JSON
   * containing every model that references the tenant directly or
   * transitively (through Client, Appointment, etc.).
   */
  async export(tenantId: string, requestId: string): Promise<Buffer> {
    this.logger.log(`GDPR export: tenant=${tenantId} request=${requestId}`);
    const data = await this.collectTenantData(tenantId);
    const json = Buffer.from(JSON.stringify(data, null, 2), "utf8");
    const gz = await this.gzip(json);
    const sha256 = createHash("sha256").update(json).digest("hex");

    // Wrap the gzipped blob in a tiny JSON envelope so the customer
    // knows what they're holding: file name, size, hash, schema.
    const envelope = {
      format: "kira-gdpr-export-v1",
      tenantId,
      requestId,
      generatedAt: new Date().toISOString(),
      compression: "gzip",
      sha256,
      sizeBytes: gz.length,
      data: gz.toString("base64"),
    };
    return Buffer.from(JSON.stringify(envelope, null, 2), "utf8");
  }

  /**
   * Right-to-erasure (anonymize). Soft-replaces all PII fields with
   * placeholder values in a single Prisma transaction. Invoice records
   * are preserved for fiscal compliance (4-year retention).
   */
  async anonymize(tenantId: string, requestId: string): Promise<GdprRequest> {
    this.logger.warn(
      `GDPR anonymize: tenant=${tenantId} request=${requestId}`,
    );
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
      });
      if (!tenant) {
        throw new Error(`Tenant ${tenantId} not found`);
      }

      // Users — replace email + PII, mark inactive. The email is unique
      // across the platform, so each user gets their own placeholder (one
      // shared address failed as soon as a salon had two users).
      const users = await tx.user.findMany({ where: { tenantId }, select: { id: true } });
      for (const user of users) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            email: `[anonymized]+${user.id}@deleted.local`,
            firstName: ANON,
            lastName: ANON,
            isActive: false,
            tokenVersion: { increment: 1 },
          },
        });
      }

      // Clients — the same erasure as a single client's (the client file's
      // "anonimizar"): profile, health data, consents' answers, chats,
      // wait-list, notifications... Appointments and FKs stay.
      const clients = await tx.client.findMany({ where: { tenantId }, select: { id: true } });
      await anonymizeClients(tx, tenantId, clients.map((c) => c.id));

      // Invoices — preserve (4-year fiscal retention). Replace recipient
      // name + taxId with placeholders so the audit trail still has
      // matching series + number + totals, but no personal data.
      await tx.invoice.updateMany({
        where: { tenantId },
        data: {
          recipientName: ANON,
          recipientTaxId: null,
          recipientAddress: null,
        },
      });

      // Tenant itself — rename, remove taxId, null out personal fields.
      // Preserve slug as `anon-<short-id>` for any internal references.
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          name: `[anonymized tenant ${tenantId.slice(0, 8)}]`,
          taxId: null,
          legalName: null,
          slug: `anon-${tenantId.slice(0, 8)}`,
          stripeCustomerId: null,
          email: null,
          phone: null,
          whatsapp: null,
          stripeTestSecretKey: null,
          stripeLiveSecretKey: null,
          deletedAt: new Date(),
        },
      });

      return tx.gdprRequest.update({
        where: { id: requestId },
        data: {
          status: GdprRequestStatus.completed,
          completedAt: new Date(),
        },
      });
    }, { timeout: 120_000 });
  }

  /** Record a new GdprRequest — used by the controller before starting work. */
  async recordRequest(
    tenantId: string,
    action: "export" | "anonymize",
    actorId: string,
    ipAddress: string | undefined,
  ): Promise<GdprRequest> {
    return this.prisma.gdprRequest.create({
      data: {
        tenantId,
        action,
        status: GdprRequestStatus.processing,
        actorId,
        ipAddress,
      },
    });
  }

  /**
   * Collect every model that references this tenant. Includes Client
   * (via tenantId), Invoice (via tenantId), Appointment (via
   * tenantId), User (via tenantId), and a few relations that link
   * indirectly through Client.
   */
  private async collectTenantData(tenantId: string) {
    const [
      tenant,
      users,
      clients,
      invoices,
      appointments,
      services,
      professionals,
      notifications,
      accountingConnections,
      reviews,
      consents,
    ] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.user.findMany({ where: { tenantId } }),
      this.prisma.client.findMany({ where: { tenantId } }),
      this.prisma.invoice.findMany({
        where: { tenantId },
        include: { lines: true },
      }),
      this.prisma.appointment.findMany({ where: { tenantId } }),
      this.prisma.service.findMany({ where: { tenantId } }),
      this.prisma.professional.findMany({ where: { tenantId } }),
      this.prisma.notification.findMany({ where: { tenantId } }),
      this.prisma.accountingConnection.findMany({ where: { tenantId } }),
      this.prisma.review.findMany({ where: { tenantId } }),
      this.prisma.consentForm.findMany({ where: { tenantId } }),
    ]);

    return {
      tenant: tenant ? withoutTenantSecrets(tenant) : null,
      users: (users ?? []).map(withoutCredentials),
      clients: (clients ?? []).map(withoutClientCredentials),
      invoices: (invoices ?? []).map((inv) => ({
        ...inv,
        // Strip large encrypted blobs — they're not human-readable.
        fiscalXml: undefined,
      })),
      appointments: appointments ?? [],
      services: services ?? [],
      professionals: professionals ?? [],
      notifications: notifications ?? [],
      accountingConnections: (accountingConnections ?? []).map((c) => ({
        ...c,
        // Encrypted access tokens are not exportable.
        encryptedAccessToken: "[encrypted]",
        encryptedRefreshToken: c.encryptedRefreshToken
          ? "[encrypted]"
          : null,
      })),
      reviews: reviews ?? [],
      consents: consents ?? [],
    };
  }

  /** Gzip-compress a Buffer using Node's built-in zlib. */
  private gzip(input: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const gz = createGzip();
      const stream = Readable.from(input);
      stream
        .pipe(gz)
        .on("data", (chunk) => chunks.push(chunk))
        .on("end", () => resolve(Buffer.concat(chunks)))
        .on("error", reject);
    });
  }
}
