"use client";

import { useCallback, useEffect, useState } from "react";
import { Star, Loader2 } from "lucide-react";
import apiClient, { ClientLoyaltySummary } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { balanceClass, isNegativeBalance } from "@/lib/loyalty-points";
import { useTranslations } from "@/lib/use-translation";

const TYPE_LABEL: Record<string, string> = {
  earn: "Ganados",
  welcome: "Bienvenida",
  redeem: "Canjeados",
  reversal: "Devueltos",
  redeem_reversal: "Canje anulado",
  adjust: "Ajuste",
  expire: "Caducados",
};

/**
 * The loyalty block of a client's file: balance, history and, when the
 * client is not a member yet, the button to sign them up.
 */
export function ClientLoyaltyCard({ clientId }: { clientId: string }) {
  const [data, setData] = useState<ClientLoyaltySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const t = useTranslations();

  const load = useCallback(async () => {
    try {
      setData(await apiClient.getClientLoyalty(clientId));
      setError(null);
    } catch (err) {
      // No plan / no permission: the card simply does not apply.
      setError(err instanceof Error ? err.message : "error");
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return null;
  if (!data) {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
      </section>
    );
  }
  if (!data.program) return null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-3">
      <h2 className="text-base font-semibold text-gray-900">Fidelización</h2>
      {!data.member ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-gray-600">No es socio de {data.program.name}.</p>
          <button
            type="button"
            disabled={busy || !data.program.isActive}
            onClick={async () => {
              setBusy(true);
              try {
                await apiClient.enrollLoyaltyMember(clientId);
                await load(); // never throws: it keeps its own error
              } catch (err) {
                // It used to fail without a word: the server says why.
                toast({
                  title: "No se pudo dar de alta en fidelización",
                  description: err instanceof Error ? err.message : undefined,
                  variant: "destructive",
                });
              } finally {
                setBusy(false);
              }
            }}
            className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            Dar de alta
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm">
            <Star className="mr-1 inline h-4 w-4 text-yellow-500" />
            <strong className={`text-lg ${balanceClass(data.member.currentPoints)}`}>{data.member.currentPoints}</strong> puntos
            {data.member.tier && <span className="ml-2 text-gray-500">· {data.member.tier.name}</span>}
            <span className="ml-2 text-gray-500">· {data.member.lifetimePoints} acumulados</span>
          </p>
          {isNegativeBalance(data.member.currentPoints) && (
            <p role="note" className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              <strong>{t("loyalty.negative_balance")}.</strong> {t("loyalty.negative_balance_help")}
            </p>
          )}
          {data.member.pointsExpireOn && data.member.currentPoints > 0 && (
            <p className="text-xs text-gray-500">
              {t("loyalty.expires_on", { date: new Date(data.member.pointsExpireOn).toLocaleDateString("es-ES") })}
            </p>
          )}
          {data.member.tier && <p className="text-xs text-gray-500">{t("loyalty.tiers_never_down")}.</p>}
          {data.rewards.length > 0 && (
            <p className="text-xs text-gray-500">
              Puede canjear en caja:{" "}
              {data.rewards.filter((r) => r.redeemable).map((r) => r.name).join(", ") || "nada todavía"}
            </p>
          )}
          {data.history.length > 0 && (
            <ul className="divide-y divide-gray-100 text-sm">
              {data.history.slice(0, 10).map((h) => (
                <li key={h.id} className="flex justify-between py-1.5">
                  <span>
                    {h.type === "expire" ? t("loyalty.history_expire") : TYPE_LABEL[h.type] ?? h.type}
                    {h.description ? ` · ${h.description}` : ""}
                  </span>
                  <span className={h.points >= 0 ? "text-green-700" : "text-red-700"}>
                    {h.points > 0 ? `+${h.points}` : h.points}{" "}
                    <span className="text-xs text-gray-400">{new Date(h.createdAt).toLocaleDateString("es-ES")}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
