// Next.js API Client for Kira Room

import type { TaxRegime } from "@kira/shared";
import type { PublicSalonPage } from "./salon-seo";
import type { WorkingHoursEntry } from "./weekly-schedule";
import { requestBody } from "./time-off";
import type { TimeOff, TimeOffConflict, TimeOffInput, TimeOffStatus } from "./time-off";
import type { CreateClientPayload, UpdateClientPayload } from "./client-form";
import type { RefundableSaleLine } from "./payments-format";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

// Token storage
const TOKEN_KEY = "kira_auth_token";
const REFRESH_TOKEN_KEY = "kira_refresh_token";

/** The most professionals GET /admin/professionals answers at once (the server's cap). */
const MAX_TEAM_PAGE = 200;

// Custom error class that carries the HTTP status so callers can distinguish
// 404 (resource not found) from other failures instead of parsing message text.
export class ApiError extends Error {
  status: number;
  /** The server's machine-readable reason, when it sends one (e.g. "OUTSIDE_HOURS"). */
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const getToken = () => {
  if (typeof window !== "undefined") {
    return localStorage.getItem(TOKEN_KEY);
  }
  return null;
};

/**
 * Where a 401 should send the browser, or `null` when it must not navigate.
 *
 * The 401 handler below does `window.location.href = "/login"`, which is a
 * full page load. Assigning the URL you are already on reloads the page, so
 * any unauthenticated request made *from* the login page produced an
 * infinite reload loop: load /login -> request -> 401 -> assign "/login" ->
 * load /login. The page refreshed forever and you could not type into the
 * form.
 *
 * That is exactly what happened in production. `useTranslations()` called
 * the authenticated `GET /auth/tenant` on first paint, which answers 401
 * with no session. It had been masked: while the backend rejected the
 * browser's origin, the same call failed CORS as a *network* error, never
 * reaching the status check, so the loop could not start. Fixing CORS turned
 * a visible "Failed to fetch" into a reload loop.
 *
 * Returning null is the structural guard: whatever calls a protected
 * endpoint from a public page, the browser never navigates to the page it is
 * already showing. The two callers below both honour it.
 */
/**
 * Endpoints where 401 is an ANSWER, not an expired session.
 *
 * Submitting the wrong password to `POST /auth/login` returns 401 with
 * `{"message":"Invalid credentials"}`. The 401 handler treated that like any
 * other unauthorized call: it tried to refresh, failed, discarded the
 * backend's message behind a generic `Error("Unauthorized")`, and navigated
 * away.
 *
 * On /saas/login that was actively misleading. There is no `user` in
 * localStorage on a first sign-in, so the handler read no `saas_owner` role
 * and sent the browser to /login -- the *tenant* login page. The reported
 * symptom was "Unauthorized" flashing for about a second before landing on
 * the wrong form, with nothing to say the password was simply wrong.
 *
 * A credential endpoint's 401 belongs to the form that asked. No refresh, no
 * navigation, and the server's own message reaches the caller.
 */
const CREDENTIAL_ENDPOINTS = [
  "/auth/login",
  // The second step of a sign-in: a wrong code is an answer, not an expired session.
  "/auth/2fa/verify",
  "/auth/register",
  "/auth/forgot-password",
  "/auth/reset-password",
  // Opened from the welcome email, usually signed out. The endpoint is public
  // and answers { verified } either way; should it ever answer 401, that is
  // the link page's to show, not a reason to navigate to /login.
  "/auth/verify-email",
];

export function isCredentialEndpoint(endpoint: string): boolean {
  // Compare against the path only: these are called with query strings in
  // some flows, and `/auth/login?next=/x` is still the login endpoint.
  const path = endpoint.split("?")[0];
  return CREDENTIAL_ENDPOINTS.includes(path);
}

export function loginRedirectTarget(
  currentPath: string,
  isSaasUser: boolean,
  isClient = false,
): string | null {
  // A salon's client signs in with a modal on that salon's site; /login is
  // the staff dashboard's page. Sending them there on an expired session
  // took them off the salon's site altogether. The caller signs them out in
  // place instead.
  if (isClient) return null;
  const target = isSaasUser ? "/saas/login" : "/login";
  // Tolerate a trailing slash so "/login/" is recognised as the same page.
  const normalized =
    currentPath.length > 1 && currentPath.endsWith("/")
      ? currentPath.slice(0, -1)
      : currentPath;
  return normalized === target ? null : target;
}

export const setToken = (token: string) => {
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, token);
  }
};

export const removeToken = () => {
  if (typeof window !== "undefined") {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    if (proactiveRefreshTimer) {
      clearTimeout(proactiveRefreshTimer);
      proactiveRefreshTimer = null;
    }
  }
};

