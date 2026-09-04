import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('YourSecurePassword123!', 12);

  // First create or find a platform tenant
  let platformTenant = await prisma.tenant.findFirst({
    where: { slug: 'platform' }
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

  // Create or update the SaaS owner user (unique constraint is [tenantId, email])
  const user = await prisma.user.upsert({
    where: {
      tenantId_email: {
        tenantId: platformTenant.id,
        email: 'saasadmin@example.com',
      }
    },
    update: {
      role: 'saas_owner',
      firstName: 'SaaS',
      lastName: 'Admin',
    },
    create: {
      email: 'saasadmin@example.com',
      firstName: 'SaaS',
      lastName: 'Admin',
      role: 'saas_owner',
      passwordHash,
      tenantId: platformTenant.id,
    },
  });

  console.log('SaaS Owner created/updated:', user.email);
  console.log('Tenant:', platformTenant.name);
  console.log('Password: YourSecurePassword123!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());