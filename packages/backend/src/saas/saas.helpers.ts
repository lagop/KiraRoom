import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  BCRYPT_ROUNDS_DEFAULT,
  MS_PER_DAY,
  TENANT_ACTIVE_WHERE,
  TRIAL_DAYS,
} from "./saas.constants";
import type { Tenant } from "@prisma/client";
import { RESERVED_SUBDOMAINS } from "@kira/shared";
import { newSalonFiscalSettings } from "../invoices/salon-tax-settings";

/** Read an "active" (non-soft-deleted) tenant by id. */
export async function getActiveTenant(
  prisma: PrismaService,
  id: string,
): Promise<Tenant> {
  const tenant = await prisma.tenant.findFirst({
    where: { id, ...TENANT_ACTIVE_WHERE },
  });
  if (!tenant) {
    throw new NotFoundException("Tenant not found");
  }
  return tenant;
}

/**
 * The salon's slug: its web address (/sites/<slug>) and its free subdomain
 * (<slug>.kiraroom.net). Accents are folded first -- "Salón Lucía" used to
 * become "sal-n-luc-a" -- and it is capped at 63 characters, the longest a
 * DNS label (a subdomain) can be.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Words a salon's address may not contain, anywhere in it: they make
 * <slug>.kiraroom.net look like KiraRoom's own (soporte-kiraroom,
 * kiraroom-login, support-pagos...). The reserved list only blocks exact
 * names. Checked on the slugified form, so accents, capitals and spaces do
 * not get round it ("Kira Room" is kira-room).
 */
export const PLATFORM_LOOKALIKE_WORDS = ["kiraroom", "kira-room", "soporte", "support"] as const;

/**
 * The slug with the platform's words taken out, so signup never fails over
 * a name: "Soporte KiraRoom Lucía" becomes "lucia". Removing a word can
 * join two pieces into a new one ("kirakiraroomroom"), so it repeats until
 * none is left. A name made only of those words comes back empty and the
 * caller falls back to "salon"; either way the free-slug search then adds
 * "-2", "-3"... as for any name that is taken.
 */
