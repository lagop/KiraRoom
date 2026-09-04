import React from "react";
import { CheckCircle, AlertCircle, Clock, XCircle } from "lucide-react";
import { getStatusBadgeStyle } from "../../appointment-drawer.utils";

/**
 * Status pill rendered in the appointment header.
 *
 * Verbatim move from the inline `getStatusBadge` in
 * `appointment-drawer.tsx:1294-1314`. The pure CSS-class / label
 * lookup lives in `appointment-drawer.utils.ts` so the styling is
 * unit-tested; this component only owns the icon and the span.
 */

export type AppointmentStatus =
  | "confirmed"
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

const ICONS: Record<string, React.ReactNode> = {
  confirmed: <CheckCircle className="w-4 h-4 mr-2" />,
  pending: <AlertCircle className="w-4 h-4 mr-2" />,
  in_progress: <Clock className="w-4 h-4 mr-2" />,
  completed: <CheckCircle className="w-4 h-4 mr-2" />,
  cancelled: <XCircle className="w-4 h-4 mr-2" />,
};

export function AppointmentStatusBadge({ status }: { status: string }) {
  const style = getStatusBadgeStyle(status);
  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${style.bg} ${style.text} ${style.border}`}
    >
      {ICONS[status] ?? null}
      {style.label}
    </span>
  );
}