/**
 * Tests for EmailService.
 *
 * Sprint 2 / Workstream 2.3 deliverable. Covers the four new
 * transactional templates + their shared gate (`shouldSkipBouncedUser`)
 * + the RFC 8058 `List-Unsubscribe` header auto-derivation.
 *
 * Approach: stub the Resend SDK so we can capture what `sendEmail`
 * calls it with, then assert on the captured payload. The prisma
 * `user.findUnique` is stubbed for the bounce-skip path.
 *
 * The pre-existing appointment / confirmation / rebooking templates
 * use `TranslationsService` for i18n and aren't exercised here —
 * they're orthogonal to the Sprint 2 transactional surface and have
 * their own assumptions about the translations schema. The 5 templates
 * tested below are the customer-facing ones whose behaviour we just
 * changed.
 */

import { EmailService } from "./email.service";

// ────────────────────── mock helpers

function makePrismaMock() {
  const users = new Map<string, any>();
  return {
    users,
    prisma: {
      user: {
        findUnique: async (args: any) => {
          const email = (args.where.email as string).toLowerCase();
          const row = users.get(email);
          if (!row) return null;
          if (args.select) {
            const out: any = {};
            for (const k of Object.keys(args.select)) out[k] = row[k];
            return out;
          }
          return row;
        },
      },
    } as any,
  };
}

function makeConfigMock(env: Record<string, string | undefined> = {}) {
  return {
    get: (key: string) => env[key],
  } as any;
}

function makeTranslationsMock() {
  // The new transactional templates don't use TranslationsService
    // (they hard-code Spanish copy). A no-op stub is enough.
  return {
    translate: () => "translated",
  } as any;
}

function makeResendMock() {
  const calls: any[] = [];
  const resend = {
    emails: {
      send: async (payload: any) => {
        calls.push(payload);
        return { data: { id: `resend-${calls.length}` }, error: null };
      },
    },
    batch: {
      send: async () => ({ data: { data: [] }, error: null }),
    },
  };
  return { resend, calls };
}

function makeService(opts?: {
  env?: Record<string, string | undefined>;
  resendCalls?: any[];
  resendError?: { message: string } | null;
}) {
  const env = {
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM: "KiraStudio <hola@kirastudio.com>",
    APP_BASE_URL: "https://app.kirastudio.com",
    ...opts?.env,
  };
  const config = makeConfigMock(env);
  const translations = makeTranslationsMock();
  const prismaMock = makePrismaMock();
  const service = new EmailService(config, translations, prismaMock.prisma);
  const { resend, calls } = makeResendMock();
  if (opts?.resendError) {
    const origSend = resend.emails.send;
    resend.emails.send = async (payload: any) => {
      calls.push(payload);
      return { data: null, error: opts.resendError };
    };
  }
  (service as any).resend = resend;
  return { service, calls, prismaMock, config, resend };
}

// ────────────────────── tests

describe("EmailService.shouldSkipBouncedUser", () => {
  it("returns true when the recipient User has emailBouncedAt set", async () => {
    const m = makePrismaMock();
    m.users.set("bounced@example.com", {
      email: "bounced@example.com",
      emailBouncedAt: new Date("2026-06-01T10:00:00Z"),
    });
    const { service } = makeService();
    // Inject the prisma mock into the service via the same prismaMock
    // (EmailService holds a reference at construction time).
    (service as any).prisma = m.prisma;
    expect(
      await (service as any).shouldSkipBouncedUser("bounced@example.com"),
    ).toBe(true);
  });

  it("returns false when the recipient User exists with no bounce", async () => {
    const m = makePrismaMock();
    m.users.set("clean@example.com", {
      email: "clean@example.com",
      emailBouncedAt: null,
    });
    const { service } = makeService();
    (service as any).prisma = m.prisma;
    expect(
      await (service as any).shouldSkipBouncedUser("clean@example.com"),
    ).toBe(false);
  });

  it("returns false when the recipient is not a User (fail open)", async () => {
    const { service } = makeService();
    expect(
      await (service as any).shouldSkipBouncedUser("nobody@example.com"),
    ).toBe(false);
  });

  it("normalises the lookup email to lowercase", async () => {
    const m = makePrismaMock();
    let queriedWith: string | undefined;
    m.prisma.user.findUnique = async (args: any) => {
      queriedWith = args.where.email;
      return null;
    };
    const { service } = makeService();
    (service as any).prisma = m.prisma;
    await (service as any).shouldSkipBouncedUser("MIXED@Example.COM");
    expect(queriedWith).toBe("mixed@example.com");
  });

  it("fails open (returns false) when the lookup itself errors", async () => {
    const { service } = makeService();
    (service as any).prisma = {
      user: {
        findUnique: async () => {
          throw new Error("DB unavailable");
        },
      },
    };
    expect(
      await (service as any).shouldSkipBouncedUser("x@y.com"),
    ).toBe(false);
  });
});

