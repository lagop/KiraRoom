// Next.js API Client for Kira Room

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

// Token storage
const TOKEN_KEY = "kira_auth_token";
const REFRESH_TOKEN_KEY = "kira_refresh_token";

// Custom error class that carries the HTTP status so callers can distinguish
// 404 (resource not found) from other failures instead of parsing message text.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
  "/auth/register",
  "/auth/forgot-password",
  "/auth/reset-password",
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
): string | null {
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

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
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

export interface ImportPreviewRow {
  rowIndex: number;
  data: Record<string, string>;
  errors: Array<{ col: string; msg: string }>;
  status: "ok" | "duplicate" | "invalid";
  existingClientId?: string;
}
export interface ImportPreviewResult {
  jobId: string;
  filename: string;
  preview: ImportPreviewRow[];
  stats: {
    totalRows: number;
    okCount: number;
    duplicateCount: number;
    invalidCount: number;
  };
  errors: Array<{ row: number; fields: Array<{ col: string; msg: string }> }>;
}
export interface ImportCommitResult {
  jobId: string;
  totalRows: number;
  successRows: number;
  errorRows: number;
  skippedRows: number;
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
  status: string;
  publishedToGoogle: boolean;
  createdAt: string;
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
export interface WhatsAppCampaign {
  id: string;
  tenantId: string;
  name: string;
  templateId: string;
  status: string;
  totalRecipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  optedOut: number;
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

export interface Client {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: "male" | "female" | "other";
  profileImage?: string;
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
  notes?: string;
  // P2A â€” Spanish tax compliance
  taxId?: string | null;
  taxIdType?: "nif" | "cif" | "nie" | "passport" | "other" | null;
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
  price: number;
  currency: string;
  isActive: boolean;
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
  tenantId: string;
  clientId?: string;
  clientInfo?: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  serviceId: string;
  professionalId: string;
  scheduledDate: string;
  scheduledTime: string;
  notes?: string;
  depositRequired?: boolean;
  depositAmount?: number;
  commissionRate?: number;
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
  status:
    | "pending"
    | "processing"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "refunded"
    | "partially_refunded";
  method: "card" | "cash" | "bank_transfer" | "wallet" | "gift_card";
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
  };
}

export interface PaymentSummary {
  totalRevenue: number;
  totalTransactions: number;
  pendingAmount: number;
  refundedAmount: number;
}

export interface StripeSettings {
  stripeMode: "test" | "live";
  stripeTestSecretKey: string | null;
  stripeTestPublishableKey: string | null;
  stripeLiveSecretKey: string | null;
  stripeLivePublishableKey: string | null;
  isConfigured: boolean;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
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
  unsubscribes: number;
  fromName?: string;
  replyTo?: string;
  _count?: {
    recipients: number;
  };
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
  openRate: number;
  clickRate: number;
  bounceRate: number;
  unsubscribeRate: number;
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

export interface ClientWallet {
  id: string;
  clientId: string;
  tenantId: string;
  balance: number;
  currency: string;
  loyaltyPoints: number;
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
  sortOrder: number;
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

export interface GoogleBusinessProfile {
  id: string;
  tenantId: string;
  businessName: string | null;
  businessAddress: string | null;
  businessPhone: string | null;
  businessWebsite: string | null;
  businessEmail: string | null;
  locationId: string | null;
  locationName: string | null;
  ranking: number | null;
  totalReviews: number;
  averageRating: number;
  profileComplete: boolean;
  enableOnlineBooking: boolean;
  enableReviewRequests: boolean;
  showRealTimeAvailability: boolean;
  lastSyncAt: string | null;
}

export interface GoogleReview {
  id: string;
  reviewId: string;
  reviewerName: string | null;
  reviewerPhoto: string | null;
  rating: number;
  comment: string | null;
  replyComment: string | null;
  replyAt: string | null;
  googleCreatedAt: string | null;
  createdAt: string;
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
  fiscalSettings: {
    enabled?: boolean;
    syncOnIssue?: boolean;
    autoInvoiceAppointments?: boolean;
    defaultSeries?: string;
    defaultTaxRate?: number;
    diputacion?: "bizkaia" | "gipuzkoa" | "alava" | null;
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
export type AccountingProvider = "holded" | "sage" | "a3" | "ncs";

export interface AccountingSettings {
  provider: AccountingProvider | null;
  enabled: boolean;
  syncOnIssue: boolean;
}

export interface AccountingConnectionInfo {
  accountingSettings: AccountingSettings;
  accountingConnection: {
    id: string;
    provider: AccountingProvider;
    isActive: boolean;
    lastSyncAt: string | null;
    lastError: string | null;
    externalCompanyId: string | null;
    expiresAt: string | null;
  } | null;
}

export interface AccountingSyncLog {
  id: string;
  tenantId: string;
  invoiceId: string;
  provider: AccountingProvider;
  action: string;
  status: string;
  externalId: string | null;
  errorMessage: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface ApiClientInterface {
  request<T>(endpoint: string, options?: RequestInit): Promise<T>;
  login(email: string, password: string): Promise<LoginResponse>;
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
  getClients(tenantId?: string): Promise<Client[]>;
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
  getClient(id: string): Promise<Client>;
  createClient(data: {
    tenantId: string;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    dateOfBirth?: string;
    gender?: "male" | "female" | "other" | "prefer_not_to_say";
    profileImage?: string;
  }): Promise<Client>;
  updateClient(
    id: string,
    data: Partial<{
      firstName: string;
      lastName: string;
      email?: string;
      phone?: string;
      dateOfBirth?: string;
      gender?: "male" | "female" | "other" | "prefer_not_to_say";
      profileImage?: string;
      preferredLanguage?: string;
      preferredServices?: string[];
      preferredProfessionals?: string[];
      preferredTimes?: string[];
      communicationPreferences?: Record<string, any>;
      status: "active" | "inactive" | "blocked";
    }>,
  ): Promise<Client>;
  deleteClient(id: string): Promise<void>;
  getServices(tenantId?: string): Promise<Service[]>;
  getService(id: string): Promise<Service>;
  createService(data: {
    tenantId: string;
    name: string;
    description?: string;
    category: "hair" | "nails" | "facial" | "massage" | "body" | "other";
    duration: number;
    price: number;
    currency: string;
  }): Promise<Service>;
  updateService(
    id: string,
    data: Partial<{
      name: string;
      description?: string;
      category: "hair" | "nails" | "facial" | "massage" | "body" | "other";
      duration: number;
      price: number;
      currency: string;
      isActive: boolean;
    }>,
  ): Promise<Service>;
  deleteService(id: string): Promise<void>;
  getProfessionalsPublic(tenantId?: string): Promise<Professional[]>;
  getProfessionals(tenantId?: string): Promise<Professional[]>;
  getProfessional(id: string): Promise<Professional>;
  createProfessional(data: {
    tenantId: string;
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
      commissionRate?: number;
      hireDate?: string;
      isActive: boolean;
      serviceIds?: string[];
    }>,
  ): Promise<Professional>;
  deleteProfessional(id: string): Promise<void>;
  changeProfessionalPassword(
    professionalId: string,
    data: { newPassword: string },
  ): Promise<any>;
  getAvailableSlots(
    tenantId: string,
    professionalId: string,
    serviceId: string,
    date: string,
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
  // Client notifications (for salon site)
  getClientNotificationPreferences(clientId: string): Promise<any>;
  updateClientNotificationPreferences(
    clientId: string,
    preferences: any,
  ): Promise<any>;
  updateMyProfile(clientId: string, data: any): Promise<any>;
  getClientNotifications(
    clientId: string,
    params?: {
      limit?: number;
      offset?: number;
      unreadOnly?: boolean;
      type?: string;
    },
  ): Promise<{ data: Notification[]; total: number; unreadCount: number }>;
  getClientUnreadNotificationCount(
    clientId: string,
  ): Promise<{ count: number }>;
  markClientNotificationAsRead(
    clientId: string,
    id: string,
  ): Promise<Notification>;
  markAllClientNotificationsAsRead(
    clientId: string,
  ): Promise<{ success: boolean; count: number }>;
  archiveClientNotification(clientId: string, id: string): Promise<void>;

  // Payments
  getPayments(params?: {
    tenantId?: string;
    clientId?: string;
    appointmentId?: string;
    status?: string;
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
  getTodayPayments(): Promise<{
    payments: any[];
    totals: { cash: number; card: number };
  }>;
  deletePayment(id: string): Promise<void>;
  createPayment(data: CreatePaymentDto): Promise<Payment>;
  updatePaymentStatus(id: string, status: string): Promise<Payment>;
  getPaymentByAppointment(appointmentId: string): Promise<Payment[]>;
  processDeposit(
    appointmentId: string,
    amount: number,
    method: "card" | "cash",
  ): Promise<Payment>;
  collectBalance(
    appointmentId: string,
    amount: number,
    method: "card" | "cash",
  ): Promise<Payment>;
  getPaymentByClient(clientId: string): Promise<Payment[]>;
  getPaymentSummary(tenantId: string): Promise<PaymentSummary>;
  confirmPayment(paymentIntentId: string): Promise<Payment>;
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
  requestAddOnCheckout(addOnKey: string): Promise<{ url?: string; checkoutUrl?: string }>;
  cancelTenantAddOn(addOnKey: string): Promise<{ ok: boolean }>;

  // P2A-receptionist-v2 â€” AI usage counter for the billing dashboard.
  getAiUsage(): Promise<{ used: number; cap: number | null; resetsAt: string | null }>;

  // P2A-receptionist-v2 â€” message bundles (metered WhatsApp marketing + SMS).
  getMessageBundlesBalance(): Promise<MessageBundlesBalance>;

  // Client Wallet
  getClientWallet(clientId: string): Promise<ClientWallet>;

  // POS
  getPosServices(): Promise<any[]>;
  getPosClients(search?: string): Promise<any[]>;
  getPosDashboard(date?: string): Promise<any>;
  posCheckout(data: any): Promise<{ orderId: string }>;
  // Products
  getProducts(params?: {
    category?: string;
    search?: string;
    lowStock?: boolean;
  }): Promise<any[]>;
  getProduct(id: string): Promise<any>;
  createProduct(data: any): Promise<any>;
  updateProduct(id: string, data: any): Promise<any>;
  deleteProduct(id: string): Promise<void>;
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
  }): Promise<{ id: string }>;

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
  sendEmailCampaignNow(id: string): Promise<any>;
  addRecipientsToCampaign(id: string, clientIds: string[]): Promise<any>;
  getEmailCampaignAnalytics(id: string): Promise<EmailCampaignAnalytics>;
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
    }>;
    notes?: string;
  }): Promise<{ id: string }>;
  cancelInvoice(id: string, reason: string): Promise<Invoice>;
  resendFiscal(id: string): Promise<Invoice>;
  generateInvoiceFromOrder(orderId: string): Promise<{ id: string } | null>;
  generateInvoiceFromAppointment(
    appointmentId: string,
  ): Promise<{ id: string } | null>;
  getInvoicePdfUrl(id: string): string;
  getInvoiceXmlUrl(id: string): string;

  // P2A â€” Fiscal settings
  getFiscalSettings(): Promise<FiscalSettings>;
  updateFiscalSettings(patch: {
    fiscalMode?: "none" | "verifactu" | "ticketbai" | "sii_only";
    defaultSeries?: string;
    defaultTaxRate?: number;
    autoInvoiceAppointments?: boolean;
    diputacion?: "bizkaia" | "gipuzkoa" | "alava" | null;
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
  getAccountingSettings(): Promise<AccountingConnectionInfo>;
  updateAccountingSettings(patch: {
    provider?: AccountingProvider | null;
    enabled?: boolean;
    syncOnIssue?: boolean;
  }): Promise<{ accountingSettings: AccountingSettings }>;
  startAccountingOAuth(
    provider: AccountingProvider,
  ): Promise<{ url: string; state: string }>;
  disconnectAccounting(): Promise<{ ok: boolean }>;
  syncAccountingInvoice(
    invoiceId: string,
  ): Promise<{ status: string; externalId?: string; error?: string }>;
  retryAccountingQueue(limit?: number): Promise<{
    attempted: number;
    synced: number;
    skipped: number;
    errors: number;
  }>;
  listAccountingLogs(limit?: number): Promise<AccountingSyncLog[]>;
  publicRebookingOptOut(
    token: string,
    clientId: string,
  ): Promise<{ ok: boolean }>;

  // Appointments
  createAppointmentByStaff(
    appointment: CreateAppointmentDto,
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
      if (typeof window !== "undefined") {
        // Clear SaaS user cookie
        document.cookie = "saas_user=; path=/; max-age=0";
        // null when we are already on that login page -- navigating there
        // again would reload it and loop. See loginRedirectTarget.
        const target = loginRedirectTarget(window.location.pathname, isSaasUser);
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
      if (typeof window !== "undefined") {
        // Clear SaaS user cookie
        document.cookie = "saas_user=; path=/; max-age=0";
        // null when we are already on that login page -- navigating there
        // again would reload it and loop. See loginRedirectTarget.
        const target = loginRedirectTarget(window.location.pathname, isSaasUser);
        if (target) window.location.href = target;
      }
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new ApiError(
        errorData.message ||
          `API Error: ${response.status} ${response.statusText}`,
        response.status,
      );
    }
    return response.json();
  }

  // Auth
  async login(email: string, password: string): Promise<LoginResponse> {
    const response = await this.request<{ user: any; tokens: any }>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
    );

    // Store both tokens
    setToken(response.tokens.accessToken);
    setRefreshToken(response.tokens.refreshToken);
    scheduleProactiveRefresh(response.tokens.accessToken);

    return {
      accessToken: response.tokens.accessToken,
      refreshToken: response.tokens.refreshToken,
      user: response.user,
    };
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
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;

    try {
      // Use raw fetch here â€” NOT `this.request` â€” to bypass the 401
      // handler. The /auth/refresh response on the wire returns the
      // new tokens at the TOP LEVEL of the JSON body (see
      // auth.service.ts:222-292 + auth.controller.ts:71-78), not
      // nested under `tokens`.
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) return false;
      const data = (await response.json()) as {
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
        tokenType?: string;
      };
      if (!data.accessToken || !data.refreshToken) return false;

      setToken(data.accessToken);
      setRefreshToken(data.refreshToken);
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
  }): Promise<LoginResponse> {
    return this.request<LoginResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async logout(): Promise<void> {
    removeToken();
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
    data: CreateAppointmentDto,
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
    return this.request<Appointment>(`/appointments/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
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

  async getClient(id: string): Promise<Client> {
    return this.request<Client>(`/admin/clients/${id}`);
  }

  async createClient(data: {
    tenantId: string;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    dateOfBirth?: string;
    gender?: "male" | "female" | "other" | "prefer_not_to_say";
    profileImage?: string;
  }): Promise<Client> {
    return this.request<Client>("/clients", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateClient(
    id: string,
    data: Partial<{
      firstName: string;
      lastName: string;
      email?: string;
      phone?: string;
      dateOfBirth?: string;
      gender?: "male" | "female" | "other" | "prefer_not_to_say";
      profileImage?: string;
      preferredLanguage?: string;
      preferredServices?: string[];
      preferredProfessionals?: string[];
      preferredTimes?: string[];
      communicationPreferences?: Record<string, any>;
      status: "active" | "inactive" | "blocked";
      notes?: string;
    }>,
  ): Promise<Client> {
    return this.request<Client>(`/admin/clients/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteClient(id: string): Promise<void> {
    return this.request<void>(`/admin/clients/${id}`, {
      method: "DELETE",
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

  async createService(data: {
    tenantId: string;
    name: string;
    description?: string;
    category: "hair" | "nails" | "facial" | "massage" | "body" | "other";
    duration: number;
    price: number;
    currency: string;
  }): Promise<Service> {
    return this.request<Service>("/services", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateService(
    id: string,
    data: Partial<{
      name: string;
      description?: string;
      category: "hair" | "nails" | "facial" | "massage" | "body" | "other";
      duration: number;
      price: number;
      currency: string;
      isActive: boolean;
    }>,
  ): Promise<Service> {
    return this.request<Service>(`/services/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteService(id: string): Promise<void> {
    return this.request<void>(`/services/${id}`, {
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

  // Professionals - Admin routes
  async getProfessionals(tenantId?: string): Promise<Professional[]> {
    const params = tenantId ? `?tenantId=${tenantId}` : "";
    const response = await this.request<{
      data: Professional[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    }>(`/admin/professionals${params}`);
    return response.data;
  }

  async getProfessional(id: string): Promise<Professional> {
    return this.request<Professional>(`/admin/professionals/${id}`);
  }

  async createProfessional(data: {
    tenantId: string;
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
      commissionRate?: number;
      hireDate?: string;
      isActive: boolean;
      serviceIds?: string[];
    }>,
  ): Promise<Professional> {
    return this.request<Professional>(`/admin/professionals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteProfessional(id: string): Promise<void> {
    return this.request<void>(`/admin/professionals/${id}`, {
      method: "DELETE",
    });
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
  ): Promise<{ time: string; isAvailable: boolean }[]> {
    let endpoint = `/appointments/available-slots?tenantId=${tenantId}&serviceId=${serviceId}&date=${date}`;

    // Add professionalIds if provided (for multi-professional scheduling)
    if (professionalIds && professionalIds.length > 0) {
      endpoint += `&professionalIds=${professionalIds.join(",")}`;
    } else if (professionalId) {
      endpoint += `&professionalId=${professionalId}`;
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

  // Client notification preferences
  async getClientNotificationPreferences(clientId: string): Promise<any> {
    return this.request<any>(`/clients/${clientId}/notifications/preferences`);
  }

  async updateClientNotificationPreferences(
    clientId: string,
    preferences: any,
  ): Promise<any> {
    return this.request<any>(`/clients/${clientId}/notifications/preferences`, {
      method: "PUT",
      body: JSON.stringify(preferences),
    });
  }

  async updateMyProfile(clientId: string, data: any): Promise<any> {
    return this.request<any>(`/clients/${clientId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  // Client Notifications (for salon site)
  async getClientNotifications(
    clientId: string,
    params?: {
      limit?: number;
      offset?: number;
      unreadOnly?: boolean;
      type?: string;
    },
  ): Promise<{ data: Notification[]; total: number; unreadCount: number }> {
    const searchParams = new URLSearchParams();
    searchParams.append("clientId", clientId);
    if (params?.limit) searchParams.append("limit", params.limit.toString());
    if (params?.offset) searchParams.append("offset", params.offset.toString());
    if (params?.unreadOnly) searchParams.append("unreadOnly", "true");
    if (params?.type) searchParams.append("type", params.type);

    const query = searchParams.toString();
    return this.request<{
      data: Notification[];
      total: number;
      unreadCount: number;
    }>(`/client/notifications?${query}`);
  }

  async getClientUnreadNotificationCount(
    clientId: string,
  ): Promise<{ count: number }> {
    return this.request<{ count: number }>(
      `/client/notifications/unread-count?clientId=${clientId}`,
    );
  }

  async markClientNotificationAsRead(
    clientId: string,
    id: string,
  ): Promise<Notification> {
    return this.request<Notification>(
      `/client/notifications/${id}/read?clientId=${clientId}`,
      {
        method: "PUT",
      },
    );
  }

  async sendVirtualReceptionistMessage(data: {
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
  }> {
    return this.request("/virtual-receptionist/messages", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async markAllClientNotificationsAsRead(
    clientId: string,
  ): Promise<{ success: boolean; count: number }> {
    return this.request<{ success: boolean; count: number }>(
      `/client/notifications/read-all?clientId=${clientId}`,
      {
        method: "PUT",
      },
    );
  }

  async archiveClientNotification(clientId: string, id: string): Promise<void> {
    return this.request<void>(
      `/client/notifications/${id}?clientId=${clientId}`,
      {
        method: "DELETE",
      },
    );
  }

  // Payments
  async getPayments(params?: {
    tenantId?: string;
    clientId?: string;
    appointmentId?: string;
    status?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    dateFrom?: string;
    dateTo?: string;
  }): Promise<{
    payments: Payment[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    const query = new URLSearchParams(
      params as Record<string, string>,
    ).toString();
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

  // Get today's payments for POS
  async getTodayPayments(): Promise<{
    payments: any[];
    totals: { cash: number; card: number };
  }> {
    return this.request<{
      payments: any[];
      totals: { cash: number; card: number };
    }>("/payments/today");
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

  async updatePaymentStatus(id: string, status: string): Promise<Payment> {
    return this.request<Payment>(`/payments/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  async getPaymentByAppointment(appointmentId: string): Promise<Payment[]> {
    return this.request<Payment[]>(`/payments/appointment/${appointmentId}`);
  }

  async processDeposit(
    appointmentId: string,
    amount: number,
    method: "card" | "cash",
  ): Promise<Payment> {
    return this.request<Payment>(
      `/payments/appointments/${appointmentId}/deposit`,
      {
        method: "POST",
        body: JSON.stringify({ amount, method }),
      },
    );
  }

  async collectBalance(
    appointmentId: string,
    amount: number,
    method: "card" | "cash",
  ): Promise<Payment> {
    return this.request<Payment>(
      `/payments/appointments/${appointmentId}/collect-balance`,
      {
        method: "POST",
        body: JSON.stringify({ amount, method }),
      },
    );
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

  // Loyalty Programs API
  async createLoyaltyProgram(data: any): Promise<any> {
    return this.request<any>("/loyalty/programs", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getLoyaltyPrograms(tenantId: string): Promise<any[]> {
    return this.request<any[]>(`/loyalty/programs/${tenantId}`);
  }

  async getLoyaltyProgram(id: string): Promise<any> {
    return this.request<any>(`/loyalty/programs/detail/${id}`);
  }

  async updateLoyaltyProgram(id: string, data: any): Promise<any> {
    return this.request<any>(`/loyalty/programs/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async deleteLoyaltyProgram(id: string): Promise<any> {
    return this.request<any>(`/loyalty/programs/${id}`, {
      method: "DELETE",
    });
  }

  async createLoyaltyTier(data: any): Promise<any> {
    return this.request<any>("/loyalty/tiers", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async deleteLoyaltyTier(id: string): Promise<any> {
    return this.request<any>(`/loyalty/tiers/${id}`, {
      method: "DELETE",
    });
  }

  async createLoyaltyReward(data: any): Promise<any> {
    return this.request<any>("/loyalty/rewards", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getLoyaltyRewards(programId: string): Promise<any[]> {
    return this.request<any[]>(`/loyalty/rewards/${programId}`);
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
    expiresAt?: string;
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

  async deleteLoyaltyReward(id: string): Promise<any> {
    return this.request<any>(`/loyalty/rewards/${id}`, {
      method: "DELETE",
    });
  }

  async addLoyaltyMember(clientId: string, programId: string): Promise<any> {
    return this.request<any>("/loyalty/members", {
      method: "POST",
      body: JSON.stringify({ clientId, programId }),
    });
  }

  async getLoyaltyMembers(programId: string): Promise<any[]> {
    return this.request<any[]>(`/loyalty/members/${programId}`);
  }

  async awardLoyaltyPoints(
    memberId: string,
    points: number,
    description: string,
  ): Promise<any> {
    return this.request<any>("/loyalty/points/award", {
      method: "POST",
      body: JSON.stringify({ memberId, points, description }),
    });
  }

  async redeemLoyaltyPoints(
    memberId: string,
    points: number,
    rewardId: string,
  ): Promise<any> {
    return this.request<any>("/loyalty/points/redeem", {
      method: "POST",
      body: JSON.stringify({ memberId, points, rewardId }),
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

  async getPaymentSummary(tenantId: string): Promise<PaymentSummary> {
    return this.request<PaymentSummary>(
      `/payments/stats/summary?tenantId=${tenantId}`,
    );
  }

  async confirmPayment(paymentIntentId: string): Promise<Payment> {
    return this.request<Payment>(`/payments/confirm/${paymentIntentId}`, {
      method: "POST",
    });
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

  async requestAddOnCheckout(
    addOnKey: string,
    opts: { returnTo?: string } = {},
  ): Promise<{ url?: string; checkoutUrl?: string }> {
    return this.request(`/payments/add-ons/${addOnKey}/checkout`, {
      method: "POST",
      body: JSON.stringify(opts),
    });
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

  async getMessageBundlesBalance(): Promise<MessageBundlesBalance> {
    return this.request<MessageBundlesBalance>(
      "/message-bundles/tenants/current/balance",
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

  async posCheckout(data: any): Promise<{ orderId: string }> {
    return this.request<{ orderId: string }>("/pos/checkout", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async posQuickSale(data: {
    serviceId: string;
    paymentMethod: string;
    clientId?: string;
  }): Promise<{ id: string }> {
    return this.request<{ id: string }>("/pos/quick-sale", {
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

  async deleteProduct(id: string): Promise<void> {
    return this.request<void>(`/pos/products/${id}`, {
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

  async sendEmailCampaignNow(id: string): Promise<any> {
    return this.request<any>(`/email-campaigns/${id}/send`, {
      method: "POST",
    });
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

  // Google Business Profile
  async getGoogleBusinessProfile(): Promise<GoogleBusinessProfile> {
    return this.request<GoogleBusinessProfile>(
      "/social-integrations/google-business",
    );
  }

  async updateGoogleBusinessProfile(data: {
    enableOnlineBooking?: boolean;
    enableReviewRequests?: boolean;
    showRealTimeAvailability?: boolean;
  }): Promise<GoogleBusinessProfile> {
    return this.request<GoogleBusinessProfile>(
      "/social-integrations/google-business",
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    );
  }

  async syncGoogleBusinessProfile(): Promise<GoogleBusinessProfile> {
    return this.request<GoogleBusinessProfile>(
      "/social-integrations/google-business/sync",
      {
        method: "POST",
      },
    );
  }

  async getGoogleReviews(): Promise<GoogleReview[]> {
    return this.request<GoogleReview[]>(
      "/social-integrations/google-business/reviews",
    );
  }

  async replyToGoogleReview(
    reviewId: string,
    replyComment: string,
  ): Promise<GoogleReview> {
    return this.request<GoogleReview>(
      `/social-integrations/google-business/reviews/${reviewId}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ replyComment }),
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
  async getChannelsConfig(): Promise<{
    enabled: boolean;
    enabledChannels: string[];
    meta: {
      configured: boolean;
      pageId?: string;
      instagramBusinessAccountId?: string;
      linkedChats: string[];
      webhookSecret?: string;
      hasAccessToken: boolean;
    } | null;
    telegram: {
      configured: boolean;
      botUsername?: string;
      linkedChats: string[];
      hasBotToken: boolean;
    } | null;
  } | null> {
    return this.request("/virtual-receptionist/channels/config");
  }

  /**
   * Update the multichannel config for the active tenant.
   * The endpoint performs a partial merge â€” fields you don't pass are
   * preserved. To remove a channel entirely, omit it from
   * `enabledChannels` and the registry will fall back to Web.
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
    meta?: {
      pageId?: string;
      pageAccessToken?: string;
      instagramBusinessAccountId?: string;
      linkedChats?: string[];
      webhookSecret?: string;
    };
    telegram?: {
      botToken?: string;
      linkedChats?: string[];
    };
  }): Promise<{
    enabled: boolean;
    enabledChannels: string[];
    meta: {
      configured: boolean;
      pageId?: string;
      instagramBusinessAccountId?: string;
      linkedChats: string[];
      webhookSecret?: string;
      hasAccessToken: boolean;
    } | null;
    telegram: {
      configured: boolean;
      botUsername?: string;
      linkedChats: string[];
      hasBotToken: boolean;
    } | null;
  }> {
    return this.request("/virtual-receptionist/channels/config", {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  /**
   * H-4: per-channel volume counters for the wizard's small
   * dashboard tile. Returned shape:
   *   {
   *     inbound: { web, whatsapp, facebook, instagram, telegram },
   *     outbound: { facebook: { ok, skipped, error }, ... },
   *     gateBlocked: { facebook: { no_feature, lookup_error }, ... }
   *   }
   */
  async getChannelsMetrics(): Promise<{
    inbound: Record<string, number>;
    outbound: Record<string, { ok: number; skipped: number; error: number }>;
    gateBlocked: Record<
      string,
      { no_feature: number; lookup_error: number }
    >;
  }> {
    return this.request("/virtual-receptionist/channels/metrics");
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
  ): Promise<{ user: any; tokens: { accessToken: string; refreshToken: string; expiresIn: number; tokenType: string } }> {
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
    refreshToken: string;
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

  // Import CSV (clients)
  async dryRunImportClients(csv: string, filename: string): Promise<ImportPreviewResult> {
    return this.request(`/import/clients/dry-run`, {
      method: "POST",
      body: JSON.stringify({ csv, filename }),
    });
  }
  async commitImportClients(csv: string, filename: string): Promise<ImportCommitResult> {
    return this.request(`/import/clients/commit`, {
      method: "POST",
      body: JSON.stringify({ csv, filename }),
    });
  }
  async listImportJobs(): Promise<ImportJob[]> {
    return this.request(`/import/jobs`);
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
  async signConsent(input: {
    tenantId: string;
    clientId: string;
    formId: string;
    responses: Record<string, unknown>;
    signatureName: string;
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
  async listWhatsAppTemplates(): Promise<Array<{ name: string; status: string; language?: string }>> {
    return this.request(`/whatsapp/templates`);
  }
  async createWhatsAppCampaign(input: {
    name: string;
    templateId: string;
    templateVars?: Record<string, string>;
    segmentFilter?: Record<string, unknown>;
    audience: string[];
    scheduledAt?: string;
  }): Promise<WhatsAppCampaign> {
    return this.request(`/whatsapp/campaigns`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  async sendWhatsAppCampaign(id: string): Promise<{ enqueued: number }> {
    return this.request(`/whatsapp/campaigns/${id}/send`, { method: "POST" });
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
    }>;
    notes?: string;
  }): Promise<{ id: string }> {
    return this.request(`/invoices`, {
      method: "POST",
      body: JSON.stringify(input),
    });
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
  getInvoicePdfUrl(id: string): string {
    return `${API_BASE_URL}/invoices/${id}/pdf`;
  }
  getInvoiceXmlUrl(id: string): string {
    return `${API_BASE_URL}/invoices/${id}/xml`;
  }

  // ---- P2A Fiscal settings ----
  async getFiscalSettings(): Promise<FiscalSettings> {
    return this.request(`/invoices/settings/fiscal`);
  }
  async updateFiscalSettings(patch: {
    fiscalMode?: "none" | "verifactu" | "ticketbai" | "sii_only";
    defaultSeries?: string;
    defaultTaxRate?: number;
    autoInvoiceAppointments?: boolean;
    diputacion?: "bizkaia" | "gipuzkoa" | "alava" | null;
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
  async getAccountingSettings(): Promise<AccountingConnectionInfo> {
    return this.request(`/accounting/settings`);
  }
  async updateAccountingSettings(patch: {
    provider?: AccountingProvider | null;
    enabled?: boolean;
    syncOnIssue?: boolean;
  }): Promise<{ accountingSettings: AccountingSettings }> {
    return this.request(`/accounting/settings`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
  async startAccountingOAuth(
    provider: AccountingProvider,
  ): Promise<{ url: string; state: string }> {
    return this.request(`/accounting/connect/${provider}`);
  }
  async disconnectAccounting(): Promise<{ ok: boolean }> {
    return this.request(`/accounting/disconnect`, { method: "POST" });
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
  async retryAccountingQueue(
    limit = 50,
  ): Promise<{ attempted: number; synced: number; skipped: number; errors: number }> {
    return this.request(`/accounting/retry-queue`, {
      method: "POST",
      body: JSON.stringify({ limit }),
    });
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







