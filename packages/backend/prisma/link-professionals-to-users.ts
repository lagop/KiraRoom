import { PrismaClient, UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function linkProfessionalsToUsers() {
  console.log("🔄 Linking professionals to user accounts...");

  // Get all professionals that don't have user accounts
  const professionals = await prisma.professional.findMany({
    where: {
      userId: null,
    },
  });

  console.log(
    `Found ${professionals.length} professionals without user accounts`,
  );

  for (const professional of professionals) {
    try {
      // Check if a user with this email already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: professional.email },
      });

      if (existingUser) {
        // Link existing user to professional
        await prisma.professional.update({
          where: { id: professional.id },
          data: { userId: existingUser.id },
        });
        console.log(
          `✅ Linked existing user ${existingUser.email} to professional ${professional.firstName} ${professional.lastName}`,
        );
      } else {
        // Create new user account for professional
        const passwordHash = await bcrypt.hash("prueba123", 12); // Default password for testing

        const newUser = await prisma.user.create({
          data: {
            tenantId: professional.tenantId,
            email: professional.email,
            firstName: professional.firstName,
            lastName: professional.lastName,
            role: UserRole.staff,
            isActive: professional.isActive,
            isEmailVerified: true,
            passwordHash,
            phone: professional.phone,
          },
        });

        // Link professional to user
        await prisma.professional.update({
          where: { id: professional.id },
          data: { userId: newUser.id },
        });

        console.log(
          `✅ Created user account and linked ${newUser.email} to professional ${professional.firstName} ${professional.lastName}`,
        );
      }
    } catch (error) {
      console.error(
        `❌ Error linking professional ${professional.email}:`,
        error,
      );
    }
  }

  console.log("🎉 Professional-user linking completed!");
}

linkProfessionalsToUsers()
  .catch((e) => {
    console.error("❌ Script failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
