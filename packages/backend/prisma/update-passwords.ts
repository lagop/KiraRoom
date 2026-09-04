import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 Updating user passwords...');

  // Hash the new password
  const passwordHash = await bcrypt.hash('demo1234', 12);

  // Update all users with the new password hash
  const users = await prisma.user.updateMany({
    data: {
      passwordHash,
    },
  });

  console.log('✅ Updated', users.count, 'users with new password');
}

main()
  .catch((e) => {
    console.error('❌ Update failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });