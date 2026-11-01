import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ClientStatus, Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditLogService } from "../../saas/audit-log.service";
import { ClientCadenceService } from "../../rebooking/client-cadence.service";
import { CLIENT_EMAIL_TAKEN } from "../../clients/client-write";
import { normalizeClientEmail } from "../../clients/client-contact";
import { MARKETING_FIELD_ID, SYSTEM_CONSENT_PURPOSES } from "../../consent/marketing-consent";

/**
 * Merging two records of the same client ("Ana López" booked online and
 * "Ana Lopez" created at the till): everything the source record has moves
 * to the target, in one transaction, and the source is then deleted.
 *
 * Why delete rather than deactivate: once everything has moved nothing
 * points at the source any more, and a deactivated copy would still be
 * found by its phone or email (the booking site and the till look clients
 * up by them) and get the next booking. The audit log keeps who merged
 * which record into which, and when.
 *
 * Every column that holds a client id is listed in CLIENT_REFERENCES with
 * what the merge does with it. client-merge.service.spec.ts reads the
 * Prisma schema and fails when a model gains a client reference that is
 * not listed, so a new relation cannot be silently left behind (it would
 * make the merge fail, or be deleted with the source).
 */
export const CLIENT_REFERENCES: Readonly<Record<string, string>> = {
  "Appointment.clientId": "moved",
  "Payment.clientId": "moved",
  "Order.clientId": "moved",
  "ChatConversation.clientId": "moved",
  "Notification.clientId": "moved",
  "RebookingReminder.clientId": "moved",
  "WaitList.clientId": "moved",
  "Review.clientId": "moved",
  "PromotionUsage.clientId": "moved (her uses of a promotion keep counting)",
  "Consent.clientId": "moved; one active marketing choice kept per purpose, a refusal over a grant",
  "EmailCampaignRecipient.clientId": "moved; dropped where the target is already on that campaign",
  "WhatsAppCampaignRecipient.clientId": "moved; dropped where the target is already on that campaign",
  "ClientWallet.clientId": "moved, or its balances added to the target's wallet",
  "LoyaltyMember.clientId": "moved, or its points added to the target's membership of that programme",
  "ClientProfile.clientId": "moved, or its histories added to the target's profile",
  "NotificationPreference.clientId": "moved, or merged into the target's (an opt-out on either stays)",
  "ClientCadence.clientId": "moved, or merged into the target's (reminders sent kept, an opt-out stays)",
  "Invoice.recipientId": "moved where recipientType is client (the invoice's fiscal content is untouched)",
  "GiftCard.purchasedById": "moved",
  "GiftCard.recipientId": "moved",
  "AuthSession.subjectId": "revoked (the source record no longer exists to sign in as)",
};

export const MERGE_SAME_CLIENT = "No se puede fusionar una ficha consigo misma";
export const MERGE_TARGET_INACTIVE =
  "Esta ficha está desactivada. Fusiona al revés (esta ficha dentro de la activa) o actívala antes.";
export const MERGE_SOURCE_BLOCKED =
  "La otra ficha está bloqueada y esta no. Fusiona al revés para conservar el bloqueo, o desbloquéala antes.";

export interface MergeActor {
  id: string;
  role: UserRole;
}

export interface MergeResult {
  ok: true;
  targetClientId: string;
  sourceClientId: string;
  moved: Record<string, number>;
  message: string;
}

type Json = Prisma.JsonValue;

