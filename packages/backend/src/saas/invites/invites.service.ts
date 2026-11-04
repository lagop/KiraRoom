import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomBytes } from "crypto";
import {
  InviteStatus,
  Prisma,
  SubscriptionPlan,
  UserRole,
  type TenantInvite,
} from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EmailService } from "../../notifications/services/email.service";
import { AuthSessionsService } from "../../auth/sessions/auth-sessions.service";
import { AuditLogService } from "../audit-log.service";
import {
  createTenantWithOwner,
  availableTenantSlug,
} from "../saas.helpers";
import { AcceptInviteDto } from "./dto/accept-invite.dto";
import { CreateInviteDto } from "./dto/create-invite.dto";
import {
  parseJwtDuration,
  DEFAULT_ACCESS_TOKEN_SECONDS,
  DEFAULT_REFRESH_TOKEN_SECONDS,
} from "../../common/jwt-duration";
import { TERMS_VERSION } from "../../auth/legal-terms";
import { ACCESS_TOKEN_TYPE, REFRESH_TOKEN_TYPE } from "../../auth/session-token";

const INVITE_TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Public projection of an invite — never returns the raw token. */
export interface InviteView {
  id: string;
  email: string;
  tenantName: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  plan: SubscriptionPlan;
  status: InviteStatus;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  /** Only included on the create response (SaaS admin needs it once). */
  magicLink?: string;
  /** Internal token (only on the create response). */
  token?: string;
  /**
   * Whether the email really went out (create and resend only). The console
   * said "Hemos enviado el email" even when sending failed (audit 8 T15).
   */
  emailSent?: boolean;
}

/** What the public accept-invite page needs to render the wizard. */
export interface InviteAcceptanceContext {
  email: string;
  tenantName: string;
  firstName: string | null;
  lastName: string | null;
  expiresAt: string;
}

/**
 * Service for Sprint 2 / Workstream 2.1 (self-serve onboarding).
 *
 * Owns the lifecycle of `TenantInvite` rows:
 *   - `createInvite` (SaaS admin only) — mint token + send magic-link email.
 *   - `getInviteForAcceptance` (public) — read what the wizard needs.
 *   - `acceptInvite` (public) — atomically create Tenant + User.
 *   - `listInvites` / `revokeInvite` / `resendInvite` (SaaS admin).
 *
 * The token is a 256-bit random base64url string; it is the
 * authentication credential for the public endpoints, so:
 *   - never returned after the initial create,
 *   - never logged (see `Logger` usage),
 *   - stored only as `token @unique` on the row,
 *   - rotated on resend (the old row is marked revoked and a new row
 *     is created).
 */
