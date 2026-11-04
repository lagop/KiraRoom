import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { BadRequestException, HttpException, UnauthorizedException } from "@nestjs/common";
import { AuthController, DISPOSABLE_EMAIL_MESSAGE, TOO_MANY_SIGNUPS_MESSAGE } from "./auth.controller";
import { AuthService, hashVerificationToken } from "./auth.service";
import { PasswordResetService } from "./password-reset.service";
import { bodyParser } from "../common/validation/validated-body.testing";
import { TERMS_LAST_UPDATED_LABEL, TERMS_VERSION } from "./legal-terms";
import { DISPOSABLE_EMAIL_DOMAINS, isDisposableEmail } from "./abuse/disposable-email-domains";
import { AUTH_LIMITS, AuthRateLimitsService } from "./abuse/auth-rate-limits.service";
import { CAPTCHA_MESSAGE, CAPTCHA_REQUIRED_CODE, TurnstileService } from "./abuse/turnstile.service";
import { noLimits, noTurnstile } from "./abuse/abuse-checks.testing";
import { RedisService } from "../common/cache/redis.service";
import { availableTenantSlug, withoutPlatformWords } from "../saas/saas.helpers";
import { EmailService } from "../notifications/services/email.service";
import { CreateInviteDto } from "../saas/invites/dto/create-invite.dto";
import { AcceptInviteDto } from "../saas/invites/dto/accept-invite.dto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

/**
 * Audit 7A (signup and account access): what a new salon's owner meets on
 * /signup, /login, /forgot-password and the confirmation link.
 */

/** A RedisService on its in-memory fallback: no Redis needed. */
function memoryRedis(): RedisService {
  const r = new RedisService({ get: () => undefined } as any);
  (r as any).usingFallback = true;
  return r;
}

const form = {
  email: "  Duena@Salon-Ficticio.TEST ",
  password: "contraseña-de-prueba",
  salonName: "Peluquería Lucía",
  phone: "+34 600 000 000",
  ownerName: "Ana Prueba",
  acceptTerms: true,
};

