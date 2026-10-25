"use client";

import { TwoFactorSettings } from "@/src/components/auth/two-factor-settings";

/** The signed-in user's own security: two-step verification. */
export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Seguridad</h1>
        <p className="text-gray-500 mt-1">Protege tu cuenta con un segundo paso al entrar.</p>
      </div>
      <TwoFactorSettings />
    </div>
  );
}
