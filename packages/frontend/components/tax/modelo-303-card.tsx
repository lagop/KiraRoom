"use client";

import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import apiClient, { TaxReportDraft } from "@/lib/api";
import { lastClosedQuarter } from "@/lib/modelo-420";
import { modelo303Deadline, modelo303Rows } from "@/lib/modelo-303";

/**
 * The quarterly IVA return (Modelo 303) of a salon under IVA, as a draft with
 * the AEAT's 2026 box numbers. Shown only to IVA salons; KiraRoom does not
 * file it, the salon or its gestoría does.
 */
export function Modelo303Card() {
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
      .then((r) => setApplies(r.type === "modelo_303"))
      .catch(() => setApplies(false));
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setDraft(await apiClient.generateTaxReport("modelo_303", year, quarter));
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
  const rows = draft ? modelo303Rows(draft.totalsJson) : null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
        <FileText className="h-4 w-4 text-purple-600" /> Modelo 303 (IVA) trimestral
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        Borrador con las casillas del modelo de la Agencia Tributaria, calculado con las facturas emitidas en
        KiraRoom. KiraRoom no lo presenta: pásalo a tu gestoría o cópialo en Pre303, en la sede de la AEAT.
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
      <p className="mt-2 text-xs text-gray-500">Plazo de presentación: {modelo303Deadline(year, quarter)}.</p>

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
                      No hay facturas con IVA emitidas en este trimestre.
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
                El IVA soportado de tus compras e importaciones (casillas 28 a 45): KiraRoom no tiene tus facturas
                de proveedores, así que el borrador lo deja en 0 y el resultado sale más alto de lo real.
              </li>
              <li>Las cuotas a compensar de trimestres anteriores (casillas 110, 78 y 87).</li>
              <li>Las ventas que no hayas facturado en KiraRoom.</li>
              {rows.zeroRateBase && (
                <li>
                  {rows.zeroRateBase} facturados al 0 %: si son operaciones a tipo cero van en la casilla 150; si
                  están exentas, no van en las casillas de IVA devengado. KiraRoom no puede saber cuál es tu caso.
                </li>
              )}
              <li>
                El borrador es de régimen general. Si tributas en régimen simplificado (módulos), la página 2 del
                303 es distinta y la tiene que preparar tu gestoría.
              </li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
