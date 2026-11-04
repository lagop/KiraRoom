import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";
import { createGzip } from "zlib";
import { Readable } from "stream";
import { GdprRequest, GdprRequestStatus, Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { CLIENT_SECRET_COLUMNS } from "../../clients/client-select";
import { anonymizeClients } from "../../clients/client-anonymize";
import { strippedBugReportData } from "../../bug-reports/bug-report-retention";
import { scrubTenantAuditLogs } from "./audit-log-scrub";

/**
 * GDPR data export (Art. 15 RGPD) and right-to-erasure (Art. 17 RGPD).
 *
 *   - `export(tenantId)` — a gzip-compressed JSON document with every table
 *     that holds the salon's data (collectTenantData), secrets left out.
 *   - `anonymize(tenantId)` — erases the personal data of the salon, its
 *     team and its clients while keeping the issued invoices and the
 *     salon's fiscal identity (Spain requires 4-year retention of invoice
 *     records, art. 66 LGT; GDPR art. 17.3.b allows keeping them).
 *     TENANT_MODEL_ON_ERASURE says what happens to every table.
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

/**
 * Columns the export leaves out, per table: credentials and tokens (they
 * let someone act as the salon or its clients, and are not "data about"
 * anyone), and large signed blobs. gdpr.service.spec.ts fails when a column
 * that looks like a secret is neither here nor in EXPORT_SECRET_LOOKALIKES_KEPT.
 */
export const EXPORT_OMITTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // features holds the chat channels' credentials (features.multichannel).
  Tenant: [...TENANT_SECRET_FIELDS, "features"],
  User: USER_CREDENTIAL_FIELDS,
  Client: CLIENT_SECRET_COLUMNS,
  AccountingConnection: ["encryptedAccessToken", "encryptedRefreshToken"],
  WhatsAppConnection: ["accessTokenEnc", "refreshTokenEnc"],
  SocialConnection: ["accessToken", "refreshToken"],
  FiscalCertificate: ["encryptedPem", "passphraseCipher"],
  TenantInvite: ["token"],
  Review: ["reviewToken"],
  CustomDomain: ["verificationToken"],
  WidgetInstance: ["token"],
  // Signed XML sent to the tax agency: large and not human-readable.
  Invoice: ["fiscalXml"],
};

/** Columns that look like secrets but are data the export keeps, and why. */
export const EXPORT_SECRET_LOOKALIKES_KEPT: Readonly<Record<string, string>> = {
  "Tenant.stripeTestPublishableKey": "public by design",
  "Tenant.stripeLivePublishableKey": "public by design",
  "Tenant.stripeMode": "test or live, not a key",
  "Invoice.fiscalHash": "the invoice record's chain hash, printed on it",
  "FiscalChainState.lastHash": "the chain hash of the last invoice",
  "Consent.signatureIpHash": "proof of the signature, already a hash",
  "PublicBookingSms.phoneHash": "already a hash",
  "SocialConnection.tokenExpiry": "a date",
  "WhatsAppConnection.tokenExpiresAt": "a date",
  "Review.reviewTokenExpiresAt": "a date",
  "UsedImpersonationToken.jti": "the id of a used, expired support access",
  "CommissionAdjustment.sourceKey": "an idempotency key",
  "TenantLlmUsage.inputTokens": "a count",
  "TenantLlmUsage.cachedInputTokens": "a count",
  "TenantLlmUsage.cacheWriteTokens": "a count",
  "TenantLlmUsage.outputTokens": "a count",
  "User.passwordResetExpires": "a date",
  "ChatConversation.hasHandoff": "a yes/no",
};

/** Tables with no link to a salon: platform configuration, sessions, catalogues. Not exported. */
export const EXPORT_GLOBAL_MODELS = [
  "AddOn",
  "AuthSession",
  "MaintenanceTask",
  "OnboardingStepDef",
  "PlatformStripeConfig",
  "PlatformEmailConfig",
  "PlatformLlmConfig",
  "StripeWebhookEvent",
] as const;

