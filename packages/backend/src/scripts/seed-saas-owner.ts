import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

/**
 * Creates the platform tenant and the `saas_owner` account.
 *
 * Lives under `src/` so `npm run build` compiles it into `dist/`, which makes
 * it runnable in the production image:
 *
 *   docker exec -e SAAS_OWNER_EMAIL=... -e SAAS_OWNER_PASSWORD=... \
 *     kiraroom-backend-prod node dist/scripts/seed-saas-owner.js
 *
 * It used to live only in `prisma/` and be invoked with `npx ts-node`. That
 * cannot work in production: ts-node and typescript are devDependencies, so
 * npx tried to fetch ts-node from the network and then crashed on the missing
 * typescript. The first-deploy instructions pointed at that command, so the one
 * step needed to get into a fresh install was the one step that failed.
 *
 * Credentials come from the environment. They were hardcoded once --
 * `saasadmin@example.com` / `YourSecurePassword123!`, printed on every run --
 * which is the role that reads across every tenant, with a password published
 * in a public repository.
 */
const PLACEHOLDERS = [
  'saasadmin@example.com',
  'yoursecurepassword123!',
  'changeme',
];

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is required. This creates a saas_owner account, so it will not ` +
        `invent credentials for you.`,
    );
  }
  if (PLACEHOLDERS.includes(value.trim().toLowerCase())) {
    throw new Error(
      `${name} is still a placeholder. Set a real one -- this account can read ` +
        `every tenant on the platform.`,
    );
  }
  return value.trim();
}

export async function seedSaasOwner(): Promise<void> {
  const email = required('SAAS_OWNER_EMAIL');
  const password = required('SAAS_OWNER_PASSWORD');

  if (password.length < 12) {
    throw new Error(
      'SAAS_OWNER_PASSWORD must be at least 12 characters. This is the platform ' +
        'owner account.',
    );
  }

  const prisma = new PrismaClient();
  try {
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
        tenantId_email: { tenantId: platformTenant.id, email },
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

    // The password is never printed: whoever ran this already has it, and
    // stdout ends up in container logs.
    console.log('saas_owner ready:', user.email);
    console.log('Tenant:', platformTenant.name);
  } finally {
    await prisma.$disconnect();
  }
}

// Run when invoked directly (`node dist/scripts/seed-saas-owner.js`).
if (require.main === module) {
  seedSaasOwner().catch((err: Error) => {
    console.error(`[seed:owner] ${err.message}`);
    process.exitCode = 1;
  });
}