describe("signup form validation (S3, S5, S7, S16)", () => {
  const parse = bodyParser(AuthController, "register");

  it("normalises the email and accepts a complete form", async () => {
    const dto = await parse({ ...form });
    expect(dto.email).toBe("duena@salon-ficticio.test");
  });

  it("refuses the form without accepting the terms, in Spanish", async () => {
    for (const acceptTerms of [false, undefined, "true"]) {
      await expect(parse({ ...form, acceptTerms })).rejects.toMatchObject({
        response: { message: expect.arrayContaining(["Tienes que aceptar los términos para crear la cuenta."]) },
      });
    }
  });

  it("refuses empty names and phone, and an endless salon name", async () => {
    const err = await parse({ ...form, salonName: "", ownerName: "", phone: "" }).catch((e) => e);
    expect(err.response.message).toEqual(
      expect.arrayContaining(["Escribe el nombre del salón.", "Escribe tu nombre.", "Escribe un teléfono de contacto."]),
    );
    const long = await parse({ ...form, salonName: "x".repeat(100_000) }).catch((e) => e);
    expect(long.response.message.join(" ")).toMatch(/máximo 80/);
  });

  it("says what is wrong with the email and the password in Spanish", async () => {
    const err = await parse({ ...form, email: "a@b", password: "corta" }).catch((e) => e);
    expect(err.response.message).toEqual(
      expect.arrayContaining(["Escribe un email válido.", "La contraseña debe tener al menos 8 caracteres."]),
    );
  });

  it("only takes a language the panel has", async () => {
    await expect(parse({ ...form, language: "en" })).resolves.toMatchObject({ language: "en" });
    await expect(parse({ ...form, language: "fr" })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("login and forgot-password normalise the email (S4)", () => {
  it("login", async () => {
    const dto = await bodyParser(AuthController, "login")({ email: " Ana@Gmail.COM", password: "una-clave-1" });
    expect(dto.email).toBe("ana@gmail.com");
  });

  it("forgot-password", async () => {
    const dto = await bodyParser(AuthController, "forgotPassword")({ email: "Ana@Gmail.com " });
    expect(dto.email).toBe("ana@gmail.com");
  });

  it("console invite", async () => {
    const dto = plainToInstance(CreateInviteDto, { email: " Ana@X.test", tenantName: "Ana", plan: "esencial" });
    expect(dto.email).toBe("ana@x.test");
  });
});

describe("console invites can only create the salon owner (S13)", () => {
  async function errors(body: object) {
    return validate(plainToInstance(CreateInviteDto, { email: "a@x.test", tenantName: "Ana", plan: "esencial", ...body }));
  }
  it("accepts owner or no role", async () => {
    expect(await errors({})).toHaveLength(0);
    expect(await errors({ role: "owner" })).toHaveLength(0);
  });
  it("refuses saas_owner, admin, staff and client", async () => {
    for (const role of ["saas_owner", "admin", "staff", "client"]) {
      expect((await errors({ role })).length).toBeGreaterThan(0);
    }
  });
});

describe("invite acceptance needs the terms (S3)", () => {
  const body = {
    password: "una-clave-larga",
    street: "Calle Mayor 1",
    city: "Madrid",
    postalCode: "28013",
    country: "ES",
    timezone: "Europe/Madrid",
  };
  it("refuses without acceptTerms: true", async () => {
    const errs = await validate(plainToInstance(AcceptInviteDto, body));
    expect(errs.map((e) => e.property)).toContain("acceptTerms");
    expect(await validate(plainToInstance(AcceptInviteDto, { ...body, acceptTerms: true }))).toHaveLength(0);
  });
});

describe("the terms version matches the terms page (S3)", () => {
  it("TERMS_VERSION is the page's 'Última actualización'", () => {
    const page = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "frontend", "app", "legal", "terms", "page.tsx"),
      "utf8",
    );
    expect(page).toContain(`Última actualización: ${TERMS_LAST_UPDATED_LABEL}`);
    const months = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    const [d, , m, , y] = TERMS_LAST_UPDATED_LABEL.split(" ");
    const iso = `${y}-${String(months.indexOf(m) + 1).padStart(2, "0")}-${d.padStart(2, "0")}`;
    expect(TERMS_VERSION).toBe(iso);
  });
});

function signupAuth() {
  const created: { tenant?: any; user?: any; legal?: any } = {};
  const prisma: any = {
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        created.user = data;
        return { id: "u1", email: data.email, role: data.role };
      }),
      update: jest.fn(async () => ({})),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        created.tenant = data;
        return { id: "t1" };
      }),
    },
    legalAcceptance: {
      create: jest.fn(async ({ data }: any) => {
        created.legal = data;
        return data;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const email = {
    sendWelcome: jest.fn().mockResolvedValue({ success: true }),
    sendEmailVerification: jest.fn().mockResolvedValue({ success: true }),
  };
  const auth = new AuthService(
    prisma,
    { sign: jest.fn().mockReturnValue("signed-jwt"), verify: jest.fn() } as any,
    { record: jest.fn() } as any,
    { record: jest.fn(), recordOnce: jest.fn().mockResolvedValue(undefined) } as any,
    email as any,
    { start: jest.fn(async () => ({ sid: "sid-1", jti: "jti-1" })), rotate: jest.fn() } as any,
    {} as any,
  );
  return { auth, prisma, created, email };
}

describe("AuthService.register keeps what the form asked for (S3, S4, S6)", () => {
  it("stores the email lower-cased, the phone on the salon and the language", async () => {
    const { auth, created } = signupAuth();
    await auth.register({ ...form, email: "duena@salon-ficticio.test", language: "en" } as any, { ip: "198.51.100.4" });
    expect(created.user).toMatchObject({ email: "duena@salon-ficticio.test", language: "en" });
    expect(created.tenant).toMatchObject({ phone: "+34 600 000 000", language: "en" });
  });

  it("records the terms acceptance: version, owner, IP and when", async () => {
    const { auth, created } = signupAuth();
    await auth.register({ ...form, email: "duena@salon-ficticio.test" } as any, { ip: "198.51.100.4" });
    expect(created.legal).toMatchObject({
      tenantId: "t1",
      acceptedByUserId: "u1",
      termsVersion: TERMS_VERSION,
      ip: "198.51.100.4",
      source: "signup",
    });
    expect(created.legal.acceptedAt).toBeInstanceOf(Date);
  });

  it("an address already used, in other capitals, is a clear Spanish 409 (S11)", async () => {
    const { auth, prisma } = signupAuth();
    prisma.user.findFirst.mockResolvedValue({ id: "other" });
    const err = await auth.register({ ...form, email: "ana@x.test" } as any).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" });
    expect(err.message).toMatch(/otro salón/);
    expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ email: { equals: "ana@x.test", mode: "insensitive" } });
  });

  it("stores only the sha256 of the confirmation link's token (S14)", async () => {
    const { auth, prisma, email } = signupAuth();
    await auth.register({ ...form, email: "duena@salon-ficticio.test" } as any);
    await new Promise((r) => setImmediate(r));
    const url = email.sendWelcome.mock.calls[0][0].verifyUrl as string;
    const token = new URL(url).searchParams.get("token")!;
    const stored = prisma.user.update.mock.calls[0][0].data.emailVerificationToken;
    expect(stored).toBe(hashVerificationToken(token));
    expect(stored).not.toBe(token);
  });
});

