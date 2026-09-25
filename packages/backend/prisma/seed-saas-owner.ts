import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Creates the platform tenant and the `saas_owner` account.
 *
 * Credentials come from the environment. They used to be hardcoded --
 * `saasadmin@example.com` / `YourSecurePassword123!`, printed to stdout on
 * every run -- which means running this against production created the most
 * privileged account in the system with a password published in a public
 * repository. `saas_owner` is the role that reads across every tenant.
 *
 *   SAAS_OWNER_EMAIL=you@yourdomain.com \
 *   SAAS_OWNER_PASSWORD='<a real password>' \
 *   npm run db:seed:saas
 */
const PLACEHOLDERS = [
  'saasadmin@example.com',
  'YourSecurePassword123!',
  'changeme',
];

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is required. This seed creates a saas_owner account, so it will ` +
        `not invent credentials for you.`,
    );
  }
  if (PLACEHOLDERS.some((p) => value.toLowerCase() === p.toLowerCase())) {
    throw new Error(
      `${name} is still a placeholder value. Set a real one -- this account can ` +
        `read every tenant on the platform.`,
    );
  }
  return value.trim();
}

async function main() {
  const email = required('SAAS_OWNER_EMAIL');
  const password = required('SAAS_OWNER_PASSWORD');

  if (password.length < 12) {
    throw new Error(
      'SAAS_OWNER_PASSWORD must be at least 12 characters. This is the platform ' +
        'owner account.',
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  let platformTenant = await prisma.tenant.findFirst({
    where: { slug: 'platform' },
  });

  if (!platformTenant) {
    platformTenant = await prisma.tenant.create({
      data: {
        name: 'Platform',
        slug: 'platform',
        description: 'SaaS Platform Owner Account',
        plan: 'empresa',
        subscriptionStatus: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
    });
    console.log('Platform tenant created:', platformTenant.name);
  }

  const user = await prisma.user.upsert({
    where: {
      tenantId_email: {
        tenantId: platformTenant.id,
        email,
      },
    },
    update: {
      role: 'saas_owner',
      firstName: 'SaaS',
      lastName: 'Admin',
      passwordHash,
    },
    create: {
      email,
      firstName: 'SaaS',
      lastName: 'Admin',
      role: 'saas_owner',
      passwordHash,
      tenantId: platformTenant.id,
    },
  });

  // The password is never printed. It came from the environment; whoever ran
  // this already has it, and stdout ends up in container logs.
  console.log('SaaS owner ready:', user.email);
  console.log('Tenant:', platformTenant.name);
}

main()
  .catch((err) => {
    console.error(`[seed:saas] ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
