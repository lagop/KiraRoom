"use client";

import apiClient from "@/lib/api";

/**
 * The panel's add-client forms: an unticked box to write down that the new
 * client does not want promotions by email. Unticked records nothing (as a
 * customer she may get them until she says no, LSSI art. 21.2); ticked
 * records a refusal by the salon once the client exists
 * (recordNewClientRefusal), like "Anotar que no quiere" on her file.
 */
export function MarketingRefusalCheckbox({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <label htmlFor={id} className="flex items-start gap-2 text-sm text-gray-800 cursor-pointer">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={`${id}-notice`}
          className="mt-0.5"
        />
        <span>No quiere recibir promociones ni novedades del salón por email</span>
      </label>
      <p id={`${id}-notice`} className="mt-1 ml-6 text-xs text-gray-500">
        Díselo al tomar sus datos: si no marcas la casilla, el salón puede enviarle por email promociones de
        servicios parecidos a los que contrata, y podrá darse de baja en cada email.
      </p>
    </div>
  );
}

/**
 * Records the box once the client was created. Resolves to false when it
 * could not be saved, so the form can say so (the client exists anyway).
 */
export async function recordNewClientRefusal(clientId: string | undefined): Promise<boolean> {
  if (!clientId) return false;
  try {
    await apiClient.recordClientEmailMarketingRefusal(clientId);
    return true;
  } catch {
    return false;
  }
}