describe("email confirmation (S1, S14)", () => {
  it("finds the link by its hash, and still by the plain token for links sent before the change", async () => {
    const { auth, prisma } = signupAuth();
    prisma.user.findFirst.mockResolvedValue({ id: "u1" });
    const token = "a".repeat(64);
    await expect(auth.verifyEmail(token)).resolves.toBe(true);
    expect(prisma.user.findFirst.mock.calls[0][0].where.emailVerificationToken).toEqual({
      in: [hashVerificationToken(token), token],
    });
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ isEmailVerified: true, emailVerificationToken: null });
  });

  it("resend: a new hashed link by email to an unconfirmed owner", async () => {
    const { auth, prisma, email } = signupAuth();
    prisma.user.findUnique.mockResolvedValue({
      id: "u1",
      email: "ana@x.test",
      firstName: "Ana",
      isEmailVerified: false,
      isActive: true,
      tenant: { name: "Salón Ana" },
    });
    await expect(auth.resendVerificationEmail("u1")).resolves.toEqual({ sent: true, alreadyVerified: false });
    const sent = email.sendEmailVerification.mock.calls[0][0];
    expect(sent).toMatchObject({ to: "ana@x.test", tenantName: "Salón Ana" });
    const token = new URL(sent.verifyUrl).searchParams.get("token")!;
    expect(prisma.user.update.mock.calls[0][0].data.emailVerificationToken).toBe(hashVerificationToken(token));
  });

  it("resend: nothing for an address already confirmed", async () => {
    const { auth, prisma, email } = signupAuth();
    prisma.user.findUnique.mockResolvedValue({ id: "u1", email: "a@x.test", isEmailVerified: true, isActive: true, tenant: null });
    await expect(auth.resendVerificationEmail("u1")).resolves.toEqual({ sent: false, alreadyVerified: true });
    expect(email.sendEmailVerification).not.toHaveBeenCalled();
  });
});