/** A JSON list, whatever was stored (non-lists count as empty). */
function asList(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

/** Both lists, in order, without repeating an item already there. */
export function unionList(a: Json | undefined, b: Json | undefined): Json[] {
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const item of [...asList(a), ...asList(b)]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, Json> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Two preference objects ({ whatsapp: false }, { appointment_reminder:
 * { email: true, sms: false } }): a key on one side only is kept; where
 * both say yes/no, a "no" on either wins (an opt-out is never undone by a
 * merge); any other clash keeps the target's value.
 */
export function mergePreferences(target: Json | undefined, source: Json | undefined): Record<string, Json> {
  const t = isPlainObject(target) ? target : {};
  const s = isPlainObject(source) ? source : {};
  const out: Record<string, Json> = { ...s, ...t };
  for (const key of Object.keys(s)) {
    if (!(key in t)) continue;
    const a = t[key];
    const b = s[key];
    if (typeof a === "boolean" && typeof b === "boolean") out[key] = a && b;
    else if (isPlainObject(a) && isPlainObject(b)) out[key] = mergePreferences(a, b);
  }
  return out;
}

/** Both notes, the target's first; one if they are the same or one is empty. */
export function mergeNotes(target: string | null, source: string | null): string | null {
  const t = target?.trim() || "";
  const s = source?.trim() || "";
  if (!s || s === t) return t || null;
  if (!t) return s;
  return `${t}\n\n${s}`;
}

const TIER_RANK = ["bronze", "silver", "gold", "platinum"];

function higherTier(a: string, b: string): string {
  return TIER_RANK.indexOf(b) > TIER_RANK.indexOf(a) ? b : a;
}

const earliest = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a <= b ? a : b);
const latest = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a >= b ? a : b);

/** What the salon reads in the toast, from the counts that matter to it. */
function summary(targetName: string, moved: Record<string, number>): string {
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, many: string) => {
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(moved.appointments, "cita", "citas");
  add(moved.payments, "pago", "pagos");
  add(moved.orders, "venta", "ventas");
  add(moved.invoices, "factura", "facturas");
  add(moved.consents, "consentimiento", "consentimientos");
  add(moved.reviews, "reseña", "reseñas");
  if (parts.length === 0) {
    return `Fichas fusionadas. La otra ficha no tenía historial; sus datos se han añadido a ${targetName}.`;
  }
  return `Fichas fusionadas. Ahora están en la ficha de ${targetName}: ${parts.join(", ")}.`;
}

const CLIENT_MERGE_SELECT = {
  id: true,
  tenantId: true,
  status: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  taxId: true,
  taxIdType: true,
  dateOfBirth: true,
  gender: true,
  profileImage: true,
  source: true,
  notes: true,
  tags: true,
  allergies: true,
  medicalConditions: true,
  preferredServices: true,
  preferredProfessionals: true,
  preferredTimes: true,
  communicationPreferences: true,
  loyaltyPoints: true,
  loyaltyTier: true,
  totalSpent: true,
  visitCount: true,
  firstVisit: true,
  lastVisit: true,
  lastReengagementSent: true,
  passwordHash: true,
} satisfies Prisma.ClientSelect;

type MergeClient = Prisma.ClientGetPayload<{ select: typeof CLIENT_MERGE_SELECT }>;

@Injectable()
export class ClientMergeService {
  private readonly logger = new Logger(ClientMergeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    @Optional() private readonly cadence?: ClientCadenceService,
  ) {}

  /**
   * Merge `sourceId` into `targetId`, both of `tenantId`. 404 when either
   * is not a client of the salon; 400 for the same record twice; 409 into
   * a deactivated record, or from a blocked record into one that is not
   * (the block would be lost silently).
   */
  async merge(tenantId: string, targetId: string, sourceId: string, actor: MergeActor): Promise<MergeResult> {
    if (targetId === sourceId) throw new BadRequestException(MERGE_SAME_CLIENT);

    let result: { moved: Record<string, number>; targetName: string };
    try {
      result = await this.prisma.$transaction(
        (tx) => this.mergeIn(tx, tenantId, targetId, sourceId, actor),
        { timeout: 60_000, maxWait: 10_000 },
      );
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "P2002") {
        throw new ConflictException(CLIENT_EMAIL_TAKEN);
      }
      throw error;
    }