/**
 * What the salon's anonymisation does with every table that has a tenantId
 * (audit 8 T11). gdpr.service.spec.ts fails when a table is added without a
 * decision here, so new personal data cannot survive an erasure by default.
 *
 * - deleted: every row of the salon goes;
 * - cleaned: the rows stay, their personal columns are emptied;
 * - clients: handled per client by anonymizeClients (client-anonymize.ts);
 * - kept: no personal data, or a fiscal / security record that must stay.
 */
export const TENANT_MODEL_ON_ERASURE: Readonly<Record<string, "deleted" | "cleaned" | "clients" | "kept">> = {
  // The team and the salon itself.
  User: "cleaned", // names, email, phone, photo, 2FA and reset secrets; sessions revoked
  Professional: "cleaned", // names, email, phone, photo, bio, certifications
  TenantInvite: "deleted", // invitee email and name
  LegalAcceptance: "cleaned", // IP; the record that the terms were accepted stays
  TimeOff: "cleaned", // free-text notes (may say why: health)
  CashSession: "cleaned", // opening / closing notes
  BugReport: "cleaned", // subject, description, email, URL, context (audit 8 D14)
  Location: "cleaned", // its phone and email; the address may be the invoices' issuer address
  // Conversations: every one, also with visitors who never booked.
  ChatConversation: "deleted", // messages and intents cascade
  AssistantConversation: "deleted", // the team's copilot; messages cascade
  ActionApproval: "deleted", // copilot actions with their inputs and previews
  CopilotFeedback: "deleted",
  // Clients and what is kept about them.
  Client: "clients",
  Consent: "clients", // answers emptied, signer replaced
  Appointment: "clients", // notes, address, feedback emptied
  Review: "clients", // comment removed, rating kept
  ClientProfile: "deleted",
  ClientCadence: "deleted",
  RebookingReminder: "deleted",
  WaitList: "deleted",
  Notification: "deleted", // to the team and to clients; deliveries cascade
  NotificationPreference: "deleted",
  GiftCard: "cleaned", // recipient name, email and message
  Order: "cleaned", // notes
  EmailCampaign: "cleaned", // recipients and their open/click events deleted
  WhatsAppCampaign: "cleaned", // recipients deleted
  EmailSuppression: "deleted", // addresses: nothing is sent for this salon again
  WhatsAppOptOut: "deleted", // phones
  PublicBookingSms: "deleted", // phone hashes
  ImportJob: "deleted", // file name and row errors (copies of the imported rows)
  // Connections and their tokens.
  ChannelAccount: "deleted",
  SocialConnection: "deleted",
  WhatsAppConnection: "deleted",
  AccountingConnection: "deleted", // its sync log stays (fiscal), unlinked
  GoogleBusinessProfile: "deleted", // its Google reviews (reviewers' names) cascade
  SocialPost: "deleted", // posts may show clients
  CustomDomain: "deleted",
  TenantSlugRedirect: "deleted",
  // Fiscal records: kept as issued (keepFiscalData).
  Invoice: "kept",
  FiscalSequence: "kept",
  FiscalChainState: "kept",
  TaxReport: "kept",
  AccountingSyncLog: "kept",
  // The salon's certificate: invoice records still pending at the tax
  // agency are sent with it. Deleting it is the owner's open question.
  FiscalCertificate: "kept",
  // Money and figures, with no personal data of their own.
  Payment: "kept",
  PosSale: "kept",
  PosSaleLine: "kept",
  PosDiscount: "kept",
  CashMovement: "kept",
  ClientWallet: "kept",
  LoyaltyProgram: "kept",
  LoyaltyTransaction: "kept",
  CommissionAdjustment: "kept",
  CommissionPayout: "kept",
  TenantAddOn: "kept",
  EmailMarketingUsage: "kept",
  EmailCreditWallet: "kept",
  EmailPackPurchase: "kept",
  MessageCreditWallet: "kept",
  TenantLlmUsage: "kept",
  TrialNotificationLog: "kept",
  // The salon's catalogue and settings.
  Service: "kept",
  Product: "kept",
  ProductCategory: "kept",
  InventoryTransaction: "kept",
  Promotion: "kept",
  ConsentForm: "kept",
  NotificationTemplate: "kept",
  EmailCampaignTemplate: "kept",
  WidgetInstance: "kept",
  OnboardingState: "kept",
  // Security and accountability records.
  AuditLog: "kept",
  GdprRequest: "kept",
  UsedImpersonationToken: "kept",
  ProductEvent: "kept", // product analytics: event names and ids
};

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

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * How to find a table's rows of one salon: by its tenantId, or through the
 * required link to a table that has one (ChatMessage -> its conversation,
 * LoyaltyRedemption -> member -> client). Null for platform-wide tables.
 */
