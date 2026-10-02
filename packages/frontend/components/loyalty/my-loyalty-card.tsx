"use client";

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import apiClient, { MyLoyalty } from "@/lib/api";

/**
 * The client portal's loyalty card: balance, what the points buy and the
 * history, or a button to join when the salon allows it. Renders nothing
 * when the salon has no active programme.
 */
export function MyLoyaltyCard() {
  const [data, setData] = useState<MyLoyalty | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient.getMyLoyalty().then(setData).catch(() => setData(null));
  }, []);

  if (!data || !data.enabled) return null;
  const { program, member, rewards, history } = data;
  const earnText =
    program.earnMode === "per_visit"
      ? `${program.pointsPerVisit} puntos por cada visita`
      : `${program.pointsPerEuro} ${program.pointsPerEuro === 1 ? "punto" : "puntos"} por cada euro`;

  return (
    <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
      <h2 className="text-2xl font-bold text-purple-900 mb-2">{program.name}</h2>
      {program.description && <p className="text-gray-600 mb-2">{program.description}</p>}
      <p className="text-sm text-gray-500 mb-4">Ganas {earnText}.</p>

      {!member ? (
        program.allowSelfEnroll ? (
          <div>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setData(await apiClient.joinMyLoyalty());
                  setError(null);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "No se ha podido completar el alta");
                } finally {
                  setBusy(false);
                }
              }}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              Unirme{program.welcomePoints > 0 ? ` y recibir ${program.welcomePoints} puntos` : ""}
            </button>
            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          </div>
        ) : (
          <p className="text-gray-600">Pide en el salón que te den de alta para empezar a sumar puntos.</p>
        )
      ) : (
        <>
          <p className="text-lg mb-4">
            <Star className="inline w-5 h-5 text-yellow-500 mr-1" />
            Tienes <strong className="text-2xl text-purple-900">{member.currentPoints}</strong> puntos
            {member.tier && <span className="ml-2 text-sm text-gray-500">· nivel {member.tier}</span>}
          </p>
          {rewards.length > 0 && (
            <div className="mb-4">
              <h3 className="font-semibold text-gray-900 mb-2">Lo que puedes conseguir</h3>
              <ul className="space-y-1 text-sm">
                {rewards.map((r) => (
                  <li key={r.id} className={member.currentPoints >= r.pointsCost ? "text-green-700" : "text-gray-600"}>
                    {r.name} · {r.pointsCost} puntos
                    {member.currentPoints >= r.pointsCost ? " · ¡ya puedes canjearlo en el salón!" : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {history.length > 0 && (
            <div>
              <h3 className="font-semibold text-gray-900 mb-2">Movimientos</h3>
              <ul className="divide-y divide-gray-100 text-sm">
                {history.slice(0, 10).map((h) => (
                  <li key={h.id} className="flex justify-between py-1.5">
                    <span>{h.description ?? ""}</span>
                    <span className={h.points >= 0 ? "text-green-700" : "text-red-700"}>
                      {h.points > 0 ? `+${h.points}` : h.points}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
