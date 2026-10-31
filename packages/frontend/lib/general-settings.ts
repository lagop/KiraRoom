/**
 * The salon's general settings page (/dashboard/settings): how the tenant row
 * becomes the page's field values, and which of them a save sends.
 *
 * The page used to prefill every field with invented values and save only a
 * few; then it showed the unsaved ones disabled under "Próximamente". Every
 * field it shows now is one the tenant stores. Those that would have needed a
 * feature of their own (fees, roles, session and password policies, goals,
 * themes...) were taken off the page.
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
    currency: tenant.currency,
    // Stored as "DD/MM/YYYY" and "24h"; the page's options are "dd/mm/yyyy"
    // and "24".
    dateFormat: (tenant.dateFormat ?? "DD/MM/YYYY").toLowerCase(),
    timeFormat: tenant.timeFormat === "12h" ? "12" : "24",
    cancellationPolicy: String(tenant.minCancelHours ?? 24),
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
  if (changed("contactPhone")) update.phone = settings.contactPhone;
  if (changed("contactEmail")) update.email = settings.contactEmail;
  // "" clears it; the server turns a handle into the profile URL.
  if (changed("instagram")) update.instagram = String(settings.instagram ?? "").trim();
  if (changed("facebook")) update.facebook = String(settings.facebook ?? "").trim();
  if (changed("language")) update.language = settings.language;
  if (changed("timezone")) update.timezone = settings.timezone;
  if (changed("currency")) update.currency = settings.currency;
  if (changed("dateFormat")) update.dateFormat = String(settings.dateFormat).toUpperCase();
  if (changed("timeFormat")) update.timeFormat = settings.timeFormat === "12" ? "12h" : "24h";
  if (changed("cancellationPolicy")) update.minCancelHours = Number(settings.cancellationPolicy);
  if (changed("bookingSlotMinutes")) update.bookingSlotMinutes = Number(settings.bookingSlotMinutes);
  if (changed("autoConfirmOnlineBookings")) {
    update.autoConfirmOnlineBookings = settings.autoConfirmOnlineBookings === "true";
  }
  if (settings.salonHours && !sameSalonHours(settings.salonHours, saved.salonHours)) {
    update.openingHours = openingHoursForSave(settings.salonHours);
  }
  return update;
}
