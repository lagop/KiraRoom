"use client";

import { useEffect, useState } from "react";
import { Loader2, Wallet } from "lucide-react";
import apiClient, { Modelo130Income } from "@/lib/api";
import { modelo130Deadline, modelo130Rows } from "@/lib/modelo-130";
import { lastClosedQuarter } from "@/lib/modelo-420";

/**
 * "Ingresos para tu modelo 130": for a salon run by an autónomo (NIF or NIE;
 * a company files no 130), the income from her invoices per quarter and
 * from 1 January, without the tax and with the rectificativas subtracted.
 * KiraRoom does not prepare the 130 itself: the expenses and the return are
 * the gestor's. Hidden for a salon with a CIF.
 */
export function Modelo130IncomeCard() {
  const initial = lastClosedQuarter();
  const [year, setYear] = useState(initial.year);
  const [income, setIncome] = useState<Modelo130Income | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    apiClient
      .getModelo130Income(year)
      .then((r) => live && setIncome(r))
      .catch((err) => {
        if (!live) return;
        // Staff: the figures are the owner's and admins' (403); no card.
        if ((err as { status?: number })?.status === 403) {
          setIncome({ applies: false, year, taxIdType: null, quarters: [], note: '' });
          return;
        }
        setIncome(null);
        setError(err instanceof Error ? err.message : "No se han podido leer los ingresos");
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [year]);

  // A company (CIF), or no NIF yet: no 130 to prepare.
  if (income && !income.applies) return null;
  // Nothing until the first answer.
  if (!income && !error) return null;

  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear - 1, thisYear - 2];
  const rows = income ? modelo130Rows(income) : [];

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
        <Wallet className="h-4 w-4 text-purple-600" /> Ingresos para tu modelo 130
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        Lo que has facturado en KiraRoom, sin IVA ni IGIC y restando las facturas rectificativas: la base imponible de
        cada trimestre y la acumulada desde el 1 de enero, que es lo que pide el modelo 130.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-700">
          Año
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="mt-1 block rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        {loading && <Loader2 className="mb-2 h-4 w-4 animate-spin text-gray-400" aria-label="Cargando" />}
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[460px] text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="text-left font-medium">Trimestre</th>
                <th className="text-right font-medium">Facturado</th>
                <th className="text-right font-medium">Rectificativas</th>
                <th className="text-right font-medium">Ingresos del trimestre</th>
                <th className="text-right font-medium">Acumulado del año</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.quarter} className="border-t border-gray-100">
                  <td className="py-1.5">{r.quarter}</td>
                  <td className="py-1.5 text-right">{r.invoiced}</td>
                  <td className="py-1.5 text-right">{r.rectified}</td>
                  <td className="py-1.5 text-right">{r.income}</td>
                  <td className="py-1.5 text-right font-medium">{r.cumulative}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500">
        Plazo del trimestre {initial.quarter}T de {initial.year}: {modelo130Deadline(initial.year, initial.quarter)}.
      </p>
      <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
        {income?.note ?? "Los gastos y el cálculo final del modelo 130 los hace tu gestor."} Solo cuenta lo facturado en
        KiraRoom: si cobras algo fuera, díselo también.
      </p>
    </section>
  );
}
