"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight, GitMerge, Loader2, Search, X } from "lucide-react";
import apiClient, { ClientDetail, ClientMergeResult, ClientSearchRow } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { fullName, mergePreviewRows, mergeRefusal, type MergeSide } from "@/lib/client-merge";

const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Inténtalo de nuevo.");

/**
 * "Fusionar con otra clienta" (owner / admin): pick the other record of the
 * same person, see both side by side, choose which one stays, confirm. The
 * server moves everything to the record kept and deletes the other.
 *
 * `onMerged` gets the server's answer and the id of the record kept (this
 * one, or the other when the sides were swapped).
 */
export function ClientMergeDialog({
  client,
  onMerged,
}: {
  client: ClientDetail;
  onMerged: (result: ClientMergeResult, keptId: string) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClientSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [other, setOther] = useState<ClientSearchRow | null>(null);
  const [keepThis, setKeepThis] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);

  // Search as she types, a moment after the last key.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const rows = await apiClient.searchClientsForManager(q);
        if (!cancelled) setResults(rows.filter((r) => r.id !== client.id));
      } catch (err) {
        if (!cancelled) toast({ title: "No se ha podido buscar", description: errorText(err), variant: "destructive" });
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, client.id, toast]);

  function close() {
    setOpen(false);
    setQuery("");
    setResults([]);
    setOther(null);
    setKeepThis(true);
    setConfirming(false);
  }

  const self: MergeSide = client;
  const kept: MergeSide | null = other ? (keepThis ? self : other) : null;
  const removed: MergeSide | null = other ? (keepThis ? other : self) : null;
  const refusal = kept && removed ? mergeRefusal(kept, removed) : null;

  async function merge() {
    if (!kept || !removed) return;
    setMerging(true);
    try {
      const result = await apiClient.mergeClient(kept.id, removed.id);
      toast({ title: "Fichas fusionadas", description: result.message });
      close();
      onMerged(result, kept.id);
    } catch (err) {
      setConfirming(false);
      toast({ title: "No se han fusionado", description: errorText(err), variant: "destructive" });
    } finally {
      setMerging(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 self-start rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 sm:self-center"
      >
        <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />
        Fusionar con otra clienta
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="merge-dialog-title"
          className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget && !merging) close();
          }}
        >
          <div className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="merge-dialog-title" className="text-base font-semibold text-gray-900">
                  Fusionar con otra clienta
                </h2>
                <p className="mt-1 text-sm text-gray-600">
                  Para cuando la misma persona tiene dos fichas. Todo lo de la ficha que se elimina (citas, pagos,
                  ventas, facturas, saldo, puntos, consentimientos…) pasa a la que se conserva, y los datos que le
                  falten se completan con los de la otra.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={merging}
                aria-label="Cerrar"
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {!other ? (
              <div className="mt-4">
                <label htmlFor="merge-search" className="text-sm font-medium text-gray-700">
                  Busca la otra ficha
                </label>
                <div className="relative mt-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input
                    id="merge-search"
                    type="search"
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Nombre, email o teléfono"
                    className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                </div>
                <div className="mt-3 max-h-72 overflow-y-auto">
                  {searching && (
                    <p className="flex items-center gap-2 text-sm text-gray-500">
                      <Loader2 className="h-4 w-4 animate-spin" /> Buscando…
                    </p>
                  )}
                  {!searching && query.trim().length >= 2 && results.length === 0 && (
                    <p className="text-sm text-gray-500">No hay otra clienta con esos datos.</p>
                  )}
                  <ul className="divide-y divide-gray-100">
                    {results.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => setOther(r)}
                          className="flex w-full flex-col items-start gap-0.5 px-2 py-2 text-left text-sm hover:bg-gray-50"
                        >
                          <span className="font-medium text-gray-900">{fullName(r)}</span>
                          <span className="text-xs text-gray-500">
                            {[r.email, r.phone].filter(Boolean).join(" · ") || "Sin email ni teléfono"}
                            {" · "}
                            {r._count?.appointments ?? 0} citas
                            {r.status !== "active" ? ` · ${r.status === "blocked" ? "bloqueada" : "desactivada"}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              kept &&
              removed && (
                <div className="mt-4 space-y-4">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-sm">
                      <thead className="text-left text-xs text-gray-500">
                        <tr>
                          <th className="py-2 pr-3" />
                          <th className="py-2 pr-3">Se conserva</th>
                          <th className="py-2 pr-3">Se elimina</th>
                          <th className="py-2">Resultado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {mergePreviewRows(kept, removed).map((row) => (
                          <tr key={row.label} className="align-top">
                            <th scope="row" className="py-2 pr-3 text-left font-normal text-gray-500">
                              {row.label}
                            </th>
                            <td className="break-words py-2 pr-3 text-gray-900">{row.kept}</td>
                            <td className="break-words py-2 pr-3 text-gray-500 line-through decoration-gray-300">
                              {row.other}
                            </td>
                            <td className={`break-words py-2 font-medium ${row.filled ? "text-violet-700" : "text-gray-900"}`}>
                              {row.result}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {refusal && (
                    <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      {refusal}
                    </p>
                  )}

                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setOther(null)}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        Elegir otra
                      </button>
                      <button
                        type="button"
                        onClick={() => setKeepThis((v) => !v)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
                        Intercambiar
                      </button>
                    </div>
                    <button
                      type="button"
                      disabled={!!refusal || merging}
                      onClick={() => setConfirming(true)}
                      className="inline-flex items-center justify-center gap-1.5 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <GitMerge className="h-4 w-4" aria-hidden="true" />
                      Fusionar…
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming && !!kept && !!removed}
        title="¿Fusionar las dos fichas?"
        description={
          kept && removed
            ? `Todo el historial de «${fullName(removed)}» pasará a «${fullName(kept)}» y la ficha de «${fullName(removed)}» se eliminará. No se puede deshacer.`
            : undefined
        }
        confirmLabel="Fusionar"
        destructive
        loading={merging}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void merge()}
      />
    </>
  );
}