describe("POST /auth/resend-verification", () => {
  function ctl(limits = noLimits()) {
    const authService: any = {
      emailVerificationStatus: jest.fn(async () => ({ verified: false, email: "a@x.test" })),
      resendVerificationEmail: jest.fn(async () => ({ sent: true, alreadyVerified: false })),
    };
    return { c: new AuthController(authService, {} as any, {} as any, noTurnstile(), limits), authService };
  }

  it("sends while under the hourly limit", async () => {
    const { c, authService } = ctl();
    await expect(c.resendVerification({ id: "u1", role: "owner" })).resolves.toEqual({ sent: true, alreadyVerified: false });
    expect(authService.resendVerificationEmail).toHaveBeenCalledWith("u1");
  });

  it("answers 429 in Spanish over 3 an hour (counted per account in Redis)", async () => {
    const limits = new AuthRateLimitsService(memoryRedis());
    const { c, authService } = ctl(limits);
    for (let i = 0; i < AUTH_LIMITS.verificationResendsPerUserPerHour; i++) {
      await c.resendVerification({ id: "u1", role: "owner" });
    }
    const err = await c.resendVerification({ id: "u1", role: "owner" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    expect(err.message).toMatch(/última hora/);
    expect(authService.resendVerificationEmail).toHaveBeenCalledTimes(3);
  });

  it("is not for a support session", async () => {
    const { c } = ctl();
    await expect(c.resendVerification({ id: "u1", role: "owner", impersonatedBy: "s1" })).rejects.toThrow(/soporte/);
  });
});

describe("signup abuse brakes (S2)", () => {
  const res = { cookie: jest.fn() } as any;
  const okRegister = () => ({
    register: jest.fn(async () => ({
      user: { id: "u1", email: "a@x.test", firstName: "", lastName: "", role: "owner", tenantId: "t1" },
      tokens: { accessToken: "a", refreshToken: "r", refreshExpiresIn: 60, expiresIn: 60, tokenType: "Bearer" },
    })),
  });

  it("refuses disposable inboxes, subdomains included", async () => {
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@eu.Mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@gmail.com")).toBe(false);
    expect(isDisposableEmail("x@salon-lucia.es")).toBe(false);
    const authService = okRegister();
    const c = new AuthController(authService as any, {} as any, {} as any, noTurnstile(), noLimits());
    await expect(c.register({ ...form, email: "ana@yopmail.com" } as any, res, { ip: "1.2.3.4" } as any)).rejects.toThrow(
      DISPOSABLE_EMAIL_MESSAGE,
    );
    expect(authService.register).not.toHaveBeenCalled();
  });

  it("the vendored list is lower-case, sorted and has no duplicates", () => {
    const sorted = [...DISPOSABLE_EMAIL_DOMAINS].sort();
    expect(DISPOSABLE_EMAIL_DOMAINS).toEqual(sorted);
    expect(new Set(DISPOSABLE_EMAIL_DOMAINS).size).toBe(DISPOSABLE_EMAIL_DOMAINS.length);
    for (const d of DISPOSABLE_EMAIL_DOMAINS) expect(d).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
  });

  it("counts signups per IP and per email domain in Redis", async () => {
    const limits = new AuthRateLimitsService(memoryRedis());
    for (let i = 0; i < AUTH_LIMITS.signupsPerIpPerHour; i++) {
      expect(await limits.signupAttempt("203.0.113.9", `u${i}@gmail.com`)).toBeNull();
    }
    expect(await limits.signupAttempt("203.0.113.9", "u9@gmail.com")).toBe("ip");

    for (let i = 0; i < AUTH_LIMITS.signupsPerOtherDomainPerHour; i++) {
      expect(await limits.signupAttempt(`198.51.100.${i}`, `u${i}@spam-domain.test`)).toBeNull();
    }
    expect(await limits.signupAttempt("198.51.100.99", "z@spam-domain.test")).toBe("domain");
  });

  it("over a limit the signup is a Spanish 429", async () => {
    const limits = noLimits();
    limits.signupAttempt.mockResolvedValue("domain");
    const authService = okRegister();
    const c = new AuthController(authService as any, {} as any, {} as any, noTurnstile(), limits);
    const err = await c.register({ ...form } as any, res, { ip: "1.2.3.4" } as any).catch((e) => e);
    expect(err.getStatus()).toBe(429);
    expect(err.message).toBe(TOO_MANY_SIGNUPS_MESSAGE);
  });

  it("with Turnstile configured, a signup without a passing token is refused", async () => {
    const turnstile = noTurnstile();
    turnstile.verify.mockResolvedValue("missing");
    const authService = okRegister();
    const c = new AuthController(authService as any, {} as any, {} as any, turnstile, noLimits());
    await expect(c.register({ ...form } as any, res, { ip: "1.2.3.4" } as any)).rejects.toThrow(CAPTCHA_MESSAGE);
    expect(authService.register).not.toHaveBeenCalled();
  });

  it("passes the IP on for the terms record", async () => {
    const authService = okRegister();
    const c = new AuthController(authService as any, {} as any, {} as any, noTurnstile(), noLimits());
    await c.register({ ...form } as any, res, { ip: "1.2.3.4" } as any);
    expect(authService.register).toHaveBeenCalledWith(expect.anything(), { ip: "1.2.3.4" });
  });
});

describe("login captcha after 3 failures (S2)", () => {
  function setup() {
    const limits = new AuthRateLimitsService(memoryRedis());
    const turnstile = noTurnstile();
    turnstile.isEnabled.mockReturnValue(true);
    turnstile.verify.mockImplementation(async (token: string | undefined) => (token === "good" ? "ok" : "failed"));
    const authService: any = { login: jest.fn(async () => { throw new UnauthorizedException("Email o contraseña incorrectos."); }) };
    const c = new AuthController(authService, {} as any, {} as any, turnstile, limits);
    return { c, authService, turnstile };
  }
  const res = { cookie: jest.fn() } as any;
  const req = { ip: "203.0.113.20" } as any;

  it("asks for it from the third failure on, and checks it before the password", async () => {
    const { c, authService } = setup();
    const body = { email: "ana@x.test", password: "mal-clave-1" };
    await expect(c.login(body as any, res, req)).rejects.not.toHaveProperty("response.code");
    await expect(c.login(body as any, res, req)).rejects.not.toHaveProperty("response.code");
    await expect(c.login(body as any, res, req)).rejects.toMatchObject({ response: { code: CAPTCHA_REQUIRED_CODE } });
    authService.login.mockClear();
    await expect(c.login(body as any, res, req)).rejects.toMatchObject({ response: { code: CAPTCHA_REQUIRED_CODE } });
    expect(authService.login).not.toHaveBeenCalled();
    // With a passing token the password is checked again.
    await expect(c.login({ ...body, turnstileToken: "good" } as any, res, req)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.login).toHaveBeenCalledTimes(1);
  });

  it("without the keys nothing changes", async () => {
    const { c, turnstile, authService } = setup();
    turnstile.isEnabled.mockReturnValue(false);
    for (let i = 0; i < 6; i++) {
      await expect(c.login({ email: "b@x.test", password: "mal-clave-1" } as any, res, req)).rejects.not.toHaveProperty(
        "response.code",
      );
    }
    expect(authService.login).toHaveBeenCalledTimes(6);
  });
});

describe("TurnstileService", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it("is off, and lets everything through, without TURNSTILE_SECRET_KEY", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    global.fetch = jest.fn() as any;
    const t = new TurnstileService();
    expect(t.isEnabled()).toBe(false);
    await expect(t.verify(undefined)).resolves.toBe("ok");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("checks the token server-side when configured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret-not-real";
    const fetchMock = jest.fn(async (..._args: unknown[]): Promise<any> => ({ ok: true, json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }) }));
    global.fetch = fetchMock as any;
    const t = new TurnstileService();
    await expect(t.verify(undefined)).resolves.toBe("missing");
    await expect(t.verify("tok", "1.2.3.4")).resolves.toBe("failed");
    const body = (fetchMock.mock.calls[0] as any)[1].body as URLSearchParams;
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("1.2.3.4");
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ success: true }) }));
    await expect(t.verify("tok")).resolves.toBe("ok");
  });

  it("lets the request through when Cloudflare cannot be reached", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret-not-real";
    global.fetch = jest.fn(async () => { throw new Error("network down"); }) as any;
    await expect(new TurnstileService().verify("tok")).resolves.toBe("ok");
  });
});

