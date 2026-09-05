// Application constants

export const APP_NAME = 'Kira Room';
export const APP_VERSION = '1.0.0';

// API Constants
export const API_VERSION = 'v1';
export const API_PREFIX = `api/${API_VERSION}`;

// Pagination
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Date/Time Constants
export const DATE_FORMAT = 'dd/MM/yyyy';
export const TIME_FORMAT = 'HH:mm';
export const DATETIME_FORMAT = 'dd/MM/yyyy HH:mm';

export const DEFAULT_TIMEZONE = 'Europe/Madrid';
export const DEFAULT_LANGUAGE = 'es';

export const BUSINESS_HOURS = {
  DEFAULT_OPEN_TIME: '09:00',
  DEFAULT_CLOSE_TIME: '18:00',
  DEFAULT_BUFFER_TIME: 15, // minutes
  MIN_ADVANCE_BOOKING: 2, // hours
  MAX_ADVANCE_BOOKING: 30, // days
};

// Appointment Status
export const APPOINTMENT_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
} as const;

export const APPOINTMENT_STATUS_LABELS = {
  [APPOINTMENT_STATUS.PENDING]: 'Pendiente',
  [APPOINTMENT_STATUS.CONFIRMED]: 'Confirmada',
  [APPOINTMENT_STATUS.IN_PROGRESS]: 'En progreso',
  [APPOINTMENT_STATUS.COMPLETED]: 'Completada',
  [APPOINTMENT_STATUS.CANCELLED]: 'Cancelada',
  [APPOINTMENT_STATUS.NO_SHOW]: 'No se presentó',
} as const;

// Payment Status
export const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
} as const;

export const PAYMENT_STATUS_LABELS = {
  [PAYMENT_STATUS.PENDING]: 'Pendiente',
  [PAYMENT_STATUS.PAID]: 'Pagado',
  [PAYMENT_STATUS.FAILED]: 'Fallido',
  [PAYMENT_STATUS.REFUNDED]: 'Reembolsado',
} as const;

// Service Categories
export const SERVICE_CATEGORIES = {
  HAIR: 'hair',
  NAILS: 'nails',
  FACIAL: 'facial',
  MASSAGE: 'massage',
  BODY: 'body',
  OTHER: 'other',
} as const;

export const SERVICE_CATEGORY_LABELS = {
  [SERVICE_CATEGORIES.HAIR]: 'Cabello',
  [SERVICE_CATEGORIES.NAILS]: 'Uñas',
  [SERVICE_CATEGORIES.FACIAL]: 'Facial',
  [SERVICE_CATEGORIES.MASSAGE]: 'Masaje',
  [SERVICE_CATEGORIES.BODY]: 'Corporal',
  [SERVICE_CATEGORIES.OTHER]: 'Otro',
} as const;

// User Roles
export const USER_ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  STAFF: 'staff',
  CLIENT: 'client',
} as const;

export const USER_ROLE_LABELS = {
  [USER_ROLES.OWNER]: 'Propietario',
  [USER_ROLES.ADMIN]: 'Administrador',
  [USER_ROLES.STAFF]: 'Personal',
  [USER_ROLES.CLIENT]: 'Cliente',
} as const;

// Client Status
export const CLIENT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  BLOCKED: 'blocked',
} as const;

export const CLIENT_STATUS_LABELS = {
  [CLIENT_STATUS.ACTIVE]: 'Activo',
  [CLIENT_STATUS.INACTIVE]: 'Inactivo',
  [CLIENT_STATUS.BLOCKED]: 'Bloqueado',
} as const;

// Languages
export const LANGUAGES = {
  ES: 'es',
  EN: 'en',
} as const;

export const LANGUAGE_LABELS = {
  [LANGUAGES.ES]: 'Español',
  [LANGUAGES.EN]: 'English',
} as const;

// Currencies
export const CURRENCIES = {
  EUR: 'EUR',
  USD: 'USD',
  GBP: 'GBP',
  MXN: 'MXN',
  ARS: 'ARS',
  COP: 'COP',
} as const;

export const CURRENCY_SYMBOLS = {
  [CURRENCIES.EUR]: '€',
  [CURRENCIES.USD]: '$',
  [CURRENCIES.GBP]: '£',
  [CURRENCIES.MXN]: '$',
  [CURRENCIES.ARS]: '$',
  [CURRENCIES.COP]: '$',
} as const;

// Subscription Plans
// Rev 3: the canonical plan catalog now lives in
// `packages/shared/src/types/subscription.ts` (esencial / pro / empresa)
// and is consumed by both backend and frontend. The legacy BASIC /
// PROFESSIONAL / ADVANCED names below are kept exported for one release
// as a soft-deprecation; new code should import from `types/subscription`.
//
// TODO(next release): remove SUBSCRIPTION_PLANS / SUBSCRIPTION_PLAN_LABELS
// once every consumer has been migrated to the canonical PlanId.
export const SUBSCRIPTION_PLANS = {
  BASIC: 'basic',
  PROFESSIONAL: 'professional',
  ADVANCED: 'advanced',
} as const;

