import { UserRole } from "@prisma/client";
import { tenantStorage } from "../common/tenancy/tenant.context";
import { attributeToSupport } from "./audit-log.service";
import { scrubAuditMetadata, AUDIT_ANON } from "./gdpr/audit-log-scrub";
import { changedFields } from "./saas.service";
import { auditLogWhere } from "./audit/audit-log-admin.controller";
import {
  isAccessTokenPayload,
  isRefreshTokenPayload,
  supportClaims,
  supportReasonProblem,
} from "../auth/session-token";
import { supportCookieKind, setRefreshCookie, SUPPORT_REFRESH_COOKIE_PREFIX } from "../auth/sessions/refresh-cookie";

/** Audit 8 (console access): the pure pieces of C4, C9, C11, C15, C17, C10. */

describe("C4: audit rows written in a support session", () => {
  const inRequest = <T>(actor: any, fn: () => T): T => tenantStorage.run({ tenantId: "t1", bypass: false, actor }, fn);

  it("name the platform owner as the actor, on behalf of the salon user", () => {
    const out = inRequest({ userId: "owner-1", role: "owner", impersonatedBy: "saas-1", impersonationId: "imp-1" }, () =>
      attributeToSupport({ actorId: "owner-1", actorRole: UserRole.owner, metadata: { clientId: "c1" } }),
    );
    expect(out.actorId).toBe("saas-1");
    expect(out.actorRole).toBe("saas_owner");
    expect(out.metadata).toEqual({
      clientId: "c1",
      impersonatedBy: "saas-1",
      impersonationId: "imp-1",
      onBehalfOf: { userId: "owner-1", role: "owner" },
    });
  });

  it("leave a normal session's rows as they are", () => {
    const out = inRequest({ userId: "owner-1", role: "owner" }, () =>
      attributeToSupport({ actorId: "owner-1", actorRole: UserRole.owner, metadata: { a: 1 } }),
    );
    expect(out).toEqual({ actorId: "owner-1", actorRole: "owner", metadata: { a: 1 } });
  });

  it("outside a request nothing changes", () => {
    expect(attributeToSupport({ actorId: "u", actorRole: UserRole.admin })).toEqual({
      actorId: "u",
      actorRole: "admin",
      metadata: {},
    });
  });
});

describe("C11: only the right token type is a session", () => {
  it("an access token needs typ access and no purpose", () => {
    expect(isAccessTokenPayload({ sub: "u", typ: "access" })).toBe(true);
    expect(isAccessTokenPayload({ sub: "u" })).toBe(false);
    expect(isAccessTokenPayload({ sub: "u", typ: "access", purpose: "2fa-login" })).toBe(false);
    expect(isAccessTokenPayload({ sub: "u", purpose: "2fa-login", aud: "kira-2fa-login" })).toBe(false);
    expect(isAccessTokenPayload({ sub: "u", aud: "impersonation", impersonate: { tenantId: "t" } })).toBe(false);
    expect(isAccessTokenPayload({ sub: "u", typ: "refresh" })).toBe(false);
  });

  it("a refresh token is typ refresh, or untyped from before", () => {
    expect(isRefreshTokenPayload({ sub: "u", typ: "refresh" })).toBe(true);
    expect(isRefreshTokenPayload({ sub: "u" })).toBe(true);
    expect(isRefreshTokenPayload({ sub: "u", typ: "access" })).toBe(false);
    expect(isRefreshTokenPayload({ sub: "u", purpose: "reset" })).toBe(false);
  });

  it("support claims are complete or nothing (a pre-cap support token has no end)", () => {
    expect(supportClaims({ impersonatedBy: "s", impersonationId: "i", impersonatedTenantId: "t" })).toBeNull();
    expect(
      supportClaims({ impersonatedBy: "s", impersonationId: "i", impersonatedTenantId: "t", impersonationEndsAt: 1, impersonatorTv: 0 }),
    ).toMatchObject({ impersonatedBy: "s", impersonationEndsAt: 1 });
  });
});

