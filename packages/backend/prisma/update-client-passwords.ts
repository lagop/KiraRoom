import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Updating client passwords...');

  // Hash the new password
  const passwordHash = await bcrypt.hash('demo1234', 12);

  // Update all clients with the new password hash
  const clients = await prisma.client.updateMany({
    data: {
      passwordHash,
    },
  });

  console.log('✅ Updated', clients.count, 'clients with new password');
}

main()
  .catch((e) => {
    console.error('❌ Update failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