    // Her return pattern now spans both records' visits. Not part of the
    // merge: a failure here leaves yesterday's prediction, nothing worse.
    if (this.cadence) {
      try {
        await this.cadence.computeForClient(targetId);
      } catch (err) {
        this.logger.warn(`Cadence not recomputed after merging into ${targetId}: ${(err as Error).message}`);
      }
    }

    return {
      ok: true,
      targetClientId: targetId,
      sourceClientId: sourceId,
      moved: result.moved,
      message: summary(result.targetName, result.moved),
    };
  }

  private async mergeIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    targetId: string,
    sourceId: string,
    actor: MergeActor,
  ): Promise<{ moved: Record<string, number>; targetName: string }> {
    // Both rows locked, in a fixed order: a booking or a second merge
    // touching either waits for this one.
    await tx.$queryRaw`
      SELECT id FROM clients
      WHERE "tenantId" = ${tenantId} AND id IN (${targetId}, ${sourceId})
      ORDER BY id
      FOR UPDATE`;
    const [target, source] = await Promise.all([
      tx.client.findFirst({ where: { id: targetId, tenantId }, select: CLIENT_MERGE_SELECT }),
      tx.client.findFirst({ where: { id: sourceId, tenantId }, select: CLIENT_MERGE_SELECT }),
    ]);
    if (!target || !source) throw new NotFoundException("Cliente no encontrado");
    if (target.status === ClientStatus.inactive) throw new ConflictException(MERGE_TARGET_INACTIVE);
    if (source.status === ClientStatus.blocked && target.status !== ClientStatus.blocked) {
      throw new ConflictException(MERGE_SOURCE_BLOCKED);
    }

    const moved: Record<string, number> = {};
    const from = { clientId: sourceId };
    const to = { clientId: targetId };

    // History: rows that simply change owner.
    moved.appointments = (await tx.appointment.updateMany({ where: { tenantId, ...from }, data: to })).count;
    moved.payments = (await tx.payment.updateMany({ where: { tenantId, ...from }, data: to })).count;
    moved.orders = (await tx.order.updateMany({ where: { tenantId, ...from }, data: to })).count;
    moved.chatConversations = (await tx.chatConversation.updateMany({ where: { tenantId, ...from }, data: to })).count;
    moved.notifications = (await tx.notification.updateMany({ where: { tenantId, ...from }, data: to })).count;
    moved.rebookingReminders = (await tx.rebookingReminder.updateMany({ where: { tenantId, ...from }, data: to })).count;
    moved.waitList = (await tx.waitList.updateMany({ where: { tenantId, ...from }, data: to })).count;
    moved.reviews = (await tx.review.updateMany({ where: { tenantId, ...from }, data: to })).count;
    moved.promotionUsages = (await tx.promotionUsage.updateMany({ where: from, data: to })).count;
    moved.invoices = (
      await tx.invoice.updateMany({
        where: { tenantId, recipientType: "client", recipientId: sourceId },
        data: { recipientId: targetId },
      })
    ).count;
    moved.giftCards =
      (await tx.giftCard.updateMany({ where: { tenantId, purchasedById: sourceId }, data: { purchasedById: targetId } }))
        .count +
      (await tx.giftCard.updateMany({ where: { tenantId, recipientId: sourceId }, data: { recipientId: targetId } }))
        .count;

    moved.consents = await this.moveConsents(tx, tenantId, sourceId, targetId);
    moved.campaignRecipients = await this.moveCampaignRecipients(tx, sourceId, targetId);
    await this.mergeWallet(tx, tenantId, sourceId, targetId);
    const hasMembership = await this.mergeLoyalty(tx, tenantId, sourceId, targetId);
    await this.mergeProfile(tx, tenantId, sourceId, targetId);
    await this.mergeNotificationPreference(tx, sourceId, targetId);
    await this.mergeCadence(tx, sourceId, targetId);

    // The source can no longer be signed in as.
    await tx.authSession.updateMany({
      where: { subjectId: sourceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Nothing points at the source any more: delete it before the target
    // takes its email, which the unique index would otherwise refuse.
    await tx.client.delete({ where: { id: sourceId } });
    await tx.client.update({
      where: { id: targetId },
      data: this.mergedFields(target, source, hasMembership ? await this.membershipPoints(tx, targetId) : null),
    });

    await this.auditLog.record(
      "client.merge",
      {
        actorId: actor.id,
        actorRole: actor.role,
        tenantId,
        // Ids and counts only: the source's details are now the target's.
        metadata: { targetClientId: targetId, sourceClientId: sourceId, moved },
      },
      tx,
    );

    return { moved, targetName: `${target.firstName} ${target.lastName}`.trim() };
  }

  /**
   * The target's record after the merge: what it has stays, what it lacks
   * is taken from the source; lists are joined; visits and spend add up.
   */
  private mergedFields(
    target: MergeClient,
    source: MergeClient,
    membershipPoints: number | null,
  ): Prisma.ClientUpdateInput {
    const data: Prisma.ClientUpdateInput = {};
    const takesEmail = !target.email && !!source.email;
    if (takesEmail) data.email = normalizeClientEmail(source.email);
    if (!target.phone && source.phone) data.phone = source.phone;
    if (!target.taxId && source.taxId) {
      data.taxId = source.taxId;
      data.taxIdType = source.taxIdType;
    }
    if (!target.dateOfBirth && source.dateOfBirth) data.dateOfBirth = source.dateOfBirth;
    if (!target.gender && source.gender) data.gender = source.gender;
    if (!target.profileImage && source.profileImage) data.profileImage = source.profileImage;
    if (!target.source && source.source) data.source = source.source;

    // Her client account comes along when it is the same sign-in address
    // and the target has none of its own. Never otherwise: a mistaken merge
    // must not let one person's password open another's record.
    const email = takesEmail ? source.email : target.email;
    if (
      !target.passwordHash &&
      source.passwordHash &&
      email &&
      source.email &&
      email.trim().toLowerCase() === source.email.trim().toLowerCase()
    ) {
      data.passwordHash = source.passwordHash;
    }

    data.notes = mergeNotes(target.notes, source.notes);
    data.tags = unionList(target.tags, source.tags) as Prisma.InputJsonValue;
    data.allergies = unionList(target.allergies, source.allergies) as Prisma.InputJsonValue;
    data.medicalConditions = unionList(target.medicalConditions, source.medicalConditions) as Prisma.InputJsonValue;
    data.preferredServices = unionList(target.preferredServices, source.preferredServices) as Prisma.InputJsonValue;
    data.preferredProfessionals = unionList(
      target.preferredProfessionals,
      source.preferredProfessionals,
    ) as Prisma.InputJsonValue;
    data.preferredTimes = { ...(isPlainObject(source.preferredTimes) ? source.preferredTimes : {}), ...(isPlainObject(target.preferredTimes) ? target.preferredTimes : {}) } as Prisma.InputJsonValue;
    data.communicationPreferences = mergePreferences(
      target.communicationPreferences,
      source.communicationPreferences,
    ) as Prisma.InputJsonValue;

    const totalSpent = new Prisma.Decimal(target.totalSpent).plus(source.totalSpent);
    const visitCount = target.visitCount + source.visitCount;
    data.totalSpent = totalSpent;
    data.visitCount = visitCount;
    data.averageSpent = visitCount > 0 ? totalSpent.dividedBy(visitCount).toDecimalPlaces(2) : new Prisma.Decimal(0);
    data.firstVisit = earliest(target.firstVisit, source.firstVisit) ?? target.firstVisit;
    data.lastVisit = latest(target.lastVisit, source.lastVisit);
    data.lastReengagementSent = latest(target.lastReengagementSent, source.lastReengagementSent);
    data.loyaltyPoints = membershipPoints ?? target.loyaltyPoints + source.loyaltyPoints;
    data.loyaltyTier = higherTier(target.loyaltyTier, source.loyaltyTier);
    return data;
  }

  /**
   * Treatment consents move as they are. Marketing choices ("marketing",
   * "marketing_whatsapp") must have one active record per client: if both
   * records had chosen, a refusal is kept over a grant (a merge must not
   * start sending promotions to someone who said no), else the latest; the
   * other is revoked, so its history stays.
   */
  private async moveConsents(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sourceId: string,
    targetId: string,
  ): Promise<number> {
    const { count } = await tx.consent.updateMany({
      where: { tenantId, clientId: sourceId },
      data: { clientId: targetId },
    });
    if (count === 0) return 0;
    for (const purpose of SYSTEM_CONSENT_PURPOSES) {
      const active = await tx.consent.findMany({
        where: { tenantId, clientId: targetId, revokedAt: null, form: { purpose } },
        orderBy: { signedAt: "desc" },
        select: { id: true, responses: true },
      });
      if (active.length < 2) continue;
      // As marketingStateOf reads it: anything but accepts === true is a no.
      const refuses = (r: { responses: Json }) =>
        !(isPlainObject(r.responses) && r.responses[MARKETING_FIELD_ID] === true);
      const keep = active.find(refuses) ?? active[0];
      await tx.consent.updateMany({
        where: { id: { in: active.filter((r) => r.id !== keep.id).map((r) => r.id) } },
        data: { revokedAt: new Date(), revokeReason: "superseded_by_merge" },
      });
    }
    return count;
  }

  /** A client is on a campaign once: the source's row goes where the target already is. */
  private async moveCampaignRecipients(
    tx: Prisma.TransactionClient,
    sourceId: string,
    targetId: string,
  ): Promise<number> {
    let movedRows = 0;

    const emailTaken = (
      await tx.emailCampaignRecipient.findMany({ where: { clientId: targetId }, select: { campaignId: true } })
    ).map((r) => r.campaignId);
    const emailDup = await tx.emailCampaignRecipient.findMany({
      where: { clientId: sourceId, campaignId: { in: emailTaken } },
      select: { id: true, campaignId: true },
    });
    if (emailDup.length > 0) {
      await tx.emailCampaignRecipient.deleteMany({ where: { id: { in: emailDup.map((r) => r.id) } } });
      await tx.emailCampaign.updateMany({
        where: { id: { in: emailDup.map((r) => r.campaignId) }, totalRecipients: { gt: 0 } },
        data: { totalRecipients: { decrement: 1 } },
      });
    }
    movedRows += (
      await tx.emailCampaignRecipient.updateMany({ where: { clientId: sourceId }, data: { clientId: targetId } })
    ).count;

    const waTaken = (
      await tx.whatsAppCampaignRecipient.findMany({ where: { clientId: targetId }, select: { campaignId: true } })
    ).map((r) => r.campaignId);
    const waDup = await tx.whatsAppCampaignRecipient.findMany({
      where: { clientId: sourceId, campaignId: { in: waTaken } },
      select: { id: true, campaignId: true },
    });
    if (waDup.length > 0) {
      await tx.whatsAppCampaignRecipient.deleteMany({ where: { id: { in: waDup.map((r) => r.id) } } });
      await tx.whatsAppCampaign.updateMany({
        where: { id: { in: waDup.map((r) => r.campaignId) }, totalRecipients: { gt: 0 } },
        data: { totalRecipients: { decrement: 1 } },
      });
    }
    movedRows += (
      await tx.whatsAppCampaignRecipient.updateMany({ where: { clientId: sourceId }, data: { clientId: targetId } })
    ).count;
    return movedRows;
  }

  /**
   * Her prepaid balance is owed to her: added to the target's wallet, with
   * a line in its history saying where it came from. The source wallet's
   * own history moves with it.
   */
  private async mergeWallet(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const sw = await tx.clientWallet.findFirst({ where: { tenantId, clientId: sourceId } });
    if (!sw) return;
    const tw = await tx.clientWallet.findFirst({ where: { tenantId, clientId: targetId } });
    if (!tw) {
      await tx.clientWallet.update({ where: { id: sw.id }, data: { clientId: targetId } });
      return;
    }
    await tx.walletTransaction.updateMany({ where: { walletId: sw.id }, data: { walletId: tw.id } });
    const updated = await tx.clientWallet.update({
      where: { id: tw.id },
      data: {
        balance: { increment: sw.balance },
        totalEarned: { increment: sw.totalEarned },
        totalSpent: { increment: sw.totalSpent },
        loyaltyPoints: { increment: sw.loyaltyPoints },
      },
    });
    if (sw.balance !== 0) {
      await tx.walletTransaction.create({
        data: {
          walletId: tw.id,
          type: sw.balance > 0 ? "credit" : "debit",
          amount: Math.abs(sw.balance),
          referenceType: "client_merge",
          referenceId: sourceId,
          description: "Saldo de la ficha fusionada",
          balanceAfter: updated.balance,
        },
      });
    }
    await tx.clientWallet.delete({ where: { id: sw.id } });
  }

  /**
   * Per programme: a membership only the source has moves; when both have
   * one, the points and totals add up into the target's, the ledger,
   * redemptions and expiring points move to it, and the tier is the one
   * the summed lifetime points reach. Returns whether the target now has a
   * membership.
   */
  private async mergeLoyalty(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sourceId: string,
    targetId: string,
  ): Promise<boolean> {
    const [sourceMembers, targetMembers] = await Promise.all([
      tx.loyaltyMember.findMany({ where: { clientId: sourceId } }),
      tx.loyaltyMember.findMany({ where: { clientId: targetId } }),
    ]);
    for (const sm of sourceMembers) {
      const tm = targetMembers.find((m) => m.programId === sm.programId);
      if (!tm) {
        await tx.loyaltyMember.update({ where: { id: sm.id }, data: { clientId: targetId } });
        continue;
      }
      // The ledger is unique per (member, type, source, sourceId): an event
      // already on the target's ledger keeps the source's row, unlinked.
      const targetKeys = new Set(
        (
          await tx.loyaltyTransaction.findMany({
            where: { tenantId, memberId: tm.id, sourceId: { not: null } },
            select: { type: true, source: true, sourceId: true },
          })
        ).map((r) => `${r.type}|${r.source}|${r.sourceId}`),
      );
      const clashing = (
        await tx.loyaltyTransaction.findMany({
          where: { tenantId, memberId: sm.id, sourceId: { not: null } },
          select: { id: true, type: true, source: true, sourceId: true },
        })
      ).filter((r) => targetKeys.has(`${r.type}|${r.source}|${r.sourceId}`));
      if (clashing.length > 0) {
        await tx.loyaltyTransaction.updateMany({
          where: { id: { in: clashing.map((r) => r.id) } },
          data: { sourceId: null },
        });
      }
      await tx.loyaltyTransaction.updateMany({ where: { tenantId, memberId: sm.id }, data: { memberId: tm.id } });
      await tx.loyaltyRedemption.updateMany({ where: { memberId: sm.id }, data: { memberId: tm.id } });
      await tx.loyaltyPointsExpiration.updateMany({ where: { memberId: sm.id }, data: { memberId: tm.id } });

      const lifetimePoints = tm.lifetimePoints + sm.lifetimePoints;
      const tier = await tx.loyaltyTier.findFirst({
        where: { programId: tm.programId, minPoints: { lte: lifetimePoints } },
        orderBy: { minPoints: "desc" },
        select: { id: true },
      });
      await tx.loyaltyMember.update({
        where: { id: tm.id },
        data: {
          lifetimePoints,
          currentPoints: tm.currentPoints + sm.currentPoints,
          totalEarned: tm.totalEarned + sm.totalEarned,
          totalRedeemed: tm.totalRedeemed + sm.totalRedeemed,
          totalSpent: tm.totalSpent + sm.totalSpent,
          joinedAt: earliest(tm.joinedAt, sm.joinedAt) ?? tm.joinedAt,
          lastActivityAt: latest(tm.lastActivityAt, sm.lastActivityAt),
          tierId: tier?.id ?? tm.tierId,
        },
      });
      await tx.loyaltyMember.delete({ where: { id: sm.id } });
    }
    return sourceMembers.length > 0 || targetMembers.length > 0;
  }

  /** The client record's copy of her points: her memberships' balance. */
  private async membershipPoints(tx: Prisma.TransactionClient, targetId: string): Promise<number> {
    const agg = await tx.loyaltyMember.aggregate({ where: { clientId: targetId }, _sum: { currentPoints: true } });
    return agg._sum.currentPoints ?? 0;
  }

  /** The receptionist's memory of her: one profile, both histories. */
  private async mergeProfile(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const sp = await tx.clientProfile.findFirst({ where: { tenantId, clientId: sourceId } });
    if (!sp) return;
    const tp = await tx.clientProfile.findFirst({ where: { tenantId, clientId: targetId } });
    if (!tp) {
      await tx.clientProfile.update({ where: { id: sp.id }, data: { clientId: targetId } });
      return;
    }
    await tx.clientProfile.update({
      where: { id: tp.id },
      data: {
        email: tp.email ?? sp.email,
        phone: tp.phone ?? sp.phone,
        preferences: { ...(isPlainObject(sp.preferences) ? sp.preferences : {}), ...(isPlainObject(tp.preferences) ? tp.preferences : {}) } as Prisma.InputJsonValue,
        interactionHistory: [...asList(tp.interactionHistory), ...asList(sp.interactionHistory)] as Prisma.InputJsonValue,
        bookingHistory: [...asList(tp.bookingHistory), ...asList(sp.bookingHistory)] as Prisma.InputJsonValue,
        servicePreferences: unionList(tp.servicePreferences, sp.servicePreferences) as Prisma.InputJsonValue,
        communicationPreferences: mergePreferences(
          tp.communicationPreferences,
          sp.communicationPreferences,
        ) as Prisma.InputJsonValue,
      },
    });
    await tx.clientProfile.delete({ where: { id: sp.id } });
  }

  private async mergeNotificationPreference(
    tx: Prisma.TransactionClient,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const sp = await tx.notificationPreference.findFirst({ where: { clientId: sourceId } });
    if (!sp) return;
    const tp = await tx.notificationPreference.findFirst({ where: { clientId: targetId } });
    if (!tp) {
      await tx.notificationPreference.update({ where: { id: sp.id }, data: { clientId: targetId } });
      return;
    }
    await tx.notificationPreference.delete({ where: { id: sp.id } });
    await tx.notificationPreference.update({
      where: { id: tp.id },
      data: { preferences: mergePreferences(tp.preferences, sp.preferences) as Prisma.InputJsonValue },
    });
  }

  /**
   * The rebooking cadence (one row per client): the target keeps hers,
   * with the reminders already sent from either record (so none is sent
   * twice) and an opt-out from either. Recomputed after the merge.
   */
  private async mergeCadence(tx: Prisma.TransactionClient, sourceId: string, targetId: string): Promise<void> {
    const sc = await tx.clientCadence.findFirst({ where: { clientId: sourceId } });
    if (!sc) return;
    const tc = await tx.clientCadence.findFirst({ where: { clientId: targetId } });
    if (!tc) {
      await tx.clientCadence.update({ where: { clientId: sourceId }, data: { clientId: targetId } });
      return;
    }
    await tx.clientCadence.delete({ where: { clientId: sourceId } });
    await tx.clientCadence.update({
      where: { clientId: targetId },
      data: {
        reminderSentFor: [...asList(tc.reminderSentFor), ...asList(sc.reminderSentFor)] as Prisma.InputJsonValue,
        optedOut: tc.optedOut || sc.optedOut,
      },
    });
  }
}
