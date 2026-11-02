/**
 * The salon's general settings page (/dashboard/settings): how the tenant row
 * becomes the page's field values, and which of them a save sends.
 *
 * The page used to prefill every field with invented values and save only a
 * few; then it showed the unsaved ones disabled under "Próximamente". Every
 * field it shows now is one the tenant stores. Those that would have needed a
 * feature of their own (fees, roles, session and password policies, goals,
 * themes...) were taken off the page. So were Moneda, Formato de fecha and
 * Formato de hora: the product is euros, DD/MM/YYYY and 24 h, and changing
 * them did nothing in the panel.
 *
 * No React and no Next imports, so lib/general-settings.spec.ts can run them.
 */
import type apiClient from "./api";
import { openingHoursForSave, salonHoursSettingFrom, sameSalonHours } from "./salon-hours";

export type TenantSettingsRow = Awaited<ReturnType<typeof apiClient.getTenant>>;
export type TenantUpdate = Parameters<typeof apiClient.updateTenant>[0];

/** The steps the server accepts between offered start times (minutes). */
export const BOOKING_SLOT_OPTIONS = [10, 15, 20, 30, 60] as const;

/** Tenant row -> the page's field values. */
export function settingsFromTenant(tenant: TenantSettingsRow): Record<string, any> {
  return {
    businessName: tenant.name ?? "",
    address: tenant.street ?? "",
    contactPhone: tenant.phone ?? "",
    contactEmail: tenant.email ?? "",
    // Stored as profile URLs; the field takes a handle or a link.
    instagram: tenant.instagram ?? "",
    facebook: tenant.facebook ?? "",
    // The salon's week; a legacy { open, close } shows as that window every day.
    salonHours: salonHoursSettingFrom(tenant.openingHours),
    language: tenant.language,
    timezone: tenant.timezone,
    // Informational, both: the receptionist explains them and the booking
    // page shows the text; nothing charges a fee or stops a cancellation.
    minCancelHours: String(tenant.minCancelHours ?? 24),
    cancellationPolicyText: tenant.cancellationPolicy ?? "",
    bookingSlotMinutes: String(tenant.bookingSlotMinutes ?? 30),
    // Switches hold "true" / "false".
    autoConfirmOnlineBookings: tenant.autoConfirmOnlineBookings ? "true" : "false",
  };
}

/** Field values -> the PATCH /auth/tenant body, only for what changed. */
export function tenantUpdateFrom(
  settings: Record<string, any>,
  saved: Record<string, any>,
): TenantUpdate {
  const changed = (id: string) => settings[id] !== saved[id];
  const update: TenantUpdate = {};
  if (changed("businessName")) update.name = settings.businessName;
  if (changed("address")) update.street = settings.address;
  // Blank clears them (stored as null); the server checks the format.
  if (changed("contactPhone")) update.phone = String(settings.contactPhone ?? "").trim() || null;
  if (changed("contactEmail")) update.email = String(settings.contactEmail ?? "").trim() || null;
  // "" clears it; the server turns a handle into the profile URL.
  if (changed("instagram")) update.instagram = String(settings.instagram ?? "").trim();
  if (changed("facebook")) update.facebook = String(settings.facebook ?? "").trim();
  if (changed("language")) update.language = settings.language;
  if (changed("timezone")) update.timezone = settings.timezone;
  if (changed("minCancelHours")) update.minCancelHours = Number(settings.minCancelHours);
  // Blank clears it (stored as null).
  if (changed("cancellationPolicyText")) {
    update.cancellationPolicy = String(settings.cancellationPolicyText ?? "").trim() || null;
  }
  if (changed("bookingSlotMinutes")) update.bookingSlotMinutes = Number(settings.bookingSlotMinutes);
  if (changed("autoConfirmOnlineBookings")) {
    update.autoConfirmOnlineBookings = settings.autoConfirmOnlineBookings === "true";
  }
  if (settings.salonHours && !sameSalonHours(settings.salonHours, saved.salonHours)) {
    update.openingHours = openingHoursForSave(settings.salonHours);
  }
  return update;
}