describe("C17: the support reason", () => {
  it("is required and capped", () => {
    expect(supportReasonProblem(undefined)).toMatch(/motivo/);
    expect(supportReasonProblem("   ab  ")).toMatch(/mínimo/);
    expect(supportReasonProblem("x".repeat(201))).toMatch(/200/);
    expect(supportReasonProblem("Ayuda con la agenda")).toBeNull();
  });
});

describe("C10: a support session has its own cookie per salon", () => {
  it("is not kr_session", () => {
    const res: any = { cookie: jest.fn() };
    setRefreshCookie(res, supportCookieKind("6f1c0a6e-1111-4222-8333-944455556666"), "tok", 60);
    expect(res.cookie.mock.calls[0][0]).toBe(`${SUPPORT_REFRESH_COOKIE_PREFIX}6f1c0a6e-1111-4222-8333-944455556666`);
  });
});

describe("C9: what a console edit records", () => {
  it("only the fields that change, before and after, dates as text", () => {
    const before = { plan: "esencial", name: "A", trialEnd: new Date("2026-11-01T00:00:00Z"), taxId: null };
    expect(
      changedFields(before, { plan: "pro", name: "A", trialEnd: new Date("2026-12-01T00:00:00Z"), taxId: undefined }),
    ).toEqual({
      plan: { before: "esencial", after: "pro" },
      trialEnd: { before: "2026-11-01T00:00:00.000Z", after: "2026-12-01T00:00:00.000Z" },
    });
  });

  it("the audit-log page filters by salon, actor, action and dates", () => {
    expect(auditLogWhere({})).toEqual({});
    const w: any = auditLogWhere({ tenantId: "t1", actor: "ana", action: "tenant.", from: "2026-11-01", to: "2026-11-03" });
    expect(w.AND).toEqual(
      expect.arrayContaining([
        { tenantId: "t1" },
        { action: { startsWith: "tenant." } },
        { createdAt: { gte: new Date("2026-11-01T00:00:00.000Z"), lte: new Date("2026-11-03T23:59:59.999Z") } },
      ]),
    );
    expect(JSON.stringify(w)).toContain("ana");
    expect((auditLogWhere({ action: "tenant.update" }) as any).AND).toEqual([{ action: "tenant.update" }]);
  });
});

describe("C15: anonymising a salon scrubs its audit rows", () => {
  it("emails, names and changed personal fields go; ids and the action's facts stay", () => {
    expect(
      scrubAuditMetadata("saas.impersonate", {
        reason: "Ayuda con la agenda",
        targetOwnerId: "o1",
        targetOwnerEmail: "ana@salon.test",
        impersonationId: "i1",
      }),
    ).toEqual({ reason: "Ayuda con la agenda", targetOwnerId: "o1", targetOwnerEmail: AUDIT_ANON, impersonationId: "i1" });
    expect(
      scrubAuditMetadata("tenant.update", {
        changes: { plan: { before: "esencial", after: "pro" }, email: { before: "a@b.test", after: "c@d.test" } },
      }),
    ).toEqual({ changes: { plan: { before: "esencial", after: "pro" }, email: AUDIT_ANON } });
    expect(scrubAuditMetadata("invoice.emailed", { to: "x@y.test", invoiceId: "inv" })).toEqual({ to: AUDIT_ANON, invoiceId: "inv" });
  });

  it("the NIF change keeps the row and loses the NIFs, unless the fiscal data is kept", () => {
    expect(scrubAuditMetadata("tenant.taxId.change", { before: "B1", after: "B2", source: "x" })).toEqual({
      before: AUDIT_ANON,
      after: AUDIT_ANON,
      source: "x",
    });
    expect(scrubAuditMetadata("tenant.taxId.change", { before: "B1", after: "B2" }, { keepFiscalData: true })).toEqual({
      before: "B1",
      after: "B2",
    });
  });
});