export const SUBSCRIPTION_PLAN_LABELS = {
  [SUBSCRIPTION_PLANS.BASIC]: 'Básico',
  [SUBSCRIPTION_PLANS.PROFESSIONAL]: 'Profesional',
  [SUBSCRIPTION_PLANS.ADVANCED]: 'Avanzado',
} as const;

// Notification Channels
export const NOTIFICATION_CHANNELS = {
  EMAIL: 'email',
  SMS: 'sms',
  WHATSAPP: 'whatsapp',
  PUSH: 'push',
} as const;

export const NOTIFICATION_CHANNEL_LABELS = {
  [NOTIFICATION_CHANNELS.EMAIL]: 'Email',
  [NOTIFICATION_CHANNELS.SMS]: 'SMS',
  [NOTIFICATION_CHANNELS.WHATSAPP]: 'WhatsApp',
  [NOTIFICATION_CHANNELS.PUSH]: 'Push',
} as const;

// Appointment Sources
export const APPOINTMENT_SOURCES = {
  ONLINE: 'online',
  PHONE: 'phone',
  WALK_IN: 'walk_in',
  STAFF: 'staff',
  WIDGET: 'widget',
  INSTAGRAM: 'instagram',
} as const;

export const APPOINTMENT_SOURCE_LABELS = {
  [APPOINTMENT_SOURCES.ONLINE]: 'Online',
  [APPOINTMENT_SOURCES.PHONE]: 'Teléfono',
  [APPOINTMENT_SOURCES.WALK_IN]: 'Presencial',
  [APPOINTMENT_SOURCES.STAFF]: 'Personal',
  [APPOINTMENT_SOURCES.WIDGET]: 'Widget',
  [APPOINTMENT_SOURCES.INSTAGRAM]: 'Instagram',
} as const;

// Appointment Locations
export const APPOINTMENT_LOCATIONS = {
  SALON: 'salon',
  CLIENT_HOME: 'client_home',
  OTHER: 'other',
} as const;

export const APPOINTMENT_LOCATION_LABELS = {
  [APPOINTMENT_LOCATIONS.SALON]: 'En el salón',
  [APPOINTMENT_LOCATIONS.CLIENT_HOME]: 'Domicilio del cliente',
  [APPOINTMENT_LOCATIONS.OTHER]: 'Otro',
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  VALIDATION_ERROR: 'Error de validación',
  UNAUTHORIZED: 'No autorizado',
  FORBIDDEN: 'Acceso denegado',
  NOT_FOUND: 'No encontrado',
  SERVER_ERROR: 'Error del servidor',
  NETWORK_ERROR: 'Error de conexión',
  TIMEOUT_ERROR: 'Tiempo de espera agotado',
} as const;

// Success Messages
export const SUCCESS_MESSAGES = {
  CREATED: 'Creado correctamente',
  UPDATED: 'Actualizado correctamente',
  DELETED: 'Eliminado correctamente',
  SAVED: 'Guardado correctamente',
  SENT: 'Enviado correctamente',
} as const;

// File Upload Limits
export const FILE_UPLOAD_LIMITS = {
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  ALLOWED_DOCUMENT_TYPES: ['application/pdf'],
} as const;

// Business Rules
export const BUSINESS_RULES = {
  MAX_CLIENTS_PER_SALON: 10000,
  MAX_SERVICES_PER_SALON: 1000,
  MAX_PROFESSIONALS_PER_SALON: 100,
  MAX_APPOINTMENTS_PER_DAY: 1000,
  MIN_SERVICE_PRICE: 0,
  MAX_SERVICE_PRICE: 10000,
  MIN_SERVICE_DURATION: 15, // minutes
  MAX_SERVICE_DURATION: 480, // 8 hours
} as const;

// Cache Keys
export const CACHE_KEYS = {
  SALON_SETTINGS: (salonId: string) => `salon:${salonId}:settings`,
  AVAILABLE_SLOTS: (salonId: string, professionalId: string, date: string) => 
    `salon:${salonId}:professional:${professionalId}:date:${date}:slots`,
  PROFESSIONAL_SCHEDULE: (professionalId: string, date: string) => 
    `professional:${professionalId}:schedule:${date}`,
} as const;

// Rate Limiting
export const RATE_LIMITS = {
  API_REQUESTS_PER_MINUTE: 100,
  BOOKING_ATTEMPTS_PER_HOUR: 10,
  LOGIN_ATTEMPTS_PER_HOUR: 5,
} as const;