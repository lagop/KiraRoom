"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { sharedIdentityBadge, sharedIdentityLine, type SharedIdentityWarning } from "@/lib/shared-identity";

/** On a salon's console page: other salons with its phone or NIF (D9). Information only. */
export function SharedIdentityNotice({ warnings }: { warnings?: SharedIdentityWarning[] | null }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-semibold">Otro salón tiene los mismos datos</p>
          {warnings.map((w) => (
            <p key={`${w.kind}:${w.value}`}>
              {sharedIdentityLine(w)}{" "}
              {w.others.map((o, i) => (
                <span key={o.id}>
                  {i > 0 && " · "}
                  <Link href={`/saas/tenants/${o.id}`} className="underline">
                    /{o.slug}
                  </Link>
                </span>
              ))}
            </p>
          ))}
          <p className="text-xs text-amber-800">
            Puede ser una segunda prueba gratis o una cuenta repetida. Es solo un aviso: no se bloquea nada.
          </p>
        </div>
      </div>
    </div>
  );
}

/** In the tenants list: a small badge next to the salon's name. */
export function SharedIdentityBadge({ warnings }: { warnings?: SharedIdentityWarning[] | null }) {
  const text = sharedIdentityBadge(warnings);
  if (!text) return null;
  return (
    <span
      title={(warnings ?? []).map(sharedIdentityLine).join(" ")}
      className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800"
    >
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      {text}
    </span>
  );
}