describe("EmailService.sendTenantInvite (Sprint 2.1)", () => {
  it("sends a Spanish HTML email with the magic link and 7-day TTL hint", async () => {
    const { service, calls } = makeService();
    const sent = await service.sendTenantInvite({
      to: "owner@glamour.com",
      tenantName: "Glamour Studio",
      firstName: "María",
      inviteLink: "https://app.kirastudio.com/accept-invite/abc",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    expect(sent.success).toBe(true);
    expect(sent.id).toBe("resend-1");
    expect(calls).toHaveLength(1);
    const payload = calls[0];
    expect(payload.from).toContain("hola@kirastudio.com");
    expect(payload.to).toEqual(["owner@glamour.com"]);
    expect(payload.subject).toMatch(/KiraStudio/);
    expect(payload.html).toContain("Glamour Studio");
    expect(payload.html).toContain("https://app.kirastudio.com/accept-invite/abc");
    // RFC 8058: List-Unsubscribe auto-attached for transactional templates.
    expect(payload.headers).toBeDefined();
    expect(payload.headers["List-Unsubscribe"]).toContain("mailto:unsubscribe@kirastudio.com");
    expect(payload.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Plain-text fallback exists.
    expect(payload.text).toContain("Glamour Studio");
    expect(payload.text).toContain("https://app.kirastudio.com/accept-invite/abc");
  });

  it("escapes HTML in the tenant name (anti-XSS)", async () => {
    const { service, calls } = makeService();
    await service.sendTenantInvite({
      to: "x@y.com",
      tenantName: "<script>alert(1)</script>",
      firstName: null,
      inviteLink: "https://app.kirastudio.com/accept-invite/abc",
      expiresAt: new Date(),
    });
    expect(calls[0].html).not.toContain("<script>alert(1)</script>");
    expect(calls[0].html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("skips the send when the recipient has bounced", async () => {
    const m = makePrismaMock();
    m.users.set("bounced@example.com", {
      email: "bounced@example.com",
      emailBouncedAt: new Date(),
    });
    const { service, calls } = makeService();
    (service as any).prisma = m.prisma;
    const sent = await service.sendTenantInvite({
      to: "bounced@example.com",
      tenantName: "Studio",
      firstName: null,
      inviteLink: "https://app.kirastudio.com/accept-invite/x",
      expiresAt: new Date(),
    });
    expect(sent.success).toBe(false);
    expect(sent.skipped).toBe(true);
    expect(sent.error).toBe("email_bounced");
    expect(calls).toHaveLength(0);
  });
});

describe("EmailService.sendTrialExpiry (Sprint 2.3 — T-3 / T-1)", () => {
  it("renders T-3 copy when daysLeft is 3", async () => {
    const { service, calls } = makeService();
    await service.sendTrialExpiry({
      to: "owner@salon.com",
      tenantName: "Salón Demo",
      daysLeft: 3,
      trialEnd: new Date("2026-08-01T12:00:00Z"),
      upgradeUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(calls[0].subject).toMatch(/3 días/);
    expect(calls[0].html).toMatch(/3 días/);
    expect(calls[0].html).not.toMatch(/Mañana/);
    expect(calls[0].text).toMatch(/en 3 días/);
  });

  it("renders T-1 copy when daysLeft is 1", async () => {
    const { service, calls } = makeService();
    await service.sendTrialExpiry({
      to: "owner@salon.com",
      tenantName: "Salón Demo",
      daysLeft: 1,
      trialEnd: new Date("2026-07-19T12:00:00Z"),
      upgradeUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(calls[0].subject).toMatch(/Mañana/);
    expect(calls[0].html).toMatch(/Mañana/);
    expect(calls[0].html).toMatch(/modo lectura/);
  });

  it("attaches List-Unsubscribe header", async () => {
    const { service, calls } = makeService();
    await service.sendTrialExpiry({
      to: "owner@salon.com",
      tenantName: "Salón",
      daysLeft: 3,
      trialEnd: new Date(),
      upgradeUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(calls[0].headers["List-Unsubscribe"]).toBeDefined();
    expect(calls[0].headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
  });

  it("skips when the recipient has bounced", async () => {
    const m = makePrismaMock();
    m.users.set("b@x.com", { email: "b@x.com", emailBouncedAt: new Date() });
    const { service, calls } = makeService();
    (service as any).prisma = m.prisma;
    const sent = await service.sendTrialExpiry({
      to: "b@x.com",
      tenantName: "X",
      daysLeft: 3,
      trialEnd: new Date(),
      upgradeUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(sent.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("EmailService.sendPaymentFailed (Sprint 2.3)", () => {
  it("formats the amount in the tenant's currency (EUR)", async () => {
    const { service, calls } = makeService();
    await service.sendPaymentFailed({
      to: "owner@salon.com",
      tenantName: "Salón",
      amount: 29,
      currency: "EUR",
      retryDate: new Date("2026-07-20T00:00:00Z"),
      updatePaymentUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(calls[0].html).toMatch(/29,00\s*€|29,00 €/);
    expect(calls[0].text).toMatch(/29,00\s*€|29,00 €/);
  });

  it("renders the Stripe retry date when provided", async () => {
    const { service, calls } = makeService();
    await service.sendPaymentFailed({
      to: "owner@salon.com",
      tenantName: "Salón",
      amount: 59,
      currency: "EUR",
      retryDate: new Date("2026-07-22T00:00:00Z"),
      updatePaymentUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(calls[0].html).toMatch(/22 de julio/);
  });

  it("omits retry copy when retryDate is undefined", async () => {
    const { service, calls } = makeService();
    await service.sendPaymentFailed({
      to: "owner@salon.com",
      tenantName: "Salón",
      amount: 29,
      currency: "EUR",
      updatePaymentUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(calls[0].html).not.toMatch(/volverá a intentarlo automáticamente/);
  });

  it("skips when the recipient has bounced", async () => {
    const m = makePrismaMock();
    m.users.set("b@x.com", { email: "b@x.com", emailBouncedAt: new Date() });
    const { service, calls } = makeService();
    (service as any).prisma = m.prisma;
    const sent = await service.sendPaymentFailed({
      to: "b@x.com",
      tenantName: "X",
      amount: 29,
      currency: "EUR",
      updatePaymentUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(sent.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("EmailService.sendAccountSuspended (Sprint 2.2)", () => {
  it("renders the grace-period date in the body and subject", async () => {
    const { service, calls } = makeService();
    await service.sendAccountSuspended({
      to: "owner@salon.com",
      tenantName: "Salón",
      gracePeriodEndsAt: new Date("2026-07-17T00:00:00Z"),
      updatePaymentUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(calls[0].subject).toMatch(/suspendido/);
    expect(calls[0].html).toMatch(/17 de julio/);
    expect(calls[0].html).toMatch(/modo lectura/);
  });

  it("attaches List-Unsubscribe header", async () => {
    const { service, calls } = makeService();
    await service.sendAccountSuspended({
      to: "owner@salon.com",
      tenantName: "Salón",
      gracePeriodEndsAt: new Date(),
      updatePaymentUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(calls[0].headers["List-Unsubscribe"]).toBeDefined();
  });

  it("skips when the recipient has bounced", async () => {
    const m = makePrismaMock();
    m.users.set("b@x.com", { email: "b@x.com", emailBouncedAt: new Date() });
    const { service, calls } = makeService();
    (service as any).prisma = m.prisma;
    const sent = await service.sendAccountSuspended({
      to: "b@x.com",
      tenantName: "X",
      gracePeriodEndsAt: new Date(),
      updatePaymentUrl: "https://app.kirastudio.com/dashboard/billing",
    });
    expect(sent.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("EmailService.sendBugReportAck (Sprint 2.3)", () => {
  it("renders the 8-char tracking id in both subject and body", async () => {
    const { service, calls } = makeService();
    const reportId = "abc12345-6789-0def-1234-567890abcdef";
    await service.sendBugReportAck({
      to: "user@example.com",
      reportId,
      subject: "Save button does nothing",
    });
    const shortId = reportId.slice(0, 8);
    expect(calls[0].subject).toContain(shortId);
    expect(calls[0].html).toContain(shortId);
    expect(calls[0].text).toContain(shortId);
    expect(calls[0].html).toContain("Save button does nothing");
  });

  it("attaches List-Unsubscribe header", async () => {
    const { service, calls } = makeService();
    await service.sendBugReportAck({
      to: "user@example.com",
      reportId: "abc12345-6789",
      subject: "X",
    });
    expect(calls[0].headers["List-Unsubscribe"]).toBeDefined();
  });

  it("skips when the recipient has bounced", async () => {
    const m = makePrismaMock();
    m.users.set("b@x.com", { email: "b@x.com", emailBouncedAt: new Date() });
    const { service, calls } = makeService();
    (service as any).prisma = m.prisma;
    const sent = await service.sendBugReportAck({
      to: "b@x.com",
      reportId: "abc12345",
      subject: "X",
    });
    expect(sent.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("EmailService.buildHeaders (RFC 8058 List-Unsubscribe)", () => {
  // We exercise buildHeaders via the observable side-effect on the
  // captured payload in `sendEmail`. White-box coverage (private method)
  // isn't strictly necessary — the public contract is the rendered
  // headers.

  it("auto-attaches List-Unsubscribe when listUnsubscribe: true is passed", async () => {
    const { service, calls } = makeService();
    await service.sendEmail({
      to: "x@y.com",
      subject: "X",
      html: "<p>X</p>",
      listUnsubscribe: true,
    });
    expect(calls[0].headers["List-Unsubscribe"]).toContain(
      "mailto:unsubscribe@kirastudio.com",
    );
    expect(calls[0].headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
  });

  it("does NOT attach List-Unsubscribe when listUnsubscribe: false (default)", async () => {
    const { service, calls } = makeService();
    await service.sendEmail({
      to: "x@y.com",
      subject: "X",
      html: "<p>X</p>",
    });
    // Headers object should be undefined or empty.
    expect(
      calls[0].headers === undefined ||
        !calls[0].headers["List-Unsubscribe"],
    ).toBe(true);
  });

  it("derives the unsubscribe mailto domain from EMAIL_FROM", async () => {
    const { service, calls } = makeService({
      env: { EMAIL_FROM: "ops@mi-dominio.es" },
    });
    await service.sendEmail({
      to: "x@y.com",
      subject: "X",
      html: "<p>X</p>",
      listUnsubscribe: true,
    });
    expect(calls[0].headers["List-Unsubscribe"]).toContain(
      "mailto:unsubscribe@mi-dominio.es",
    );
  });

  it("uses APP_BASE_URL for the https:// unsubscribe link", async () => {
    const { service, calls } = makeService({
      env: {
        APP_BASE_URL: "https://staging.kirastudio.com/",
      },
    });
    await service.sendEmail({
      to: "x@y.com",
      subject: "X",
      html: "<p>X</p>",
      listUnsubscribe: true,
    });
    // Trailing slash is trimmed.
    expect(calls[0].headers["List-Unsubscribe"]).toContain(
      "https://staging.kirastudio.com/dashboard/settings/notifications",
    );
  });

  it("passes through caller-supplied headers verbatim and merges with auto-added List-Unsubscribe", async () => {
    const { service, calls } = makeService();
    await service.sendEmail({
      to: "x@y.com",
      subject: "X",
      html: "<p>X</p>",
      listUnsubscribe: true,
      headers: { "X-Custom": "yes" },
    });
    expect(calls[0].headers["X-Custom"]).toBe("yes");
    expect(calls[0].headers["List-Unsubscribe"]).toBeDefined();
  });
});

describe("EmailService.sendEmail (low-level)", () => {
  it("returns success: false when Resend is not configured", async () => {
    const { service, calls } = makeService({ env: { RESEND_API_KEY: "" } });
    // The constructor will have logged a warn and left resend = null.
    (service as any).resend = null;
    const sent = await service.sendEmail({
      to: "x@y.com",
      subject: "X",
      html: "<p>X</p>",
    });
    expect(sent.success).toBe(false);
    expect(sent.error).toMatch(/not configured/);
    expect(calls).toHaveLength(0);
  });

  it("returns success: false with the Resend error message on provider failure", async () => {
    const { service, calls } = makeService({
      resendError: { message: "rate_limited" },
    });
    const sent = await service.sendEmail({
      to: "x@y.com",
      subject: "X",
      html: "<p>X</p>",
    });
    expect(sent.success).toBe(false);
    expect(sent.error).toBe("rate_limited");
    expect(calls).toHaveLength(1);
  });

  it("normalises the `to` field to an array before calling Resend", async () => {
    const { service, calls } = makeService();
    await service.sendEmail({
      to: "single@example.com",
      subject: "X",
      html: "<p>X</p>",
    });
    expect(calls[0].to).toEqual(["single@example.com"]);
  });

  it("forwards an array `to` unchanged", async () => {
    const { service, calls } = makeService();
    await service.sendEmail({
      to: ["a@example.com", "b@example.com"],
      subject: "X",
      html: "<p>X</p>",
    });
    expect(calls[0].to).toEqual(["a@example.com", "b@example.com"]);
  });
});

describe("EmailService.escapeHtml (anti-XSS)", () => {
  // Cover the edge cases that aren't exercised by the templates.
  it("escapes ampersands, angle brackets, and quotes", () => {
    const svc = new EmailService(
      makeConfigMock({}),
      makeTranslationsMock(),
      makePrismaMock().prisma,
    );
    const escaped = (svc as any).escapeHtml(
      `<a href="x">'y' & "z"</a>`,
    );
    expect(escaped).toBe("&lt;a href=&quot;x&quot;&gt;&#39;y&#39; &amp; &quot;z&quot;&lt;/a&gt;");
  });

  it("returns plain text unchanged", () => {
    const svc = new EmailService(
      makeConfigMock({}),
      makeTranslationsMock(),
      makePrismaMock().prisma,
    );
    const escaped = (svc as any).escapeHtml("hello world");
    expect(escaped).toBe("hello world");
  });
});