"use client";

import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { getCurrentUser } from "@/lib/utils";

/**
 * "Importar" next to "Nuevo cliente" / "Nuevo servicio" / "Nueva cita". The import screen
 * existed but nothing in the menu or on these pages led to it. Only owners
 * and admins may import, so only they see the button.
 */
const HREF = {
  clients: "/dashboard/clients/import",
  services: "/dashboard/clients/import?tipo=servicios",
  appointments: "/dashboard/clients/import?tipo=citas",
};

export function ImportLink({ kind }: { kind: keyof typeof HREF }) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const role = getCurrentUser()?.role;
    setAllowed(role === "owner" || role === "admin");
  }, []);
  if (!allowed) return null;
  return (
    <a
      href={HREF[kind]}
      className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
    >
      <Upload className="h-4 w-4" />
      Importar
    </a>
  );
}