export function decodeJwtToken(token: string): any { try { const b = token.split('.')[1]; const j = JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/'))); return j; } catch { return null; } }

/** Returns the JWT `exp` claim (in seconds) or `null` if unparseable. */
/**
 * The query string of the payments list, summary and CSV: only the
 * filters that are set.
 */
function paymentQuery(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

function getJwtExp(token: string): number | null {
  const claims = decodeJwtToken(token);
  if (claims && typeof claims.exp === "number") return claims.exp;
  return null;
}

/**
 * Proactive refresh scheduler.
 *
 * Decodes the `exp` claim of the current access token and schedules a
 * single `setTimeout` to refresh ~60 seconds before expiry. This means
 * dashboard polling never hits a 401 in the happy path: the token is
 * always valid because we refreshed just before it would have expired.
 *
 * The timer is module-scoped so re-logins / refreshes replace it cleanly.
 */
let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleProactiveRefresh(
  accessToken: string,
  expiresInSeconds?: number,
) {
  if (typeof window === "undefined") return;
  if (proactiveRefreshTimer) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }

  let expiresAtMs: number | null = null;
  if (typeof expiresInSeconds === "number" && expiresInSeconds > 0) {
    expiresAtMs = Date.now() + expiresInSeconds * 1000;
  } else {
    const exp = getJwtExp(accessToken);
    if (exp) expiresAtMs = exp * 1000;
  }
  if (!expiresAtMs) return;

  // Refresh 60s before expiry; clamp to a sane minimum of 5s so a
  // very-short-lived token can't busy-loop.
  const delay = Math.max(5_000, expiresAtMs - Date.now() - 60_000);
  proactiveRefreshTimer = setTimeout(() => {
    proactiveRefreshTimer = null;
    const api = (window as any).__kiraApiClient;
    if (api && typeof api.refreshAccessToken === "function") {
      api.refreshAccessToken();
    }
  }, delay);
}

export const getRefreshToken = () => {
  if (typeof window !== "undefined") {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  }
  return null;
};

export const setRefreshToken = (token: string) => {
  if (typeof window !== "undefined") {
    localStorage.setItem(REFRESH_TOKEN_KEY, token);
  }
};

export const removeRefreshToken = () => {
  if (typeof window !== "undefined") {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
};

/**
 * Deleting a client, professional or service. One with appointments or
 * payments is history, so the server deactivates it instead of deleting it
 * (`deactivated: true`): it stays in the list, marked inactive.
 */
export interface HistoryDeleteResult {
  ok: boolean;
  deactivated: boolean;
}

/** POST /admin/clients/:id/merge: what moved to the record kept, and the sentence to show. */
export interface ClientMergeResult {
  ok: true;
  targetClientId: string;
  sourceClientId: string;
  moved: Record<string, number>;
  message: string;
}

/** A row of GET /admin/clients: the list columns and how many appointments she has. */
export type ClientSearchRow = Client & { _count?: { appointments: number } };

/** The password was right and the account asks for a code from the app next. */
export interface TwoFactorRequired {
  twoFactorRequired: true;
  /** Sent back with the code to verifyTwoFactor; valid 5 minutes. */
  challenge: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

export function isTwoFactorRequired(r: unknown): r is TwoFactorRequired {
  return !!r && typeof r === "object" && (r as TwoFactorRequired).twoFactorRequired === true;
}

interface LoginResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    role: string;
    tenantId: string;
  };
}

// P0 â€” Widget / QR / Import / Consent / Reviews / WhatsApp types
export interface WidgetInstance {
  id: string;
  name: string;
  token?: string;
  allowedOrigins: string[];
  services: string[];
  professionals: string[];
  theme: Record<string, unknown>;
  bookCount?: number;
  lastUsedAt?: string | null;
  createdAt?: string;
}

/** An import file: CSV text, or an .xlsx as base64 (the backend reads its first sheet). */
export type ImportUpload = { csv: string } | { xlsx: string };

export interface ImportPreviewRow {
  rowIndex: number;
  data: Record<string, any>;
  errors: Array<{ col: string; msg: string }>;
  /** skip: left out on purpose (an appointment already past or cancelled). */
  status: "ok" | "duplicate" | "invalid" | "update" | "skip";
  existingId?: string;
  note?: string;
}
export interface ImportPreviewResult {
  jobId: string;
  filename: string;
  preview: ImportPreviewRow[];
  stats: {
    totalRows: number;
    okCount: number;
    updateCount?: number;
    duplicateCount: number;
    invalidCount: number;
    skipCount?: number;
  };
  errors: Array<{ row: number; fields: Array<{ col: string; msg: string }> }>;
  /** Appointments: clients that will be (or were) created. */
  newClients?: number;
}
export interface ImportCommitResult {
  jobId: string;
  totalRows: number;
  successRows: number;
  createdRows?: number;
  updatedRows?: number;
  errorRows: number;
  skippedRows: number;
  newClients?: number;
  /** Clients: refusals of advertising recorded from the file. */
  marketingRefusals?: number;
}
export interface ImportJob {
  id: string;
  filename: string;
  type: string;
  status: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  dryRun: boolean;
  createdAt: string;
  completedAt?: string | null;
}

/** GET /ics/tokens and POST /ics/tokens/rotate. version 0 = never rotated. */
export interface IcsFeedTokens {
  version: number;
  rotatedAt: string | null;
  salon: { slug: string; token: string };
  professionals: Array<{ id: string; name: string; token: string }>;
}

export interface ConsentFormField {
  id: string;
  type: "boolean" | "text" | "select" | "date" | "info";
  label: string;
  required?: boolean;
  options?: string[];
  helpText?: string;
}
export interface ConsentForm {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  fields: ConsentFormField[];
  serviceIds: string[];
  isActive: boolean;
  version: number;
  createdAt: string;
}
export interface ConsentFormInput {
  name: string;
  description?: string;
  fields: ConsentFormField[];
  serviceIds?: string[];
}
export interface Consent {
  id: string;
  tenantId: string;
  clientId: string;
  formId: string;
  formVersion: number;
  signedAt: string;
  revokedAt?: string | null;
}

export interface Review {
  id: string;
  tenantId: string;
  appointmentId?: string | null;
  clientId: string;
  professionalId?: string | null;
  rating: number;
  comment?: string | null;
  source: string;
  /** pending = requested, not answered yet; moderation = answered, awaiting the salon. */
  status: "pending" | "moderation" | "published" | "rejected";
  createdAt: string;
  submittedAt?: string | null;
  /** The client opened the salon's Google review page. Not proof she posted there. */
  googleLinkClickedAt?: string | null;
  clientName?: string | null;
  professionalName?: string | null;
  serviceName?: string | null;
}
export interface ReviewAnalytics {
  averageRating: number;
  total: number;
  distribution: number[];
  topPerformers: Array<{
    professionalId: string;
    averageRating: number;
    count: number;
  }>;
  requestsSent: number;
  responseRate: number;
  pendingModeration: number;
  googleClicks: number;
}
export interface ReviewSettings {
  googlePlaceId: string | null;
  googleWriteReviewUrl: string | null;
  googleReviewLink: string | null;
  autoRequestsEnabled: boolean;
  /** The google_reviews_auto add-on (or a plan with it) is active. */
  addOnActive: boolean;
  channels: {
    email: boolean;
    sms: boolean;
    /** "not_connected", "NOT_SUBMITTED", or Meta's template status (APPROVED, PENDING...). */
    whatsapp: string;
  };
  googleApi: { available: boolean };
  policy: { delayHours: number; clientCooldownDays: number; tokenTtlDays: number };
}

/** GET /virtual-receptionist/channels/config. Never carries a token. */
export interface ChannelsConfig {
  enabled: boolean;
  enabledChannels: string[];
  meta: {
    configured: boolean;
    pageId?: string;
    pageName?: string;
    instagramBusinessAccountId?: string;
    instagramUsername?: string;
    hasAccessToken: boolean;
    needsReconnect: boolean;
  } | null;
  metaPagesPending: boolean;
  telegram: {
    configured: boolean;
    botUsername?: string;
    hasBotToken: boolean;
    needsReconnect: boolean;
  } | null;
  /** What the server can offer, and why not (e.g. "meta_app_not_configured"). */
  availability?: {
    meta: boolean;
    metaReason?: string;
    telegram: boolean;
    telegramReason?: string;
  };
}

export interface WhatsAppConnection {
  id: string;
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhone: string;
  displayName?: string | null;
  qualityScore?: string | null;
  tokenExpiresAt?: string | null;
  isActive: boolean;
}
/** A quarterly tax return draft (Modelo 303 / 420 / 130): box -> value. */
export interface TaxReportDraft {
  id: string;
  type: "modelo_303" | "modelo_420" | "modelo_130";
  year: number;
  quarter: number;
  /** Amounts in cents; the tipo boxes of the 420 (02, 05...) are percentages. */
  totalsJson: Record<string, number>;
  status: string;
}

export type WhatsAppCampaignStatus = "draft" | "scheduled" | "sending" | "paused" | "completed" | "failed" | "cancelled";

/** A WhatsApp promotion: the salon's text, reviewed by Meta as a template. */
export interface WhatsAppCampaign {
  id: string;
  tenantId: string;
  name: string;
  /** {{nombre}} is the client's first name. */
  body: string;
  templateId: string;
  /** Meta's review: draft (not submitted), PENDING, APPROVED, REJECTED... */
  templateStatus: string;
  templateReason: string | null;
  status: WhatsAppCampaignStatus;
  segmentFilter: { inactiveDays?: number };
  scheduledAt: string | null;
  submittedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  totalRecipients: number;
  /** Counts worked out from the recipients when the campaign is read. */
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  optedOut: number;
  /** Recipients not sent yet (a sending or paused campaign). */
  pending?: number;
  /** Recipients by status (detail only): pending, sent, delivered, read, failed, opted_out. */
  byStatus?: Record<string, number>;
}

export interface WhatsAppCampaignInput {
  name: string;
  body: string;
  inactiveDays?: number | null;
  scheduledAt?: string | null;
}

export interface WhatsAppAudiencePreview {
  eligible: number;
  withoutConsent: number;
  withoutPhone: number;
}

// Types matching our backend Prisma schema
export interface Appointment {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  clientId: string;
  serviceId: string;
  professionalId: string;
  scheduledDate: string;
  scheduledTime: string;
  duration: number;
  status:
    | "pending"
    | "confirmed"
    | "in_progress"
    | "completed"
    | "cancelled"
    | "no_show";
  price: number;
  totalAmount?: number;
  amountPaid?: number;
  amountDue?: number;
  currency: string;
  paymentStatus: "pending" | "paid" | "failed" | "refunded";
  notes?: string;
  services?: AppointmentService[];
}

export interface AppointmentService {
  id: string;
  createdAt: string;
  updatedAt: string;
  appointmentId: string;
  serviceId: string;
  professionalId?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  actualStart?: string;
  actualEnd?: string;
  type: "active" | "processing" | "continuation";
  isParallel: boolean;
  order: number;
  status: "pending" | "active" | "processing" | "completed" | "cancelled";
  notes?: string;
  service?: Service;
  professional?: Professional;
}

/** GET /clients?page=…: one page of the panel's client list. */
export interface ClientListParams {
  page: number;
  pageSize?: number;
  /** Name or email (accents ignored), or phone digits. */
  q?: string;
  status?: Client["status"];
  sort?: "firstName" | "lastName" | "email" | "status" | "createdAt";
  dir?: "asc" | "desc";
}

export interface ClientPage {
  data: Client[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface Client {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string | null;
  gender?: "male" | "female" | "other" | "prefer_not_to_say" | null;
  profileImage?: string | null;
  status: "active" | "inactive" | "blocked";
  preferredLanguage?: string;
  preferredServices?: string[];
  preferredProfessionals?: string[];
  preferredTimes?: string[];
  communicationPreferences?: Record<string, any>;
  lastVisit?: string | null;
  lastReengagementSent?: string | null;
  visitCount?: number;
  totalSpent?: number;
  tags?: string[];
  notes?: string | null;
  loyaltyPoints?: number;
  loyaltyTier?: string;
  // P2A â€” Spanish tax compliance
  taxId?: string | null;
  taxIdType?: "nif" | "cif" | "nie" | "passport" | "other" | null;
}

/** A visit in the client file (GET /clients/:id): what, with whom, what it cost. */
export interface ClientAppointmentSummary {
  id: string;
  scheduledDate: string;
  scheduledTime: string;
  duration: number;
  status: "pending" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";
  /** Euros. */
  price: number | string;
  /** Cents: every service and add-on, after discounts. */
  totalAmount: number | string;
  /** Cents. */
  amountPaid: number | string;
  paymentStatus: string;
  notes?: string | null;
  service?: { id: string; name: string } | null;
  professional?: { id: string; firstName: string; lastName: string } | null;
  services?: Array<{
    id: string;
    order: number;
    service?: { id: string; name: string } | null;
    professional?: { id: string; firstName: string; lastName: string } | null;
  }>;
}

/** GET /clients/:id: the list row plus health data and the visits. */
export interface ClientDetail extends Client {
  allergies?: string[];
  medicalConditions?: string[];
  appointments: ClientAppointmentSummary[];
}

export interface Service {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  name: string;
  description?: string;
  category: "hair" | "nails" | "facial" | "massage" | "body" | "other";
  duration: number;
  /** Euros. Arrives as a string ("25.00", a Decimal column): Number() it. */
  price: number;
  currency: string;
  isActive: boolean;
  /** The salon's own view only (the public one leaves the settings out). */
  isOnlineBookable?: boolean;
  requiresApproval?: boolean;
  /** Hours of notice an online booking needs. */
  minAdvanceBooking?: number;
  /** Days ahead an online booking may be made. */
  maxAdvanceBooking?: number;
}

/** What the services panel sends; see lib/service-form.ts. */
export interface ServiceWrite {
  name: string;
  description?: string;
  category: "hair" | "nails" | "facial" | "massage" | "body" | "other";
  duration: number;
  price: number;
  currency: string;
  isActive?: boolean;
  isOnlineBookable?: boolean;
  requiresApproval?: boolean;
  minAdvanceBooking?: number;
  maxAdvanceBooking?: number;
}

export interface Professional {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  profileImage?: string;
  bio?: string;
  specialties: string[];
  // Portfolio fields
  portfolioImages: string[];
  yearsExperience?: number;
  languages: string[];
  certifications: string[];
  // End of portfolio fields
  position?: string;
  commissionRate?: number;
  hireDate?: string;
  isActive: boolean;
  /**
   * One entry per shift, several per day for a split shift:
   * `[{ day: "monday", openTime: "10:00", closeTime: "14:00" }, ...]`. Read it
   * with scheduleFromWorkingHours (lib/weekly-schedule.ts); older rows may
   * hold another shape.
   */
  workingHours?: unknown;
  /** Multi-local: where they work (GET /admin/professionals). */
  locations?: { locationId: string; isPrimary: boolean }[];
  // Services relation - populated by admin endpoints
  services?: {
    serviceId: string;
    service: {
      id: string;
      name: string;
      category: string;
    };
  }[];
}

export interface CreateClientDto {
  tenantId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: "male" | "female" | "other";
  profileImage?: string;
  taxId?: string;
  taxIdType?: "nif" | "cif" | "nie" | "passport" | "other";
}

export interface CreateAppointmentDto {
  /** Ignored by the backend, which decides the salon itself. */
  tenantId?: string;
  clientId?: string;
  clientInfo?: {
    firstName: string;
    lastName: string;
    /** Online bookings: phone required, email optional. */
    email?: string;
    phone?: string;
  };
  serviceId: string;
  professionalId: string;
  scheduledDate: string;
  scheduledTime: string;
  notes?: string;
  depositRequired?: boolean;
  depositAmount?: number;
  /** null clears the appointment's own rate (PATCH). */
  commissionRate?: number | null;
  /**
   * Public booking only: she ticked "No quiero recibir promociones ni
   * novedades del salón por email" / "Recibir los avisos de mi cita por
   * WhatsApp" (lib/public-booking.ts, BOOKING_CHOICE_TEXT).
   */
  refusesMarketingEmail?: boolean;
  wantsWhatsAppNotices?: boolean;
  /**
   * Public booking at one of the salon's locations, when it has several:
   * the professional must work there.
   */
  locationId?: string;
}

/**
 * POST /appointments/staff. A professional's own booking may leave out the
 * professional (the server uses theirs). `services`: a visit of several,
 * created with the appointment in one request; the server times them.
 * `allowOutsideHours`: an owner or manager confirmed booking in the past or
 * outside the hours (the server refuses with code OUTSIDE_HOURS otherwise).
 */
export interface StaffBookingRequest extends Omit<CreateAppointmentDto, "professionalId"> {
  professionalId?: string;
  services?: Array<{ serviceId: string; professionalId?: string; isParallel?: boolean }>;
  allowOutsideHours?: boolean;
}

// Notification types
export type NotificationType =
  | "appointment_created"
  | "appointment_reminder"
  | "appointment_cancelled"
  | "appointment_confirmed"
  | "appointment_completed"
  | "review_request"
  | "payment_received"
  | "payment_failed"
  | "refund_processed"
  | "promotion"
  | "news"
  | "special_offer"
  | "system_alert"
  | "account_update"
  | "password_change"
  | "new_appointment_assigned"
  | "schedule_change"
  | "new_message";

export interface Notification {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  userId?: string;
  clientId?: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  readAt?: string;
  archivedAt?: string;
  data?: Record<string, any>;
}

export interface NotificationPreferences {
  [key: string]: {
    email?: boolean;
    sms?: boolean;
    whatsapp?: boolean;
    inApp?: boolean;
    push?: boolean;
    appointmentReminders?: boolean;
    appointmentConfirmations?: boolean;
    promotions?: boolean;
    news?: boolean;
  };
}

export type NotificationChannel = "email" | "sms" | "whatsapp" | "inApp";

// Payment types
export interface Payment {
  id: string;
  tenantId: string;
  clientId?: string;
  appointmentId?: string;
  amount: number;
  currency: string;
  type:
    | "appointment"
    | "deposit"
    | "product"
    | "service"
    | "gift_card"
    | "membership"
    | "other";
  /** The server's PaymentStatus enum (a partial refund leaves it "paid"). */
  status: "pending" | "paid" | "failed" | "refunded";
  method: "card" | "cash" | "bizum" | "bank_transfer" | "wallet" | "gift_card" | "loyalty_points";
  /** Cents given back so far (refunds). */
  refundedAmount?: number;
  stripePaymentId?: string;
  stripeInvoiceId?: string;
  description?: string;
  metadata?: Record<string, any>;
  receiptUrl?: string;
  failureMessage?: string;
  isDeposit?: boolean;
  depositAmount?: number;
  remainingAmount?: number;
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  // Relations
  client?: {
    id: string;
    firstName: string;
    lastName: string;
    email?: string;
  };
  appointment?: {
    id: string;
    scheduledDate: string;
    status: string;
    service?: { name: string } | null;
  };
}

/** The Pagos page's cards (GET /payments/stats/summary), in cents. */
export interface PaymentSummary {
  /** Paid, net of refunds. */
  totalRevenue: number;
  totalTransactions: number;
  pendingAmount: number;
  refundedAmount: number;
  byMethod: { method: Payment["method"]; amount: number; count: number }[];
}

/** The Pagos page's filters, sent to the list, the summary and the CSV. */
export interface PaymentFilters {
  status?: Payment["status"];
  method?: Payment["method"];
  clientId?: string;
  /** YYYY-MM-DD (a salon day) or an ISO instant. */
  dateFrom?: string;
  dateTo?: string;
}

/** POST /payments/:id/refund's body (cents). `lines`: units of a till sale given back (products return to stock). */
export interface PaymentRefundBody {
  amount?: number;
  reason: string;
  lines?: Array<{ lineId: string; quantity: number }>;
}

/** GET /payments/:id/refund-lines: null saleId when the payment is not a till sale's own. */
export interface PaymentRefundLines {
  saleId: string | null;
  lines: RefundableSaleLine[];
}

/** POST /payments/:id/refund's answer. */
export interface PaymentRefundResult {
  refundedAmount: number;
  refundableAmount: number;
  /** Products back in stock. */
  restocked?: Array<{ productId: string; description: string; quantity: number }>;
  /** The appointment's issued invoice, which needs a rectificativa. */
  invoice: { id: string; number: string } | null;
  rectificationNeeded: boolean;
}

export interface StripeSettings {
  stripeMode: "test" | "live";
  /** Masked by the server (sk_test_…1234); sent back as is, it is kept. */
  stripeTestSecretKey: string | null;
  stripeTestPublishableKey: string | null;
  stripeLiveSecretKey: string | null;
  stripeLivePublishableKey: string | null;
  testSecretKeyConfigured?: boolean;
  liveSecretKeyConfigured?: boolean;
  isConfigured: boolean;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
  /** Set on plans charged per location (Empresa); same unit as price. */
  pricePerLocation?: number | null;
  interval: "month" | "year";
  features: string[];
  limits: {
    staff: number;
    clients: number;
    appointmentsPerMonth: number;
  };
}

export interface Subscription {
  id?: string;
  tenantId?: string;
  plan: string;
  legacyPlan?: string;
  subscriptionStatus?: string;
  status: "active" | "cancelled" | "past_due" | "trialing";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd?: string | null;
  cancelledAt?: string | null;
  readOnlyUntil?: string | null;
  maxLocations?: number;
  addons?: Record<string, any>;
  stripeSubscriptionId?: string;
  cancelAtPeriodEnd: boolean;
}

export interface SubscriptionInvoice {
  id: string;
  number: string | null;
  /** Amount in cents (Stripe amount_paid) */
  amount: number;
  currency: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | string;
  created: string;
  invoiceUrl?: string | null;
  pdfUrl?: string | null;
}

// Email Campaign Interfaces
export type CampaignStatus =
  | "draft"
  | "active"
  | "scheduled"
  | "sending"
  | "sent"
  | "cancelled"
  | "failed";
export type CampaignType =
  | "newsletter"
  | "promotion"
  | "announcement"
  | "reminder"
  | "review_request"
  | "loyalty"
  | "reengagement"
  | "custom";

export interface Promotion {
  id: string;
  name: string;
  description?: string;
  code: string;
  type: "PERCENTAGE" | "FIXED" | "BUY_X_GET_Y";
  value: number;
  minOrderValue?: number;
  maxUses?: number;
  maxUsesPerClient?: number;
  usedCount: number;
  startDate: string;
  endDate?: string;
  isActive: boolean;
}

export interface CreateReengagementCampaignDto {
  name: string;
  subject: string;
  previewText?: string;
  content: string;
  inactiveDaysThreshold: number;
  linkedPromotionId?: string;
  fromName?: string;
  replyTo?: string;
}

export interface EmailCampaign {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  name: string;
  subject: string;
  previewText?: string;
  content: string;
  campaignType: CampaignType;
  status: CampaignStatus;
  scheduledAt?: string;
  sentAt?: string;
  totalRecipients: number;
  emailsSent: number;
  emailsDelivered: number;
  emailsOpened: number;
  clicks: number;
  bounces: number;
  /** Recipients who marked it as spam (from Resend's webhook). */
  complaints: number;
  unsubscribes: number;
  fromName?: string;
  replyTo?: string;
  _count?: {
    recipients: number;
  };
}

/**
 * Whether the server can send campaigns and receive Resend's delivery
 * events. Without the webhook, opens, clicks and bounces cannot be known.
 */
export interface EmailCampaignTrackingStatus {
  sendingConfigured: boolean;
  trackingConfigured: boolean;
  /** Addresses this salon no longer emails (hard bounce or spam complaint). */
  suppressedAddresses: number;
}

export interface SendEmailCampaignResult {
  success: boolean;
  sentCount: number;
  failedCount: number;
  suppressedCount: number;
  /** Clients who said no to promotions in their account. */
  skippedCount?: number;
  /** Recipients dropped at send time: client deleted or no longer active. */
  droppedCount?: number;
}

export interface EmailCampaignTemplate {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  name: string;
  subject: string;
  previewText?: string;
  content: string;
  campaignType?: CampaignType;
  isDefault: boolean;
}

export interface EmailCampaignAnalytics {
  campaign: EmailCampaign;
  totalSent: number;
  totalDelivered: number;
  totalOpened: number;
  totalClicks: number;
  totalBounces: number;
  totalComplaints: number;
  openRate: number;
  clickRate: number;
  bounceRate: number;
  complaintRate: number;
  recentEvents: any[];
}

export interface CreateCampaignDto {
  name: string;
  subject: string;
  previewText?: string;
  content: string;
  campaignType: CampaignType;
  fromName?: string;
  replyTo?: string;
}

export interface CreateTemplateDto {
  name: string;
  subject: string;
  previewText?: string;
  content: string;
  campaignType?: CampaignType;
  isDefault?: boolean;
}

export interface SubscriptionUsage {
  staffCount: number;
  clientCount: number;
  appointmentsThisMonth: number;
  limits: {
    staff: number;
    clients: number;
    appointmentsPerMonth: number;
  };
}

/** How money goes into a wallet (top-up) or is handed back from it (withdrawal): real money. */
export type WalletTopUpMethod = "cash" | "card" | "bizum" | "bank_transfer";

export interface ClientWallet {
  id: string;
  clientId: string;
  tenantId: string;
  balance: number;
  currency: string;
  // No loyaltyPoints: the wallet column stopped moving in #120. Points are
  // in getClientLoyalty().
}

/** GET /virtual-receptionist/stats: the salon's own conversations. */
export interface ReceptionistStats {
  days: number;
  since: string;
  conversations: number;
  byChannel: Record<"web" | "whatsapp" | "facebook" | "instagram" | "telegram", number>;
  messages: { fromClients: number; fromReceptionist: number };
  bookings: number;
  handedOff: number;
  /** Null until replies have recorded their time. */
  avgResponseMs: number | null;
}

/** P2A-receptionist-v2 â€” add-on catalog entry (Phase 8 UI). */
export interface CatalogAddOn {
  id: string;
  key: string;
  name: string;
  description: string | null;
  monthlyPriceCents: number | null;
  currency: string;
  unlocks: string[];
  metered: boolean;
  isActive: boolean;
  /** False = "Próximamente": shown, not sold. */
  purchasable: boolean;
  sortOrder: number;
}

/** A client's recorded choice about promotions by email (a signed Consent). */
export interface MarketingConsentState {
  status: "granted" | "refused" | "none";
  decidedAt: string | null;
  text: string;
  /** Where it was made: "booking", "widget", "salon"; null otherwise. */
  source?: string | null;
}

export type NoticeChannel = "email" | "sms" | "whatsapp";

/** How a client gets her appointment notices (GET /consent/clients/:id/notices). */
export interface ClientNoticesState {
  channels: Record<NoticeChannel, boolean>;
  /** Her request for WhatsApp notices: when and where it was made. */
  whatsappRequest: MarketingConsentState;
  /** Can the salon send by each channel today? */
  available: Record<NoticeChannel, boolean>;
  /** Has she an email / a phone on file? */
  contact: { email: boolean; phone: boolean };
}

/** P2A-receptionist-v2 â€” tenant add-on entitlement. */
export interface TenantAddOnView {
  id: string;
  tenantId: string;
  addOn: CatalogAddOn;
  status: 'active' | 'past_due' | 'cancelled' | 'expired';
  isManualGrant: boolean;
  startedAt: string;
  currentPeriodEnd: string | null;
  cancelledAt: string | null;
}

/** P2A-receptionist-v2 â€” message bundles (metered) credit balance. */
export interface MessageBundlesBalance {
  creditsRemaining: number;
  creditsPurchasedTotal: number;
  creditsUsedTotal: number;
  lastTopupAt: string | null;
}

export interface CreatePaymentDto {
  tenantId: string;
  clientId?: string;
  appointmentId?: string;
  amount: number;
  currency?: string;
  paymentMethod: "card" | "cash" | "bank_transfer" | "wallet" | "gift_card";
}

// Social Integration Types
export type SocialPlatform =
  | "GOOGLE"
  | "FACEBOOK"
  | "INSTAGRAM"
  | "TWITTER"
  | "TIKTOK";
export type SocialConnectionStatus =
  | "PENDING"
  | "CONNECTED"
  | "DISCONNECTED"
  | "ERROR";

export interface SocialConnection {
  id: string;
  tenantId: string;
  platform: SocialPlatform;
  status: SocialConnectionStatus;
  accountName: string | null;
  accountUrl: string | null;
  profileImage: string | null;
  isActive: boolean;
  autoPost: boolean;
  notifyReviews: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Only what the salon entered: nothing is synced from Google. */
export interface GoogleBusinessProfile {
  id: string;
  tenantId: string;
  placeId: string | null;
  writeReviewUrl: string | null;
  enableReviewRequests: boolean;
}

export interface GoogleBusinessProfileState {
  profile: GoogleBusinessProfile | null;
  api: { available: false; reason: string };
}

export interface SocialPost {
  id: string;
  tenantId: string;
  content: string;
  mediaUrls: string[];
  linkUrl: string | null;
  platforms: SocialPlatform[];
  scheduledAt: string | null;
  publishedAt: string | null;
  status: string;
  platformPostId: string | null;
  platformUrl: string | null;
  errorMessage: string | null;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  createdAt: string;
  updatedAt: string;
}

export interface SocialAnalytics {
  totalPosts: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalClicks: number;
  engagementRate: string;
}

// P1 â€” Onboarding wizard types
export interface OnboardingStepDef {
  key: string;
  order: number;
  group: "linear_required" | "linear_optional" | "checklist_optional";
  titleI18nKey: string;
  descI18nKey: string;
  href: string | null;
  detectName: string;
  enabled: boolean;
}

export interface OnboardingStepStatus {
  status: "pending" | "done" | "skipped" | "dismissed";
  completedAt?: string;
  skippedAt?: string;
  dismissedAt?: string;
}

export interface OnboardingState {
  currentStep: number;
  steps: Record<string, OnboardingStepStatus>;
  checklistDismissed: boolean;
  finishedAt: string | null;
  defs: OnboardingStepDef[];
  detectResults: Record<string, boolean>;
}

// P1.4 â€” Rebooking types
export interface RebookingConfig {
  enabled: boolean;
  leadDays: number;
  channelFallback: "email" | "whatsapp" | "both";
  minVisits: number;
}

export interface ClientCadenceByService {
  avgDays: number;
  stdDevDays: number;
  lastVisit: string;
  visitsCount: number;
  nextExpectedAt: string;
}

export interface ClientCadence {
  clientId: string;
  tenantId: string;
  byService: Record<string, ClientCadenceByService>;
  nextRecommendedReminderAt: string | null;
  recommendedServiceId: string | null;
  reminderSentFor: Array<{
    serviceId: string;
    sentAt: string;
    channel: "email" | "whatsapp" | "both";
  }>;
  optedOut: boolean;
  lastComputedAt: string;
}

export interface RebookingReminder {
  id: string;
  tenantId: string;
  clientId: string;
  serviceId: string | null;
  scheduledAt: string;
  sentAt: string | null;
  channel: "email" | "whatsapp" | "both";
  status: "scheduled" | "sent" | "cancelled" | "failed" | "booked";
  resultAppointmentId: string | null;
  cancelledReason: string | null;
  createdAt: string;
}

// P2A â€” Fiscal Spain (Verifactu / TicketBAI / SII) types
export interface InvoiceLine {
  id?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountPct?: number;
  taxRate: number;
  taxCents?: number;
  totalCents?: number;
  productId?: string;
  serviceId?: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  series: string;
  number: string;
  issueDate: string;
  recipientType: "client" | "tenant";
  recipientId?: string | null;
  recipientName: string;
  recipientTaxId?: string | null;
  recipientAddress?: Record<string, unknown> | null;
  subtotalCents: number;
  taxBreakdown: Array<{
    rate: number;
    baseCents: number;
    taxCents: number;
  }>;
  totalCents: number;
  currency: string;
  status: "draft" | "issued" | "paid" | "cancelled" | "refunded";
  fiscalMode: "none" | "verifactu" | "ticketbai" | "sii_only";
  fiscalStatus: "not_required" | "pending" | "accepted" | "rejected" | "error";
  fiscalHash?: string | null;
  fiscalQrUrl?: string | null;
  fiscalXml?: string | null;
  fiscalReference?: string | null;
  fiscalError?: string | null;
  fiscalSubmittedAt?: string | null;
  sourceType: "order" | "appointment" | "manual" | "subscription";
  sourceId?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: InvoiceLine[];
}

export interface FiscalSettings {
  fiscalMode: "none" | "verifactu" | "ticketbai" | "sii_only";
  /** False while sending invoices to the AEAT is not available (production). */
  submissionAvailable?: boolean;
  fiscalSettings: {
    enabled?: boolean;
    syncOnIssue?: boolean;
    autoInvoiceAppointments?: boolean;
    defaultSeries?: string;
    defaultTaxRate?: number;
    diputacion?: "bizkaia" | "gipuzkoa" | "alava" | null;
    /** Territory tax regime: iva (peninsula/Baleares), igic (Canarias), ipsi (Ceuta/Melilla). */
    taxRegime?: TaxRegime;
    /**
     * The salon's prices already include the tax (true: an invoice splits
     * them into base + tax) or have it added on top (false, or missing for a
     * salon from before the setting).
     */
    pricesIncludeTax?: boolean;
    /** P2A â€” emitter NIF/CIF/NIE (mirrored to Tenant.taxId on the backend). */
    tenantNif?: string;
  };
  taxId?: string;
  taxIdType?: "nif" | "cif" | "nie" | "passport" | "other";
  legalName?: string;
}

export interface FiscalCertificate {
  id: string;
  tenantId: string;
  provider: "p12" | "cloud_dnie";
  alias: string;
  fingerprint: string;
  issuer?: string | null;
  subject?: string | null;
  notBefore?: string | null;
  notAfter?: string | null;
  isActive: boolean;
  createdAt: string;
}

// P2B â€” Accounting integrations
/**
 * Only Holded has a direct sync (the salon pastes its Holded API key). Sage,
 * A3 and NCS have no API we can use: their users download the libro de
 * facturas emitidas (downloadAccountingInvoiceBook) for their gestoría.
 */
export type AccountingProvider = "holded";

export type InvoiceAccountingStatus = "not_synced" | "pending" | "synced" | "error";

export interface AccountingStatus {
  syncOnIssue: boolean;
  connection: {
    provider: AccountingProvider;
    isActive: boolean;
    connectedAt: string;
    lastSyncAt: string | null;
    lastError: string | null;
  } | null;
  /** Issued invoices by accounting status. */
  invoices: Record<InvoiceAccountingStatus, number>;
}

export interface AccountingPushResult {
  attempted: number;
  synced: number;
  errors: number;
  skipped: number;
  remaining: number;
}

export interface AccountingSyncLog {
  id: string;
  invoiceId: string;
  provider: string;
  action: string;
  status: string;
  externalId: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/** GET /web-domain: the public page and the salon's own domain, if any. */
export interface WebDomainStatus {
  /** The free subdomain once live, otherwise the page on the app host. */
  publicUrl: string;
  /** salon-lucia.kiraroom.net; active once the wildcard certificate is in place. */
  subdomain?: null | { host: string; active: boolean };
  target: string;
  /** False until the operator serves customer domains over HTTPS. */
  servingEnabled: boolean;
  domain: null | {
    name: string;
    verified: boolean;
    verifiedAt: string | null;
    lastCheckedAt: string | null;
    lastCheckError: string | null;
    active: boolean;
    records: Array<{ type: "CNAME" | "A" | "TXT"; name: string; value: string }>;
    targetIps: string[];
  };
}

export interface ApiClientInterface {
  request<T>(endpoint: string, options?: RequestInit): Promise<T>;
  login(email: string, password: string, tenantSlug?: string): Promise<LoginResponse | TwoFactorRequired>;
  forgotPassword(email: string, tenantSlug?: string): Promise<{ message: string }>;
  resetPassword(token: string, password: string): Promise<{ message: string }>;
  verifyEmail(token: string): Promise<{ verified: boolean }>;
  register(data: {
    email: string;
    password: string;
    salonName: string;
    phone: string;
    ownerName: string;
    language?: string;
    acceptTerms: boolean;
  }): Promise<LoginResponse>;
  logout(): Promise<void>;
  sendVirtualReceptionistMessage(data: {
    clientId: string;
    salonId: string;
    message: string;
    channel: "whatsapp" | "web";
    metadata?: Record<string, any>;
  }): Promise<{
    id: string;
    content: string;
    provider: string;
    model: string;
    responseTime: number;
    requiresHandoff: boolean;
    intent: string;
  }>;
  getAppointments(filters?: {
    tenantId?: string;
    professionalId?: string;
    clientId?: string;
    clientEmail?: string;
    serviceId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    searchQuery?: string;
  }): Promise<Appointment[]>;
  getAppointment(id: string): Promise<Appointment>;
  getAppointmentActivity(id: string): Promise<any[]>;
  createAppointment(data: CreateAppointmentDto): Promise<Appointment>;
  updateAppointment(
    id: string,
    data: Partial<CreateAppointmentDto>,
  ): Promise<Appointment>;
  cancelAppointment(id: string, reason?: string): Promise<Appointment>;
  completeAppointment(id: string, notes?: string): Promise<Appointment>;
  markAppointmentNoShow(id: string): Promise<Appointment>;
  deleteAppointment(id: string): Promise<void>;
  getClients(tenantId?: string): Promise<Client[]>;
  getClientsPage(params: ClientListParams): Promise<ClientPage>;
  filterClients(filters: {
    gender?: string;
    minAge?: number;
    maxAge?: number;
    tags?: string[];
    loyaltyTier?: string;
    status?: string;
    minTotalSpent?: number;
    maxTotalSpent?: number;
    minVisits?: number;
    maxVisits?: number;
  }): Promise<Client[]>;
  getClient(id: string): Promise<ClientDetail>;
  createClient(data: CreateClientPayload & { tenantId?: string }): Promise<Client>;
  updateClient(id: string, data: UpdateClientPayload, options?: { asStaff?: boolean }): Promise<Client>;
  deleteClient(id: string): Promise<HistoryDeleteResult>;
  searchClientsForManager(query: string): Promise<ClientSearchRow[]>;
  mergeClient(targetId: string, sourceClientId: string): Promise<ClientMergeResult>;
  getServices(tenantId?: string): Promise<Service[]>;
  getService(id: string): Promise<Service>;
  createService(data: ServiceWrite): Promise<Service>;
  updateService(id: string, data: Partial<ServiceWrite>): Promise<Service>;
  deleteService(id: string): Promise<HistoryDeleteResult>;
  getProfessionalsPublic(tenantId?: string): Promise<Professional[]>;
  getProfessionals(tenantId?: string): Promise<Professional[]>;
  getProfessional(id: string): Promise<Professional>;
  getTimeOff(
    from: string,
    to: string,
    professionalId?: string,
    opts?: { includePending?: boolean },
  ): Promise<TimeOff[]>;
  previewTimeOff(input: TimeOffInput): Promise<{ conflicts: TimeOffConflict[] }>;
  createTimeOff(input: TimeOffInput): Promise<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }>;
  deleteTimeOff(id: string): Promise<{ deleted: boolean }>;
  getMyTimeOff(): Promise<TimeOff[]>;
  previewTimeOffRequest(input: TimeOffInput): Promise<{ conflicts: TimeOffConflict[] }>;
  createTimeOffRequest(input: TimeOffInput): Promise<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }>;
  cancelTimeOffRequest(id: string): Promise<{ deleted: boolean }>;
  getTimeOffRequests(status?: TimeOffStatus): Promise<TimeOff[]>;
  getTimeOffRequestCount(): Promise<{ count: number }>;
  approveTimeOff(id: string, note?: string | null): Promise<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }>;
  rejectTimeOff(id: string, note?: string | null): Promise<{ timeOff: TimeOff }>;
  createProfessional(data: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    profileImage?: string;
    bio?: string;
    specialties?: string[];
    portfolioImages?: string[];
    yearsExperience?: number;
    languages?: string[];
    certifications?: string[];
    position?: string;
    commissionRate?: number;
    hireDate?: string;
    serviceIds?: string[];
    /** Multi-local: the locations they work at and the main one; left out keeps them. */
    locationIds?: string[];
    primaryLocationId?: string | null;
  }): Promise<Professional>;
  updateProfessional(
    id: string,
    data: Partial<{
      tenantId: string;
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      profileImage?: string;
      bio?: string;
      specialties: string[];
      portfolioImages: string[];
      yearsExperience?: number;
      languages: string[];
      certifications: string[];
      position?: string;
      /** 0 is a rate; null clears it (the salon default applies); left out keeps it. */
      commissionRate?: number | null;
      hireDate?: string;
      isActive: boolean;
      serviceIds?: string[];
    /** Multi-local: the locations they work at and the main one; left out keeps them. */
    locationIds?: string[];
    primaryLocationId?: string | null;
    }>,
  ): Promise<Professional>;
  deleteProfessional(id: string): Promise<HistoryDeleteResult>;
  changeProfessionalPassword(
    professionalId: string,
    data: { newPassword: string },
  ): Promise<any>;
  getAvailableSlots(
    tenantId: string,
    professionalId: string,
    serviceId: string,
    date: string,
    professionalIds?: string[],
    locationId?: string,
  ): Promise<{ time: string; isAvailable: boolean }[]>;
  getNotifications(params?: {
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
    type?: string;
  }): Promise<{ data: Notification[]; total: number; unreadCount: number }>;
  getUnreadNotificationCount(): Promise<{ count: number }>;
  markNotificationAsRead(id: string): Promise<Notification>;
  markAllNotificationsAsRead(): Promise<{ success: boolean; count: number }>;
  archiveNotification(id: string): Promise<void>;
  getNotificationPreferences(): Promise<NotificationPreferences>;
  updateNotificationPreferences(
    preferences: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences>;

  // Payments
  getPayments(params?: PaymentFilters & {
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
  }): Promise<{
    payments: Payment[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }>;
  getPayment(id: string): Promise<Payment>;
  getTodayPayments(): Promise<any[]>;
  deletePayment(id: string): Promise<void>;
  createPayment(data: CreatePaymentDto): Promise<Payment>;
  refundPayment(id: string, body: PaymentRefundBody): Promise<PaymentRefundResult>;
  getPaymentRefundLines(id: string): Promise<PaymentRefundLines>;
  getPaymentByAppointment(appointmentId: string): Promise<Payment[]>;
  getPaymentByClient(clientId: string): Promise<Payment[]>;
  getPaymentSummary(filters?: PaymentFilters): Promise<PaymentSummary>;
  downloadPaymentsCsv(filters?: PaymentFilters): Promise<{ blob: Blob; filename: string }>;
  // Stripe Settings
  getStripeSettings(): Promise<StripeSettings>;
  updateStripeSettings(
    settings: Partial<StripeSettings>,
  ): Promise<{ success: boolean; stripeMode: string }>;
  getStripePublishableKey(): Promise<{ publishableKey: string | null }>;

  // Subscriptions
  getCurrentSubscription(): Promise<Subscription | null>;
  createSubscriptionCheckout(plan: string): Promise<{ url: string }>;
  changeSubscriptionPlan(plan: string): Promise<Subscription>;
  cancelSubscription(immediately?: boolean): Promise<Subscription>;
  getSubscriptionInvoices(limit?: number): Promise<SubscriptionInvoice[]>;
  getBillingPortalUrl(): Promise<{ url: string }>;
  getSubscriptionUsage(): Promise<SubscriptionUsage>;
  getSubscriptionPlans(): Promise<SubscriptionPlan[]>;

  // P2A-receptionist-v2 â€” add-ons catalog + per-tenant entitlement
  // (Phase 8 surfaces these in the billing dashboard).
  getAvailableAddOns(plan?: string): Promise<CatalogAddOn[]>;
  getTenantAddOns(): Promise<TenantAddOnView[]>;
  purchaseAddOn(addOnKey: string): Promise<{ status: string; currentPeriodEnd: string | null }>;
  cancelTenantAddOn(addOnKey: string): Promise<{ ok: boolean }>;

  // P2A-receptionist-v2 â€” AI usage counter for the billing dashboard.
  getAiUsage(): Promise<{ used: number; cap: number | null; resetsAt: string | null }>;

  // P2A-receptionist-v2 â€” message bundles (metered WhatsApp marketing + SMS).
  getMessageBundlesBalance(): Promise<MessageBundlesBalance>;

  // Client Wallet
  getClientWallet(clientId: string): Promise<ClientWallet>;
  depositToWallet(clientId: string, amountCents: number, method: WalletTopUpMethod, description?: string): Promise<unknown>;
  withdrawFromWallet(clientId: string, amountCents: number, method: WalletTopUpMethod, description?: string): Promise<unknown>;

  // POS
  getPosServices(): Promise<any[]>;
  getPosClients(search?: string): Promise<any[]>;
  getPosDashboard(date?: string): Promise<any>;
  posCheckout(data: any): Promise<PosSale>;
  posQuote(data: any): Promise<PosQuote>;
  getPosSaleProducts(search?: string): Promise<PosSaleProduct[]>;
  getPosReceipt(saleId: string): Promise<PosReceipt>;
  getPosSettings(): Promise<PosSettings>;
  savePosSettings(settings: PosSettings): Promise<PosSettings>;
  // The cash drawer (arqueo)
  getCurrentCashSession(): Promise<CashSessionCurrent>;
  openCashSession(body: { openingFloatCents: number; notes?: string }): Promise<CashSessionView>;
  addCashMovement(
    sessionId: string,
    body: { type: CashMovementType; amountCents: number; reason: string },
  ): Promise<CashMovementRow>;
  closeCashSession(
    sessionId: string,
    body: { countedCashCents: number; breakdown?: Record<string, number>; notes?: string },
  ): Promise<CashSessionView>;
  getCashSessions(params?: { from?: string; to?: string; page?: number; limit?: number }): Promise<CashSessionList>;
  getCashSession(sessionId: string): Promise<CashSessionView>;
  // Products
  getProducts(params?: {
    category?: string;
    search?: string;
    lowStock?: boolean;
  }): Promise<any[]>;
  getProduct(id: string): Promise<any>;
  createProduct(data: any): Promise<any>;
  updateProduct(id: string, data: any): Promise<any>;
  deleteProduct(id: string): Promise<{ deleted?: boolean; deactivated?: boolean } | void>;
  getProductCategories(): Promise<any[]>;
  createProductCategory(data: any): Promise<any>;
  getInventoryTransactions(params?: {
    productId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<any[]>;
  adjustInventory(data: {
    productId: string;
    type: string;
    quantity: number;
    reason?: string;
  }): Promise<any>;
  getOrders(params?: {
    status?: string;
    clientId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<any[]>;
  getOrder(id: string): Promise<any>;
  posQuickSale(data: {
    serviceId: string;
    paymentMethod: string;
    clientId?: string;
    saleId?: string;
  }): Promise<PosSale>;

  // Email Campaigns
  getEmailCampaigns(
    status?: string,
    campaignType?: string,
  ): Promise<EmailCampaign[]>;
  getEmailCampaign(id: string): Promise<EmailCampaign>;
  getEmailCampaignRecipients(id: string): Promise<any[]>;
  createEmailCampaign(data: CreateCampaignDto): Promise<EmailCampaign>;
  removeRecipientsFromCampaign(id: string, clientIds: string[]): Promise<any>;
  updateEmailCampaign(
    id: string,
    data: Partial<CreateCampaignDto>,
  ): Promise<EmailCampaign>;
  deleteEmailCampaign(id: string): Promise<void>;
  scheduleEmailCampaign(
    id: string,
    scheduledAt: string,
  ): Promise<EmailCampaign>;
  sendEmailCampaignNow(id: string): Promise<SendEmailCampaignResult>;
  sendEmailCampaignToAll(id: string): Promise<SendEmailCampaignResult>;
  addRecipientsToCampaign(id: string, clientIds: string[]): Promise<any>;
  getEmailCampaignAnalytics(id: string): Promise<EmailCampaignAnalytics>;
  getEmailCampaignTrackingStatus(): Promise<EmailCampaignTrackingStatus>;
  getEmailCampaignTemplates(): Promise<EmailCampaignTemplate[]>;
  getEmailCampaignTemplate(id: string): Promise<EmailCampaignTemplate>;
  createEmailCampaignTemplate(
    data: CreateTemplateDto,
  ): Promise<EmailCampaignTemplate>;
  deleteEmailCampaignTemplate(id: string): Promise<void>;
  broadcastEmailCampaign(
    data: CreateCampaignDto & { sendNow?: boolean },
  ): Promise<EmailCampaign>;
  // Re-engagement campaigns
  createReengagementCampaign(
    data: CreateReengagementCampaignDto,
  ): Promise<EmailCampaign>;
  activateEmailCampaign(id: string): Promise<EmailCampaign>;
  deactivateEmailCampaign(id: string): Promise<EmailCampaign>;
  getAvailablePromotions(): Promise<Promotion[]>;

  // Admin Settings
  getProfessionalCrossBookingSetting(): Promise<{
    allowProfessionalCrossBooking: boolean;
  }>;
  updateProfessionalCrossBookingSetting(
    allowProfessionalCrossBooking: boolean,
  ): Promise<{ allowProfessionalCrossBooking: boolean }>;

  // P1 â€” Onboarding wizard
  getOnboardingState(): Promise<OnboardingState>;
  skipOnboardingStep(key: string): Promise<{ ok: boolean }>;
  dismissOnboardingChecklist(): Promise<{ ok: boolean }>;
  restoreOnboardingChecklist(): Promise<{ ok: boolean }>;

  // P1.4 â€” Rebooking
  getRebookingConfig(): Promise<RebookingConfig>;
  updateRebookingConfig(
    patch: Partial<RebookingConfig>,
  ): Promise<RebookingConfig>;
  getRebookingPrediction(clientId: string): Promise<ClientCadence | null>;
  getRebookingLog(clientId: string): Promise<RebookingReminder[]>;
  optOutClientRebooking(clientId: string): Promise<{ ok: boolean }>;
  recomputeClientCadence(clientId: string): Promise<{ ok: boolean }>;

  // P2A â€” Invoices (Verifactu / TicketBAI / SII)
  listInvoices(filters?: {
    series?: string;
    status?: string;
    fromDate?: string;
    toDate?: string;
    limit?: number;
  }): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice>;
  createInvoice(input: {
    series?: string;
    issueDate?: string;
    recipientType?: "client" | "tenant";
    recipientId?: string;
    recipientName: string;
    recipientTaxId?: string;
    recipientAddress?: Record<string, unknown>;
    lines: Array<{
      description: string;
      quantity: number;
      unitPriceCents: number;
      discountPct?: number;
      taxRate: number;
      productId?: string;
      serviceId?: string;
      /**
       * The unit price already includes the tax (the salon's pricesIncludeTax).
       * Left out, the server adds the tax on top.
       */
      taxIncluded?: boolean;
    }>;
    notes?: string;
  }): Promise<{ id: string }>;
  /** A page of GET /invoices (lib/invoice-list.ts builds the query and reads the answer). */
  listInvoicesPage(query: Record<string, string>): Promise<unknown>;
  cancelInvoice(id: string, reason: string): Promise<Invoice>;
  /** A rectificativa of the invoice (series R): the whole of it without lines. */
  rectifyInvoice(
    id: string,
    body: {
      reason: string;
      lines?: Array<
        | { originalLineId: string; quantity: number }
        | { description: string; quantity: number; unitPriceCents: number; taxRate: number; taxIncluded: boolean }
      >;
    },
  ): Promise<{ id: string }>;
  /** Emails the invoice's PDF to its client, or to `to`. */
  emailInvoice(id: string, to?: string): Promise<{ sent: boolean; to: string }>;
  /**
   * The invoice's PDF or fiscal XML, fetched with the session's token. The
   * API's file name is not readable cross-origin: `filename` names the file.
   */
  downloadInvoiceFile(id: string, kind: "pdf" | "xml", filename?: string): Promise<{ blob: Blob; filename: string }>;
  resendFiscal(id: string): Promise<Invoice>;
  generateInvoiceFromOrder(orderId: string): Promise<{ id: string } | null>;
  generateInvoiceFromAppointment(
    appointmentId: string,
  ): Promise<{ id: string } | null>;

  // P2A â€” Fiscal settings
  getFiscalSettings(): Promise<FiscalSettings>;
  updateFiscalSettings(patch: {
    fiscalMode?: "none" | "verifactu" | "ticketbai" | "sii_only";
    defaultSeries?: string;
    defaultTaxRate?: number;
    autoInvoiceAppointments?: boolean;
    diputacion?: "bizkaia" | "gipuzkoa" | "alava" | null;
    /** Territory tax regime: iva (peninsula/Baleares), igic (Canarias), ipsi (Ceuta/Melilla). */
    taxRegime?: TaxRegime;
    pricesIncludeTax?: boolean;
    /** Emitter NIF/CIF/NIE â€” mirrored to Tenant.taxId on the backend. */
    tenantNif?: string;
    taxIdType?: "nif" | "cif" | "nie" | "passport" | "other";
    legalName?: string;
  }): Promise<FiscalSettings>;

  // P2A â€” Certificates
  listFiscalCertificates(): Promise<FiscalCertificate[]>;
  uploadFiscalCertificate(input: {
    alias: string;
    provider: "p12" | "cloud_dnie";
    encryptedPem: string;
    passphraseCipher?: string;
    fingerprint: string;
    issuer?: string;
    subject?: string;
    notBefore?: string;
    notAfter?: string;
  }): Promise<FiscalCertificate>;
  deactivateFiscalCertificate(id: string): Promise<{ count: number }>;

  // P2B â€” Accounting integrations
  getAccountingSettings(): Promise<AccountingStatus>;
  updateAccountingSettings(patch: { syncOnIssue?: boolean }): Promise<AccountingStatus>;
  connectHolded(apiKey: string): Promise<AccountingStatus>;
  disconnectAccounting(): Promise<{ ok: boolean }>;
  pushPendingToHolded(from?: string): Promise<AccountingPushResult>;
  syncAccountingInvoice(
    invoiceId: string,
  ): Promise<{ status: string; externalId?: string; error?: string }>;
  downloadAccountingInvoiceBook(
    from: string,
    to: string,
    format: "csv" | "xlsx",
  ): Promise<{ blob: Blob; filename: string }>;
  listAccountingLogs(limit?: number): Promise<AccountingSyncLog[]>;
  publicRebookingOptOut(
    token: string,
    clientId: string,
  ): Promise<{ ok: boolean }>;

  // Appointments
  createAppointmentByStaff(
    appointment: StaffBookingRequest,
  ): Promise<Appointment>;
}

class ApiClient implements ApiClientInterface {
  async request<T>(
    endpoint: string,
    options: RequestInit = {},
    retryCount = 0,
  ): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;
    const token = getToken();

    const headers: HeadersInit = {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    };

    const response = await fetch(url, {
      headers,
      // The refresh token is an httpOnly cookie on the API's host: sign-in
      // sets it and logout clears it only if the request carries credentials.
      credentials: "include",
      ...options,
    });

    // A 401 from a sign-in or password-reset form is the answer to what was
    // asked, so it is handed straight back with the server's message. Doing
    // the session-expiry dance here logged the message out of existence and
    // navigated away from the form. See isCredentialEndpoint.
    if (response.status === 401 && isCredentialEndpoint(endpoint)) {
      const errorData = await response.json().catch(() => ({}));
      throw new ApiError(errorData.message || "Invalid credentials", 401);
    }

    if (response.status === 401 && retryCount === 0) {
      // Critical: never try to refresh *the refresh endpoint* â€” that
      // would recurse infinitely if the refresh token itself is bad.
      const isRefreshCall = endpoint.startsWith("/auth/refresh");
      if (isRefreshCall) {
        removeToken();
      } else {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          // Retry the request with new token
          return this.request<T>(endpoint, options, retryCount + 1);
        }
        // Refresh failed, redirect to login
        removeToken();
      }
      const userJson = typeof window !== "undefined" ? localStorage.getItem("user") : null;
      const user = userJson ? JSON.parse(userJson) : null;
      const isSaasUser = user?.role === "saas_owner";
      const isClient = user?.role === "client";
      if (typeof window !== "undefined") {
        // Clear SaaS user cookie
        document.cookie = "saas_user=; path=/; max-age=0";
        // A client is signed out where they are (see loginRedirectTarget).
        if (isClient) localStorage.removeItem("user");
        // null when we are already on that login page -- navigating there
        // again would reload it and loop. See loginRedirectTarget.
        const target = loginRedirectTarget(window.location.pathname, isSaasUser, isClient);
        if (target) window.location.href = target;
      }
      // Throw a recognisable error so callers don't try to parse the
      // (already empty) body.
      throw new Error("Unauthorized");
    } else if (response.status === 401) {
      removeToken();
      const userJson = typeof window !== "undefined" ? localStorage.getItem("user") : null;
      const user = userJson ? JSON.parse(userJson) : null;
      const isSaasUser = user?.role === "saas_owner";
      const isClient = user?.role === "client";
      if (typeof window !== "undefined") {
        // Clear SaaS user cookie
        document.cookie = "saas_user=; path=/; max-age=0";
        // A client is signed out where they are (see loginRedirectTarget).
        if (isClient) localStorage.removeItem("user");
        // null when we are already on that login page -- navigating there
        // again would reload it and loop. See loginRedirectTarget.
        const target = loginRedirectTarget(window.location.pathname, isSaasUser, isClient);
        if (target) window.location.href = target;
      }
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      // A NestJS validation failure sends `message` as an array, one entry per
      // offending field: ["website must be a URL address"]. Passed straight to
      // Error it was coerced to a comma-joined blob, so a form could report a
      // 400 without naming the field that caused it. Joining as sentences is
      // what turns "Failed to update salon" into something actionable.
      const raw = errorData.message;
      const message = Array.isArray(raw)
        ? raw.join(". ")
        : raw || `API Error: ${response.status} ${response.statusText}`;
      throw new ApiError(
        message,
        response.status,
        typeof errorData.code === "string" ? errorData.code : undefined,
      );
    }
    return response.json();
  }

  // Auth
  /**
   * `tenantSlug`: pass it when a client signs in on a salon's site, so a
   * client of two salons lands in this one.
   */
  async login(email: string, password: string, tenantSlug?: string): Promise<LoginResponse | TwoFactorRequired> {
    const response = await this.request<{ user: any; tokens: any } | TwoFactorRequired>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password, ...(tenantSlug && { tenantSlug }) }),
      },
    );
    // Two-step verification: no session yet, the code comes next.
    if (isTwoFactorRequired(response)) return response;
    return this.startSession(response);
  }

  /** Second step of a sign-in with two-step verification. */
  async verifyTwoFactor(challenge: string, code: string): Promise<LoginResponse> {
    const response = await this.request<{ user: any; tokens: any }>("/auth/2fa/verify", {
      method: "POST",
      body: JSON.stringify({ challenge, code: code.trim() }),
    });
    return this.startSession(response);
  }

  async getTwoFactorStatus(): Promise<TwoFactorStatus> {
    return this.request("/auth/2fa");
  }

  async setupTwoFactor(): Promise<{ secret: string; otpauthUrl: string }> {
    return this.request("/auth/2fa/setup", { method: "POST" });
  }

  async enableTwoFactor(code: string): Promise<{ recoveryCodes: string[] }> {
    return this.request("/auth/2fa/enable", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
  }

  async disableTwoFactor(password: string, code: string): Promise<TwoFactorStatus> {
    return this.request("/auth/2fa/disable", {
      method: "POST",
      body: JSON.stringify({ password, code: code.trim() }),
    });
  }

  async regenerateRecoveryCodes(code: string): Promise<{ recoveryCodes: string[] }> {
    return this.request("/auth/2fa/recovery-codes", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
  }

  /**
   * The signed-in panel user changes their own password. Every other session
   * ends; this one continues with the new tokens the server answers with.
   */
  async changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
    const response = await this.request<{ user: any; tokens: any }>("/auth/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    this.startSession(response);
  }

  private startSession(response: { user: any; tokens: any }): LoginResponse {
    // The refresh token came as an httpOnly cookie; only the access token is ours.
    setToken(response.tokens.accessToken);
    removeRefreshToken();
    scheduleProactiveRefresh(response.tokens.accessToken);

    return {
      accessToken: response.tokens.accessToken,
      user: response.user,
    };
  }

  /** Emails a reset link if the address has an account (same answer either way). */
  async forgotPassword(email: string, tenantSlug?: string): Promise<{ message: string }> {
    return this.request("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email, ...(tenantSlug && { tenantSlug }) }),
    });
  }

  /** Sets a new password with the token from the reset email. */
  async resetPassword(token: string, password: string): Promise<{ message: string }> {
    return this.request("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    });
  }

  /**
   * Confirms an email address with the token from the welcome email. The
   * answer is { verified: false } for an unknown, used or expired token
   * rather than an error, so the server never says which.
   */
  async verifyEmail(token: string): Promise<{ verified: boolean }> {
    return this.request(`/auth/verify-email?token=${encodeURIComponent(token)}`);
  }

  /**
   * Single in-flight refresh promise. Concurrent 401s from polling
   * widgets (notifications, onboarding, invoices) used to each kick
   * off their own refresh, racing to delete each other's tokens.
   */
  private refreshInFlight: Promise<boolean> | null = null;

  async refreshAccessToken(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const promise = this.doRefreshAccessToken();
    this.refreshInFlight = promise;
    try {
      return await promise;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async doRefreshAccessToken(): Promise<boolean> {
    // Only a browser signed in before the cookie existed still has one here;
    // the server accepts it once more and moves it to the cookie.
    const legacyRefreshToken = getRefreshToken();
    const isClient = (() => {
      try {
        return JSON.parse(localStorage.getItem("user") || "null")?.role === "client";
      } catch {
        return false;
      }
    })();

    try {
      // Use raw fetch here â€” NOT `this.request` â€” to bypass the 401
      // handler. The /auth/refresh response on the wire returns the
      // new tokens at the TOP LEVEL of the JSON body (see
      // auth.service.ts:222-292 + auth.controller.ts:71-78), not
      // nested under `tokens`.
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ...(legacyRefreshToken && { refreshToken: legacyRefreshToken }),
          // A client on a salon's site has its own cookie, apart from the panel's.
          ...(isClient && { kind: "client" }),
        }),
      });

      if (!response.ok) {
        if (response.status === 401) removeRefreshToken();
        return false;
      }
      const data = (await response.json()) as {
        accessToken?: string;
        expiresIn?: number;
        tokenType?: string;
      };
      if (!data.accessToken) return false;

      setToken(data.accessToken);
      removeRefreshToken();
      scheduleProactiveRefresh(data.accessToken, data.expiresIn);
      return true;
    } catch {
      return false;
    }
  }

  async register(data: {
    email: string;
    password: string;
    salonName: string;
    phone: string;
    ownerName: string;
    language?: string;
    acceptTerms: boolean;
    /** The browser's IANA zone, a first guess at the salon's. */
    timezone?: string;
  }): Promise<LoginResponse> {
    /*
     * Signing up did not log anyone in.
     *
     * This claimed to return a LoginResponse — `{ accessToken, refreshToken,
     * user }` — and returned the backend's actual shape, which is
     * `{ user, tokens: { accessToken, refreshToken } }`. The generic on
     * `this.request` made TypeScript believe the lie, so nothing caught it.
     *
     * The signup page then did `if (res?.accessToken) { …store it… }` and
     * navigated to /dashboard either way. `res.accessToken` was always
     * undefined, so the branch never ran and no token was ever stored.
     *
     * In a clean browser that meant the new salon landed on a dashboard with
     * no session, got a 401 and was bounced to the login form seconds after
     * creating an account. In a browser that already held a session it was
     * worse: the old token stayed, and every tenant endpoint answered 403
     * "Forbidden resource" because the roles did not match the new tenant.
     *
     * So register now stores the tokens and flattens the response, exactly as
     * login does. Same shape, same side effects, one code path.
     */
    const response = await this.request<{ user: any; tokens: any }>(
      "/auth/register",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );

    setToken(response.tokens.accessToken);
    removeRefreshToken();
    scheduleProactiveRefresh(response.tokens.accessToken);

    return {
      accessToken: response.tokens.accessToken,
      user: response.user,
    };
  }

  /**
   * Signs this browser out on the server too: it revokes the session and
   * clears the refresh cookie. Emptying localStorage alone is not enough any
   * more, since the next page load would renew the session from the cookie.
   */
  async logout(): Promise<void> {
    try {
      if (getToken()) await this.request("/auth/logout", { method: "POST" });
    } catch {
      // Offline or already signed out: the local tokens still go.
    } finally {
      removeToken();
      removeRefreshToken();
    }
  }

  // Appointments
  async getAppointments(filters?: {
    tenantId?: string;
    professionalId?: string;
    clientId?: string;
    clientEmail?: string;
    serviceId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    searchQuery?: string;
  }): Promise<Appointment[]> {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.append(key, value);
      });
    }

    const query = params.toString();
    const endpoint = query ? `/appointments?${query}` : "/appointments";

    return this.request<Appointment[]>(endpoint);
  }

  async getAppointment(id: string): Promise<Appointment> {
    return this.request<Appointment>(`/appointments/${id}`);
  }

  async getAppointmentActivity(id: string): Promise<any[]> {
    return this.request<any[]>(`/appointments/${id}/activity`);
  }

  async createAppointment(data: CreateAppointmentDto): Promise<Appointment> {
    return this.request<Appointment>("/appointments", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async createAppointmentByStaff(
    data: StaffBookingRequest,
  ): Promise<Appointment> {
    return this.request<Appointment>("/appointments/staff", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateAppointment(
    id: string,
    data: Partial<CreateAppointmentDto>,
  ): Promise<Appointment> {
    return this.request<Appointment>(`/appointments/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async cancelAppointment(id: string, reason?: string): Promise<Appointment> {
    // PUT: the backend route is `@Put(":id/cancel")`; POST was a 404.
    return this.request<Appointment>(`/appointments/${id}/cancel`, {
      method: "PUT",
      body: JSON.stringify({ reason }),
    });
  }

  // Completing and marking a no-show have their own routes, like cancelling:
  // they set off the invoice, the cadence and the notices, which a PATCH of
  // `status` used to skip (the server now routes that the same way too).
  async completeAppointment(id: string, notes?: string): Promise<Appointment> {
    return this.request<Appointment>(`/appointments/${id}/complete`, {
      method: "PUT",
      body: JSON.stringify({ notes }),
    });
  }

  async markAppointmentNoShow(id: string): Promise<Appointment> {
    return this.request<Appointment>(`/appointments/${id}/no-show`, {
      method: "PUT",
    });
  }

  async deleteAppointment(id: string): Promise<void> {
    return this.request<void>(`/appointments/${id}`, {
      method: "DELETE",
    });
  }

  // Appointment Services - Multi-service support
  async getAppointmentServices(
    appointmentId: string,
  ): Promise<AppointmentService[]> {
    return this.request<AppointmentService[]>(
      `/appointment-services/appointment/${appointmentId}`,
    );
  }

  async getAppointmentService(id: string): Promise<AppointmentService> {
    return this.request<AppointmentService>(`/appointment-services/${id}`);
  }

  async createAppointmentService(data: {
    appointmentId: string;
    serviceId: string;
    professionalId?: string;
    scheduledStart?: string;
    scheduledEnd?: string;
    type?: "active" | "processing" | "continuation";
    isParallel?: boolean;
    order?: number;
    notes?: string;
  }): Promise<AppointmentService> {
    return this.request<AppointmentService>("/appointment-services", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateAppointmentService(
    id: string,
    data: Partial<{
      professionalId: string;
      scheduledStart: string;
      scheduledEnd: string;
      actualStart: string;
      actualEnd: string;
      type: "active" | "processing" | "continuation";
      isParallel: boolean;
      order: number;
      status: "pending" | "active" | "processing" | "completed" | "cancelled";
      notes: string;
    }>,
  ): Promise<AppointmentService> {
    return this.request<AppointmentService>(`/appointment-services/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteAppointmentService(id: string): Promise<void> {
    return this.request<void>(`/appointment-services/${id}`, {
      method: "DELETE",
    });
  }

  async startAppointmentService(id: string): Promise<AppointmentService> {
    return this.request<AppointmentService>(
      `/appointment-services/${id}/start`,
      {
        method: "POST",
      },
    );
  }

  async completeAppointmentService(id: string): Promise<AppointmentService> {
    return this.request<AppointmentService>(
      `/appointment-services/${id}/complete`,
      {
        method: "POST",
      },
    );
  }

  async cancelAppointmentService(id: string): Promise<AppointmentService> {
    return this.request<AppointmentService>(
      `/appointment-services/${id}/cancel`,
      {
        method: "POST",
      },
    );
  }

  async bulkCreateAppointmentServices(
    appointmentId: string,
    services: Array<{
      serviceId: string;
      professionalId?: string;
      scheduledStart?: string;
      scheduledEnd?: string;
      type?: "active" | "processing" | "continuation";
      isParallel?: boolean;
      order?: number;
      notes?: string;
    }>,
  ): Promise<AppointmentService[]> {
    return this.request<AppointmentService[]>(
      `/appointment-services/bulk/${appointmentId}`,
      {
        method: "POST",
        body: JSON.stringify(services),
      },
    );
  }

  async reorderAppointmentServices(
    appointmentId: string,
    serviceOrders: Array<{ serviceId: string; order: number }>,
  ): Promise<AppointmentService[]> {
    return this.request<AppointmentService[]>(
      `/appointment-services/appointment/${appointmentId}/reorder`,
      {
        method: "PUT",
        body: JSON.stringify(serviceOrders),
      },
    );
  }

  /**
   * Drags one service of a multi-service appointment: the whole visit, or
   * only this service (owners and managers). The server checks every
   * professional's agenda and that the client is never in two places.
   */
  async moveAppointmentService(
    id: string,
    /** minutesDelta: how far it moves, not a clock time (see MoveVisitServiceDto). */
    data: { scope: "visit" | "service"; minutesDelta: number; professionalId?: string },
  ): Promise<{ appointmentId: string; moved: number; scheduledDate?: string; scheduledTime?: string; duration?: number }> {
    return this.request(`/appointment-services/${id}/move`, { method: "PUT", body: JSON.stringify(data) });
  }

  async updateAppointmentServiceTiming(
    id: string,
    scheduledStart: string,
    scheduledEnd: string,
  ): Promise<AppointmentService> {
    return this.request<AppointmentService>(
      `/appointment-services/${id}/timing`,
      {
        method: "PUT",
        body: JSON.stringify({ scheduledStart, scheduledEnd }),
      },
    );
  }

  async toggleAppointmentServiceMode(
    id: string,
    isParallel: boolean,
  ): Promise<AppointmentService> {
    return this.request<AppointmentService>(
      `/appointment-services/${id}/mode`,
      {
        method: "PUT",
        body: JSON.stringify({ isParallel }),
      },
    );
  }

  // Clients - Public routes
  async getClients(tenantId?: string): Promise<Client[]> {
    const params = tenantId ? `?tenantId=${tenantId}` : "";
    return this.request<Client[]>(`/clients${params}`);
  }

  /** One page of the clients list, searched and filtered by the server. */
  async getClientsPage(params: ClientListParams): Promise<ClientPage> {
    const query = new URLSearchParams({ page: String(params.page) });
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    if (params.q?.trim()) query.set("q", params.q.trim());
    if (params.status) query.set("status", params.status);
    if (params.sort) query.set("sort", params.sort);
    if (params.dir) query.set("dir", params.dir);
    return this.request<ClientPage>(`/clients?${query.toString()}`);
  }

  async filterClients(filters: {
    gender?: string;
    minAge?: number;
    maxAge?: number;
    tags?: string[];
    loyaltyTier?: string;
    status?: string;
    minTotalSpent?: number;
    maxTotalSpent?: number;
    minVisits?: number;
    maxVisits?: number;
  }): Promise<Client[]> {
    const params = new URLSearchParams();
    if (filters.gender) params.append("gender", filters.gender);
    if (filters.minAge) params.append("minAge", filters.minAge.toString());
    if (filters.maxAge) params.append("maxAge", filters.maxAge.toString());
    if (filters.tags?.length) params.append("tags", filters.tags.join(","));
    if (filters.loyaltyTier) params.append("loyaltyTier", filters.loyaltyTier);
    if (filters.status) params.append("status", filters.status);
    if (filters.minTotalSpent)
      params.append("minTotalSpent", filters.minTotalSpent.toString());
    if (filters.maxTotalSpent)
      params.append("maxTotalSpent", filters.maxTotalSpent.toString());
    if (filters.minVisits)
      params.append("minVisits", filters.minVisits.toString());
    if (filters.maxVisits)
      params.append("maxVisits", filters.maxVisits.toString());

    return this.request<Client[]>(`/clients/filter?${params.toString()}`);
  }

  /**
   * A client's file. /clients/:id, not /admin/clients/:id: staff may read
   * the clients they serve (the server answers 404 for the others).
   */
  async getClient(id: string): Promise<ClientDetail> {
    return this.request<ClientDetail>(`/clients/${id}`);
  }

  /** The tenant is taken from the token; a `tenantId` here is ignored. */
  async createClient(data: CreateClientPayload & { tenantId?: string }): Promise<Client> {
    return this.request<Client>("/clients", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /**
   * Owner/admin edit through /admin/clients/:id. Staff go through
   * /clients/:id, which lets them edit the clients they serve (not the
   * email or the status).
   */
  async updateClient(
    id: string,
    data: UpdateClientPayload,
    options: { asStaff?: boolean } = {},
  ): Promise<Client> {
    const path = options.asStaff ? `/clients/${id}` : `/admin/clients/${id}`;
    return this.request<Client>(path, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteClient(id: string): Promise<HistoryDeleteResult> {
    return this.request<HistoryDeleteResult>(`/admin/clients/${id}`, {
      method: "DELETE",
    });
  }

  /** Owner/admin: the salon's clients matching a name, email or phone (10 at most). */
  async searchClientsForManager(query: string): Promise<ClientSearchRow[]> {
    const params = new URLSearchParams({ search: query, limit: "10", page: "1" });
    const res = await this.request<{ data: ClientSearchRow[] }>(`/admin/clients?${params.toString()}`);
    return res.data ?? [];
  }

  /**
   * Owner/admin: everything `sourceClientId` has moves to `targetId`, and
   * the source record is deleted (see the backend's client-merge.service).
   */
  async mergeClient(targetId: string, sourceClientId: string): Promise<ClientMergeResult> {
    return this.request<ClientMergeResult>(`/admin/clients/${targetId}/merge`, {
      method: "POST",
      body: JSON.stringify({ sourceClientId }),
    });
  }

  // Services
  async getServices(tenantId?: string): Promise<Service[]> {
    const params = tenantId ? `?tenantId=${tenantId}` : "";
    return this.request<Service[]>(`/services${params}`);
  }

  async getService(id: string): Promise<Service> {
    return this.request<Service>(`/services/${id}`);
  }

  async createService(data: ServiceWrite): Promise<Service> {
    return this.request<Service>("/services", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateService(id: string, data: Partial<ServiceWrite>): Promise<Service> {
    // PUT: the backend route is `@Put(":id")`; PATCH was a 404, so no
    // service could be edited or toggled from the dashboard.
    return this.request<Service>(`/services/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteService(id: string): Promise<HistoryDeleteResult> {
    return this.request<HistoryDeleteResult>(`/services/${id}`, {
      method: "DELETE",
    });
  }

  // Professionals - Public routes
  async getProfessionalsPublic(tenantId?: string): Promise<Professional[]> {
    const params = tenantId ? `?tenantId=${tenantId}` : "";
    return this.request<Professional[]>(`/professionals${params}`);
  }

  // Public tenant resolution (no auth required)
  async getPublicTenant(slug: string): Promise<{
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    phone: string | null;
    email: string | null;
    description: string | null;
  }> {
    return this.request(`/public-site/tenant/${encodeURIComponent(slug)}`);
  }

  // Everything the salon's public page shows, opening hours included (no auth).
  async getPublicSalonPage(slug: string): Promise<PublicSalonPage> {
    return this.request<PublicSalonPage>(`/public-site/page/${encodeURIComponent(slug)}`);
  }

  // The salon's own domain (bring-your-own; nothing is bought here).
  async getWebDomain(): Promise<WebDomainStatus> {
    return this.request<WebDomainStatus>("/web-domain");
  }

  async setWebDomain(domain: string): Promise<WebDomainStatus> {
    return this.request<WebDomainStatus>("/web-domain", {
      method: "PUT",
      body: JSON.stringify({ domain }),
    });
  }

  async verifyWebDomain(): Promise<WebDomainStatus> {
    return this.request<WebDomainStatus>("/web-domain/verify", { method: "POST" });
  }

  async removeWebDomain(): Promise<WebDomainStatus> {
    return this.request<WebDomainStatus>("/web-domain", { method: "DELETE" });
  }

  // Professionals - Admin routes
  /**
   * The whole team (the salon is the caller's, from the token; `tenantId`
   * is ignored). Without a limit the server answered the first 10, so an
   * 11th professional was missing from every screen that lists the team.
   */
  async getProfessionals(_tenantId?: string): Promise<Professional[]> {
    const response = await this.request<{
      data: Professional[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }>(`/admin/professionals?limit=${MAX_TEAM_PAGE}`);
    return response.data;
  }

  async getProfessional(id: string): Promise<Professional> {
    return this.request<Professional>(`/admin/professionals/${id}`);
  }

  /** Appointments still to happen (today on) of a professional: what deactivating leaves to reassign. */
  async getProfessionalUpcomingCount(id: string): Promise<{ count: number }> {
    return this.request<{ count: number }>(`/admin/professionals/${id}/upcoming-appointments`);
  }

  // Time off and salon closures. The salon is the caller's, from the token.
  async getTimeOff(
    from: string,
    to: string,
    professionalId?: string,
    opts: { includePending?: boolean } = {},
  ): Promise<TimeOff[]> {
    const params = new URLSearchParams({ from, to });
    if (professionalId) params.set("professionalId", professionalId);
    // Owner and admin only; the server ignores it for staff.
    if (opts.includePending) params.set("includePending", "true");
    return this.request<TimeOff[]>(`/time-off?${params.toString()}`);
  }

  // The appointments a block would clash with; nothing is saved.
  async previewTimeOff(input: TimeOffInput): Promise<{ conflicts: TimeOffConflict[] }> {
    return this.request<{ conflicts: TimeOffConflict[] }>("/time-off/preview", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createTimeOff(input: TimeOffInput): Promise<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }> {
    return this.request<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }>("/time-off", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async deleteTimeOff(id: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>(`/time-off/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // Time off requests. A professional asks for their own (who it is for comes
  // from the session); the owner or a manager approves or rejects it.
  async getMyTimeOff(): Promise<TimeOff[]> {
    return this.request<TimeOff[]>("/time-off/requests/mine");
  }

  async previewTimeOffRequest(input: TimeOffInput): Promise<{ conflicts: TimeOffConflict[] }> {
    return this.request<{ conflicts: TimeOffConflict[] }>("/time-off/requests/preview", {
      method: "POST",
      body: JSON.stringify(requestBody(input)),
    });
  }

  async createTimeOffRequest(input: TimeOffInput): Promise<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }> {
    return this.request<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }>("/time-off/requests", {
      method: "POST",
      body: JSON.stringify(requestBody(input)),
    });
  }

  async cancelTimeOffRequest(id: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>(`/time-off/requests/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async getTimeOffRequests(status: TimeOffStatus = "pending"): Promise<TimeOff[]> {
    return this.request<TimeOff[]>(`/time-off/requests?status=${encodeURIComponent(status)}`);
  }

  async getTimeOffRequestCount(): Promise<{ count: number }> {
    return this.request<{ count: number }>("/time-off/requests/count");
  }

  async approveTimeOff(id: string, note?: string | null): Promise<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }> {
    return this.request<{ timeOff: TimeOff; conflicts: TimeOffConflict[] }>(
      `/time-off/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: JSON.stringify(note ? { note } : {}) },
    );
  }

  async rejectTimeOff(id: string, note?: string | null): Promise<{ timeOff: TimeOff }> {
    return this.request<{ timeOff: TimeOff }>(`/time-off/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {}),
    });
  }

  async createProfessional(data: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    profileImage?: string;
    bio?: string;
    specialties?: string[];
    portfolioImages?: string[];
    yearsExperience?: number;
    languages?: string[];
    certifications?: string[];
    position?: string;
    commissionRate?: number;
    hireDate?: string;
    serviceIds?: string[];
    /** Multi-local: the locations they work at and the main one; left out keeps them. */
    locationIds?: string[];
    primaryLocationId?: string | null;
    workingHours?: WorkingHoursEntry[];
  }): Promise<Professional> {
    return this.request<Professional>("/admin/professionals", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateProfessional(
    id: string,
    data: Partial<{
      tenantId: string;
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      profileImage?: string;
      bio?: string;
      specialties: string[];
      portfolioImages: string[];
      yearsExperience?: number;
      languages: string[];
      certifications: string[];
      position?: string;
      /** 0 is a rate; null clears it (the salon default applies); left out keeps it. */
      commissionRate?: number | null;
      hireDate?: string;
      isActive: boolean;
      serviceIds?: string[];
    /** Multi-local: the locations they work at and the main one; left out keeps them. */
    locationIds?: string[];
    primaryLocationId?: string | null;
      /** Owners and admins only; leave it out to keep the current schedule. */
      workingHours: WorkingHoursEntry[];
    }>,
  ): Promise<Professional> {
    return this.request<Professional>(`/admin/professionals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteProfessional(id: string): Promise<HistoryDeleteResult> {
    return this.request<HistoryDeleteResult>(`/admin/professionals/${id}`, {
      method: "DELETE",
    });
  }

  /** Gives a professional their own login, with a first password (also: a new one, or back after removal). */
  async grantProfessionalAccess(professionalId: string, password: string): Promise<{ active: boolean; email: string }> {
    return this.request(`/admin/professionals/${professionalId}/access`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  async revokeProfessionalAccess(professionalId: string): Promise<{ active: boolean }> {
    return this.request(`/admin/professionals/${professionalId}/access`, { method: "DELETE" });
  }

  async changeProfessionalPassword(
    professionalId: string,
    data: { newPassword: string },
  ): Promise<any> {
    return this.request<any>(
      `/admin/professionals/${professionalId}/password`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
    );
  }

  // Availability
  async getAvailableSlots(
    tenantId: string,
    professionalId: string,
    serviceId: string,
    date: string,
    professionalIds?: string[],
    /** One of the salon's locations (multi-local): only who works there. */
    locationId?: string,
  ): Promise<{ time: string; isAvailable: boolean }[]> {
    let endpoint = `/appointments/available-slots?tenantId=${tenantId}&serviceId=${serviceId}&date=${date}`;

    // Add professionalIds if provided (for multi-professional scheduling)
    if (professionalIds && professionalIds.length > 0) {
      endpoint += `&professionalIds=${professionalIds.join(",")}`;
    } else if (professionalId) {
      endpoint += `&professionalId=${professionalId}`;
    }
    if (locationId) {
      endpoint += `&locationId=${encodeURIComponent(locationId)}`;
    }

    return this.request<{ time: string; isAvailable: boolean }[]>(endpoint);
  }

  // Notifications
  async getNotifications(params?: {
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
    type?: string;
  }): Promise<{ data: Notification[]; total: number; unreadCount: number }> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.append("limit", params.limit.toString());
    if (params?.offset) searchParams.append("offset", params.offset.toString());
    if (params?.unreadOnly) searchParams.append("unreadOnly", "true");
    if (params?.type) searchParams.append("type", params.type);

    const query = searchParams.toString();
    const endpoint = query ? `/notifications?${query}` : "/notifications";

    return this.request<{
      data: Notification[];
      total: number;
      unreadCount: number;
    }>(endpoint);
  }

  async getUnreadNotificationCount(): Promise<{ count: number }> {
    return this.request<{ count: number }>("/notifications/unread-count");
  }

  async markNotificationAsRead(id: string): Promise<Notification> {
    return this.request<Notification>(`/notifications/${id}/read`, {
      method: "PUT",
    });
  }

  async markAllNotificationsAsRead(): Promise<{
    success: boolean;
    count: number;
  }> {
    return this.request<{ success: boolean; count: number }>(
      "/notifications/read-all",
      {
        method: "PUT",
      },
    );
  }

  async archiveNotification(id: string): Promise<void> {
    return this.request<void>(`/notifications/${id}`, {
      method: "DELETE",
    });
  }

  async getNotificationPreferences(): Promise<NotificationPreferences> {
    return this.request<NotificationPreferences>("/notifications/preferences");
  }

  async updateNotificationPreferences(
    preferences: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    return this.request<NotificationPreferences>("/notifications/preferences", {
      method: "PUT",
      body: JSON.stringify(preferences),
    });
  }

  /** Both marketing choices of a client, for the client file. */
  async getClientMarketingConsent(
    clientId: string,
  ): Promise<{ email: MarketingConsentState; whatsapp: MarketingConsentState }> {
    return this.request(`/consent/clients/${clientId}/marketing`);
  }

  /**
   * Everything the salon holds about a client (RGPD arts. 15 and 20), as the
   * JSON document to hand her. Owner / admin only.
   */
  async exportClientData(clientId: string): Promise<Record<string, unknown> & { generatedAt: string }> {
    return this.request(`/admin/clients/${clientId}/export`);
  }

  /** Erase a client's personal data, keeping visits and invoices (RGPD art. 17). */
  async anonymizeClient(clientId: string): Promise<{ ok: true }> {
    return this.request(`/admin/clients/${clientId}/anonymize`, { method: "POST" });
  }

  /** The salon records a WhatsApp choice the client made in person. */
  async setClientWhatsAppMarketingConsent(
    clientId: string,
    accepts: boolean,
    confirmedInPerson = false,
  ): Promise<MarketingConsentState> {
    return this.request<MarketingConsentState>(`/consent/clients/${clientId}/whatsapp-marketing`, {
      method: "PUT",
      body: JSON.stringify({ accepts, confirmedInPerson }),
    });
  }

  /**
   * The salon writes down that the client does not want promotions by
   * email. Only a refusal: the server never takes an acceptance from the salon.
   */
  async recordClientEmailMarketingRefusal(clientId: string): Promise<MarketingConsentState> {
    return this.request<MarketingConsentState>(`/consent/clients/${clientId}/marketing`, {
      method: "PUT",
      body: JSON.stringify({ accepts: false }),
    });
  }

  /** How the client gets her appointment notices, for the client file. */
  async getClientNotices(clientId: string): Promise<ClientNoticesState> {
    return this.request<ClientNoticesState>(`/consent/clients/${clientId}/notices`);
  }

  /**
   * Turns channels of her appointment notices on or off. WhatsApp on needs
   * `clientAsked`: the team member confirms she asked for it.
   */
  async setClientNotices(
    clientId: string,
    changes: Partial<Record<NoticeChannel, boolean>> & { clientAsked?: boolean },
  ): Promise<ClientNoticesState> {
    return this.request<ClientNoticesState>(`/consent/clients/${clientId}/notices`, {
      method: "PUT",
      body: JSON.stringify(changes),
    });
  }

  async sendVirtualReceptionistMessage(data: {
    clientId: string;
    /** The signed visitor id the previous answer issued (lib/chat-visitor.ts). */
    visitorToken?: string;
    salonId: string;
    message: string;
    channel: "whatsapp" | "web";
    metadata?: Record<string, any>;
  }): Promise<{
    id: string;
    content: string;
    provider: string;
    model: string;
    responseTime: number;
    requiresHandoff: boolean;
    intent: string;
    visitorToken?: string;
  }> {
    return this.request("/virtual-receptionist/messages", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Payments
  async getPayments(params?: PaymentFilters & {
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
  }): Promise<{
    payments: Payment[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const query = paymentQuery(params ?? {});
    return this.request<{
      payments: Payment[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }>(`/payments${query ? `?${query}` : ""}`);
  }

  /** Signed ICS feed tokens for the caller's salon (owner/admin). */
  async getIcsTokens(): Promise<IcsFeedTokens> {
    return this.request("/ics/tokens");
  }

  /** Revokes every calendar link of the salon and returns the new ones. */
  async rotateIcsTokens(): Promise<IcsFeedTokens> {
    return this.request("/ics/tokens/rotate", { method: "POST" });
  }

  // Get today's payments for POS
  // An array: PaymentsService.getTodayPayments returns the rows themselves.
  // This was typed as { payments, totals }, which nothing returns.
  async getTodayPayments(): Promise<any[]> {
    return this.request<any[]>("/payments/today");
  }

  // Delete/cancel a payment (admin only)
  async deletePayment(id: string): Promise<void> {
    return this.request<void>(`/payments/${id}`, {
      method: "DELETE",
    });
  }

  async getPayment(id: string): Promise<Payment> {
    return this.request<Payment>(`/payments/${id}`);
  }

  async createPayment(data: CreatePaymentDto): Promise<Payment> {
    return this.request<Payment>("/payments", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** Gives back all or part of a charge (owner/admin). No amount: all that is left (or what the lines are worth). */
  async refundPayment(id: string, body: PaymentRefundBody): Promise<PaymentRefundResult> {
    return this.request<PaymentRefundResult>(`/payments/${id}/refund`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** The lines of the till sale a payment paid, with what is left to give back of each (owner/admin). */
  async getPaymentRefundLines(id: string): Promise<PaymentRefundLines> {
    return this.request<PaymentRefundLines>(`/payments/${id}/refund-lines`);
  }

  async getPaymentByAppointment(appointmentId: string): Promise<Payment[]> {
    return this.request<Payment[]>(`/payments/appointment/${appointmentId}`);
  }

  async getPendingPaymentAppointments(params?: {
    searchQuery?: string;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
  }): Promise<any[]> {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<any[]>(`/appointments/pending-payment${query ? `?${query}` : ""}`);
  }

  async getAppointmentsWithPayment(params?: {
    searchQuery?: string;
    dateFrom?: string;
    dateTo?: string;
    status?: string;
  }): Promise<any[]> {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<any[]>(`/appointments/pending-payment${query ? `?${query}` : ""}`);
  }

  async updateAppointmentPayment(
    appointmentId: string,
    data: { status: string; amountPaid: number; paymentMethod: string },
  ): Promise<any> {
    return this.request<any>(`/appointments/${appointmentId}/payment`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  // Loyalty programme (one per salon; the tenant comes from the session)
  async getLoyaltyProgram(): Promise<{ program: LoyaltyProgram | null }> {
    return this.request("/loyalty/program");
  }

  async saveLoyaltyProgram(data: Partial<LoyaltyProgramSettings>): Promise<{ program: LoyaltyProgram }> {
    return this.request("/loyalty/program", { method: "PUT", body: JSON.stringify(data) });
  }

  async createLoyaltyReward(data: LoyaltyRewardInput): Promise<LoyaltyReward> {
    return this.request("/loyalty/rewards", { method: "POST", body: JSON.stringify(data) });
  }

  async updateLoyaltyReward(id: string, data: Partial<LoyaltyRewardInput>): Promise<LoyaltyReward> {
    return this.request(`/loyalty/rewards/${id}`, { method: "PUT", body: JSON.stringify(data) });
  }

  async deleteLoyaltyReward(id: string): Promise<{ ok: boolean; deactivated: boolean }> {
    return this.request(`/loyalty/rewards/${id}`, { method: "DELETE" });
  }

  async createLoyaltyTier(data: { name: string; minPoints: number; pointsMultiplier: number }): Promise<LoyaltyTier> {
    return this.request("/loyalty/tiers", { method: "POST", body: JSON.stringify(data) });
  }

  async deleteLoyaltyTier(id: string): Promise<{ ok: boolean }> {
    return this.request(`/loyalty/tiers/${id}`, { method: "DELETE" });
  }

  async getLoyaltyMembers(search?: string): Promise<LoyaltyMemberRow[]> {
    const q = search ? `?search=${encodeURIComponent(search)}` : "";
    return this.request(`/loyalty/members${q}`);
  }

  async enrollLoyaltyMember(clientId: string): Promise<any> {
    return this.request("/loyalty/members", { method: "POST", body: JSON.stringify({ clientId }) });
  }

  async adjustLoyaltyPoints(memberId: string, points: number, reason: string): Promise<any> {
    return this.request(`/loyalty/members/${memberId}/adjust`, {
      method: "POST",
      body: JSON.stringify({ points, reason }),
    });
  }

  async getClientLoyalty(clientId: string): Promise<ClientLoyaltySummary> {
    return this.request(`/loyalty/clients/${clientId}`);
  }

  // Wait-list
  async getWaitList(status?: string): Promise<WaitListEntry[]> {
    const q = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request(`/wait-list${q}`);
  }

  async addToWaitList(data: {
    clientId: string;
    serviceId: string;
    professionalId?: string;
    earliestDate?: string;
    latestDate?: string;
    notes?: string;
  }): Promise<WaitListEntry> {
    return this.request("/wait-list", { method: "POST", body: JSON.stringify(data) });
  }

  async updateWaitListEntry(id: string, data: { status?: string; notes?: string }): Promise<WaitListEntry> {
    return this.request(`/wait-list/${id}`, { method: "PATCH", body: JSON.stringify(data) });
  }

  async removeWaitListEntry(id: string): Promise<{ ok: boolean }> {
    return this.request(`/wait-list/${id}`, { method: "DELETE" });
  }

  /** "Avisar": really sends the notice and says, channel by channel, what happened. */
  async notifyWaitListEntry(
    id: string,
    slot: { date?: string; time?: string; professionalId?: string } = {},
  ): Promise<WaitListNotifyResult> {
    return this.request(`/wait-list/${id}/notify`, { method: "POST", body: JSON.stringify(slot) });
  }

  async getWaitListSettings(): Promise<{ autoNotify: boolean }> {
    return this.request("/wait-list/settings");
  }

  async saveWaitListSettings(autoNotify: boolean): Promise<{ autoNotify: boolean }> {
    return this.request("/wait-list/settings", { method: "PUT", body: JSON.stringify({ autoNotify }) });
  }

  async getWaitListChannels(): Promise<{ email: boolean; sms: boolean; whatsapp: boolean; whatsappReason: string | null }> {
    return this.request("/wait-list/channels");
  }

  // Gift Cards API (plan-gated by `gift_cards`; see docs/billing-plans-rev3.md Â§18.1)
  async listGiftCards(params?: {
    page?: number;
    limit?: number;
    isActive?: boolean;
  }): Promise<{
    items: any[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.limit) qs.set("limit", String(params.limit));
    if (typeof params?.isActive === "boolean") {
      qs.set("isActive", String(params.isActive));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request<any>(`/gift-cards${suffix}`);
  }

  async getGiftCard(id: string): Promise<any> {
    return this.request<any>(`/gift-cards/${id}`);
  }

  async lookupGiftCard(code: string): Promise<any> {
    return this.request<any>(`/gift-cards/lookup/${encodeURIComponent(code)}`);
  }

  async createGiftCard(data: {
    initialAmount: number;
    purchasedById?: string;
    recipientId?: string;
    recipientEmail?: string;
    recipientName?: string;
    message?: string;
    /** Last valid day ("YYYY-MM-DD"); left out: two years; null: never expires. */
    expiresAt?: string | null;
    /** Email the card to `recipientEmail` (server default: yes). */
    sendEmail?: boolean;
  }): Promise<any> {
    return this.request<any>("/gift-cards", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateGiftCard(
    id: string,
    data: { isActive?: boolean; expiresAt?: string | null; message?: string },
  ): Promise<any> {
    return this.request<any>(`/gift-cards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async redeemGiftCard(data: {
    giftCardId: string;
    amount: number;
    paymentId?: string;
    note?: string;
  }): Promise<any> {
    return this.request<any>("/gift-cards/redeem", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async deleteGiftCard(id: string): Promise<any> {
    return this.request<any>(`/gift-cards/${id}`, {
      method: "DELETE",
    });
  }

  // Analytics
  async getAnalyticsOverview(months: number = 6): Promise<any> {
    return this.request<any>(`/analytics/overview?months=${months}`);
  }

  async getRevenueReport(startDate: string, endDate: string): Promise<any> {
    return this.request<any>(
      `/analytics/revenue?startDate=${startDate}&endDate=${endDate}`,
    );
  }

  async getAppointmentsReport(
    startDate: string,
    endDate: string,
  ): Promise<any> {
    return this.request<any>(
      `/analytics/appointments?startDate=${startDate}&endDate=${endDate}`,
    );
  }

  async getAppointmentStatusEvolution(
    status: string,
    months: number = 6,
  ): Promise<any> {
    return this.request<any>(
      `/analytics/appointment-status-evolution?status=${encodeURIComponent(status)}&months=${months}`,
    );
  }

  async getAppointmentStatusesEvolution(months: number = 6): Promise<
    {
      period: string;
      Completed: number;
      Confirmed: number;
      Pending: number;
      Cancelled: number;
      "No Show": number;
      "In Progress": number;
    }[]
  > {
    return this.request(
      `/analytics/appointment-statuses-evolution?months=${months}`,
    );
  }

  async getAppointmentStatusByDays(days: number = 7): Promise<
    {
      name: string;
      count: number;
      color: string;
    }[]
  > {
    return this.request(`/analytics/appointment-status-by-days?days=${days}`);
  }

  // Analytics Feature Flags
  async getAnalyticsFeatures(): Promise<{
    hasAdvancedAnalytics: boolean;
    hasDetailedReports: boolean;
    hasForecasting: boolean;
    hasExport: boolean;
    maxMonths: number;
  }> {
    return this.request("/analytics/features");
  }

  // Advanced Analytics (paid feature)
  async getDetailedReport(
    startDate: string,
    endDate: string,
    type: string = "both",
  ): Promise<any> {
    return this.request<any>(
      `/analytics/detailed-report?startDate=${startDate}&endDate=${endDate}&type=${type}`,
    );
  }

  async getProfessionalPerformance(range?: string): Promise<any> {
    const queryParams = range ? `?range=${range}` : "";
    return this.request<any>(
      `/analytics/professional-performance${queryParams}`,
    );
  }

  async getClientInsights(months: number = 6): Promise<any> {
    return this.request<any>(`/analytics/client-insights?months=${months}`);
  }

  /** Per-location KPIs (plan Empresa). Money in cents. */
  async getConsolidatedReport(range: string = "this_month"): Promise<any> {
    return this.request<any>(
      `/multi-location/consolidated?range=${encodeURIComponent(range)}`,
    );
  }

  // Promotions
  async getPromotions(): Promise<any[]> {
    return this.request<any[]>("/promotions");
  }

  async getPromotion(id: string): Promise<any> {
    return this.request<any>(`/promotions/${id}`);
  }

  async createPromotion(data: any): Promise<any> {
    return this.request<any>("/promotions", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updatePromotion(id: string, data: any): Promise<any> {
    return this.request<any>(`/promotions/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deletePromotion(id: string): Promise<any> {
    return this.request<any>(`/promotions/${id}`, {
      method: "DELETE",
    });
  }

  async validatePromotionCode(code: string): Promise<any> {
    return this.request<any>(`/promotions/validate/${code}`);
  }

  async applyPromotionCode(
    code: string,
    clientId: string,
    orderValue: number,
  ): Promise<any> {
    return this.request<any>("/promotions/apply", {
      method: "POST",
      body: JSON.stringify({ code, clientId, orderValue }),
    });
  }

  async getPromotionStatistics(promotionId?: string): Promise<any[]> {
    const query = promotionId ? `?promotionId=${promotionId}` : "";
    return this.request<any[]>(`/promotions/statistics${query}`);
  }

  async getAllCommissionSummaries(): Promise<any[]> {
    return this.request<any[]>("/commissions/all");
  }

  async calculateCommission(
    appointmentId: string,
    amount?: number,
    rate?: number,
  ): Promise<any> {
    return this.request<any>(`/commissions/calculate/${appointmentId}`, {
      method: "POST",
      body: JSON.stringify({ amount, rate }),
    });
  }

  async payCommission(
    professionalId: string,
    appointmentIds?: string[],
    startDate?: string,
    endDate?: string,
  ): Promise<any> {
    return this.request<any>(`/commissions/pay/${professionalId}`, {
      method: "POST",
      body: JSON.stringify({ appointmentIds, startDate, endDate }),
    });
  }

  async getPayrollReport(startDate: string, endDate: string): Promise<any> {
    return this.request<any>(
      `/commissions/payroll?startDate=${startDate}&endDate=${endDate}`,
    );
  }

  async getPaymentByClient(clientId: string): Promise<Payment[]> {
    return this.request<Payment[]>(`/payments/client/${clientId}`);
  }

  /** The Pagos page's cards, for the list's filters (status aside). */
  async getPaymentSummary(filters: PaymentFilters = {}): Promise<PaymentSummary> {
    const { status: _status, ...rest } = filters;
    const query = paymentQuery(rest);
    return this.request<PaymentSummary>(`/payments/stats/summary${query ? `?${query}` : ""}`);
  }

  /**
   * The Pagos list as a CSV (owner/admin), with the page's filters. A file
   * download needs the bearer token, so it cannot be a plain link.
   */
  async downloadPaymentsCsv(filters: PaymentFilters = {}): Promise<{ blob: Blob; filename: string }> {
    const query = paymentQuery(filters);
    const url = `${API_BASE_URL}/exports/payments.csv${query ? `?${query}` : ""}`;
    const get = () => {
      const token = getToken();
      return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: "include" });
    };
    let res = await get();
    if (res.status === 401 && (await this.refreshAccessToken())) res = await get();
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const raw = (body as { message?: unknown }).message;
      throw new ApiError(Array.isArray(raw) ? raw.join(". ") : String(raw || `Error ${res.status}`), res.status);
    }
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "pagos.csv";
    return { blob: await res.blob(), filename };
  }

  // Stripe Settings
  async getStripeSettings(): Promise<StripeSettings> {
    return this.request<StripeSettings>("/payments/stripe/settings");
  }

  async updateStripeSettings(
    settings: Partial<StripeSettings>,
  ): Promise<{ success: boolean; stripeMode: string }> {
    return this.request<{ success: boolean; stripeMode: string }>(
      "/payments/stripe/settings",
      {
        method: "PATCH",
        body: JSON.stringify(settings),
      },
    );
  }

  async getStripePublishableKey(): Promise<{ publishableKey: string | null }> {
    return this.request<{ publishableKey: string | null }>(
      "/payments/stripe/publishable-key",
    );
  }

  // Subscriptions
  async getCurrentSubscription(): Promise<Subscription | null> {
    return this.request<Subscription | null>("/payments/subscription/current");
  }

  async createSubscriptionCheckout(plan: string): Promise<{ url: string }> {
    return this.request<{ url: string }>("/payments/subscription/checkout", {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
  }

  async changeSubscriptionPlan(plan: string): Promise<Subscription> {
    return this.request<Subscription>("/payments/subscription/change-plan", {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
  }

  async cancelSubscription(immediately?: boolean): Promise<Subscription> {
    return this.request<Subscription>("/payments/subscription/cancel", {
      method: "POST",
      body: JSON.stringify({ immediately }),
    });
  }

  async reactivateSubscription(): Promise<{
    tenantId: string;
    status: string;
    checkoutUrl: string | null;
  }> {
    return this.request("/payments/subscription/reactivate", {
      method: "POST",
    });
  }

  async getTenantTrialStatus(): Promise<{
    inTrial: boolean;
    daysRemaining: number;
    trialEnd: string | null;
    subscriptionStatus: string;
  }> {
    return this.request("/payments/subscription/trial-status");
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ P2A-receptionist-v2: add-ons + AI counter + bundles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async getAvailableAddOns(plan?: string): Promise<CatalogAddOn[]> {
    const q = plan ? `?plan=${encodeURIComponent(plan)}` : "";
    const res = await this.request<{ data: CatalogAddOn[] }>(
      `/payments/add-ons/available${q}`,
    );
    return res.data ?? [];
  }

  async getTenantAddOns(): Promise<TenantAddOnView[]> {
    const res = await this.request<{ data: TenantAddOnView[] }>(
      `/payments/tenants/current/add-ons`,
    );
    return res.data ?? [];
  }

  // Adds the add-on to the salon's plan subscription (prorated) and answers
  // the row as Stripe left it. It used to open a Checkout that needed a
  // Stripe price no add-on had.
  async purchaseAddOn(
    addOnKey: string,
  ): Promise<{ status: string; currentPeriodEnd: string | null }> {
    return this.request(
      `/payments/tenants/current/add-ons/${encodeURIComponent(addOnKey)}`,
      { method: "POST" },
    );
  }

  async cancelTenantAddOn(addOnKey: string): Promise<{ ok: boolean }> {
    return this.request(
      `/payments/tenants/current/add-ons/${addOnKey}`,
      { method: "DELETE" },
    );
  }

  async getAiUsage(): Promise<{
    used: number;
    cap: number | null;
    resetsAt: string | null;
  }> {
    return this.request("/virtual-receptionist/ai-usage");
  }

  /** The salon page address, name and logo, for sharing and printing (QrController.share). */
  async getShareInfo(): Promise<import("./share-page").ShareInfo> {
    return this.request("/qr/share");
  }

  async getMessageBundlesBalance(): Promise<MessageBundlesBalance> {
    // The salon's own route (TenantAddOnsController, owner/admin). The
    // similar-looking /message-bundles/tenants/:tenantId/balance is the
    // SaaS-admin one and answers 403 to a salon.
    return this.request<MessageBundlesBalance>(
      "/payments/message-bundles/tenants/current/balance",
    );
  }

  async getSubscriptionInvoices(
    limit: number = 10,
  ): Promise<SubscriptionInvoice[]> {
    return this.request<SubscriptionInvoice[]>(
      `/payments/subscription/invoices?limit=${limit}`,
    );
  }

  async getBillingPortalUrl(): Promise<{ url: string }> {
    return this.request<{ url: string }>('/payments/subscription/billing-portal', {
      method: 'POST',
    });
  }
  async getSubscriptionUsage(): Promise<SubscriptionUsage> {
    return this.request<SubscriptionUsage>("/payments/subscription/usage");
  }

  async getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return this.request<SubscriptionPlan[]>("/payments/subscription/plans");
  }

  // Client Wallet
  async getClientWallet(clientId: string): Promise<ClientWallet> {
    return this.request<ClientWallet>(`/payments/wallet/${clientId}`);
  }

  /**
   * A wallet top-up (owner/admin) and how the client paid it; the first one
   * creates the wallet. Cash needs the cash drawer open (409 CASH_SESSION_CLOSED).
   */
  async depositToWallet(clientId: string, amountCents: number, method: WalletTopUpMethod, description?: string): Promise<unknown> {
    return this.request(`/payments/wallet/${clientId}/deposit`, {
      method: "POST",
      body: JSON.stringify({ amount: amountCents, method, ...(description ? { description } : {}) }),
    });
  }

  /**
   * Money handed back from a client's wallet (owner/admin) and how, never
   * past its balance. Cash needs the cash drawer open (409 CASH_SESSION_CLOSED).
   */
  async withdrawFromWallet(clientId: string, amountCents: number, method: WalletTopUpMethod, description?: string): Promise<unknown> {
    return this.request(`/payments/wallet/${clientId}/withdraw`, {
      method: "POST",
      body: JSON.stringify({ amount: amountCents, method, ...(description ? { description } : {}) }),
    });
  }

  // POS
  async getPosServices(): Promise<any[]> {
    return this.request<any[]>("/pos/services");
  }

  async getPosClients(search?: string): Promise<any[]> {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    return this.request<any[]>(`/pos/clients${query}`);
  }

  async getPosDashboard(date?: string): Promise<any> {
    const query = date ? `?date=${date}` : "";
    return this.request<any>(`/pos/dashboard${query}`);
  }

  /** A sale at the till. Send the same `saleId` on a retry: the server records it once. */
  async posCheckout(data: any): Promise<PosSale> {
    return this.request<PosSale>("/pos/checkout", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** The ticket priced by the server (money, tax included): what the checkout will charge. */
  async posQuote(data: any): Promise<PosQuote> {
    return this.request<PosQuote>("/pos/quote", { method: "POST", body: JSON.stringify(data) });
  }

  /** Products the till sells: active, with their price in money and their stock. */
  async getPosSaleProducts(search?: string): Promise<PosSaleProduct[]> {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    return this.request<PosSaleProduct[]>(`/pos/sale-products${query}`);
  }

  /** The ticket of a sale (the simplified invoice's legal minimum). */
  async getPosReceipt(saleId: string): Promise<PosReceipt> {
    return this.request<PosReceipt>(`/pos/sales/${encodeURIComponent(saleId)}/receipt`);
  }

  /** The till's settings: the staff discount limit (everyone reads, owner and managers save). */
  async getPosSettings(): Promise<PosSettings> {
    return this.request<PosSettings>("/pos/settings");
  }

  async savePosSettings(settings: PosSettings): Promise<PosSettings> {
    return this.request<PosSettings>("/pos/settings", { method: "PUT", body: JSON.stringify(settings) });
  }

  /** The open cash-drawer session (null when closed), with what it should hold. */
  async getCurrentCashSession(): Promise<CashSessionCurrent> {
    return this.request<CashSessionCurrent>("/pos/cash-sessions/current");
  }

  /** "Abrir caja": the float, in cents. A 409 when another one is open. */
  async openCashSession(body: { openingFloatCents: number; notes?: string }): Promise<CashSessionView> {
    return this.request<CashSessionView>("/pos/cash-sessions/open", { method: "POST", body: JSON.stringify(body) });
  }

  /** "Movimiento de caja": money put in or taken out of the open drawer, with why. */
  async addCashMovement(
    sessionId: string,
    body: { type: CashMovementType; amountCents: number; reason: string },
  ): Promise<CashMovementRow> {
    return this.request<CashMovementRow>(`/pos/cash-sessions/${encodeURIComponent(sessionId)}/movements`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** "Cerrar caja": the cash counted (cents), optionally by coin and note. */
  async closeCashSession(
    sessionId: string,
    body: { countedCashCents: number; breakdown?: Record<string, number>; notes?: string },
  ): Promise<CashSessionView> {
    return this.request<CashSessionView>(`/pos/cash-sessions/${encodeURIComponent(sessionId)}/close`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** Past sessions (owner and managers). */
  async getCashSessions(params: { from?: string; to?: string; page?: number; limit?: number } = {}): Promise<CashSessionList> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
    const qs = query.toString();
    return this.request<CashSessionList>(`/pos/cash-sessions${qs ? `?${qs}` : ""}`);
  }

  /** One session's report. */
  async getCashSession(sessionId: string): Promise<CashSessionView> {
    return this.request<CashSessionView>(`/pos/cash-sessions/${encodeURIComponent(sessionId)}`);
  }

  async posQuickSale(data: {
    serviceId: string;
    paymentMethod: string;
    clientId?: string;
    saleId?: string;
  }): Promise<PosSale> {
    return this.request<PosSale>("/pos/quick-sale", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Products
  async getProducts(params?: {
    category?: string;
    search?: string;
    lowStock?: boolean;
  }): Promise<any[]> {
    const queryParams = new URLSearchParams();
    if (params?.category) queryParams.set("category", params.category);
    if (params?.search) queryParams.set("search", params.search);
    if (params?.lowStock) queryParams.set("lowStock", "true");
    const query = queryParams.toString() ? `?${queryParams.toString()}` : "";
    return this.request<any[]>(`/pos/products${query}`);
  }

  async getProduct(id: string): Promise<any> {
    return this.request<any>(`/pos/products/${id}`);
  }

  async createProduct(data: any): Promise<any> {
    return this.request<any>("/pos/products", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateProduct(id: string, data: any): Promise<any> {
    return this.request<any>(`/pos/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  /** Deleted, or deactivated when it has sales or stock movements (`deactivated: true`). */
  async deleteProduct(id: string): Promise<{ deleted?: boolean; deactivated?: boolean } | void> {
    return this.request<{ deleted?: boolean; deactivated?: boolean } | void>(`/pos/products/${id}`, {
      method: "DELETE",
    });
  }

  async getProductCategories(): Promise<any[]> {
    return this.request<any[]>("/pos/products/categories");
  }

  async createProductCategory(data: any): Promise<any> {
    return this.request<any>("/pos/products/categories", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getInventoryTransactions(params?: {
    productId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<any[]> {
    const queryParams = new URLSearchParams();
    if (params?.productId) queryParams.set("productId", params.productId);
    if (params?.startDate) queryParams.set("startDate", params.startDate);
    if (params?.endDate) queryParams.set("endDate", params.endDate);
    const query = queryParams.toString() ? `?${queryParams.toString()}` : "";
    return this.request<any[]>(`/pos/inventory${query}`);
  }

  async adjustInventory(data: {
    productId: string;
    type: string;
    quantity: number;
    reason?: string;
  }): Promise<any> {
    return this.request<any>("/pos/inventory/adjust", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getOrders(params?: {
    status?: string;
    clientId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<any[]> {
    const queryParams = new URLSearchParams();
    if (params?.status) queryParams.set("status", params.status);
    if (params?.clientId) queryParams.set("clientId", params.clientId);
    if (params?.startDate) queryParams.set("startDate", params.startDate);
    if (params?.endDate) queryParams.set("endDate", params.endDate);
    const query = queryParams.toString() ? `?${queryParams.toString()}` : "";
    return this.request<any[]>(`/pos/orders${query}`);
  }

  async getOrder(id: string): Promise<any> {
    return this.request<any>(`/pos/orders/${id}`);
  }

  // Email Campaigns
  async getEmailCampaigns(
    status?: string,
    campaignType?: string,
  ): Promise<EmailCampaign[]> {
    const params = new URLSearchParams();
    if (status) params.append("status", status);
    if (campaignType) params.append("campaignType", campaignType);
    const queryString = params.toString();
    return this.request<EmailCampaign[]>(
      `/email-campaigns${queryString ? "?" + queryString : ""}`,
    );
  }

  async getEmailCampaign(id: string): Promise<EmailCampaign> {
    return this.request<EmailCampaign>(`/email-campaigns/${id}`);
  }

  async getEmailCampaignRecipients(id: string): Promise<any[]> {
    return this.request<any[]>(`/email-campaigns/${id}/recipients`);
  }

  async createEmailCampaign(data: CreateCampaignDto): Promise<EmailCampaign> {
    return this.request<EmailCampaign>("/email-campaigns", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateEmailCampaign(
    id: string,
    data: Partial<CreateCampaignDto>,
  ): Promise<EmailCampaign> {
    return this.request<EmailCampaign>(`/email-campaigns/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteEmailCampaign(id: string): Promise<void> {
    return this.request<void>(`/email-campaigns/${id}`, {
      method: "DELETE",
    });
  }

  async scheduleEmailCampaign(
    id: string,
    scheduledAt: string,
  ): Promise<EmailCampaign> {
    return this.request<EmailCampaign>(`/email-campaigns/${id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduledAt }),
    });
  }

  async sendEmailCampaignNow(id: string): Promise<SendEmailCampaignResult> {
    return this.request<SendEmailCampaignResult>(`/email-campaigns/${id}/send`, {
      method: "POST",
    });
  }

  /**
   * "Enviar a todos": the server adds every active client with an email
   * who accepts promotions, then sends.
   */
  async sendEmailCampaignToAll(id: string): Promise<SendEmailCampaignResult> {
    return this.request<SendEmailCampaignResult>(`/email-campaigns/${id}/send-to-all`, {
      method: "POST",
    });
  }

  async getEmailCampaignTrackingStatus(): Promise<EmailCampaignTrackingStatus> {
    return this.request<EmailCampaignTrackingStatus>(
      "/email-campaigns/tracking-status",
    );
  }

  async addRecipientsToCampaign(id: string, clientIds: string[]): Promise<any> {
    return this.request<any>(`/email-campaigns/${id}/recipients`, {
      method: "POST",
      body: JSON.stringify({ clientIds }),
    });
  }

  async removeRecipientsFromCampaign(
    id: string,
    clientIds: string[],
  ): Promise<any> {
    return this.request<any>(`/email-campaigns/${id}/recipients`, {
      method: "DELETE",
      body: JSON.stringify({ clientIds }),
    });
  }

  async getEmailCampaignAnalytics(id: string): Promise<EmailCampaignAnalytics> {
    return this.request<EmailCampaignAnalytics>(
      `/email-campaigns/${id}/analytics`,
    );
  }

  async getEmailCampaignTemplates(): Promise<EmailCampaignTemplate[]> {
    return this.request<EmailCampaignTemplate[]>(
      "/email-campaigns/templates/list",
    );
  }

  async getEmailCampaignTemplate(id: string): Promise<EmailCampaignTemplate> {
    return this.request<EmailCampaignTemplate>(
      `/email-campaigns/templates/${id}`,
    );
  }

  async createEmailCampaignTemplate(
    data: CreateTemplateDto,
  ): Promise<EmailCampaignTemplate> {
    return this.request<EmailCampaignTemplate>("/email-campaigns/templates", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async deleteEmailCampaignTemplate(id: string): Promise<void> {
    return this.request<void>(`/email-campaigns/templates/${id}`, {
      method: "DELETE",
    });
  }

  async broadcastEmailCampaign(
    data: CreateCampaignDto & { sendNow?: boolean },
  ): Promise<EmailCampaign> {
    return this.request<EmailCampaign>("/email-campaigns/broadcast", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Re-engagement campaigns
  async createReengagementCampaign(
    data: CreateReengagementCampaignDto,
  ): Promise<EmailCampaign> {
    return this.request<EmailCampaign>("/email-campaigns/reengagement", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async activateEmailCampaign(id: string): Promise<EmailCampaign> {
    return this.request<EmailCampaign>(`/email-campaigns/${id}/activate`, {
      method: "POST",
    });
  }

  async deactivateEmailCampaign(id: string): Promise<EmailCampaign> {
    return this.request<EmailCampaign>(`/email-campaigns/${id}/deactivate`, {
      method: "POST",
    });
  }

  async getAvailablePromotions(): Promise<Promotion[]> {
    return this.request<Promotion[]>("/email-campaigns/promotions/available");
  }

  // Social Integration methods
  async getSocialConnections(): Promise<SocialConnection[]> {
    return this.request<SocialConnection[]>("/social-integrations/connections");
  }

  async getSocialConnection(
    platform: SocialPlatform,
  ): Promise<SocialConnection> {
    return this.request<SocialConnection>(
      `/social-integrations/connections/${platform}`,
    );
  }

  async getOAuthUrl(platform: SocialPlatform): Promise<{ url: string }> {
    return this.request<{ url: string }>(
      `/social-integrations/oauth-url/${platform}`,
    );
  }

  async connectSocialPlatform(
    platform: SocialPlatform,
    code: string,
  ): Promise<SocialConnection> {
    return this.request<SocialConnection>(
      `/social-integrations/oauth-callback/${platform}`,
      {
        method: "POST",
        body: JSON.stringify({ code }),
      },
    );
  }

  async disconnectSocialPlatform(
    platform: SocialPlatform,
  ): Promise<SocialConnection> {
    return this.request<SocialConnection>(
      `/social-integrations/disconnect/${platform}`,
      {
        method: "POST",
      },
    );
  }

  async updateSocialConnectionSettings(
    platform: SocialPlatform,
    settings: {
      isActive?: boolean;
      autoPost?: boolean;
      notifyReviews?: boolean;
    },
  ): Promise<SocialConnection> {
    return this.request<SocialConnection>(
      `/social-integrations/connections/${platform}`,
      {
        method: "PUT",
        body: JSON.stringify(settings),
      },
    );
  }

  // Google Business Profile. Syncing the profile and reading or replying to
  // Google reviews need Google's approval of its Business Profile API, which
  // KiraRoom does not have: the backend answers 501 for those, so there are
  // no client methods for them. The review link lives in getReviewSettings.
  async getGoogleBusinessProfile(): Promise<GoogleBusinessProfileState> {
    return this.request<GoogleBusinessProfileState>(
      "/social-integrations/google-business",
    );
  }

  async updateGoogleBusinessProfile(data: {
    enableReviewRequests?: boolean;
  }): Promise<GoogleBusinessProfileState> {
    return this.request<GoogleBusinessProfileState>(
      "/social-integrations/google-business",
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    );
  }

  // Social Posts
  async getSocialPosts(status?: string): Promise<SocialPost[]> {
    const params = status ? `?status=${status}` : "";
    return this.request<SocialPost[]>(`/social-integrations/posts${params}`);
  }

  async createSocialPost(data: {
    content: string;
    mediaUrls?: string[];
    linkUrl?: string;
    platforms?: SocialPlatform[];
    scheduledAt?: string;
  }): Promise<SocialPost> {
    return this.request<SocialPost>("/social-integrations/posts", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateSocialPost(
    postId: string,
    data: {
      content?: string;
      mediaUrls?: string[];
      linkUrl?: string;
      platforms?: SocialPlatform[];
      scheduledAt?: string;
    },
  ): Promise<SocialPost> {
    return this.request<SocialPost>(`/social-integrations/posts/${postId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteSocialPost(postId: string): Promise<void> {
    return this.request<void>(`/social-integrations/posts/${postId}`, {
      method: "DELETE",
    });
  }

  async publishSocialPost(postId: string): Promise<SocialPost> {
    return this.request<SocialPost>(
      `/social-integrations/posts/${postId}/publish`,
      {
        method: "POST",
      },
    );
  }

  async getSocialAnalytics(): Promise<SocialAnalytics> {
    return this.request<SocialAnalytics>("/social-integrations/analytics");
  }

  async getTenant(): Promise<{
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    country: string;
    language: string;
    plan?: string;
    subscriptionStatus?: string;
    description?: string | null;
    street?: string | null;
    city?: string | null;
    postalCode?: string | null;
    state?: string | null;
    phone?: string | null;
    logo?: string | null;
    taxId?: string | null;
    taxIdType?: "nif" | "cif" | "nie" | "passport" | "other" | null;
    legalName?: string | null;
    email?: string | null;
    dateFormat?: string;
    timeFormat?: string;
    minCancelHours?: number;
    /**
     * The salon's own week ([{ day, openTime, closeTime }]), or a legacy
     * shape: read it with lib/salon-hours.ts.
     */
    openingHours?: unknown;
    /** Profile URLs, linked from the salon's public page. */
    instagram?: string | null;
    facebook?: string | null;
    /** Minutes between the start times offered when booking. */
    bookingSlotMinutes?: number;
    /** Online bookings start confirmed instead of pending. */
    autoConfirmOnlineBookings?: boolean;
  }> {
    return this.request("/auth/tenant");
  }

  async updateTenant(data: {
    name?: string;
    description?: string;
    language?: string;
    currency?: string;
    timezone?: string;
    dateFormat?: string;
    timeFormat?: string;
    street?: string;
    city?: string;
    postalCode?: string;
    state?: string;
    phone?: string;
    logo?: string;
    email?: string;
    minCancelHours?: number;
    /** The salon's week, replacing what was stored; [] = no salon-level hours. */
    openingHours?: WorkingHoursEntry[];
    /** "@handle" or a profile link (stored as the profile URL); "" clears it. */
    instagram?: string;
    facebook?: string;
    bookingSlotMinutes?: number;
    autoConfirmOnlineBookings?: boolean;
  }): Promise<{
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    country: string;
    language: string;
  }> {
    return this.request("/auth/tenant", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  // ---- P2A-receptionist-v2 H-4: multichannel channels wizard ----

  /**
   * Read the current multichannel config for the active tenant.
   * Secrets (pageAccessToken, botToken) are never echoed back â€” only
   * `hasAccessToken` / `hasBotToken` flags so the UI can render the
   * connected badge without leaking credentials.
   */
  async getChannelsConfig(): Promise<ChannelsConfig | null> {
    return this.request("/virtual-receptionist/channels/config");
  }

  /**
   * Turn channels on or off. Credentials are not sent here: the Facebook
   * Page is connected through Facebook Login and the Telegram bot through
   * connectTelegramBot().
   */
  async updateChannelsConfig(data: {
    enabled?: boolean;
    enabledChannels?: (
      | "web"
      | "whatsapp"
      | "facebook"
      | "instagram"
      | "telegram"
    )[];
  }): Promise<ChannelsConfig> {
    return this.request("/virtual-receptionist/channels/config", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  /** Facebook Login URL to connect a Page (Messenger + its Instagram). */
  async getMetaChannelConnectUrl(): Promise<{ url: string }> {
    return this.request("/virtual-receptionist/channels/meta/connect");
  }

  /** Pages to choose from when Facebook Login returned more than one. */
  async getMetaChannelPages(): Promise<Array<{ id: string; name: string; instagramUsername?: string }>> {
    return this.request("/virtual-receptionist/channels/meta/pages");
  }

  async selectMetaChannelPage(pageId: string): Promise<{ connected: boolean }> {
    return this.request("/virtual-receptionist/channels/meta/select", {
      method: "POST",
      body: JSON.stringify({ pageId }),
    });
  }

  async disconnectMetaChannel(): Promise<{ disconnected: boolean }> {
    return this.request("/virtual-receptionist/channels/meta", { method: "DELETE" });
  }

  /** Checks the @BotFather token with Telegram and registers the webhook. */
  async connectTelegramBot(botToken: string): Promise<{ connected: boolean; botUsername?: string }> {
    return this.request("/virtual-receptionist/channels/telegram", {
      method: "POST",
      body: JSON.stringify({ botToken }),
    });
  }

  async disconnectTelegramBot(): Promise<{ disconnected: boolean }> {
    return this.request("/virtual-receptionist/channels/telegram", { method: "DELETE" });
  }

  /**
   * The receptionist's activity in the salon over the last `days`, counted
   * from the salon's own conversations. Replaces /channels/metrics, which
   * summed every salon's messages since the last server restart.
   */
  async getReceptionistStats(days = 30): Promise<ReceptionistStats> {
    return this.request(`/virtual-receptionist/stats?days=${days}`);
  }

  // Admin Settings
  async getProfessionalCrossBookingSetting(): Promise<{
    allowProfessionalCrossBooking: boolean;
  }> {
    return this.request<{ allowProfessionalCrossBooking: boolean }>(
      "/admin/settings/professional-cross-booking",
    );
  }

  async updateProfessionalCrossBookingSetting(
    allowProfessionalCrossBooking: boolean,
  ): Promise<{ allowProfessionalCrossBooking: boolean }> {
    return this.request<{ allowProfessionalCrossBooking: boolean }>(
      "/admin/settings/professional-cross-booking",
      {
        method: "PATCH",
        body: JSON.stringify({ allowProfessionalCrossBooking }),
      },
    );
  }

  // ========== SaaS Owner Methods ==========

  async getSaasTenants(filter?: {
    page?: number;
    limit?: number;
    search?: string;
    plan?: string;
    subscriptionStatus?: string;
    includeDeleted?: boolean;
  }): Promise<{
    data: any[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const params = new URLSearchParams();
    if (filter?.page) params.append("page", String(filter.page));
    if (filter?.limit) params.append("limit", String(filter.limit));
    if (filter?.search) params.append("search", filter.search);
    if (filter?.plan) params.append("plan", filter.plan);
    if (filter?.subscriptionStatus) params.append("subscriptionStatus", filter.subscriptionStatus);
    if (filter?.includeDeleted) params.append("includeDeleted", "true");
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/saas/tenants${query}`);
  }

  async getSaasTenant(id: string): Promise<any> {
    return this.request(`/saas/tenants/${id}`);
  }

  async createSaasTenant(data: any): Promise<any> {
    return this.request("/saas/tenants", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateSaasTenant(id: string, data: any): Promise<any> {
    return this.request(`/saas/tenants/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteSaasTenant(id: string): Promise<{ message: string }> {
    return this.request(`/saas/tenants/${id}`, {
      method: "DELETE",
    });
  }

  async getSaasTenantStats(id: string): Promise<any> {
    return this.request(`/saas/tenants/${id}/stats`);
  }

  async launchSalonDashboard(tenantId: string): Promise<{
    token: string;
    ownerEmail: string;
    ownerName: string;
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
  }> {
    return this.request(`/saas/tenants/${tenantId}/launch`, {
      method: "POST",
    });
  }

  async impersonate(
    token: string,
    reason: string = "support",
  ): Promise<{ user: any; tokens: { accessToken: string; expiresIn: number; tokenType: string } }> {
    return this.request(`/auth/impersonate`, {
      method: "POST",
      body: JSON.stringify({ token, reason }),
    });
  }

  async suspendSaasTenant(id: string): Promise<any> {
    return this.request(`/saas/tenants/${id}/suspend`, {
      method: "POST",
    });
  }

  async reactivateSaasTenant(id: string): Promise<any> {
    return this.request(`/saas/tenants/${id}/reactivate`, {
      method: "POST",
    });
  }

  async getSaasAnalytics(): Promise<any> {
    return this.request("/saas/analytics/overview");
  }

  async getSaasUsers(filter?: {
    page?: number;
    limit?: number;
    search?: string;
    tenantId?: string;
  }): Promise<{
    data: any[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const params = new URLSearchParams();
    if (filter?.page) params.append("page", String(filter.page));
    if (filter?.limit) params.append("limit", String(filter.limit));
    if (filter?.search) params.append("search", filter.search);
    if (filter?.tenantId) params.append("tenantId", filter.tenantId);
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/saas/users${query}`);
  }

  async getSalonGrowthMetrics(tenantId: string, months: number = 6): Promise<any> {
    return this.request(`/saas/tenants/${tenantId}/growth?months=${months}`);
  }

  async getPlatformGrowthMetrics(months: number = 6): Promise<any> {
    return this.request(`/saas/analytics/growth?months=${months}`);
  }

  // SaaS admin: bug reports
  async getSaasBugReports(filter?: {
    page?: number;
    limit?: number;
    status?: string;
    tenantId?: string;
    search?: string;
  }): Promise<{
    data: any[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const params = new URLSearchParams();
    if (filter?.page) params.append("page", String(filter.page));
    if (filter?.limit) params.append("limit", String(filter.limit));
    if (filter?.status) params.append("status", filter.status);
    if (filter?.tenantId) params.append("tenantId", filter.tenantId);
    if (filter?.search) params.append("search", filter.search);
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/saas/bug-reports${query}`);
  }

  async getSaasBugReport(id: string): Promise<any> {
    return this.request(`/saas/bug-reports/${id}`);
  }

  async getSaasBugReportStats(): Promise<Record<string, number>> {
    return this.request(`/saas/bug-reports/stats`);
  }

  async updateSaasBugReport(
    id: string,
    data: { status: string; resolution?: string },
  ): Promise<any> {
    return this.request(`/saas/bug-reports/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  // ============================================
  // Sprint 2 / Workstream 2.1 â€” Self-serve onboarding
  // ============================================

  // SaaS admin: tenant invites
  async createTenantInvite(data: {
    email: string;
    tenantName: string;
    plan: string;
    firstName?: string;
    lastName?: string;
    role?: string;
  }): Promise<{
    id: string;
    email: string;
    tenantName: string;
    status: string;
    expiresAt: string;
    magicLink: string;
  }> {
    return this.request(`/saas/invites`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async listTenantInvites(filter?: { status?: string; email?: string }): Promise<any[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.append("status", filter.status);
    if (filter?.email) params.append("email", filter.email);
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/saas/invites${query}`);
  }

  async revokeTenantInvite(id: string): Promise<any> {
    return this.request(`/saas/invites/${id}`, { method: "DELETE" });
  }

  async resendTenantInvite(id: string): Promise<any> {
    return this.request(`/saas/invites/${id}/resend`, { method: "POST" });
  }

  // Public: invite acceptance wizard
  async getInvite(token: string): Promise<{
    email: string;
    tenantName: string;
    firstName: string | null;
    lastName: string | null;
    expiresAt: string;
  }> {
    return this.request(`/invites/${encodeURIComponent(token)}`);
  }

  async acceptInvite(
    token: string,
    data: {
      password: string;
      firstName?: string;
      lastName?: string;
      street: string;
      city: string;
      state?: string;
      postalCode: string;
      country: string;
      timezone: string;
      currency?: string;
      language?: string;
      contactEmail?: string;
      phone?: string;
    },
  ): Promise<{
    tenantId: string;
    userId: string;
    email: string;
    role: string;
    accessToken: string;
    expiresIn: number;
    tokenType: string;
  }> {
    return this.request(`/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // SaaS admin: per-tenant onboarding progress
  async getTenantProgress(tenantId: string): Promise<{
    tenantId: string;
    tenantName: string;
    score: number;
    percent: number;
    components: {
      servicesConfigured: boolean;
      workingHoursSet: boolean;
      staffAdded: boolean;
      firstAppointmentCreated: boolean;
    };
    counts: {
      services: number;
      professionals: number;
      appointments: number;
    };
  }> {
    return this.request(`/saas/tenants/${tenantId}/progress`);
  }

  /**
   * Submit a bug report. Anonymous-friendly (no auth required).
   * The backend's BugReportService.submit:
   *   - emails the founder (FOUNDER_EMAIL env var)
   *   - if `email` is provided, sends an acknowledgement to the
   *     reporter with the tracking id
   */
  async reportBug(data: {
    subject: string;
    description: string;
    email?: string;
    currentUrl?: string;
    appVersion?: string;
    context?: Record<string, unknown>;
  }): Promise<{ ok: true; id: string }> {
    return this.request(`/bug-reports`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // Owner onboarding wizard at /dashboard/onboarding
  // (services + first appointment). The current /onboarding-state
  // overlay already exists; this is a separate, fuller wizard.
  async getOwnerOnboardingWizard(): Promise<{
    tenantId: string;
    currency: string;
    timezone: string;
    hasServices: boolean;
    hasStaff: boolean;
    hasWorkingHours: boolean;
    hasFirstAppointment: boolean;
    serviceTemplates: Array<{ name: string; durationMinutes: number; price: number }>;
  }> {
    return this.request(`/onboarding/wizard`);
  }

  async submitOwnerOnboardingWizard(data: {
    services?: Array<{
      name: string;
      durationMinutes: number;
      price: number;
      description?: string;
    }>;
    firstAppointment?: {
      clientName: string;
      serviceName: string;
      date: string;
      time: string;
    };
    workingHours?: Record<string, { open: string; close: string } | null>;
    /** The salon's week in the list format (several entries a day = shifts). */
    openingHours?: Array<{ day: string; openTime: string; closeTime: string }>;
  }): Promise<{
    ok: true;
    completed: number;
    total: number;
    skipped: { appointment: "no_staff" | "no_service" | null };
  }> {
    return this.request(`/onboarding/wizard`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ============================================
  // P0 â€” Widget / QR / Import / Consent / Reviews / WhatsApp
  // ============================================

  // Widget
  async listWidgetInstances(): Promise<WidgetInstance[]> {
    return this.request(`/widget/instances`);
  }
  async createWidgetInstance(input: {
    name: string;
    allowedOrigins?: string[];
    services?: string[];
    professionals?: string[];
    theme?: Record<string, unknown>;
  }): Promise<WidgetInstance> {
    return this.request(`/widget/instances`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async updateWidgetInstance(
    id: string,
    input: Partial<{
      name: string;
      allowedOrigins: string[];
      services: string[];
      professionals: string[];
      theme: Record<string, unknown>;
    }>,
  ): Promise<WidgetInstance> {
    return this.request(`/widget/instances/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  async revokeWidgetInstance(id: string): Promise<{ revoked: boolean }> {
    return this.request(`/widget/instances/${id}`, { method: "DELETE" });
  }

  // Import (CSV or .xlsx)
  async dryRunImportClients(file: ImportUpload, filename: string): Promise<ImportPreviewResult> {
    return this.request(`/import/clients/dry-run`, {
      method: "POST",
      body: JSON.stringify({ ...file, filename }),
    });
  }
  async commitImportClients(file: ImportUpload, filename: string): Promise<ImportCommitResult> {
    return this.request(`/import/clients/commit`, {
      method: "POST",
      body: JSON.stringify({ ...file, filename }),
    });
  }
  async listImportJobs(): Promise<ImportJob[]> {
    return this.request(`/import/jobs`);
  }
  async dryRunImportServices(file: ImportUpload, filename: string): Promise<ImportPreviewResult> {
    return this.request(`/import/services/dry-run`, { method: "POST", body: JSON.stringify({ ...file, filename }) });
  }
  async commitImportServices(file: ImportUpload, filename: string): Promise<ImportCommitResult> {
    return this.request(`/import/services/commit`, { method: "POST", body: JSON.stringify({ ...file, filename }) });
  }
  async dryRunImportAppointments(file: ImportUpload, filename: string, sendReminders: boolean): Promise<ImportPreviewResult> {
    return this.request(`/import/appointments/dry-run`, {
      method: "POST",
      body: JSON.stringify({ ...file, filename, sendReminders }),
    });
  }
  async commitImportAppointments(file: ImportUpload, filename: string, sendReminders: boolean): Promise<ImportCommitResult> {
    return this.request(`/import/appointments/commit`, {
      method: "POST",
      body: JSON.stringify({ ...file, filename, sendReminders }),
    });
  }
  getImportTemplateUrl(): string {
    return `${API_BASE_URL}/import/template/clients`;
  }

  // Consent forms
  async listConsentForms(): Promise<ConsentForm[]> {
    return this.request(`/consent-forms`);
  }
  async createConsentForm(input: ConsentFormInput): Promise<ConsentForm> {
    return this.request(`/consent-forms`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async updateConsentForm(id: string, input: ConsentFormInput): Promise<ConsentForm> {
    return this.request(`/consent-forms/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }
  async deleteConsentForm(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/consent-forms/${id}`, { method: "DELETE" });
  }
  /**
   * Records a signed consent; needs a session. The salon comes from the
   * session. From the panel, name the client and the name she signed with;
   * a signed-in client signs for herself (no clientId, her name by default).
   */
  async signConsent(input: {
    clientId?: string;
    formId: string;
    responses: Record<string, unknown>;
    signatureName?: string;
    appointmentId?: string;
    serviceId?: string;
  }): Promise<Consent> {
    return this.request(`/consent/sign`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async getRequiredConsents(serviceId?: string, clientId?: string): Promise<ConsentForm[]> {
    const params = new URLSearchParams();
    if (serviceId) params.append("serviceId", serviceId);
    if (clientId) params.append("clientId", clientId);
    const q = params.toString();
    return this.request(`/consent/required${q ? `?${q}` : ""}`);
  }

  // Reviews (owner)
  async listReviews(filters?: {
    rating?: number;
    professionalId?: string;
    status?: string;
  }): Promise<Review[]> {
    const params = new URLSearchParams();
    if (filters?.rating) params.append("rating", String(filters.rating));
    if (filters?.professionalId) params.append("professionalId", filters.professionalId);
    if (filters?.status) params.append("status", filters.status);
    const q = params.toString();
    return this.request(`/reviews${q ? `?${q}` : ""}`);
  }
  async moderateReview(id: string, action: "approve" | "reject"): Promise<Review> {
    return this.request(`/reviews/${id}/moderate`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
  }
  async getReviewSettings(): Promise<ReviewSettings> {
    return this.request(`/reviews/settings`);
  }
  async updateReviewSettings(data: {
    googlePlaceId?: string | null;
    googleWriteReviewUrl?: string | null;
    autoRequestsEnabled?: boolean;
  }): Promise<ReviewSettings> {
    return this.request(`/reviews/settings`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }
  async getReviewAnalytics(from?: string, to?: string): Promise<ReviewAnalytics> {
    const params = new URLSearchParams();
    if (from) params.append("from", from);
    if (to) params.append("to", to);
    const q = params.toString();
    return this.request(`/analytics/reviews${q ? `?${q}` : ""}`);
  }

  // WhatsApp
  async getWhatsAppConnection(): Promise<WhatsAppConnection | null> {
    try {
      return await this.request(`/whatsapp/connection`);
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }
  async startWhatsAppConnect(): Promise<{ url: string; state: string }> {
    return this.request(`/whatsapp/connect/start`);
  }
  async manualWhatsAppConnect(input: {
    accessToken: string;
    wabaId: string;
    phoneNumberId: string;
    displayPhone: string;
    displayName?: string;
  }): Promise<WhatsAppConnection> {
    return this.request(`/whatsapp/connect/manual`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async disconnectWhatsApp(): Promise<{ disconnected: boolean }> {
    return this.request(`/whatsapp/connection`, { method: "DELETE" });
  }
  /** Review status of the reminder template KiraRoom submits to Meta. */
  async getWhatsAppStandardTemplates(): Promise<Array<{ name: string; status: string }>> {
    return this.request(`/whatsapp/templates/standard`);
  }
  async submitWhatsAppStandardTemplates(): Promise<Record<string, string>> {
    return this.request(`/whatsapp/templates/standard`, { method: "POST" });
  }
  async listWhatsAppTemplates(): Promise<Array<{ name: string; status: string; language?: string }>> {
    return this.request(`/whatsapp/templates`);
  }
  async listWhatsAppCampaigns(): Promise<WhatsAppCampaign[]> {
    return this.request(`/whatsapp/campaigns`);
  }
  async getWhatsAppCampaign(id: string): Promise<WhatsAppCampaign> {
    return this.request(`/whatsapp/campaigns/${id}`);
  }
  async getWhatsAppCampaignAudience(inactiveDays?: number | null): Promise<WhatsAppAudiencePreview> {
    const q = inactiveDays ? `?inactiveDays=${inactiveDays}` : "";
    return this.request(`/whatsapp/campaigns/audience${q}`);
  }
  async createWhatsAppCampaign(input: WhatsAppCampaignInput): Promise<WhatsAppCampaign> {
    return this.request(`/whatsapp/campaigns`, { method: "POST", body: JSON.stringify(input) });
  }
  async updateWhatsAppCampaign(id: string, input: Partial<WhatsAppCampaignInput>): Promise<WhatsAppCampaign> {
    return this.request(`/whatsapp/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  }
  /** Sends the text to Meta for review and schedules the campaign. */
  async submitWhatsAppCampaign(id: string): Promise<WhatsAppCampaign> {
    return this.request(`/whatsapp/campaigns/${id}/submit`, { method: "POST" });
  }
  async cancelWhatsAppCampaign(id: string): Promise<WhatsAppCampaign> {
    return this.request(`/whatsapp/campaigns/${id}/cancel`, { method: "POST" });
  }
  /** Carries on a campaign paused by a problem with the salon's WhatsApp account. */
  async resumeWhatsAppCampaign(id: string): Promise<WhatsAppCampaign> {
    return this.request(`/whatsapp/campaigns/${id}/resume`, { method: "POST" });
  }
  async deleteWhatsAppCampaign(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/whatsapp/campaigns/${id}`, { method: "DELETE" });
  }

  // ---- P1 Onboarding wizard ----
  async getOnboardingState(): Promise<OnboardingState> {
    return this.request(`/onboarding/state`);
  }
  async skipOnboardingStep(key: string): Promise<{ ok: boolean }> {
    return this.request(`/onboarding/step/${key}/skip`, { method: "POST" });
  }
  async dismissOnboardingChecklist(): Promise<{ ok: boolean }> {
    return this.request(`/onboarding/checklist/dismiss`, { method: "POST" });
  }
  async restoreOnboardingChecklist(): Promise<{ ok: boolean }> {
    return this.request(`/onboarding/checklist/restore`, { method: "POST" });
  }

  // ---- P1.4 Rebooking ----
  async getRebookingConfig(): Promise<RebookingConfig> {
    return this.request(`/rebooking/config`);
  }
  async updateRebookingConfig(patch: Partial<RebookingConfig>): Promise<RebookingConfig> {
    return this.request(`/rebooking/config`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  async getRebookingPrediction(clientId: string): Promise<ClientCadence | null> {
    return this.request(`/rebooking/clients/${clientId}/prediction`);
  }
  async getRebookingLog(clientId: string): Promise<RebookingReminder[]> {
    return this.request(`/rebooking/clients/${clientId}/log`);
  }
  async optOutClientRebooking(clientId: string): Promise<{ ok: boolean }> {
    return this.request(`/rebooking/clients/${clientId}/opt-out`, { method: "POST" });
  }
  async recomputeClientCadence(clientId: string): Promise<{ ok: boolean }> {
    return this.request(`/rebooking/recompute/${clientId}`, { method: "POST" });
  }
  async publicRebookingOptOut(
    token: string,
    clientId: string,
  ): Promise<{ ok: boolean }> {
    return this.request(
      `/rebooking/public/opt-out?token=${encodeURIComponent(token)}&client=${encodeURIComponent(clientId)}`,
      { method: "POST" },
    );
  }

  // ---- P2A Invoices ----
  async listInvoices(
    filters: {
      series?: string;
      status?: string;
      fromDate?: string;
      toDate?: string;
      limit?: number;
    } = {},
  ): Promise<Invoice[]> {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        qs.set(k, String(v));
      }
    });
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request(`/invoices${suffix}`);
  }
  async getInvoice(id: string): Promise<Invoice> {
    return this.request(`/invoices/${id}`);
  }
  async createInvoice(input: {
    series?: string;
    issueDate?: string;
    recipientType?: "client" | "tenant";
    recipientId?: string;
    recipientName: string;
    recipientTaxId?: string;
    recipientAddress?: Record<string, unknown>;
    lines: Array<{
      description: string;
      quantity: number;
      unitPriceCents: number;
      discountPct?: number;
      taxRate: number;
      productId?: string;
      serviceId?: string;
      /**
       * The unit price already includes the tax (the salon's pricesIncludeTax).
       * Left out, the server adds the tax on top.
       */
      taxIncluded?: boolean;
    }>;
    notes?: string;
  }): Promise<{ id: string }> {
    return this.request(`/invoices`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async listInvoicesPage(query: Record<string, string>): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    return this.request(`/invoices${qs ? `?${qs}` : ""}`);
  }
  async rectifyInvoice(
    id: string,
    body: {
      reason: string;
      lines?: Array<
        | { originalLineId: string; quantity: number }
        | { description: string; quantity: number; unitPriceCents: number; taxRate: number; taxIncluded: boolean }
      >;
    },
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/invoices/${id}/rectify`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  async emailInvoice(id: string, to?: string): Promise<{ sent: boolean; to: string }> {
    return this.request<{ sent: boolean; to: string }>(`/invoices/${id}/email`, {
      method: "POST",
      body: JSON.stringify(to ? { to } : {}),
    });
  }
  /**
   * A plain link to /invoices/:id/pdf carried no token (it lives in
   * localStorage, the API reads the Authorization header) and got 401.
   */
  async downloadInvoiceFile(
    id: string,
    kind: "pdf" | "xml",
    filename?: string,
  ): Promise<{ blob: Blob; filename: string }> {
    return this.downloadWithToken(`${API_BASE_URL}/invoices/${id}/${kind}`, filename ?? `factura.${kind}`);
  }
  async cancelInvoice(id: string, reason: string): Promise<Invoice> {
    return this.request<Invoice>(`/invoices/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }
  async resendFiscal(id: string): Promise<Invoice> {
    return this.request<Invoice>(`/invoices/${id}/resend-fiscal`, {
      method: "POST",
    });
  }
  async generateInvoiceFromOrder(orderId: string): Promise<{ id: string } | null> {
    return this.request<{ id: string } | null>(
      `/invoices/from-order/${orderId}`,
      { method: "POST" },
    );
  }
  async generateInvoiceFromAppointment(
    appointmentId: string,
  ): Promise<{ id: string } | null> {
    return this.request<{ id: string } | null>(
      `/invoices/from-appointment/${appointmentId}`,
      { method: "POST" },
    );
  }

  // ---- P2A Fiscal settings ----
  /** The quarterly return of the salon's tax regime (modelo_303, modelo_420 or null). */
  async getQuarterlyReturnType(): Promise<{ regime: string; type: string | null }> {
    return this.request(`/tax-reports/quarterly-type`);
  }
  /** Generates (or regenerates) the draft for a quarter. */
  async generateTaxReport(type: string, year: number, quarter: number): Promise<TaxReportDraft> {
    return this.request(`/tax-reports/${type}/${year}/${quarter}/generate`, { method: "POST" });
  }

  async getFiscalSettings(): Promise<FiscalSettings> {
    return this.request(`/invoices/settings/fiscal`);
  }
  async updateFiscalSettings(patch: {
    fiscalMode?: "none" | "verifactu" | "ticketbai" | "sii_only";
    defaultSeries?: string;
    defaultTaxRate?: number;
    autoInvoiceAppointments?: boolean;
    diputacion?: "bizkaia" | "gipuzkoa" | "alava" | null;
    /** Territory tax regime: iva (peninsula/Baleares), igic (Canarias), ipsi (Ceuta/Melilla). */
    taxRegime?: TaxRegime;
    tenantNif?: string;
    taxIdType?: "nif" | "cif" | "nie" | "passport" | "other";
    legalName?: string;
  }): Promise<FiscalSettings> {
    return this.request<FiscalSettings>(`/invoices/settings/fiscal`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  // ---- P2A Certificates ----
  async listFiscalCertificates(): Promise<FiscalCertificate[]> {
    return this.request(`/invoices/certificates`);
  }
  async uploadFiscalCertificate(input: any): Promise<FiscalCertificate> {
    return this.request<FiscalCertificate>(`/invoices/certificates`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async deactivateFiscalCertificate(id: string): Promise<{ count: number }> {
    return this.request<{ count: number }>(
      `/invoices/certificates/${id}/deactivate`,
      { method: "PATCH" },
    );
  }

  // ---- P2B Accounting ----
  async getAccountingSettings(): Promise<AccountingStatus> {
    return this.request(`/accounting/settings`);
  }
  async updateAccountingSettings(patch: { syncOnIssue?: boolean }): Promise<AccountingStatus> {
    return this.request(`/accounting/settings`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  async connectHolded(apiKey: string): Promise<AccountingStatus> {
    return this.request(`/accounting/holded/connect`, {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    });
  }
  async disconnectAccounting(): Promise<{ ok: boolean }> {
    return this.request(`/accounting/disconnect`, { method: "POST" });
  }
  async pushPendingToHolded(from?: string): Promise<AccountingPushResult> {
    return this.request(`/accounting/holded/push`, {
      method: "POST",
      body: JSON.stringify(from ? { from } : {}),
    });
  }
  async syncAccountingInvoice(invoiceId: string): Promise<{
    status: string;
    externalId?: string;
    error?: string;
  }> {
    return this.request(`/accounting/sync`, {
      method: "POST",
      body: JSON.stringify({ invoiceId }),
    });
  }
  /**
   * A file download needs the bearer token, so it cannot be a plain link:
   * fetch it, refreshing the session once on a 401 like request() does.
   */
  async downloadAccountingInvoiceBook(
    from: string,
    to: string,
    format: "csv" | "xlsx",
  ): Promise<{ blob: Blob; filename: string }> {
    const qs = new URLSearchParams({ from, to, format });
    return this.downloadWithToken(
      `${API_BASE_URL}/accounting/export/facturas-emitidas?${qs}`,
      `facturas-emitidas_${from}_${to}.${format}`,
    );
  }
  /** GET a file with the bearer token, refreshing the session once on a 401 like request() does. */
  private async downloadWithToken(url: string, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
    const get = () => {
      const token = getToken();
      return fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    };
    let res = await get();
    if (res.status === 401 && (await this.refreshAccessToken())) res = await get();
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const raw = (body as { message?: unknown }).message;
      throw new ApiError(
        Array.isArray(raw) ? raw.join(". ") : String(raw || `Error ${res.status}`),
        res.status,
      );
    }
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
    return { blob: await res.blob(), filename };
  }
  async listAccountingLogs(limit = 100): Promise<AccountingSyncLog[]> {
    return this.request(`/accounting/log?limit=${limit}`);
  }

  async getWhatsAppCampaignReport(id: string): Promise<{
    id: string;
    name: string;
    status: string;
    totalRecipients: number;
    byStatus: Record<string, string>;
  }> {
    return this.request(`/whatsapp/campaigns/${id}/report`);
  }

  // P2A-platform-llm: admin-only endpoints for the global LLM provider.
  // The plaintext API key is NEVER returned; the backend sends back
  // a masked preview (`sk-ant-••••-aB23`) and the last-4 chars.
  async getPlatformLlmConfig(): Promise<PlatformLlmConfig> {
    return this.request(`/platform/llm-config`);
  }
  async updatePlatformLlmConfig(input: {
    provider?: string;
    apiKey?: string;          // empty/undefined = keep existing
    defaultModel?: string;
    baseUrl?: string | null;
    workspaceId?: string | null;
  }): Promise<PlatformLlmConfig> {
    return this.request(`/platform/llm-config`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  async testPlatformLlmConnection(): Promise<{
    ok: boolean;
    message: string;
    model?: string;
    latencyMs?: number;
  }> {
    return this.request(`/platform/llm-config/test`, {
      method: "POST",
    });
  }

  // Platform email (Resend). The key and the webhook secret are write-only:
  // GET says where each setting comes from, never its value.
  async getPlatformEmailConfig(): Promise<PlatformEmailConfig> {
    return this.request(`/platform/email-config`);
  }
  /** A string sets a field, null clears it (the server's .env applies), absent keeps it. */
  async updatePlatformEmailConfig(input: {
    apiKey?: string | null;
    from?: string | null;
    webhookSecret?: string | null;
  }): Promise<PlatformEmailConfig> {
    return this.request(`/platform/email-config`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  async sendPlatformTestEmail(): Promise<{ ok: boolean; message: string }> {
    return this.request(`/platform/email-config/test`, { method: "POST" });
  }

  // KiraRoom's own Stripe account. Secret key and webhook secret are
  // write-only: GET says where each comes from, never its value.
  async getPlatformStripeConfig(): Promise<PlatformStripeConfig> {
    return this.request(`/platform/stripe-config`);
  }
  /** A value sets a field, null clears it (the server's .env applies), absent keeps it. */
  async updatePlatformStripeConfig(input: {
    secretKey?: string | null;
    publishableKey?: string | null;
    webhookSecret?: string | null;
    taxEnabled?: boolean | null;
  }): Promise<PlatformStripeConfig> {
    return this.request(`/platform/stripe-config`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  async testPlatformStripe(): Promise<{ ok: boolean; message: string }> {
    return this.request(`/platform/stripe-config/test`, { method: "POST" });
  }

  // ---------------------------------------------------------------------------
  //  P2A-staff-copilot
  // ---------------------------------------------------------------------------
  async listAssistantConversations(): Promise<AssistantConversation[]> {
    return this.request('/assistant/conversations');
  }

  async createAssistantConversation(
    body: CreateAssistantConversationDto = {},
  ): Promise<AssistantConversation> {
    return this.request('/assistant/conversations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async listAssistantMessages(conversationId: string): Promise<AssistantMessage[]> {
    return this.request(`/assistant/conversations/${conversationId}/messages`);
  }

  async sendAssistantMessage(
    conversationId: string,
    body: SendAssistantMessageDto,
  ): Promise<AssistantSendResponse> {
    return this.request(`/assistant/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async markAssistantConversationRead(conversationId: string): Promise<void> {
    return this.request(`/assistant/conversations/${conversationId}/read`, {
      method: 'POST',
    });
  }

  async getAssistantDailyBriefing(): Promise<DailyBriefing> {
    return this.request('/assistant/insights/daily');
  }

  async getAssistantTier(): Promise<{
    tier: 'free' | 'pro' | 'premium';
    readTools: string[];
    writeTools: string[];
  }> {
    return this.request('/assistant/tier');
  }

  async getAssistantUsage(): Promise<{
    month: string;
    messages: Record<string, number>;
    actionsTotal: number;
    approvalBreakdown: Record<string, number>;
    topConversations: Array<{ conversationId: string; messages: number }>;
    overCostCap: boolean;
  }> {
    return this.request('/assistant/usage');
  }

  async submitAssistantFeedback(body: {
    messageId: string;
    rating: 1 | -1;
    comment?: string;
  }): Promise<{ id: string; rating: number; createdAt: string }> {
    return this.request('/assistant/feedback', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getAssistantFeedbackForMessage(messageId: string): Promise<{
    messageId: string;
    up: number;
    down: number;
  }> {
    return this.request(`/assistant/messages/${messageId}/feedback`);
  }

  /**
   * Re-exported for component imports.
   */

  async listAssistantApprovals(): Promise<Array<{
    id: string;
    toolName: string;
    preview: string | null;
    expiresAt: string;
  }>> {
    return this.request('/assistant/approvals');
  }

  async resolveAssistantApproval(
    id: string,
    body: { action: 'approve' } | { action: 'reject'; reason?: string },
  ): Promise<{
    id: string;
    status: string;
    toolName: string;
    preview: string | null;
    resultSnapshot: unknown;
  }> {
    return this.request(`/assistant/approvals/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
const apiClient = new ApiClient();
export default apiClient;
export { ApiClient, apiClient };

export type EmailSettingSource = "console" | "server" | "none";

export interface PlatformEmailConfig {
  apiKey: { source: EmailSettingSource; lastFour: string | null };
  from: { source: EmailSettingSource; value: string | null };
  webhookSecret: { source: EmailSettingSource; lastFour: string | null };
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PlatformStripeConfig {
  mode: "test" | "live" | "none";
  secretKey: { source: EmailSettingSource; lastFour: string | null };
  publishableKey: { source: EmailSettingSource; value: string | null };
  webhookSecret: { source: EmailSettingSource; lastFour: string | null };
  taxEnabled: { source: EmailSettingSource; value: boolean };
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PlatformLlmConfig {
  provider: string;
  defaultModel: string;
  baseUrl: string | null;
  workspaceId: string | null;   // Anthropic identity-linked keys only
  apiKeyMasked: string;        // e.g. "sk-an••••23"
  apiKeyLastFour: string;      // last-4 chars only
  apiKeyHash: string;          // SHA-256 fingerprint, never reversible
  hasKey: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

// ---------------------------------------------------------------------------
// P2A-staff-copilot: types and methods
// ---------------------------------------------------------------------------
export type AssistantMessageRole = 'user' | 'assistant' | 'tool' | 'approval' | 'system';

export interface AssistantMessage {
  id: string;
  conversationId: string;
  role: AssistantMessageRole;
  content: string;
  toolName?: string | null;
  toolInput?: unknown;
  toolResult?: unknown;
  pendingActionId?: string | null;
  createdAt: string;
}

export interface AssistantConversation {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantSendResponse {
  conversation: AssistantConversation;
  message: AssistantMessage;
  pendingApprovals: Array<{
    id: string;
    toolName: string;
    preview: string | null;
    expiresAt: string;
  }>;
  toolsExecuted: Array<{
    name: string;
    input?: unknown;
    result?: unknown;
  }>;
  /**
   * P2A-staff-copilot-sprint15: true when the tenant hit the monthly
   * cost cap (3× Premium fee). The UI shows a billing alert and stops
   * sending messages.
   */
  costCapReached?: boolean;
}

export interface SendAssistantMessageDto {
  content: string;
  conversationId?: string;
}

export interface CreateAssistantConversationDto {
  sessionId?: string;
  title?: string;
}

export interface DailyBriefing {
  date: string;
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'receptionist' | 'saas_owner';
  appointments: {
    total: number;
    confirmed: number;
    pending: number;
    items: Array<{
      id: string;
      time: string;
      status: string;
      clientFirstName: string | null;
      professionalFirstName: string | null;
    }>;
  };
  pendingConfirmations: {
    total: number;
    items: Array<{
      id: string;
      time: string;
      clientFirstName: string | null;
      professionalFirstName: string | null;
    }>;
  };
  gaps: {
    total: number;
    items: Array<{ start: string; end: string; minutes: number }>;
  };
  lowStock: {
    total: number;
    items: Array<{
      id: string;
      name: string;
      quantity: number;
      lowStockAlert: number;
    }>;
  };
  clientsAtRisk: {
    total: number;
    items: Array<{
      id: string;
      firstName: string;
      daysSinceLastVisit: number | null;
    }>;
  };
  generatedAt: string;
}

// Expose for the proactive-refresh timer callback set in
// `scheduleProactiveRefresh` above.
if (typeof window !== "undefined") {
  (window as any).__kiraApiClient = apiClient;
}

export interface AssistantUsage {
  month: string;
  messages: Record<string, number>;
  actionsTotal: number;
  approvalBreakdown: Record<string, number>;
  topConversations: Array<{ conversationId: string; messages: number }>;
  overCostCap: boolean;
}

// ---------------------------------------------------------------- loyalty

export interface LoyaltyProgramSettings {
  name: string;
  description: string | null;
  isActive: boolean;
  earnMode: "per_euro" | "per_visit";
  pointsPerEuro: number;
  pointsPerVisit: number;
  minPointsRedemption: number;
  welcomePoints: number;
  autoEnroll: boolean;
  allowSelfEnroll: boolean;
}

export interface LoyaltyTier {
  id: string;
  name: string;
  minPoints: number;
  pointsMultiplier: number;
}

export interface LoyaltyRewardInput {
  name: string;
  description?: string;
  type: "discount" | "free_service" | "product" | "voucher";
  pointsCost: number;
  discountPercent?: number | null;
  /** Cents. */
  discountAmount?: number | null;
  freeServiceId?: string | null;
  isActive?: boolean;
  /** How many times it can be redeemed in all; null: no limit. */
  maxRedemptions?: number | null;
  /** ISO date-time after which it can no longer be redeemed; null: never. */
  expiresAt?: string | null;
}

export interface LoyaltyReward extends LoyaltyRewardInput {
  id: string;
  isActive: boolean;
  currentRedemptions: number;
  redeemable?: boolean;
}

export interface LoyaltyProgram extends LoyaltyProgramSettings {
  id: string;
  tiers: LoyaltyTier[];
  rewards: LoyaltyReward[];
  _count: { members: number };
}

export interface LoyaltyMemberRow {
  id: string;
  currentPoints: number;
  lifetimePoints: number;
  totalSpent: number;
  status: string;
  enrolledVia: string | null;
  joinedAt: string;
  client: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null };
  tier: { name: string } | null;
}

export interface LoyaltyTransactionRow {
  id: string;
  createdAt: string;
  type: string;
  points: number;
  description: string | null;
}

/** The till's settings (GET/PUT /pos/settings). */
/** A line of the ticket as the server priced it (money cents, tax included). */
export interface PosQuoteLine {
  kind: "appointment" | "service" | "product";
  serviceId?: string;
  productId?: string;
  appointmentId?: string;
  professionalId?: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxRate: number;
  taxCents: number;
}

/** POST /pos/quote: what the checkout will charge. */
export interface PosQuote {
  lines: PosQuoteLine[];
  giftCards: Array<{ amountCents: number; recipientName?: string; recipientEmail?: string; message?: string }>;
  subtotal: number;
  discount: { lines: number; order: number; total: number };
  loyalty: { discount: number; pointsSpent: number; rewardName: string } | null;
  total: number;
  tax: { label: string; cents: number; included: boolean; note: string };
  invoice: { kind: "none" | "simplified" | "full"; problem?: string };
}

/** A sale recorded at the till (POST /pos/checkout, /pos/quick-sale). */
export interface PosSale {
  saleId: string;
  orderId: string;
  kind: "checkout" | "quick_sale";
  total: number;
  change: number;
  tendered: number;
  discount?: { lines: number; order: number; total: number };
  loyalty?: { pointsEarned: number; pointsSpent: number; discount: number; rewardName?: string };
  invoice: { id: string; series: string; number: string; full: boolean } | null;
  giftCards?: Array<{ id: string; code: string; amountCents: number; recipientEmail?: string; emailSent?: boolean }>;
  /** Visits whose loyalty reward their issued invoice could not take: a rectificativa to issue by hand. */
  loyaltyNotOnInvoice?: Array<{ appointmentId: string; invoiceId?: string; invoice: string; amountCents: number }>;
  /** True when this answer is the first one of a sale sent again. */
  replayed?: boolean;
  [key: string]: unknown;
}

export interface PosSaleProduct {
  id: string;
  name: string;
  sku?: string | null;
  category?: string | null;
  chargeCents: number;
  taxRate: number;
  trackInventory: boolean;
  quantity: number;
}

/** GET /pos/sales/:id/receipt. */
export interface PosReceipt {
  saleId: string;
  salon: { name: string; tradeName: string; taxId: string | null; address: string; phone: string | null };
  invoice: { id: string; number: string; full: boolean; recipientName?: string | null; recipientTaxId?: string | null } | null;
  date: string;
  time: string;
  lines: Array<{
    kind: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
    discountCents: number;
    totalCents: number;
    taxRate: number;
    taxCents: number;
  }>;
  taxLabel: string;
  taxNote: string;
  taxBreakdown: Array<{ rate: number; baseCents: number; taxCents: number }>;
  taxCents: number;
  subtotalCents: number;
  discountCents: number;
  loyaltyDiscountCents: number;
  totalCents: number;
  payments: Array<{ method: string; amount: number }>;
  tenderedCents: number;
  changeCents: number;
  giftCards: Array<{ code: string; amountCents: number }>;
}

export type CashMovementType = "in" | "out";

export interface CashPerson {
  id: string;
  name: string | null;
}

export interface CashMovementRow {
  id: string;
  createdAt: string;
  type: CashMovementType;
  amountCents: number;
  reason: string;
  createdBy?: CashPerson | null;
}

/** What a session took, by method and in the drawer (cents): the owner's and managers' view only. */
export interface CashSessionFigures {
  /**
   * amountCents includes wallet top-ups taken with the method (topUpCents of
   * it); netCents is it minus refunds and wallet withdrawals handed back with it.
   */
  byMethod: Array<{
    method: string;
    count: number;
    amountCents: number;
    topUpCents: number;
    refundedCents: number;
    walletWithdrawnCents: number;
    netCents: number;
  }>;
  cash: {
    openingFloatCents: number;
    salesCents: number;
    changeGivenCents: number;
    tenderedCents: number;
    refundsCents: number;
    /** Cash handed over to load clients' wallets: in the drawer, not a sale. */
    walletTopUpsCents: number;
    /** Cash handed back from clients' wallets: out of the drawer. */
    walletWithdrawalsCents: number;
    movementsInCents: number;
    movementsOutCents: number;
    expectedCents: number;
  };
  sales: {
    count: number;
    grossCents: number;
    subtotalCents: number;
    discountCents: number;
    loyaltyDiscountCents: number;
    taxCents: number;
    netCents: number;
  };
  refunds: { count: number; totalCents: number };
  walletTopUps: { count: number; totalCents: number };
  walletWithdrawals: { count: number; totalCents: number };
}

/** What every view of a session has. */
interface CashSessionBase {
  id: string;
  status: "open" | "closed";
  openedAt: string;
  openingFloatCents: number;
  closedAt: string | null;
  countedCashCents: number | null;
  openedBy: CashPerson | null;
  closedBy: CashPerson | null;
  openingNotes: string | null;
  closingNotes: string | null;
  countBreakdown: Record<string, number> | null;
  movements: CashMovementRow[];
  salon: { name: string; timezone: string };
}

/** GET /pos/cash-sessions/:id for the owner and managers: the session and its figures (cents). */
export interface CashSessionFullView extends CashSessionBase {
  blind?: false;
  /** Open: what the drawer should hold now. Closed: what it should have held at close. */
  expectedCashCents: number | null;
  discrepancyCents: number | null;
  figures: CashSessionFigures;
}

/**
 * The same for staff (blind count): no expected cash, no totals, no
 * difference; only their own movements. The server never sends the rest.
 */
export interface CashSessionBlindView extends CashSessionBase {
  blind: true;
}

export type CashSessionView = CashSessionFullView | CashSessionBlindView;

export interface CashSessionCurrent {
  session: CashSessionView | null;
  /** The last close: its count is offered as the new float. */
  lastClosed: { id: string; closedAt: string; countedCashCents: number | null } | null;
  /** Owner and managers: the history of past sessions. */
  canSeeHistory: boolean;
}

export interface CashSessionSummary {
  id: string;
  status: "open" | "closed";
  openedAt: string;
  openingFloatCents: number;
  closedAt: string | null;
  countedCashCents: number | null;
  expectedCashCents: number | null;
  discrepancyCents: number | null;
  openedBy: CashPerson | null;
  closedBy: CashPerson | null;
}

export interface CashSessionList {
  sessions: CashSessionSummary[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  totals: { closedSessions: number; countedCashCents: number; expectedCashCents: number; discrepancyCents: number };
}

export interface PosSettings {
  /** The most a staff member may take off a line at the till, in percent. 0: only the owner or a manager. */
  maxStaffDiscountPercent: number;
}

export interface ClientLoyaltySummary {
  program: (LoyaltyProgramSettings & { id: string }) | null;
  member: (LoyaltyMemberRow & { tier: { name: string } | null }) | null;
  rewards: LoyaltyReward[];
  history: LoyaltyTransactionRow[];
}

// -------------------------------------------------------------- wait-list

export interface WaitListChannelOutcome {
  channel: "email" | "whatsapp" | "sms" | "inApp";
  status: "sent" | "skipped" | "failed";
  reason?: string;
}

export interface WaitListEntry {
  id: string;
  clientId: string;
  serviceId: string;
  professionalId: string | null;
  serviceName: string | null;
  professionalName: string | null;
  earliestDate: string | null;
  latestDate: string | null;
  status: "waiting" | "notified" | "cancelled" | "fulfilled" | "expired";
  notifiedAt: string | null;
  notifyCount: number;
  /** Set when the system (window_passed, too_old) or the client (client_left) closed it. */
  closedReason?: string | null;
  closedAt?: string | null;
  notes: string | null;
  createdAt: string;
  lastNotification: {
    at: string;
    auto: boolean;
    channels: WaitListChannelOutcome[];
    slot: { date: string | null; time: string | null; professionalId: string | null };
  } | null;
  // email and phone are null for staff (contactHidden): only owner and admin see them.
  client: { firstName: string; lastName: string; email: string | null; phone: string | null };
  contactHidden?: boolean;
}

export interface WaitListNotifyResult {
  notified: boolean;
  channels: WaitListChannelOutcome[];
  // null when the service is not bookable online: the notice asks the client to call.
  bookingUrl: string | null;
  summary: string;
}
