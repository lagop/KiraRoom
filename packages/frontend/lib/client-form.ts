/**
 * The clients panel's add / edit drawers: a client row → form fields, and
 * form fields → the body the API takes.
 *
 * - Add: an empty field is left out (the API rejects "" as an email or a
 *   date, and stores "" as a gender it does not know).
 * - Edit: an emptied optional field is sent as null, which empties it on
 *   the server; leaving it out would keep the old value.
 * - Staff (not owner/admin) never send the email or the status: the
 *   server keeps those for the salon's managers.
 */

export type ClientGender = "male" | "female" | "other" | "prefer_not_to_say";
export type ClientStatusValue = "active" | "inactive" | "blocked";
export type ClientTaxIdType = "nif" | "cif" | "nie" | "passport" | "other";

export const CLIENT_GENDERS: ClientGender[] = ["male", "female", "other", "prefer_not_to_say"];
export const CLIENT_STATUSES: ClientStatusValue[] = ["active", "inactive", "blocked"];
export const CLIENT_TAX_ID_TYPES: ClientTaxIdType[] = ["nif", "cif", "nie", "passport", "other"];

export interface ClientFormValues {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  /** YYYY-MM-DD, as <input type="date"> reads and writes it; "" for none. */
  dateOfBirth: string;
  gender: ClientGender | "";
  status: ClientStatusValue;
  notes: string;
  taxId: string;
  taxIdType: ClientTaxIdType;
}

export const EMPTY_CLIENT_FORM: ClientFormValues = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  dateOfBirth: "",
  gender: "",
  status: "active",
  notes: "",
  taxId: "",
  taxIdType: "nif",
};

/** POST /clients. */
export interface CreateClientPayload {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: ClientGender;
  profileImage?: string;
  notes?: string;
  status?: ClientStatusValue;
  taxId?: string;
  taxIdType?: ClientTaxIdType;
}

/** PUT /admin/clients/:id (owner/admin) or /clients/:id (staff). null empties. */
export interface UpdateClientPayload {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: ClientGender | null;
  profileImage?: string | null;
  notes?: string | null;
  status?: ClientStatusValue;
  taxId?: string | null;
  taxIdType?: ClientTaxIdType | null;
  preferredLanguage?: string;
  preferredServices?: string[];
  preferredProfessionals?: string[];
  preferredTimes?: string[];
  communicationPreferences?: Record<string, any>;
}

/** What the drawers read from a client row of the API. */
export interface ClientRowForForm {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  status?: string | null;
  notes?: string | null;
  taxId?: string | null;
  taxIdType?: string | null;
}

/** "1990-05-17T00:00:00.000Z" → "1990-05-17": the date input shows nothing for a full ISO string. */
export function isoToDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : "";
}

function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function clientToForm(client: ClientRowForForm): ClientFormValues {
  return {
    firstName: client.firstName ?? "",
    lastName: client.lastName ?? "",
    email: client.email ?? "",
    phone: client.phone ?? "",
    dateOfBirth: isoToDateInput(client.dateOfBirth),
    gender: oneOf<ClientGender | "">(client.gender, CLIENT_GENDERS, ""),
    status: oneOf(client.status, CLIENT_STATUSES, "active"),
    notes: client.notes ?? "",
    taxId: client.taxId ?? "",
    taxIdType: oneOf(client.taxIdType, CLIENT_TAX_ID_TYPES, "nif"),
  };
}

/** A tax id as typed → as sent: uppercase, no spaces. */
export function cleanTaxId(value: string): string {
  return value.toUpperCase().replace(/\s/g, "");
}

export interface ClientFormOptions {
  /** Owner or admin: may set the email and the status. */
  canManage: boolean;
}

export function createClientPayload(form: ClientFormValues, { canManage }: ClientFormOptions): CreateClientPayload {
  const payload: CreateClientPayload = {
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim(),
  };
  const email = form.email.trim();
  const phone = form.phone.trim();
  const notes = form.notes.trim();
  const taxId = cleanTaxId(form.taxId);
  if (email) payload.email = email;
  if (phone) payload.phone = phone;
  if (form.dateOfBirth) payload.dateOfBirth = form.dateOfBirth;
  if (form.gender) payload.gender = form.gender;
  if (notes) payload.notes = notes;
  if (canManage) payload.status = form.status;
  if (taxId) {
    payload.taxId = taxId;
    payload.taxIdType = form.taxIdType;
  }
  return payload;
}

export function updateClientPayload(form: ClientFormValues, { canManage }: ClientFormOptions): UpdateClientPayload {
  const taxId = cleanTaxId(form.taxId);
  const payload: UpdateClientPayload = {
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim(),
    phone: form.phone.trim() || null,
    dateOfBirth: form.dateOfBirth || null,
    gender: form.gender || null,
    notes: form.notes.trim() || null,
    taxId: taxId || null,
    taxIdType: taxId ? form.taxIdType : null,
  };
  if (canManage) {
    payload.email = form.email.trim() || null;
    payload.status = form.status;
  }
  return payload;
}

/** Dates in the panel, the Spanish way: "17 may 1990". */
export function formatClientDate(value: string | null | undefined): string {
  if (!value) return "";
  // A date of birth is a calendar day: read it as such, not as UTC midnight
  // shifted into the browser's zone (the day before, west of Greenwich).
  const day = isoToDateInput(value);
  const date = day && value.length <= 10 ? new Date(`${day}T12:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("es-ES", { year: "numeric", month: "short", day: "numeric" });
}

/** A calendar-day column (date of birth, an appointment's day) in Spanish. */
export function formatClientDay(value: string | null | undefined): string {
  return formatClientDate(isoToDateInput(value));
}

/** Tailwind classes of a client status badge. */
export function clientStatusBadgeClass(status: string | null | undefined): string {
  switch (status) {
    case "active":
      return "bg-green-100 text-green-800";
    case "inactive":
      return "bg-yellow-100 text-yellow-800";
    case "blocked":
      return "bg-red-100 text-red-800";
    default:
      return "bg-blue-100 text-blue-800";
  }
}
