"use client";

import { ChangePasswordForm } from "@/src/components/auth/change-password-form";
import { TwoFactorSettings } from "@/src/components/auth/two-factor-settings";
import { BookingAlertsSettings } from "@/src/components/auth/booking-alerts-settings";
import { DeleteSalonSettings } from "@/src/components/auth/delete-salon-settings";
import { SupportAccessSettings } from "@/src/components/auth/support-access-settings";

/**
 * The signed-in user's own account: their password, two-step verification
 * and, for owners and admins, their booking emails; the owner can also
 * delete the salon, and choose whether KiraRoom support may enter the panel.
 */
export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Seguridad</h1>
        <p className="text-gray-500 mt-1">Tu contraseña y un segundo paso al entrar.</p>
      </div>
      <ChangePasswordForm />
      <TwoFactorSettings />
      <BookingAlertsSettings />
      <SupportAccessSettings />
      <DeleteSalonSettings />
    </div>
  );
}
