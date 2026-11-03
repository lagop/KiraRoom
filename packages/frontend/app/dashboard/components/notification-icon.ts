import {
  AlertCircle,
  Bell,
  CalendarClock,
  Calendar,
  Check,
  CreditCard,
  ListChecks,
  Megaphone,
  MessageSquare,
  UserX,
  X,
  type LucideIcon,
} from "lucide-react";

/** The icon and colours of a notice, shared by the bell and the notifications page. */
export function getNotificationIcon(type: string): { icon: LucideIcon; color: string } {
  switch (type) {
    case "appointment_created":
    case "appointment_reminder":
    case "appointment_reminder_24h":
    case "appointment_reminder_1h":
    case "appointment_confirmed":
    case "appointment_completed":
    case "new_appointment_assigned":
    case "schedule_change":
      return { icon: Calendar, color: "text-blue-500 bg-blue-100" };
    case "appointment_rescheduled":
      return { icon: CalendarClock, color: "text-amber-600 bg-amber-100" };
    case "appointment_no_show":
      return { icon: UserX, color: "text-red-500 bg-red-100" };
    case "appointment_cancelled":
      return { icon: X, color: "text-red-500 bg-red-100" };
    case "payment_received":
    case "refund_processed":
      return { icon: CreditCard, color: "text-green-500 bg-green-100" };
    case "payment_failed":
      return { icon: CreditCard, color: "text-red-500 bg-red-100" };
    case "promotion":
    case "special_offer":
      return { icon: Megaphone, color: "text-purple-500 bg-purple-100" };
    case "system_alert":
    case "account_update":
    case "password_change":
      return { icon: AlertCircle, color: "text-amber-500 bg-amber-100" };
    case "new_message":
      return { icon: MessageSquare, color: "text-indigo-500 bg-indigo-100" };
    case "review_request":
      return { icon: Check, color: "text-teal-500 bg-teal-100" };
    case "news":
      return { icon: Megaphone, color: "text-sky-500 bg-sky-100" };
    case "waitlist_slot_available":
      return { icon: ListChecks, color: "text-violet-500 bg-violet-100" };
    default:
      return { icon: Bell, color: "text-gray-500 bg-gray-100" };
  }
}
