import { Prisma } from "@prisma/client";

/**
 * What the panel gets back for a client row.
 *
 * A bare `findMany()` / `update()` on Client returns every column, which
 * includes the client's sign-in secrets (password hash, reset token and
 * its expiry, session version). None of that belongs in a panel response.
 * Every clients / admin-clients endpoint selects from here instead.
 *
 * Columns that are deliberately left out of every panel response.
 * client-select.spec.ts fails when a new Client column is neither selected
 * nor listed here, so a new secret cannot leak by default.
 */
export const CLIENT_SECRET_COLUMNS = [
  "passwordHash",
  "passwordResetToken",
  "passwordResetExpires",
  "tokenVersion",
] as const;

/** Health data: only in the single-client detail, never in lists. */
export const CLIENT_HEALTH_COLUMNS = ["allergies", "medicalConditions"] as const;

/** A client row in a list (panel list, filters, search). */
export const CLIENT_LIST_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  tenantId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  taxId: true,
  taxIdType: true,
  dateOfBirth: true,
  gender: true,
  profileImage: true,
  status: true,
  preferredLanguage: true,
  preferredServices: true,
  preferredProfessionals: true,
  preferredTimes: true,
  communicationPreferences: true,
  loyaltyPoints: true,
  loyaltyTier: true,
  totalSpent: true,
  visitCount: true,
  averageSpent: true,
  firstVisit: true,
  lastVisit: true,
  lastReengagementSent: true,
  source: true,
  notes: true,
  tags: true,
} satisfies Prisma.ClientSelect;

/** One client, as the client file shows it: the list row plus health data. */
export const CLIENT_DETAIL_SELECT = {
  ...CLIENT_LIST_SELECT,
  allergies: true,
  medicalConditions: true,
} satisfies Prisma.ClientSelect;

/** A client as the till and its orders need it: who, how to reach, points. */
export const CLIENT_POS_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  status: true,
  loyaltyPoints: true,
  loyaltyTier: true,
} satisfies Prisma.ClientSelect;

/** The client's visits in her file: when, with whom, what and what it cost. */
export const CLIENT_APPOINTMENTS_SELECT = {
  id: true,
  scheduledDate: true,
  scheduledTime: true,
  duration: true,
  status: true,
  price: true,
  totalAmount: true,
  amountPaid: true,
  paymentStatus: true,
  notes: true,
  service: { select: { id: true, name: true } },
  professional: { select: { id: true, firstName: true, lastName: true } },
  services: {
    select: {
      id: true,
      order: true,
      service: { select: { id: true, name: true } },
      professional: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { order: "asc" },
  },
} satisfies Prisma.AppointmentSelect;

/** At most this many visits in the client file, most recent first. */
export const CLIENT_APPOINTMENTS_LIMIT = 100;
