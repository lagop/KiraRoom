"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import apiClient from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";

/**
 * D15: the salon's contact email is missing. It is shown on the salon's web
 * page and in its aviso legal (with the razón social and the NIF, which the
 * issuer-data banner above asks for). For the owner and admins, on Inicio,
 * until it is set: it cannot be closed, and it blocks nothing.
 */
export function ContactEmailNotice({ className = "" }: { className?: string }) {
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);
  const tenant = useQuery({
    queryKey: ["tenant", "contact-email"],
    queryFn: () => apiClient.getTenant(),
    enabled: manager,
    staleTime: 60_000,
  });

  if (!manager || !tenant.data) return null;
  const email = (tenant.data as { email?: string | null }).email;
  if (email && email.trim()) return null;

  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ${className}`}
    >
      <Mail className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">Falta el email de contacto del salón</p>
        <p>
          Aparece en tu web y en el aviso legal, para que tus clientas puedan escribirte. Las reservas siguen
          funcionando mientras tanto.
        </p>
        <Link href="/dashboard/settings" className="font-medium underline hover:no-underline">
          Añadirlo en Ajustes
        </Link>
      </div>
    </div>
  );
}
