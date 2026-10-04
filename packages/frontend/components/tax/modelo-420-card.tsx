"use client";

import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import apiClient, { TaxReportDraft } from "@/lib/api";
import { lastClosedQuarter, modelo420Deadline, modelo420Rows } from "@/lib/modelo-420";

/**
 * The quarterly IGIC return (Modelo 420) of a Canarian salon, as a draft with
 * the Agencia Tributaria Canaria's box numbers. Shown only to IGIC salons;
 * KiraRoom does not file it, the salon or its gestoría does.
 */
export function Modelo420Card() {
  const [applies, setApplies] = useState<boolean | null>(null);
  const initial = lastClosedQuarter();
  const [year, setYear] = useState(initial.year);
  const [quarter, setQuarter] = useState(initial.quarter);
  const [draft, setDraft] = useState<TaxReportDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiClient
      .getQuarterlyReturnType()
      .then((r) => setApplies(r.type === "modelo_420"))
      .catch(() => setApplies(false));
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setDraft(await apiClient.generateTaxReport("modelo_420", year, quarter));
    } catch (err) {
      setDraft(null);
      setError(err instanceof Error ? err.message : "No se pudo generar");
    } finally {
      setBusy(false);
    }
  }

  if (!applies) return null;

  const years = [initial.year + 1, initial.year, initial.year - 1, initial.year - 2].filter(
    (y) => y <= new Date().getFullYear(),
  );
  const rows = draft ? modelo420Rows(draft.totalsJson) : null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
        <FileText className="h-4 w-4 text-purple-600" /> Modelo 420 (IGIC) trimestral
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        Borrador con las casillas del modelo de la Agencia Tributaria Canaria, calculado con las facturas
        emitidas en KiraRoom. KiraRoom no lo presenta: pásalo a tu gestoría o cópialo en el programa de la ATC.
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
        <label className="text-sm text-gray-700">
          Trimestre
          <select
            value={quarter}
            onChange={(e) => setQuarter(Number(e.target.value))}
            className="mt-1 block rounded-md border border-gray-300 px-3 py-1.5 text-sm"
          >
            {[1, 2, 3, 4].map((q) => (
              <option key={q} value={q}>
                {q}T
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Generar borrador
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-500">Plazo de presentación: {modelo420Deadline(year, quarter)}.</p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {rows && (
        <div className="mt-4 space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="text-xs text-gray-500">
                <tr>
                  <th className="text-left font-medium">Casillas</th>
                  <th className="text-right font-medium">Tipo</th>
                  <th className="text-right font-medium">Base imponible</th>
                  <th className="text-right font-medium">Cuota</th>
                </tr>
              </thead>
              <tbody>
                {rows.rates.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-2 text-gray-500">
                      No hay facturas emitidas en este trimestre.
                    </td>
                  </tr>
                ) : (
                  rows.rates.map((r) => (
                    <tr key={r.boxes} className="border-t border-gray-100">
                      <td className="py-1.5 font-mono text-xs text-gray-600">{r.boxes}</td>
                      <td className="py-1.5 text-right">{r.rate}</td>
                      <td className="py-1.5 text-right">{r.base}</td>
                      <td className="py-1.5 text-right">{r.cuota}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <dl className="divide-y divide-gray-100 rounded-lg border border-gray-100 text-sm">
            {rows.totals.map((t) => (
              <div key={t.box} className="flex justify-between gap-4 px-3 py-1.5">
                <dt className="text-gray-600">
                  <span className="font-mono text-xs text-gray-500">{t.box}</span> {t.label}
                </dt>
                <dd className="font-medium text-gray-900">{t.value}</dd>
              </div>
            ))}
          </dl>
          <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            <p className="font-medium">Antes de presentarlo, tu gestoría tiene que completar:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                El IGIC soportado de tus compras e importaciones (casillas 26 a 40): KiraRoom no tiene tus facturas
                de proveedores, así que el borrador lo deja en 0 y el resultado sale más alto de lo real.
              </li>
              <li>Las cuotas a compensar de trimestres anteriores (casilla 43).</li>
              <li>
                Las ventas que no hayas facturado en KiraRoom y, si las hubo, las rectificaciones de trimestres
                anteriores (casillas 21 y 22).
              </li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