describe("forgot-password (S9)", () => {
  function prisma(user: any) {
    return { user: { findFirst: jest.fn(async () => user), update: jest.fn(async () => ({})) } } as any;
  }
  const mail = () => ({ sendPasswordReset: jest.fn(async () => ({ success: true })) }) as any;

  it("at most 3 emails an hour to one address, counted in Redis", async () => {
    const p = prisma({ id: "u1", email: "ana@x.test", firstName: "Ana" });
    const m = mail();
    const svc = new PasswordResetService(p, m, new AuthRateLimitsService(memoryRedis()));
    for (let i = 0; i < 5; i++) {
      // No recent link in the row (the mock), so only the limit stops it.
      await svc.request("ana@x.test");
    }
    expect(m.sendPasswordReset).toHaveBeenCalledTimes(AUTH_LIMITS.passwordResetsPerEmailPerHour);
  });

  it("no new email while a link sent under 5 minutes ago is valid", async () => {
    const p = prisma({
      id: "u1",
      email: "ana@x.test",
      firstName: "Ana",
      passwordResetToken: "h",
      passwordResetExpires: new Date(Date.now() + PasswordResetService.TTL_MS - 60_000),
    });
    const m = mail();
    await new PasswordResetService(p, m).request("ana@x.test");
    expect(m.sendPasswordReset).not.toHaveBeenCalled();
    expect(p.user.update).not.toHaveBeenCalled();
  });

  it("does not wait for the email provider", async () => {
    const p = prisma({ id: "u1", email: "ana@x.test", firstName: "Ana" });
    const m = { sendPasswordReset: jest.fn(() => new Promise(() => undefined)) } as any;
    await expect(new PasswordResetService(p, m).request("ana@x.test")).resolves.toBeUndefined();
    expect(m.sendPasswordReset).toHaveBeenCalled();
  });

  it("with Turnstile configured, the request needs a passing token", async () => {
    const turnstile = noTurnstile();
    turnstile.verify.mockResolvedValue("failed");
    const passwordReset = { request: jest.fn() };
    const c = new AuthController({} as any, passwordReset as any, {} as any, turnstile, noLimits());
    await expect(c.forgotPassword({ email: "a@x.test" } as any, { ip: "1.1.1.1" } as any)).rejects.toThrow(CAPTCHA_MESSAGE);
    expect(passwordReset.request).not.toHaveBeenCalled();
  });
});

