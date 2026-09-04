import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Assigning services to professionals...\n');

  // Get all professionals
  const professionals = await prisma.professional.findMany();
  console.log(`Found ${professionals.length} professionals:`);
  professionals.forEach(p => {
    const specialties = Array.isArray(p.specialties) ? p.specialties.join(', ') : String(p.specialties);
    console.log(`  - ${p.firstName} ${p.lastName} (${p.position || 'No position'}) - Specialties: ${specialties}`);
  });

  // Get all services
  const services = await prisma.service.findMany();
  console.log(`\nFound ${services.length} services:`);
  services.forEach(s => console.log(`  - ${s.name} (${s.category})`));

  // Assign services based on specialty/position
  for (const professional of professionals) {
    const existingAssignments = await prisma.professionalService.findMany({
      where: { professionalId: professional.id },
    });

    if (existingAssignments.length > 0) {
      console.log(`\n${professional.firstName} ${professional.lastName} already has ${existingAssignments.length} services assigned.`);
      continue;
    }

    // Get specialties as array
    const specialties = Array.isArray(professional.specialties) 
      ? professional.specialties.map(s => String(s).toLowerCase())
      : [];
    const position = (professional.position || '').toLowerCase();

    const servicesToAssign: string[] = [];

    // Hair stylists get hair services
    if (specialties.includes('hair') || position.includes('stylist') || position.includes('hair')) {
      servicesToAssign.push(
        ...services.filter(s => s.category === 'hair').map(s => s.id)
      );
    }

    // Nail technicians get nail services
    if (position.includes('nail')) {
      servicesToAssign.push(
        ...services.filter(s => s.category === 'nails').map(s => s.id)
      );
    }

    // Massage therapists get massage services
    if (position.includes('massage') || specialties.includes('massage')) {
      servicesToAssign.push(
        ...services.filter(s => s.category === 'massage').map(s => s.id)
      );
    }

    // Estheticians get facial services
    if (position.includes('esthetic') || specialties.includes('facial')) {
      servicesToAssign.push(
        ...services.filter(s => s.category === 'facial').map(s => s.id)
      );
    }

    // If no specific match, assign some default services
    if (servicesToAssign.length === 0) {
      // Assign first 2 services as default
      servicesToAssign.push(...services.slice(0, 2).map(s => s.id));
    }

    // Remove duplicates
    const uniqueServiceIds = [...new Set(servicesToAssign)];

    if (uniqueServiceIds.length > 0) {
      // Create assignments
      await prisma.professionalService.createMany({
        data: uniqueServiceIds.map(serviceId => ({
          professionalId: professional.id,
          serviceId,
        })),
      });

      const assignedServices = services
        .filter(s => uniqueServiceIds.includes(s.id))
        .map(s => s.name);

      console.log(`\nAssigned to ${professional.firstName} ${professional.lastName}: ${assignedServices.join(', ')}`);
    }
  }

  console.log('\nDone!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