/** How an invite's status reads in the console's messages. */
const INVITE_STATUS_ES: Record<string, string> = {
  pending: "pendiente",
  accepted: "aceptada",
  revoked: "anulada",
  expired: "caducada",
};

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly sessions: AuthSessionsService,
  ) {}

  /**
   * Mint a new invite. Returns the row (incl. `magicLink`) so the SaaS
   * admin UI can display it as a fallback if email delivery is broken.
   */
  async createInvite(
    dto: CreateInviteDto,
    invitedById: string,
  ): Promise<InviteView> {
    const invite = await this.prisma.$transaction(async (tx) => {
      return this.createInviteInTx(tx, dto, invitedById);
    });

    const emailSent = await this.sendInviteEmail(invite);

    return { ...this.toView(invite, true), emailSent };
  }

  /**
   * Transactional core of `createInvite`. Refactored out so that
   * `resendInvite` can wrap the revoke-old + create-new pair in a
   * single atomic transaction — otherwise a failure on `create` left
   * the previous invite revoked with no replacement (see review,
   * 2026-07-17 finding #2).
   *
   * Pre-conditions checked in this method:
   *   - no active (pending, non-expired) invite for the same
   *     email + tenantName combo
   *   - the email is not already tied to a `User` row (whether owner
   *     on another tenant or staff — `User.email @unique` is global)
   *
   * Audit-log row is written inside the same transaction so a row
   * can never exist without a matching audit entry.
   */
  private async createInviteInTx(
    tx: Prisma.TransactionClient,
    dto: CreateInviteDto,
    invitedById: string,
  ): Promise<TenantInvite> {
    const email = dto.email.trim().toLowerCase();

    const existing = await tx.tenantInvite.findFirst({
      where: {
        email,
        tenantName: dto.tenantName,
        status: InviteStatus.pending,
        expiresAt: { gt: new Date() },
      },
    });
    if (existing) {
      throw new ConflictException(
        `Ya hay una invitación pendiente para ${email} (${dto.tenantName}). Reenvíala desde la lista de invitaciones.`,
      );
    }

    // Ignoring case: older accounts may still have capitals.
    const existingUser = await tx.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { tenantId: true },
    });
    if (existingUser) {
      throw new ConflictException(
        `${email} ya tiene una cuenta en KiraRoom. Si se une a un equipo, la dueña del salón la añade desde su panel.`,
      );
    }

    const token = this.mintToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * MS_PER_DAY);

    const invite = await tx.tenantInvite.create({
      data: {
        email,
        tenantName: dto.tenantName,
        firstName: dto.firstName ?? null,
        lastName: dto.lastName ?? null,
        role: dto.role ?? UserRole.owner,
        plan: dto.plan,
        token,
        expiresAt,
        invitedById,
        status: InviteStatus.pending,
      },
    });

    await this.auditLog.record(
      "tenant.invite.create",
      {
        actorId: invitedById,
        actorRole: UserRole.saas_owner,
        metadata: {
          email: invite.email,
          tenantName: invite.tenantName,
          inviteId: invite.id,
        },
      },
      tx,
    );

    return invite;
  }

  /**
   * Public endpoint input — what the invite-acceptance wizard needs.
   * Throws 404 (not 410) on every "unusable" path so we don't leak
   * whether a token was ever issued.
   */
  async getInviteForAcceptance(token: string): Promise<InviteAcceptanceContext> {
    if (!token || token.length < 16) {
      throw new NotFoundException("Invitación no encontrada");
    }

    const invite = await this.prisma.tenantInvite.findUnique({
      where: { token },
    });

    if (
      !invite ||
      invite.status !== InviteStatus.pending ||
      invite.expiresAt.getTime() <= Date.now()
    ) {
      throw new NotFoundException("Invitación no encontrada");
    }

    return {
      email: invite.email,
      tenantName: invite.tenantName,
      firstName: invite.firstName,
      lastName: invite.lastName,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /**
   * Atomic accept: create Tenant + first owner User + mark invite
   * accepted. Returns the LoginResponse-shaped payload so the frontend
   * can drop the user straight into the dashboard.
   */
  async acceptInvite(
    token: string,
    dto: AcceptInviteDto,
    context: { ip?: string | null } = {},
  ): Promise<{
    tenantId: string;
    userId: string;
    email: string;
    role: UserRole;
    accessToken: string;
    refreshToken: string;
  }> {
    if (!token || token.length < 16) {
      throw new ForbiddenException("Invalid invite token");
    }

    return this.prisma.$transaction(async (tx) => {
      const invite = await tx.tenantInvite.findUnique({
        where: { token },
        select: { id: true, tenantName: true, email: true, firstName: true, lastName: true, role: true, plan: true, expiresAt: true, status: true },
      });

      if (
        !invite ||
        invite.status !== InviteStatus.pending ||
        invite.expiresAt.getTime() <= Date.now()
      ) {
        throw new ForbiddenException(
          "Esta invitación ya no es válida: ha caducado, se ha anulado o ya se ha usado. Pide una nueva a KiraRoom.",
        );
      }

      // Slug must be available at accept time (a tenant could have
      // registered the same slug between invite-mint and invite-accept).
      // A taken name gets the next free address ("-2", "-3"...), the same
      // as a signup, so the accept never blocks on a name collision.
      const finalSlug = await availableTenantSlug(tx, invite.tenantName);

      const { tenantId, userId, email, role } = await this.acceptWithSlug(
        tx,
        invite,
        dto,
        finalSlug,
        context.ip ?? null,
      );

      // Atomic accept: updateMany with the status filter so that two
      // concurrent accepts of the same token can never both succeed.
      // `count === 0` means another request already consumed this
      // invite between our read and our write — abort the transaction
      // so the tenant + user we just created get rolled back too.
      const flip = await tx.tenantInvite.updateMany({
        where: {
          id: invite.id,
          status: InviteStatus.pending,
          expiresAt: { gt: new Date() },
        },
        data: {
          status: InviteStatus.accepted,
          acceptedAt: new Date(),
          tenantId,
        },
      });

      if (flip.count === 0) {
        throw new ForbiddenException(
          "Esta invitación se acaba de usar. Si has sido tú, inicia sesión.",
        );
      }

      return { tenantId, userId, email, role };
    }).then(async (result) => {
      // After the tenant + user are committed, mint a JWT pair for
      // instant dashboard access. Mirrors AuthService.generateTokens
      // so the frontend login flow is identical.
      // Same parser as AuthService.generateTokens. This used to strip an
      // "m" and multiply by 60, so the documented JWT_EXPIRES_IN=8h minted
      // an 8-MINUTE token and logged the new owner out mid-onboarding.
      const accessExpiresIn = parseJwtDuration(
        process.env.JWT_EXPIRES_IN,
        DEFAULT_ACCESS_TOKEN_SECONDS,
      );
      const refreshExpiresIn = parseJwtDuration(
        process.env.JWT_REFRESH_EXPIRES_IN,
        DEFAULT_REFRESH_TOKEN_SECONDS,
      );

      const payload = {
        sub: result.userId,
        email: result.email,
        role: result.role,
        tenantId: result.tenantId,
      };

      // Typed like every session token (audit 8, C11).
      const accessToken = this.jwt.sign({ ...payload, typ: ACCESS_TOKEN_TYPE }, {
        expiresIn: accessExpiresIn,
      });
      // A session like any sign-in's, so the refresh token rotates.
      const session = await this.sessions.start(
        { id: result.userId, type: "user" },
        new Date(Date.now() + refreshExpiresIn * 1000),
      );
      const refreshToken = this.jwt.sign(
        { ...payload, typ: REFRESH_TOKEN_TYPE, sid: session.sid, jti: session.jti },
        {
          secret: process.env.JWT_REFRESH_SECRET,
          expiresIn: refreshExpiresIn,
        },
      );

      return {
        tenantId: result.tenantId,
        userId: result.userId,
        email: result.email,
        role: result.role,
        accessToken,
        refreshToken,
        refreshExpiresIn,
        expiresIn: accessExpiresIn,
        tokenType: "Bearer",
      };
    });
  }

  private async acceptWithSlug(
    tx: Prisma.TransactionClient,
    invite: {
      id: string;
      tenantName: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      role: UserRole;
      plan: SubscriptionPlan;
    },
    dto: AcceptInviteDto,
    slug: string,
    ip: string | null = null,
  ): Promise<{ tenantId: string; userId: string; email: string; role: UserRole }> {
    // Owner User — `email` is the invite email so the same person can
    // log in via the regular /auth/login endpoint after the trial ends.
    const ownerFirstName =
      dto.firstName ?? invite.firstName ?? invite.email.split("@")[0];
    const ownerLastName = dto.lastName ?? invite.lastName ?? "";

    // A1.3: route through the shared helper. The helper accepts the
    // outer transaction's `tx` directly (it detects PrismaService vs
    // TransactionClient via duck-typing on `$transaction`), so the
    // tenant+user writes run inside the same outer transaction as the
    // TOCTOU updateMany guard at the end of acceptInvite — atomicity
    // preserved without a nested savepoint.
    const result = await createTenantWithOwner(tx as any, {
      name: invite.tenantName,
      slug,
      email: dto.contactEmail ?? null,
      phone: dto.phone ?? null,
      street: dto.street,
      city: dto.city,
      state: dto.state ?? null,
      postalCode: dto.postalCode,
      country: dto.country,
      timezone: dto.timezone,
      currency: dto.currency,
      language: dto.language,
      plan: invite.plan,
      ownerEmail: invite.email,
      ownerPassword: dto.password,
      ownerFirstName,
      ownerLastName,
      // Invites only ever create the salon owner (CreateInviteDto); an old
      // invite with another role still makes an owner, never a platform admin.
      ownerRole: invite.role === UserRole.admin ? UserRole.admin : UserRole.owner,
      legalAcceptance: { termsVersion: TERMS_VERSION, ip, source: "invite" },
    });

    // Mark the user as email-verified — accepted invite is the proof.
    await tx.user.update({
      where: { id: result.user.id },
      data: { isEmailVerified: true },
    });

    return {
      tenantId: result.tenant.id,
      userId: result.user.id,
      email: result.user.email,
      role: result.user.role as UserRole,
    };
  }

  /** List all invites (SaaS admin). */
  async listInvites(filter?: {
    status?: InviteStatus;
    email?: string;
  }): Promise<InviteView[]> {
    const now = Date.now();

    // A1.1 follow-up (2026-07-17): lazy-expire all pending rows whose
    // window has elapsed in a single round-trip, instead of the N+1
    // update loop we used to have. Both approaches are idempotent;
    // this one scales linearly with the table size only via the
    // subsequent findMany.
    const expired = await this.prisma.tenantInvite.updateMany({
      where: {
        status: InviteStatus.pending,
        expiresAt: { lte: new Date(now) },
      },
      data: { status: InviteStatus.expired },
    });
    if (expired.count > 0) {
      this.logger.debug(
        `Lazy-expired ${expired.count} pending invite(s) past their window`,
      );
    }

    const invites = await this.prisma.tenantInvite.findMany({
      where: {
        status: filter?.status,
        email: filter?.email
          ? { contains: filter.email, mode: "insensitive" }
          : undefined,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return invites.map((i) => this.toView(i, false));
  }

  /** Revoke a pending invite. No-op if already accepted/revoked. */
  async revokeInvite(id: string, actorId: string): Promise<InviteView> {
    const invite = await this.prisma.tenantInvite.findUnique({
      where: { id },
    });
    if (!invite) {
      throw new NotFoundException("Invitación no encontrada");
    }
    if (invite.status !== InviteStatus.pending) {
      throw new BadRequestException(
        `Solo se puede anular una invitación pendiente (esta está ${INVITE_STATUS_ES[invite.status] ?? invite.status}).`,
      );
    }
    const updated = await this.prisma.tenantInvite.update({
      where: { id },
      data: {
        status: InviteStatus.revoked,
        revokedAt: new Date(),
      },
    });
    await this.auditLog.record("tenant.invite.revoke", {
      actorId,
      actorRole: UserRole.saas_owner,
      metadata: { inviteId: id },
    });
    return this.toView(updated, false);
  }

  /**
   * Revoke the old invite and mint a fresh one with the same email +
   * tenantName + plan. Used when the original email bounced or the
   * owner lost the link.
   *
   * Atomic: the revoke + create run in a single `prisma.$transaction`
   * so that if `create` fails (e.g., a database error or a conflict
   * check), the old invite stays valid — the SaaS admin never loses
   * their only working link. Email is sent OUTSIDE the transaction
   * because Resend is best-effort.
   */
  async resendInvite(
    id: string,
    actorId: string,
  ): Promise<InviteView> {
    const newInvite = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.tenantInvite.findUnique({
        where: { id },
      });
      if (!existing) {
        throw new NotFoundException("Invitación no encontrada");
      }
      if (existing.status === InviteStatus.accepted) {
        throw new BadRequestException("Esta invitación ya se aceptó: el salón existe.");
      }
      // Pending or expired: a fresh link (an expired one used to need a
      // new invite by hand, audit 8 T15). A revoked one stays revoked.
      const expired =
        existing.status === InviteStatus.expired ||
        (existing.status === InviteStatus.pending && existing.expiresAt.getTime() <= Date.now());
      if (existing.status !== InviteStatus.pending && !expired) {
        throw new BadRequestException(
          `No se puede reenviar una invitación ${INVITE_STATUS_ES[existing.status] ?? existing.status}.`,
        );
      }

      if (existing.status === InviteStatus.pending) {
        await tx.tenantInvite.update({
          where: { id },
          data: {
            status: InviteStatus.revoked,
            revokedAt: new Date(),
          },
        });
      }

      await this.auditLog.record(
        "tenant.invite.revoke",
        {
          actorId,
          actorRole: UserRole.saas_owner,
          metadata: { inviteId: id, reason: "resend" },
        },
        tx,
      );

      // Reuse the transactional createInvite core so the new row +
      // its audit log are written in the same transaction.
      return this.createInviteInTx(
        tx,
        {
          email: existing.email,
          tenantName: existing.tenantName,
          plan: existing.plan,
          firstName: existing.firstName ?? undefined,
          lastName: existing.lastName ?? undefined,
          role: existing.role,
        },
        actorId,
      );
    });

    const emailSent = await this.sendInviteEmail(newInvite);

    return { ...this.toView(newInvite, true), emailSent };
  }

  // ────────────────────── private helpers

  private mintToken(): string {
    // 32 bytes -> 256 bits of entropy, base64url-encoded (43 chars).
    return randomBytes(32).toString("base64url");
  }

  private buildMagicLink(token: string): string {
    const base = this.config.get<string>("APP_BASE_URL") ||
      this.config.get<string>("FRONTEND_URL");
    if (!base) {
      // Loud and visible — magic links to `localhost` would be dead on
      // arrival in any non-dev environment. Operators should set
      // `APP_BASE_URL` (preferred) or `FRONTEND_URL` in prod.
      this.logger.error(
        "APP_BASE_URL is not set — invite magic links will point to " +
          "http://localhost:3000, which is unreachable in production. " +
          "Set APP_BASE_URL=https://app.kiraroom.net in the environment.",
      );
      return `http://localhost:3000/accept-invite/${token}`;
    }
    return `${base.replace(/\/+$/, "")}/accept-invite/${token}`;
  }

  /** Sends the invite; true only when the email provider accepted it. */
  private async sendInviteEmail(invite: TenantInvite): Promise<boolean> {
    const link = this.buildMagicLink(invite.token);
    try {
      const sent = await this.emailService.sendTenantInvite({
        to: invite.email,
        tenantName: invite.tenantName,
        firstName: invite.firstName,
        inviteLink: link,
        expiresAt: invite.expiresAt,
      });
      if (!sent.success) {
        this.logger.warn(
          `Invite email failed for ${invite.email}: ${sent.error}`,
        );
        return false;
      }
      // Email off in this environment: nothing went out.
      return !(sent as { skipped?: boolean }).skipped;
    } catch (err) {
      // Email failure must NOT block invite creation — the SaaS admin
      // already gets the magicLink in the API response.
      this.logger.error(
        `Invite email threw for ${invite.email}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private toView(invite: TenantInvite, includeMagicLink: boolean): InviteView {
    const view: InviteView = {
      id: invite.id,
      email: invite.email,
      tenantName: invite.tenantName,
      firstName: invite.firstName,
      lastName: invite.lastName,
      role: invite.role,
      plan: invite.plan,
      status: invite.status,
      expiresAt: invite.expiresAt.toISOString(),
      acceptedAt: invite.acceptedAt ? invite.acceptedAt.toISOString() : null,
      createdAt: invite.createdAt.toISOString(),
    };
    if (includeMagicLink) {
      view.magicLink = this.buildMagicLink(invite.token);
      view.token = invite.token;
    }
    return view;
  }
}