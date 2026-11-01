/**
 * The channels each kind of notice goes by when a client (or a user) has
 * not chosen. Kept apart from NotificationsService so the consent module can
 * read them without loading the service (see client-notices.ts).
 */
export const DEFAULT_PREFERENCES: Record<
  string,
  { inApp: boolean; email: boolean; sms: boolean; whatsapp: boolean }
> = {
  appointment_created: {
    inApp: true,
    email: true,
    sms: false,
    whatsapp: false,
  },
  appointment_confirmed: {
    inApp: true,
    email: true,
    sms: true,
    whatsapp: false,
  },
  appointment_cancelled: {
    inApp: true,
    email: true,
    sms: true,
    whatsapp: false,
  },
  appointment_reminder_24h: {
    inApp: true,
    email: true,
    sms: true,
    whatsapp: false,
  },
  appointment_reminder_1h: {
    inApp: true,
    // Used only when the salon has no SMS/WhatsApp for the client: the
    // 1-hour reminder then falls back to email (NotificationsScheduler).
    email: true,
    sms: true,
    whatsapp: false,
  },
  appointment_completed: {
    inApp: true,
    email: true,
    sms: false,
    whatsapp: false,
  },
  review_request: { inApp: true, email: true, sms: false, whatsapp: false },
  payment_received: { inApp: true, email: true, sms: false, whatsapp: false },
  payment_failed: { inApp: true, email: true, sms: true, whatsapp: false },
  promotion: { inApp: true, email: true, sms: false, whatsapp: false },
  news: { inApp: true, email: true, sms: false, whatsapp: false },
  special_offer: { inApp: true, email: true, sms: false, whatsapp: false },
  system_alert: { inApp: true, email: true, sms: false, whatsapp: false },
  new_appointment_assigned: {
    inApp: true,
    email: true,
    sms: false,
    whatsapp: false,
  },
  schedule_change: { inApp: true, email: true, sms: false, whatsapp: false },
  new_message: { inApp: true, email: false, sms: false, whatsapp: false },
  // The client asked to be told: every channel is on unless they turn it off.
  waitlist_slot_available: {
    inApp: true,
    email: true,
    sms: true,
    whatsapp: true,
  },
};
