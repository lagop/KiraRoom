import {
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  BCRYPT_ROUNDS_DEFAULT,
  MS_PER_DAY,
  TENANT_ACTIVE_WHERE,
  TRIAL_DAYS,
} from "./saas.constants";
import type { Tenant } from "@prisma/client";

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

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

export async function assertTenantSlugAvailable(
  prisma: PrismaService,
  slug: string,
  errMessage: string = "Salon slug already exists, please choose another",
): Promise<void> {
  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    throw new BadRequestException(errMessage);
  }
}

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
