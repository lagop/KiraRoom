import {
  PrismaClient,
  UserRole,
  ClientStatus,
  Gender,
  ServiceCategory,
  AppointmentStatus,
  PaymentStatus,
  AppointmentSource,
  AppointmentLocation,
} from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting comprehensive seed...");

  // Create tenant
  const tenant = await prisma.tenant.create({
    data: {
      name: "Kira Room",
      slug: "kira-room",
      description:
        "Premium beauty and wellness salon in the heart of Madrid. We offer hair, nails, facial, massage, and body treatments with personalized care.",
      email: "info@kira-room.com",
      phone: "+34 600 123 456",
      whatsapp: "+34 600 123 456",
      street: "Calle Gran Vía 42",
      city: "Madrid",
      state: "Community of Madrid",
      postalCode: "28013",
      country: "ES",
      timezone: "Europe/Madrid",
      currency: "EUR",
      language: "es",
      dateFormat: "DD/MM/YYYY",
      timeFormat: "24h",
      plan: "professional",
      subscriptionStatus: "active",
      currentPeriodStart: new Date("2025-01-01"),
      currentPeriodEnd: new Date("2026-01-01"),
      features: {
        onlineBooking: true,
        smsNotifications: true,
        emailMarketing: true,
        loyaltyProgram: true,
        multiStaff: true,
        inventory: true,
        reports: true,
      },
    },
  });
  console.log("✅ Created tenant:", tenant.name);

  // Create users (owner, admin, staff, client)
  const users = await Promise.all([
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "owner@kira-room.com",
        firstName: "Carlos",
        lastName: "Martínez",
        role: UserRole.owner,
        isActive: true,
        isEmailVerified: true,
        passwordHash:
          "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy", // demo123
        phone: "+34 610 000 001",
        lastLoginAt: new Date(),
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "admin@kira-room.com",
        firstName: "Elena",
        lastName: "Sánchez",
        role: UserRole.admin,
        isActive: true,
        isEmailVerified: true,
        passwordHash:
          "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy", // demo123
        phone: "+34 610 000 002",
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "staff@kira-room.com",
        firstName: "Roberto",
        lastName: "Gómez",
        role: UserRole.staff,
        isActive: true,
        isEmailVerified: true,
        passwordHash:
          "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy", // demo1234
        phone: "+34 610 000 003",
      },
    }),
    prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: "juan.perez@email.com",
        firstName: "Juan",
        lastName: "Pérez García",
        role: UserRole.staff, // Using staff role for client test account
        isActive: true,
        isEmailVerified: true,
        passwordHash:
          "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy", // demo123
        phone: "+34 630 000 001",
        lastLoginAt: new Date(),
      },
    }),
  ]);
  console.log("✅ Created", users.length, "users");

  // Create services
  const services = await Promise.all([
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Corte de Cabello Mujer",
        description:
          "Corte profesional diseñado específicamente para resaltar tu estilo personal. Incluye consulta previa y styling.",
        category: ServiceCategory.hair,
        duration: 60,
        price: 45.0,
        isActive: true,
        isOnlineBookable: true,
        maxAdvanceBooking: 30,
        minAdvanceBooking: 2,
        bufferTime: 15,
        tags: ["cabello", "mujer", "estilo"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Coloración Completa",
        description:
          "Coloración profesional con productos de primera línea. Incluye tratamiento nutritivo post-color.",
        category: ServiceCategory.hair,
        duration: 120,
        price: 85.0,
        isActive: true,
        isOnlineBookable: true,
        maxAdvanceBooking: 14,
        minAdvanceBooking: 4,
        bufferTime: 30,
        requiresApproval: true,
        tags: ["color", "cabello", "tinte"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Manicura Clásica",
        description:
          "Manicura con esmalte tradicional en más de 50 colores. Incluye cutícula y exfoliación de manos.",
        category: ServiceCategory.nails,
        duration: 45,
        price: 28.0,
        isActive: true,
        isOnlineBookable: true,
        tags: ["uñas", "manicura", "esmalte"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Manicura Semipermanente",
        description:
          "Esmalte de larga duración que mantiene su brillo hasta 3 semanas. Incluye base nutritiva.",
        category: ServiceCategory.nails,
        duration: 60,
        price: 38.0,
        isActive: true,
        isOnlineBookable: true,
        tags: ["uñas", "semi", "permanente"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Pedicura Spa",
        description:
          "Tratamiento completo para pies con exfoliación, mascarilla, masaje y esmalte.",
        category: ServiceCategory.nails,
        duration: 75,
        price: 45.0,
        isActive: true,
        isOnlineBookable: true,
        tags: ["pies", "pedicura", "relax"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Facial Limpieza Profunda",
        description:
          "Limpieza facial profunda con tecnología ultrasónica. Incluye vapour, extracción y mascarilla personalizada.",
        category: ServiceCategory.facial,
        duration: 75,
        price: 65.0,
        isActive: true,
        isOnlineBookable: true,
        tags: ["facial", "limpieza", "hidratación"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Facial Antiaging",
        description:
          "Tratamiento intensivo con vitamina C y ácido hialurónico para reducir líneas de expresión.",
        category: ServiceCategory.facial,
        duration: 90,
        price: 95.0,
        isActive: true,
        isOnlineBookable: true,
        requiresApproval: false,
        tags: ["facial", "antiedad", "vitamina c"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Masaje Relajante",
        description:
          "Masaje suave con aceites esenciales para relajar cuerpo y mente. 60 minutos de bliss.",
        category: ServiceCategory.massage,
        duration: 60,
        price: 55.0,
        isActive: true,
        isOnlineBookable: true,
        tags: ["masaje", "relax", "aromaterapia"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Masaje Descontracturante",
        description:
          "Masaje profundo para liberar tensión muscular. Ideal para contracturas y estrés acumulado.",
        category: ServiceCategory.massage,
        duration: 75,
        price: 70.0,
        isActive: true,
        isOnlineBookable: true,
        tags: ["masaje", "terapéutico", "contracturas"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Tratamiento Corporal Reafirmante",
        description:
          "Tratamiento con radiofrecuencia para reafirmar y mejorar la textura de la piel.",
        category: ServiceCategory.body,
        duration: 90,
        price: 120.0,
        isActive: true,
        isOnlineBookable: true,
        requiresApproval: true,
        tags: ["body", "reafirmante", "rf"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Depilación con Cera",
        description:
          "Depilación profesional con cera tibia. Piernas completas, axilas, ingles brasileño.",
        category: ServiceCategory.body,
        duration: 45,
        price: 35.0,
        isActive: true,
        isOnlineBookable: true,
        tags: ["depilación", "cera", "suave"],
      },
    }),
    prisma.service.create({
      data: {
        tenantId: tenant.id,
        name: "Tratamiento Capilar",
        description:
          "Tratamiento nutritivo y reparador para cabello dañado. Incluye kératina y mascarilla intensiva.",
        category: ServiceCategory.hair,
        duration: 45,
        price: 50.0,
        isActive: true,
        isOnlineBookable: true,
        tags: ["cabello", "keratina", "reparación"],
      },
    }),
  ]);
  console.log("✅ Created", services.length, "services");

  // Create professionals with working hours
  const professionals = await Promise.all([
    prisma.professional.create({
      data: {
        tenantId: tenant.id,
        firstName: "María",
        lastName: "García López",
        email: "maria@kira-room.com",
        phone: "+34 620 000 001",
        bio: "Especialista en cortes y coloración con más de 10 años de experiencia. Formada en las mejores academias de Madrid.",
        specialties: ["cortes", "coloración", "mechas", "balayage"],
        isActive: true,
        isOwner: false,
        position: "Senior Stylist",
        commissionRate: 15,
        hireDate: new Date("2022-01-15"),
        workingHours: {
          monday: { start: "09:00", end: "14:00" },
          tuesday: { start: "09:00", end: "18:00" },
          wednesday: { start: "09:00", end: "18:00" },
          thursday: { start: "09:00", end: "14:00" },
          friday: { start: "09:00", end: "18:00" },
          saturday: { start: "10:00", end: "14:00" },
          sunday: null,
        },
        settings: {
          acceptsOnlineBooking: true,
          bufferBetweenClients: 15,
          maxDailyClients: 8,
        },
        stats: {
          totalClients: 156,
          totalAppointments: 892,
          averageRating: 4.9,
          totalRevenue: 42850.0,
        },
      },
    }),
    prisma.professional.create({
      data: {
        tenantId: tenant.id,
        firstName: "Ana",
        lastName: "Martínez Ruiz",
        email: "ana@kira-room.com",
        phone: "+34 620 000 002",
        bio: "Experta en manicura y pedicura artística. ganadora del concurso nacional de nail art 2023.",
        specialties: ["manicura", "pedicura", "nail art", "extensiones"],
        isActive: true,
        isOwner: false,
        position: "Nail Artist",
        commissionRate: 12,
        hireDate: new Date("2022-06-20"),
        workingHours: {
          monday: { start: "10:00", end: "18:00" },
          tuesday: { start: "10:00", end: "18:00" },
          wednesday: { start: "10:00", end: "18:00" },
          thursday: { start: "10:00", end: "18:00" },
          friday: { start: "10:00", end: "20:00" },
          saturday: { start: "09:00", end: "15:00" },
          sunday: null,
        },
        settings: {
          acceptsOnlineBooking: true,
          bufferBetweenClients: 10,
          maxDailyClients: 10,
        },
        stats: {
          totalClients: 203,
          totalAppointments: 1245,
          averageRating: 4.8,
          totalRevenue: 35620.0,
        },
      },
    }),
    prisma.professional.create({
      data: {
        tenantId: tenant.id,
        firstName: "Carmen",
        lastName: "Sánchez Torres",
        email: "carmen@kira-room.com",
        phone: "+34 620 000 003",
        bio: "Esteticista especializada en facial y masajes terapéuticos. Certificada en técnicas de drenaje linfático.",
        specialties: [
          "faciales",
          "masajes",
          "drenaje linfático",
          "tratamientos corporales",
        ],
        isActive: true,
        isOwner: false,
        position: "Beauty Therapist",
        commissionRate: 12,
        hireDate: new Date("2023-03-01"),
        workingHours: {
          monday: { start: "09:00", end: "17:00" },
          tuesday: { start: "09:00", end: "17:00" },
          wednesday: { start: "09:00", end: "17:00" },
          thursday: { start: "09:00", end: "17:00" },
          friday: { start: "09:00", end: "17:00" },
          saturday: null,
          sunday: null,
        },
        settings: {
          acceptsOnlineBooking: true,
          bufferBetweenClients: 15,
          maxDailyClients: 6,
        },
        stats: {
          totalClients: 89,
          totalAppointments: 412,
          averageRating: 4.95,
          totalRevenue: 28450.0,
        },
      },
    }),
    prisma.professional.create({
      data: {
        tenantId: tenant.id,
        firstName: "Laura",
        lastName: "Fernández Díaz",
        email: "laura@kira-room.com",
        phone: "+34 620 000 004",
        bio: "Apasionada por la belleza natural. Especialista en coloración orgánica y tratamientos capilares naturales.",
        specialties: [
          "coloración natural",
          "tratamientos capilares",
          "cortes orgánicos",
        ],
        isActive: true,
        isOwner: false,
        position: "Organic Stylist",
        commissionRate: 12,
        hireDate: new Date("2023-09-15"),
        workingHours: {
          monday: { start: "10:00", end: "16:00" },
          tuesday: { start: "10:00", end: "16:00" },
          wednesday: { start: "10:00", end: "16:00" },
          thursday: { start: "10:00", end: "16:00" },
          friday: { start: "10:00", end: "19:00" },
          saturday: { start: "10:00", end: "14:00" },
          sunday: null,
        },
        settings: {
          acceptsOnlineBooking: true,
          bufferBetweenClients: 15,
          maxDailyClients: 6,
        },
        stats: {
          totalClients: 67,
          totalAppointments: 234,
          averageRating: 4.85,
          totalRevenue: 15680.0,
        },
      },
    }),
    prisma.professional.create({
      data: {
        tenantId: tenant.id,
        firstName: "Javier",
        lastName: "Moreno Ruiz",
        email: "javier@kira-room.com",
        phone: "+34 620 000 005",
        bio: "Barbero profesional especializado en cortes clásicos y modernos para caballeros. Experiencia internacional.",
        specialties: ["cortes caballero", "barba", "afeitado clásico", "fade"],
        isActive: true,
        isOwner: false,
        position: "Master Barber",
        commissionRate: 15,
        hireDate: new Date("2023-11-01"),
        workingHours: {
          monday: { start: "10:00", end: "19:00" },
          tuesday: { start: "10:00", end: "19:00" },
          wednesday: { start: "10:00", end: "19:00" },
          thursday: { start: "10:00", end: "19:00" },
          friday: { start: "10:00", end: "20:00" },
          saturday: { start: "09:00", end: "15:00" },
          sunday: null,
        },
        settings: {
          acceptsOnlineBooking: true,
          bufferBetweenClients: 10,
          maxDailyClients: 12,
        },
        stats: {
          totalClients: 145,
          totalAppointments: 567,
          averageRating: 4.92,
          totalRevenue: 22580.0,
        },
      },
    }),
  ]);
  console.log("✅ Created", professionals.length, "professionals");

  // Assign services to professionals
  console.log("🔄 Assigning services to professionals...");
  await Promise.all([
    // María García López - Hair stylist (services 1,2,3,4,5,6)
    prisma.professionalService.create({
      data: { professionalId: professionals[0].id, serviceId: services[0].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[0].id, serviceId: services[1].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[0].id, serviceId: services[2].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[0].id, serviceId: services[3].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[0].id, serviceId: services[4].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[0].id, serviceId: services[5].id },
    }),

    // Ana Martínez Ruiz - Nail artist (services 7,8,9,10,11,12)
    prisma.professionalService.create({
      data: { professionalId: professionals[1].id, serviceId: services[6].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[1].id, serviceId: services[7].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[1].id, serviceId: services[8].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[1].id, serviceId: services[9].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[1].id, serviceId: services[10].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[1].id, serviceId: services[11].id },
    }),

    // Carmen Sánchez Torres - Hair stylist (services 1,2,3,4,5,6 - same as María)
    prisma.professionalService.create({
      data: { professionalId: professionals[2].id, serviceId: services[0].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[2].id, serviceId: services[1].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[2].id, serviceId: services[2].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[2].id, serviceId: services[3].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[2].id, serviceId: services[4].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[2].id, serviceId: services[5].id },
    }),

    // Javier Moreno Ruiz - Hair stylist (services 1,2,3,4,5,6 - same as María and Carmen)
    prisma.professionalService.create({
      data: { professionalId: professionals[3].id, serviceId: services[0].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[3].id, serviceId: services[1].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[3].id, serviceId: services[2].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[3].id, serviceId: services[3].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[3].id, serviceId: services[4].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[3].id, serviceId: services[5].id },
    }),

    // Laura Fernández Díaz - Hair stylist (services 1,2,3,4,5,6 - same as others)
    prisma.professionalService.create({
      data: { professionalId: professionals[4].id, serviceId: services[0].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[4].id, serviceId: services[1].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[4].id, serviceId: services[2].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[4].id, serviceId: services[3].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[4].id, serviceId: services[4].id },
    }),
    prisma.professionalService.create({
      data: { professionalId: professionals[4].id, serviceId: services[5].id },
    }),
  ]);
  console.log("✅ Assigned services to professionals");

  // Create clients with diverse data
  const clients = await Promise.all([
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Juan",
        lastName: "Pérez García",
        email: "juan.perez@email.com",
        phone: "+34 630 000 001",
        dateOfBirth: new Date("1985-03-15"),
        gender: Gender.male,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[0].id, services[4].id],
        preferredProfessionals: [professionals[4].id],
        preferredTimes: { day: "saturday", time: "morning" },
        communicationPreferences: {
          sms: true,
          email: true,
          marketing: false,
        },
        loyaltyPoints: 450,
        loyaltyTier: "silver",
        totalSpent: 890.5,
        visitCount: 12,
        averageSpent: 74.21,
        firstVisit: new Date("2024-02-10"),
        lastVisit: new Date("2025-01-05"),
        source: "google",
        tags: ["vip", "frecuente"],
        notes:
          "Prefiere cita los sábados por la mañana. Alérgico a ciertos productos con fragancia fuerte.",
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Laura",
        lastName: "Gómez Martínez",
        email: "laura.gomez@email.com",
        phone: "+34 630 000 002",
        dateOfBirth: new Date("1990-07-22"),
        gender: Gender.female,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[5].id, services[6].id],
        preferredProfessionals: [professionals[2].id],
        preferredTimes: { day: "tuesday", time: "afternoon" },
        communicationPreferences: {
          sms: true,
          email: true,
          marketing: true,
        },
        loyaltyPoints: 1200,
        loyaltyTier: "gold",
        totalSpent: 2450.0,
        visitCount: 28,
        averageSpent: 87.5,
        firstVisit: new Date("2023-06-15"),
        lastVisit: new Date("2025-01-03"),
        source: "instagram",
        tags: ["vip", "frecuente", "cliente-premium"],
        notes:
          "Cliente muy fiel. Siempre pide los mismos tratamientos faciales.",
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Carlos",
        lastName: "Rodríguez López",
        email: "carlos.rodriguez@email.com",
        phone: "+34 630 000 003",
        dateOfBirth: new Date("1978-11-08"),
        gender: Gender.male,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[4].id],
        preferredProfessionals: [professionals[4].id],
        preferredTimes: { day: "friday", time: "evening" },
        communicationPreferences: {
          sms: true,
          email: false,
          marketing: false,
        },
        loyaltyPoints: 180,
        loyaltyTier: "bronze",
        totalSpent: 320.0,
        visitCount: 5,
        averageSpent: 64.0,
        firstVisit: new Date("2024-09-20"),
        lastVisit: new Date("2025-01-06"),
        source: "referral",
        tags: ["nuevo-2025"],
        notes: null,
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "María",
        lastName: "Fernández Sánchez",
        email: "maria.fernandez@email.com",
        phone: "+34 630 000 004",
        dateOfBirth: new Date("1995-02-14"),
        gender: Gender.female,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[1].id, services[11].id],
        preferredProfessionals: [professionals[0].id],
        preferredTimes: { day: "wednesday", time: "morning" },
        communicationPreferences: {
          sms: true,
          email: true,
          marketing: true,
        },
        loyaltyPoints: 780,
        loyaltyTier: "silver",
        totalSpent: 1560.0,
        visitCount: 18,
        averageSpent: 86.67,
        firstVisit: new Date("2023-11-05"),
        lastVisit: new Date("2025-01-02"),
        source: "google",
        tags: ["frecuente"],
        notes:
          "Le gusta experimentar con nuevos colores. Siempre pide tratamiento después de teñir.",
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Antonio",
        lastName: "Martínez Ruiz",
        email: "antonio.martinez@email.com",
        phone: "+34 630 000 005",
        dateOfBirth: new Date("1965-09-30"),
        gender: Gender.male,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[0].id],
        preferredProfessionals: [professionals[4].id],
        preferredTimes: { day: "saturday", time: "morning" },
        communicationPreferences: {
          sms: true,
          email: false,
          marketing: false,
        },
        loyaltyPoints: 320,
        loyaltyTier: "bronze",
        totalSpent: 540.0,
        visitCount: 8,
        averageSpent: 67.5,
        firstVisit: new Date("2024-04-12"),
        lastVisit: new Date("2025-01-04"),
        source: "walk-in",
        tags: ["tradicional"],
        notes: "Prefiere cortes clásicos. Cliente muy amable.",
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Sofía",
        lastName: "López García",
        email: "sofia.lopez@email.com",
        phone: "+34 630 000 006",
        dateOfBirth: new Date("2000-05-18"),
        gender: Gender.female,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[2].id, services[3].id],
        preferredProfessionals: [professionals[1].id],
        preferredTimes: { day: "saturday", time: "afternoon" },
        communicationPreferences: {
          sms: true,
          email: true,
          marketing: true,
        },
        loyaltyPoints: 220,
        loyaltyTier: "bronze",
        totalSpent: 380.0,
        visitCount: 7,
        averageSpent: 54.29,
        firstVisit: new Date("2024-07-20"),
        lastVisit: new Date("2025-01-07"),
        source: "instagram",
        tags: ["nail-art", "frecuente"],
        notes:
          "Le encanta el nail art creativo. Siempre pide diseños diferentes.",
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Roberto",
        lastName: "Sánchez Torres",
        email: "roberto.sanchez@email.com",
        phone: "+34 630 000 007",
        dateOfBirth: new Date("1988-12-03"),
        gender: Gender.male,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[7].id, services[8].id],
        preferredProfessionals: [professionals[2].id],
        preferredTimes: { day: "thursday", time: "evening" },
        communicationPreferences: {
          sms: true,
          email: true,
          marketing: false,
        },
        loyaltyPoints: 560,
        loyaltyTier: "silver",
        totalSpent: 980.0,
        visitCount: 14,
        averageSpent: 70.0,
        firstVisit: new Date("2024-01-15"),
        lastVisit: new Date("2025-01-06"),
        source: "google",
        tags: ["masajes", "frecuente"],
        notes:
          "Gran alivio para el estrés del trabajo. Le encantan los masajes descontracturantes.",
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Elena",
        lastName: "Romero Díaz",
        email: "elena.romero@email.com",
        phone: "+34 630 000 008",
        dateOfBirth: new Date("1972-08-25"),
        gender: Gender.female,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[5].id, services[6].id, services[9].id],
        preferredProfessionals: [professionals[2].id, professionals[3].id],
        preferredTimes: { day: "monday", time: "morning" },
        communicationPreferences: {
          sms: true,
          email: true,
          marketing: true,
        },
        loyaltyPoints: 2500,
        loyaltyTier: "platinum",
        totalSpent: 5200.0,
        visitCount: 52,
        averageSpent: 100.0,
        firstVisit: new Date("2022-10-01"),
        lastVisit: new Date("2025-01-06"),
        source: "referral",
        tags: ["vip", "platinum", "frecuente", "cliente-premium"],
        notes:
          "Nuestra cliente más fiel. Siempre al día con tratamientos. Cumpleaños: 25 de agosto.",
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Patricia",
        lastName: "Navarro Cruz",
        email: "patricia.navarro@email.com",
        phone: "+34 630 000 009",
        dateOfBirth: new Date("1998-04-10"),
        gender: Gender.female,
        status: ClientStatus.inactive,
        preferredLanguage: "es",
        preferredServices: [services[0].id],
        preferredProfessionals: [professionals[0].id],
        preferredTimes: { day: "friday", time: "afternoon" },
        communicationPreferences: {
          sms: false,
          email: true,
          marketing: false,
        },
        loyaltyPoints: 120,
        loyaltyTier: "bronze",
        totalSpent: 180.0,
        visitCount: 3,
        averageSpent: 60.0,
        firstVisit: new Date("2024-06-15"),
        lastVisit: new Date("2024-08-20"),
        source: "instagram",
        tags: ["inactivo"],
        notes: "No ha visitado desde agosto. Enviar promoción.",
      },
    }),
    prisma.client.create({
      data: {
        tenantId: tenant.id,
        firstName: "Miguel",
        lastName: "Vargas Ruiz",
        email: "miguel.vargas@email.com",
        phone: "+34 630 000 010",
        dateOfBirth: new Date("1993-01-20"),
        gender: Gender.male,
        status: ClientStatus.active,
        preferredLanguage: "es",
        preferredServices: [services[0].id, services[10].id],
        preferredProfessionals: [professionals[4].id],
        preferredTimes: { day: "tuesday", time: "evening" },
        communicationPreferences: {
          sms: true,
          email: true,
          marketing: true,
        },
        loyaltyPoints: 340,
        loyaltyTier: "bronze",
        totalSpent: 520.0,
        visitCount: 9,
        averageSpent: 57.78,
        firstVisit: new Date("2024-03-10"),
        lastVisit: new Date("2025-01-05"),
        source: "facebook",
        tags: ["caballero", "frecuente"],
        notes: null,
      },
    }),
  ]);
  console.log("✅ Created", clients.length, "clients");

  // Create appointments with various statuses and dates
  const today = new Date();
  const appointments = await Promise.all([
    // Today's appointments
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[0].id,
        serviceId: services[0].id,
        professionalId: professionals[0].id,
        scheduledDate: today,
        scheduledTime: "09:00",
        duration: 60,
        endTime: "10:00",
        status: AppointmentStatus.completed,
        price: 45.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.paid,
        paymentMethod: "card",
        totalAmount: 45.0,
        amountPaid: 45.0,
        amountDue: 0,
        source: AppointmentSource.online,
        location: AppointmentLocation.salon,
        startTime: new Date(today.setHours(9, 0, 0, 0)),
        completionTime: new Date(today.setHours(10, 5, 0, 0)),
        notes: "Corte clásico para evento especial.",
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[1].id,
        serviceId: services[5].id,
        professionalId: professionals[2].id,
        scheduledDate: today,
        scheduledTime: "10:00",
        duration: 75,
        endTime: "11:15",
        status: AppointmentStatus.in_progress,
        price: 65.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.paid,
        paymentMethod: "card",
        totalAmount: 65.0,
        amountPaid: 65.0,
        amountDue: 0,
        source: AppointmentSource.online,
        location: AppointmentLocation.salon,
        startTime: new Date(today.setHours(10, 0, 0, 0)),
        checkInTime: new Date(today.setHours(9, 55, 0, 0)),
        notes: "Facial limpieza profunda. Primera vez con este tratamiento.",
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[5].id,
        serviceId: services[3].id,
        professionalId: professionals[1].id,
        scheduledDate: today,
        scheduledTime: "11:00",
        duration: 60,
        endTime: "12:00",
        status: AppointmentStatus.confirmed,
        price: 38.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.pending,
        totalAmount: 38.0,
        amountPaid: 0,
        amountDue: 38.0,
        source: AppointmentSource.instagram,
        location: AppointmentLocation.salon,
        reminders: [
          {
            type: "sms",
            scheduledFor: new Date(today.setHours(today.getHours() - 24)),
            sent: true,
          },
          {
            type: "email",
            scheduledFor: new Date(today.setHours(today.getHours() - 48)),
            sent: true,
          },
        ],
        notes: "Semipermanente. Quiere color nude.",
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[6].id,
        serviceId: services[8].id,
        professionalId: professionals[2].id,
        scheduledDate: today,
        scheduledTime: "14:00",
        duration: 75,
        endTime: "15:15",
        status: AppointmentStatus.pending,
        price: 70.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.pending,
        totalAmount: 70.0,
        amountPaid: 0,
        amountDue: 70.0,
        source: AppointmentSource.online,
        location: AppointmentLocation.salon,
        notes: "Masaje descontracturante. Tiene tensión en espalda y hombros.",
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[7].id,
        serviceId: services[6].id,
        professionalId: professionals[2].id,
        scheduledDate: today,
        scheduledTime: "16:00",
        duration: 90,
        endTime: "17:30",
        status: AppointmentStatus.confirmed,
        price: 95.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.paid,
        paymentMethod: "card",
        totalAmount: 95.0,
        amountPaid: 95.0,
        amountDue: 0,
        source: AppointmentSource.phone,
        location: AppointmentLocation.salon,
        depositRequired: true,
        depositAmount: 20.0,
        depositPaid: true,
        notes: "Facial antiaging. Tratamiento mensual.",
      },
    }),
    // Future appointments
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[0].id,
        serviceId: services[1].id,
        professionalId: professionals[0].id,
        scheduledDate: new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
        scheduledTime: "10:00",
        duration: 120,
        endTime: "12:00",
        status: AppointmentStatus.confirmed,
        price: 85.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.pending,
        totalAmount: 85.0,
        amountPaid: 0,
        amountDue: 85.0,
        source: AppointmentSource.online,
        location: AppointmentLocation.salon,
        notes: "Coloración completa. Retoque de raíces.",
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[3].id,
        serviceId: services[11].id,
        professionalId: professionals[3].id,
        scheduledDate: new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
        scheduledTime: "11:00",
        duration: 45,
        endTime: "11:45",
        status: AppointmentStatus.pending,
        price: 50.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.pending,
        totalAmount: 50.0,
        amountPaid: 0,
        amountDue: 50.0,
        source: AppointmentSource.online,
        location: AppointmentLocation.salon,
        notes: "Tratamiento capilar con keratina.",
      },
    }),
    // Past appointments
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[2].id,
        serviceId: services[4].id,
        professionalId: professionals[4].id,
        scheduledDate: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
        scheduledTime: "15:00",
        duration: 45,
        endTime: "15:45",
        status: AppointmentStatus.completed,
        price: 35.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.paid,
        paymentMethod: "cash",
        totalAmount: 35.0,
        amountPaid: 35.0,
        amountDue: 0,
        source: AppointmentSource.staff,
        location: AppointmentLocation.salon,
        startTime: new Date(
          today.getTime() - 7 * 24 * 60 * 60 * 1000 + 15 * 60 * 1000,
        ),
        completionTime: new Date(
          today.getTime() - 7 * 24 * 60 * 60 * 1000 + 16 * 60 * 1000,
        ),
        rating: 5,
        review: "Excelente servicio, muy satisfecho con el resultado.",
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[4].id,
        serviceId: services[0].id,
        professionalId: professionals[4].id,
        scheduledDate: new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000), // 14 days ago
        scheduledTime: "10:00",
        duration: 60,
        endTime: "11:00",
        status: AppointmentStatus.completed,
        price: 45.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.paid,
        paymentMethod: "card",
        totalAmount: 45.0,
        amountPaid: 45.0,
        amountDue: 0,
        source: AppointmentSource.online,
        location: AppointmentLocation.salon,
        startTime: new Date(
          today.getTime() - 14 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000,
        ),
        completionTime: new Date(
          today.getTime() - 14 * 24 * 60 * 60 * 1000 + 11 * 60 * 1000,
        ),
        rating: 4,
        review: "Buen corte, aunque tardó más de lo esperado.",
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[8].id,
        serviceId: services[0].id,
        professionalId: professionals[0].id,
        scheduledDate: new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        scheduledTime: "14:00",
        duration: 60,
        endTime: "15:00",
        status: AppointmentStatus.cancelled,
        price: 45.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.refunded,
        totalAmount: 45.0,
        amountPaid: 0,
        amountDue: 0,
        source: AppointmentSource.online,
        location: AppointmentLocation.salon,
        cancellationReason:
          "Cliente solicitó cancelación por conflicto de horarios.",
        cancellationPolicy: "Cancelación gratuita con 24h de anticipación.",
        rating: null,
        review: null,
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[9].id,
        serviceId: services[10].id,
        professionalId: professionals[4].id,
        scheduledDate: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        scheduledTime: "16:00",
        duration: 45,
        endTime: "16:45",
        status: AppointmentStatus.no_show,
        price: 35.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.pending,
        totalAmount: 35.0,
        amountPaid: 0,
        amountDue: 35.0,
        source: AppointmentSource.online,
        location: AppointmentLocation.salon,
        internalNotes: "El cliente no se presentó. Llamar para reprogramar.",
      },
    }),
    prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: clients[7].id,
        serviceId: services[9].id,
        professionalId: professionals[2].id,
        scheduledDate: new Date(today.getTime() - 21 * 24 * 60 * 60 * 1000), // 21 days ago
        scheduledTime: "09:00",
        duration: 90,
        endTime: "10:30",
        status: AppointmentStatus.completed,
        price: 120.0,
        currency: "EUR",
        paymentStatus: PaymentStatus.paid,
        paymentMethod: "card",
        totalAmount: 120.0,
        amountPaid: 120.0,
        amountDue: 0,
        source: AppointmentSource.phone,
        location: AppointmentLocation.salon,
        startTime: new Date(
          today.getTime() - 21 * 24 * 60 * 60 * 1000 + 9 * 60 * 1000,
        ),
        completionTime: new Date(
          today.getTime() - 21 * 24 * 60 * 60 * 1000 + 10 * 45 * 1000,
        ),
        rating: 5,
        review: "Increíble tratamiento. Piel muy suave y renovada. Repetiré.",
        feedback: {
          improvement: "Nada, todo perfecto",
          wouldRecommend: true,
          favoriteAspects: ["Resultado", "Profesionalidad", "Ambiente"],
        },
      },
    }),
  ]);
  console.log("✅ Created", appointments.length, "appointments");

  console.log("\n🎉 Seed completed successfully!");
  console.log("\n📊 Summary:");
  console.log("  - 1 tenant: Kira Room");
  console.log(`  - ${users.length} users (owner, admin, staff)`);
  console.log(
    `  - ${services.length} services (hair, nails, facial, massage, body)`,
  );
  console.log(`  - ${professionals.length} professionals`);
  console.log(`  - ${clients.length} clients`);
  console.log(`  - ${appointments.length} appointments (various statuses)`);
  console.log("\n🔐 Demo Credentials:");
  console.log("  Owner: owner@kira-room.com");
  console.log("  Admin: admin@kira-room.com");
  console.log("  Staff: staff@kira-room.com");
  console.log("  (Password: demo123 for all accounts)");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