export function tenantScope(
  model: string,
  tenantId: string,
  models: readonly Prisma.DMMF.Model[] = Prisma.dmmf.datamodel.models,
  depth = 0,
): Record<string, unknown> | null {
  const m = models.find((x) => x.name === model);
  if (!m) return null;
  if (m.fields.some((f) => f.name === "tenantId")) return { tenantId };
  if (depth >= 3 || model === "Tenant") return null;
  const links = m.fields
    .filter((f) => f.kind === "object" && (f.relationFromFields?.length ?? 0) > 0 && f.type !== model)
    .sort((a, b) => Number(b.isRequired) - Number(a.isRequired));
  // A required link first; an optional one (a delivery and its notification) after.
  for (const link of links) {
    const inner = tenantScope(link.type, tenantId, models, depth + 1);
    if (inner) return { [link.name]: inner };
  }
  return null;
}

/** BigInt counters (LLM usage) cannot go through JSON.stringify as they are. */
function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Data export for a single tenant. Returns a Buffer with a JSON envelope
   * around the gzipped JSON of collectTenantData().
   */
  async export(tenantId: string, requestId: string): Promise<Buffer> {
    this.logger.log(`GDPR export: tenant=${tenantId} request=${requestId}`);
    const json = await this.exportJson(tenantId);
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

  /** The export as plain JSON (the console's download, audit 8 D14). */
  async exportJson(tenantId: string): Promise<Buffer> {
    const data = await this.collectTenantData(tenantId);
    return Buffer.from(JSON.stringify(data, jsonReplacer, 2), "utf8");
  }

  /**
   * Right-to-erasure (anonymize). Replaces or deletes the personal data of
   * the salon, its team and its clients in one transaction, following
   * TENANT_MODEL_ON_ERASURE. Issued invoices, the recipient on each one and
   * the salon's NIF, razón social and address stay as they were: they are
   * fiscal records (4 years) and, with VERI*FACTU, already chained and sent.
   * The console's erasure used to wipe the recipients: it no longer can.
   *
   * `opts.keepFiscalData` is accepted for the callers that pass it and is
   * always true.
   */
  async anonymize(
    tenantId: string,
    requestId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _opts: { keepFiscalData?: boolean } = {},
  ): Promise<GdprRequest> {
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
      const now = new Date();

      // Users — replace email + PII, mark inactive. The email is unique
      // across the platform, so each user gets their own placeholder (one
      // shared address failed as soon as a salon had two users).
      // Never a saas_owner (audit 8, C14): the platform owner's own account
      // is not the salon's data, and anonymising it would lock the console.
      const users = await tx.user.findMany({
        where: { tenantId, role: { not: UserRole.saas_owner } },
        select: { id: true },
      });
      for (const user of users) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            email: `[anonymized]+${user.id}@deleted.local`,
            firstName: ANON,
            lastName: ANON,
            phone: null,
            profileImage: null,
            emailBounceReason: null,
            preferences: {},
            twoFactorEnabled: false,
            twoFactorSecret: null,
            twoFactorPendingSecret: null,
            twoFactorRecoveryCodes: [],
            passwordResetToken: null,
            emailVerificationToken: null,
            isActive: false,
            tokenVersion: { increment: 1 },
          },
        });
      }
      if (users.length > 0) {
        await tx.authSession.updateMany({
          where: { subjectType: "user", subjectId: { in: users.map((u) => u.id) }, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      // Clients — the same erasure as a single client's (the client file's
      // "anonimizar"): profile, health data, consents' answers, chats,
      // wait-list, notifications... Appointments and FKs stay.
      const clients = await tx.client.findMany({ where: { tenantId }, select: { id: true } });
      await anonymizeClients(tx, tenantId, clients.map((c) => c.id));

      // Bug reports from the salon or its users: their text, email, URL and
      // context go too (audit 8 D14). The rows stay for the triage history.
      await tx.bugReport.updateMany({
        where: {
          anonymizedAt: null,
          OR: [{ tenantId }, { authorId: { in: users.map((u) => u.id) } }],
        },
        data: strippedBugReportData(new Date()),
      });

      await this.eraseTenantTables(tx, tenantId);

      // Tenant itself — rename, null out contact and public profile. Its
      // NIF, razón social and postal address stay: they are the issuer of
      // the invoices kept (and the invoice PDF reads the address).
      // Preserve slug as `anon-<short-id>` for any internal references.
      const icsVersion = Number((tenant.features as any)?.icsFeed?.version ?? 0) || 0;
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          name: `[anonymized tenant ${tenantId.slice(0, 8)}]`,
          slug: `anon-${tenantId.slice(0, 8)}`,
          stripeCustomerId: null,
          email: null,
          phone: null,
          whatsapp: null,
          description: null,
          logo: null,
          coverImage: null,
          website: null,
          instagram: null,
          facebook: null,
          privacyPolicyUrl: null,
          stripeTestSecretKey: null,
          stripeLiveSecretKey: null,
          stripeTestPublishableKey: null,
          stripeLivePublishableKey: null,
          // Channel credentials and push subscriptions live here; the
          // calendar feeds' version goes up so no old feed link works.
          features: { icsFeed: { version: icsVersion + 1 } },
          deletionRestore: Prisma.DbNull,
          anonymizedAt: tenant.anonymizedAt ?? now,
          deletedAt: tenant.deletedAt ?? now,
        },
      });

      // The audit trail stays, without the personal data in it (C15).
      // Fiscal data is always kept here, so the NIF change rows keep it too.
      await scrubTenantAuditLogs(tx, tenantId, { keepFiscalData: true });

      return tx.gdprRequest.update({
        where: { id: requestId },
        data: {
          status: GdprRequestStatus.completed,
          completedAt: new Date(),
        },
      });
    }, { timeout: 120_000 });
  }

  /** Every table of TENANT_MODEL_ON_ERASURE marked deleted or cleaned (the clients' are done). */
  private async eraseTenantTables(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    const where = { tenantId };

    // The team.
    const professionals = await tx.professional.findMany({ where, select: { id: true } });
    for (const p of professionals) {
      await tx.professional.update({
        where: { id: p.id },
        data: {
          firstName: ANON,
          lastName: ANON,
          email: `[anonymized]+${p.id}@deleted.local`,
          phone: null,
          profileImage: null,
          bio: null,
          position: null,
          specialties: [],
          portfolioImages: [],
          certifications: [],
          languages: [],
          isActive: false,
        },
      });
    }
    await tx.tenantInvite.deleteMany({ where });
    await tx.legalAcceptance.updateMany({ where, data: { ip: null } });
    await tx.timeOff.updateMany({ where, data: { note: null, decisionNote: null } });
    await tx.cashSession.updateMany({ where, data: { openingNotes: null, closingNotes: null } });
    await tx.bugReport.updateMany({ where, data: { email: null } });
    await tx.location.updateMany({ where, data: { phone: null, email: null } });

    // Conversations: all of them, with clients or with visitors.
    await tx.chatConversation.deleteMany({ where });
    await tx.copilotFeedback.deleteMany({ where });
    await tx.actionApproval.deleteMany({ where });
    await tx.assistantConversation.deleteMany({ where });

    // What is left about clients outside their own rows.
    await tx.clientProfile.deleteMany({ where });
    await tx.clientCadence.deleteMany({ where });
    await tx.rebookingReminder.deleteMany({ where });
    await tx.waitList.deleteMany({ where });
    await tx.notification.deleteMany({ where });
    await tx.notificationPreference.deleteMany({ where });
    await tx.giftCard.updateMany({ where, data: { recipientName: null, recipientEmail: null, message: null } });
    await tx.order.updateMany({ where, data: { notes: null } });
    await tx.emailCampaignAnalytics.deleteMany({ where: { campaign: where } });
    await tx.emailCampaignRecipient.deleteMany({ where: { campaign: where } });
    await tx.whatsAppCampaignRecipient.deleteMany({ where: { campaign: where } });
    await tx.emailSuppression.deleteMany({ where });
    await tx.whatsAppOptOut.deleteMany({ where });
    await tx.publicBookingSms.deleteMany({ where });
    await tx.importJob.deleteMany({ where });

    // Connections and their tokens; the public profile elsewhere.
    await tx.channelAccount.deleteMany({ where });
    await tx.socialConnection.deleteMany({ where });
    await tx.whatsAppConnection.deleteMany({ where });
    await tx.accountingConnection.deleteMany({ where });
    await tx.googleBusinessProfile.deleteMany({ where });
    await tx.socialPost.deleteMany({ where });
    await tx.customDomain.deleteMany({ where });
    await tx.tenantSlugRedirect.deleteMany({ where });
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

  /** An export's request is completed once the file is built (audit 8 T12). */
  async completeRequest(requestId: string, notes?: string): Promise<void> {
    await this.prisma.gdprRequest.update({
      where: { id: requestId },
      data: { status: GdprRequestStatus.completed, completedAt: new Date(), ...(notes ? { notes } : {}) },
    });
  }

  /** ...or failed, with why. Never throws: the original error is what matters. */
  async failRequest(requestId: string, err: unknown): Promise<void> {
    await this.prisma.gdprRequest
      .update({
        where: { id: requestId },
        data: { status: GdprRequestStatus.failed, notes: `Failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 500) },
      })
      .catch((e) => this.logger.warn(`GdprRequest ${requestId} not marked failed: ${(e as Error).message}`));
  }

  /** The salon's GDPR requests, newest first (the console's history). */
  async listRequests(tenantId: string, take = 50) {
    return this.prisma.gdprRequest.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, action: true, status: true, actorId: true, createdAt: true, completedAt: true, notes: true },
    });
  }

  /**
   * Every table with the salon's data (audit 8 T11): the tenant row, then
   * each table by name (`tables.Consent` are the signed consents,
   * `tables.ConsentForm` their forms), found through tenantScope(). Columns
   * of EXPORT_OMITTED_COLUMNS are left out.
   */
  private async collectTenantData(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const tables: Record<string, unknown[]> = {};
    for (const model of Prisma.dmmf.datamodel.models) {
      if (model.name === "Tenant") continue;
      const where = tenantScope(model.name, tenantId);
      if (!where) continue;
      const delegate = (this.prisma as any)[lowerFirst(model.name)];
      if (!delegate?.findMany) continue;
      const rows: Record<string, unknown>[] = (await delegate.findMany({ where })) ?? [];
      const omit = EXPORT_OMITTED_COLUMNS[model.name] ?? [];
      tables[model.name] = rows.map((row) => without(row, omit));
    }
    return {
      format: "kira-gdpr-export-v2",
      generatedAt: new Date().toISOString(),
      tenant: tenant ? without(tenant as unknown as Record<string, unknown>, EXPORT_OMITTED_COLUMNS.Tenant) : null,
      tables,
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
