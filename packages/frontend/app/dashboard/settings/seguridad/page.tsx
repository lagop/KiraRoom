"use client";

import { ChangePasswordForm } from "@/src/components/auth/change-password-form";
import { TwoFactorSettings } from "@/src/components/auth/two-factor-settings";
import { DeleteSalonSettings } from "@/src/components/auth/delete-salon-settings";

/** The signed-in user's own security: their password and two-step verification; the owner can also delete the salon. */
export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Seguridad</h1>
        <p className="text-gray-500 mt-1">Tu contraseña y un segundo paso al entrar.</p>
      </div>
      <ChangePasswordForm />
      <TwoFactorSettings />
      <DeleteSalonSettings />
    </div>
  );
}