describe("salon addresses that look like KiraRoom's own (S8)", () => {
  it("takes the platform's words out instead of failing", () => {
    expect(withoutPlatformWords("soporte-kiraroom")).toBe("");
    expect(withoutPlatformWords("kiraroom-login")).toBe("login");
    expect(withoutPlatformWords("salon-lucia-kira-room")).toBe("salon-lucia");
    expect(withoutPlatformWords("kirakiraroomroom-ana")).toBe("ana");
    expect(withoutPlatformWords("support-pagos")).toBe("pagos");
    expect(withoutPlatformWords("salon-lucia")).toBe("salon-lucia");
  });

  it("signup gets a safe free address", async () => {
    const prisma = { tenant: { findUnique: jest.fn(async () => null) } };
    await expect(availableTenantSlug(prisma, "Soporte KiraRoom")).resolves.toBe("salon");
    // "login" is reserved, so it takes the next number.
    await expect(availableTenantSlug(prisma, "KiraRoom Login")).resolves.toBe("login-2");
    await expect(availableTenantSlug(prisma, "Peluquería Kira Room Ana")).resolves.toBe("peluqueria-ana");
  });
});

describe("welcome email (S7, S12)", () => {
  function service() {
    const config = { get: (k: string) => ({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "KiraRoom <hola@example.test>" } as any)[k] } as any;
    const s = new EmailService(config, {} as any, { user: { findUnique: async () => null } } as any);
    const calls: any[] = [];
    (s as any).resend = { emails: { send: async (payload: any) => (calls.push(payload), { data: { id: "x" }, error: null }) } };
    (s as any).resendKey = "re_test_key";
    return { s, calls };
  }
  afterEach(() => delete process.env.SUPPORT_EMAIL);

  it("has no user text in the subject, accents in the body, and a Reply-To from SUPPORT_EMAIL", async () => {
    process.env.SUPPORT_EMAIL = "soporte@example.test";
    const { s, calls } = service();
    await s.sendWelcome({
      to: "ana@x.test",
      tenantName: "Tu cuenta bancaria está bloqueada",
      ownerName: "Ana",
      dashboardUrl: "https://app.example.test/dashboard",
    });
    expect(calls[0].subject).toBe("Te damos la bienvenida a KiraRoom");
    expect(calls[0].replyTo).toBe("soporte@example.test");
    for (const text of [calls[0].html, calls[0].text]) {
      expect(text).toContain("14 días");
      expect(text).toContain("ya está creado");
      expect(text).not.toMatch(/\b(dias|esta creado|salon)\b/);
    }
    expect(calls[0].html).toContain("España");
  });

  it("no Reply-To without SUPPORT_EMAIL", async () => {
    const { s, calls } = service();
    await s.sendWelcome({ to: "ana@x.test", tenantName: "Salón", dashboardUrl: "https://app.example.test/dashboard" });
    expect(calls[0].replyTo).toBeUndefined();
  });
});
