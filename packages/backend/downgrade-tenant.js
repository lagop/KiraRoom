const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  const result = await prisma.tenant.updateMany({
    where: { id: 'f6d06ea0-9bd8-490a-a704-e3bf95aad3ce' },
    data: { plan: 'esencial' },
  });
  console.log('tenant plan set to esencial', result.count);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