export function withoutPlatformWords(slug: string): string {
  let out = slug;
  for (let guard = 0; guard < 10; guard++) {
    let next = out;
    for (const word of PLATFORM_LOOKALIKE_WORDS) next = next.split(word).join("-");
    next = next.replace(/-+/g, "-").replace(/(^-|-$)/g, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

export function containsPlatformWord(slug: string): boolean {
  return PLATFORM_LOOKALIKE_WORDS.some((w) => slug.includes(w));
}

export async function assertTenantSlugAvailable(
  prisma: PrismaService,
  slug: string,
  errMessage: string = "Ya hay otro salón con esa dirección en KiraRoom. Prueba con otra.",
): Promise<void> {
  // A reserved name would be the salon's subdomain (app.kiraroom.net...).
  // One shaped like an id would be read as another salon's id by the
  // lookups that take "slug or id" (public page, receptionist).
  if (RESERVED_SUBDOMAINS.has(slug) || UUID_SHAPED.test(slug)) {
    throw new BadRequestException(
      "Ese nombre no se puede usar como dirección del salón. Añade algo más, por ejemplo la ciudad.",
    );
  }
  if (await slugHeld(prisma, slug)) {
    throw new BadRequestException(errMessage);
  }
}

/** "salon-lucia", "salon-lucia-2", "salon-lucia-3"... each at most 63 chars. */
export function tenantSlugCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** How many numbered slugs signup tries before falling back to a random one. */
const SLUG_NUMBERED_TRIES = 20;

/**
 * A free slug for a salon called `name`. Names are not unique -- two salons
 * may both be "Peluquería Lucía" -- so a name that is taken (or reserved for
 * the platform, or shaped like an id) gets "-2", "-3"..., and after those a
 * short random suffix. `skip` lists slugs already known to be taken (a
 * create that lost a race), so a retry moves past them.
 */
export async function availableTenantSlug(
  prisma: {
    tenant: { findUnique: (args: any) => Promise<unknown> };
    tenantSlugRedirect?: { findFirst: (args: any) => Promise<unknown> };
  },
  name: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<string> {
  const base = withoutPlatformWords(slugify(name)) || "salon";
  const usable = (slug: string) =>
    !skip.has(slug) &&
    !RESERVED_SUBDOMAINS.has(slug) &&
    !UUID_SHAPED.test(slug) &&
    !containsPlatformWord(slug);
  for (let n = 1; n <= SLUG_NUMBERED_TRIES; n++) {
    const slug = tenantSlugCandidate(base, n);
    if (!usable(slug)) continue;
    if (!(await slugHeld(prisma, slug))) return slug;
  }
  for (let i = 0; i < 5; i++) {
    const slug = `${base.slice(0, 56).replace(/-+$/, "")}-${randomBytes(3).toString("hex")}`;
    if (!usable(slug)) continue;
    if (!(await slugHeld(prisma, slug))) return slug;
  }
  throw new ConflictException(TENANT_SLUG_UNAVAILABLE);
}

/**
 * Taken by a salon, or still redirecting to one (D4: an address a salon left
 * in the last 12 months). Past those months the address is free again.
 */
async function slugHeld(
  prisma: {
    tenant: { findUnique: (args: any) => Promise<unknown> };
    tenantSlugRedirect?: { findFirst: (args: any) => Promise<unknown> };
  },
  slug: string,
): Promise<boolean> {
  if (await prisma.tenant.findUnique({ where: { slug }, select: { id: true } })) return true;
  if (!prisma.tenantSlugRedirect) return false;
  return !!(await prisma.tenantSlugRedirect.findFirst({
    where: { oldSlug: slug, expiresAt: { gt: new Date() } },
    select: { id: true },
  }));
}

/** When no free address could be found for a new salon (practically never). */
export const TENANT_SLUG_UNAVAILABLE =
  "No hemos podido crear la dirección de tu salón. Vuelve a intentarlo en unos segundos.";

export async function hashPassword(plain: string): Promise<string> {
  const rounds = Number(process.env.BCRYPT_ROUNDS) || BCRYPT_ROUNDS_DEFAULT;
  return bcrypt.hash(plain, rounds);
}

export function computeTrialEnd(now: Date = new Date()): Date {
  return new Date(now.getTime() + TRIAL_DAYS * MS_PER_DAY);
}

export interface CreateTenantWithOwnerInput {
  name: string;
  slug: string;
  fallbackSlug?: string;
  email?: string | null;
  phone?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  timezone?: string | null;
  currency?: string;
  language?: string;
  description?: string | null;
  logo?: string | null;
  coverImage?: string | null;
  website?: string | null;
  whatsapp?: string | null;
  plan?: string;
  trialDays?: number;
  ownerEmail: string;
  ownerPassword: string;
  ownerFirstName: string;
  ownerLastName: string;
  ownerRole?: "saas_owner" | "owner" | "admin" | "staff" | "client";
  ownerLanguage?: string;
  /**
   * The terms (with the art. 28 GDPR processing agreement) and the privacy
   * policy, accepted by the owner being created: written in the same
   * transaction as the salon. Signup and invite acceptance pass it; the
   * console's createTenant does not (nobody accepted anything there).
   */
  legalAcceptance?: { termsVersion: string; ip?: string | null; source: "signup" | "invite" };
}

export interface CreateTenantWithOwnerResult {
  tenant: { id: string };
  user: { id: string; email: string; role: string };
}

export async function createTenantWithOwner(
  prisma:
    | PrismaService
    | ((tx: Prisma.TransactionClient) => Promise<CreateTenantWithOwnerResult>),
  input: CreateTenantWithOwnerInput,
): Promise<CreateTenantWithOwnerResult> {
  const now = new Date();
  const trialDays = input.trialDays ?? TRIAL_DAYS;
  const trialEnd = new Date(now.getTime() + trialDays * MS_PER_DAY);
  const finalLanguage = input.language ?? "es";
  const finalOwnerRole = input.ownerRole ?? ("owner" as const);
  const passwordHash = await hashPassword(input.ownerPassword);

  if (typeof (prisma as any).$transaction === "function") {
    return (prisma as PrismaService).$transaction(async (tx) => {
      return createTenantAndUserOnTx(tx, input, now, trialEnd, finalLanguage, finalOwnerRole, passwordHash);
    });
  }
  return createTenantAndUserOnTx(
    prisma as unknown as Prisma.TransactionClient,
    input,
    now,
    trialEnd,
    finalLanguage,
    finalOwnerRole,
    passwordHash,
  );
}

async function createTenantAndUserOnTx(
  tx: Prisma.TransactionClient,
  input: CreateTenantWithOwnerInput,
  now: Date,
  trialEnd: Date,
  finalLanguage: string,
  finalOwnerRole: "saas_owner" | "owner" | "admin" | "staff" | "client",
  passwordHash: string,
): Promise<CreateTenantWithOwnerResult> {
  const tenant = await tx.tenant.create({
    data: {
      name: input.name,
      slug: input.slug,
      email: input.email ?? null,
      phone: input.phone ?? null,
      whatsapp: input.whatsapp ?? null,
      description: input.description ?? null,
      logo: input.logo ?? null,
      coverImage: input.coverImage ?? null,
      website: input.website ?? null,
      street: input.street ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? "ES",
      timezone: input.timezone ?? "Europe/Madrid",
      currency: input.currency ?? "EUR",
      language: finalLanguage,
      plan: (input.plan as any),
      subscriptionStatus: "trialing",
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      trialEnd,
      // A new salon's prices include the tax (pricesIncludeTax: true); one
      // created before the setting keeps the column default, with no key,
      // which reads as tax on top. See salon-tax-settings.ts. A salon in the
      // Canaries starts on IGIC 7 %, one in Ceuta or Melilla on IPSI (audit 7
      // N6), from its address or, with none yet, a Canary timezone.
      fiscalSettings: newSalonFiscalSettings(
        { street: input.street, city: input.city, state: input.state, postalCode: input.postalCode, country: input.country ?? "ES" },
        input.timezone,
      ) as any,
    },
    select: { id: true },
  });

  const user = await tx.user.create({
    data: {
      tenantId: tenant.id,
      // Lower-case like every account email (auth/email-normalize.ts).
      email: input.ownerEmail.trim().toLowerCase(),
      firstName: input.ownerFirstName,
      lastName: input.ownerLastName,
      role: finalOwnerRole,
      passwordHash,
      language: input.ownerLanguage ?? finalLanguage,
      isActive: true,
    },
    select: { id: true, email: true, role: true },
  });

  if (input.legalAcceptance) {
    await tx.legalAcceptance.create({
      data: {
        tenantId: tenant.id,
        acceptedByUserId: user.id,
        termsVersion: input.legalAcceptance.termsVersion,
        ip: input.legalAcceptance.ip ? input.legalAcceptance.ip.slice(0, 64) : null,
        source: input.legalAcceptance.source,
        acceptedAt: now,
      },
    });
  }

  return {
    tenant,
    user: { id: user.id, email: user.email, role: user.role },
  };
}
