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
  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
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
  prisma: { tenant: { findUnique: (args: any) => Promise<unknown> } },
  name: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<string> {
  const base = slugify(name) || "salon";
  const usable = (slug: string) =>
    !skip.has(slug) && !RESERVED_SUBDOMAINS.has(slug) && !UUID_SHAPED.test(slug);
  for (let n = 1; n <= SLUG_NUMBERED_TRIES; n++) {
    const slug = tenantSlugCandidate(base, n);
    if (!usable(slug)) continue;
    const taken = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (!taken) return slug;
  }
  for (let i = 0; i < 5; i++) {
    const slug = `${base.slice(0, 56).replace(/-+$/, "")}-${randomBytes(3).toString("hex")}`;
    if (!usable(slug)) continue;
    const taken = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (!taken) return slug;
  }
  throw new ConflictException(TENANT_SLUG_UNAVAILABLE);
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
      email: input.ownerEmail,
      firstName: input.ownerFirstName,
      lastName: input.ownerLastName,
      role: finalOwnerRole,
      passwordHash,
      language: input.ownerLanguage ?? finalLanguage,
      isActive: true,
    },
    select: { id: true, email: true, role: true },
  });

  return {
    tenant,
    user: { id: user.id, email: user.email, role: user.role },
  };
}
