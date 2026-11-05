"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import apiClient from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { useToast } from "@/components/ui/use-toast";

/**
 * "Tus avisos" (owner and admins, audit 7 D12): an email for each online
 * booking (salon page, widget, virtual receptionist) and each cancellation a
 * client makes herself. On by default; each user decides for herself.
 */
export function BookingAlertsSettings() {
  const { toast } = useToast();
  const [manager, setManager] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // Read after mount: the token is in localStorage (render-time-user.spec).
  useEffect(() => {
    const role = getCurrentUser()?.role;
    const isManager = role === "owner" || role === "admin";
    setManager(isManager);
    if (!isManager) return;
    apiClient
      .getSalonBookingAlerts()
      .then(setEnabled)
      .catch(() => setEnabled(null));
  }, []);

  if (!manager || enabled === null) return null;

  const toggle = async () => {
    const next = !enabled;
    setBusy(true);
    try {
      await apiClient.setSalonBookingAlerts(next);
      setEnabled(next);
      toast({ title: next ? "Recibirás estos avisos por email" : "Ya no recibirás estos avisos" });
    } catch (err) {
      toast({
        title: "No se ha podido guardar",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6 max-w-2xl">
      <div className="flex items-start gap-3">
        <Bell className="w-6 h-6 text-gray-400 shrink-0" aria-hidden />
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">Tus avisos por email</h2>
          <label className="mt-2 flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
              checked={enabled}
              disabled={busy}
              onChange={toggle}
            />
            <span className="text-sm text-gray-700">
              Avisarme cuando una clienta reserve online (web, widget o recepcionista virtual) o anule ella misma su
              cita. Solo para ti: cada persona del equipo lo decide en su cuenta.
            </span>
          </label>
        </div>
      </div>
    </section>
  );
}
