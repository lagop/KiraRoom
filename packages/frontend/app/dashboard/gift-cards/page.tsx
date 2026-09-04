"use client";

import { useState, useEffect } from "react";
import {
  Gift,
  Plus,
  Search,
  Trash2,
  Eye,
  Power,
  CheckCircle2,
  XCircle,
  Loader2,
  Calendar,
  Euro,
  Copy,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { PlanGate } from "@/components/billing/PlanGate";
import { useToast } from "@/components/ui/use-toast";

interface GiftCardRow {
  id: string;
  code: string;
  initialAmount: number;
  currentBalance: number;
  isActive: boolean;
  expiresAt: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  message: string | null;
  createdAt: string;
}

export default function GiftCardsPage() {
  const t = useTranslations();
  const { toast } = useToast();
  const [items, setItems] = useState<GiftCardRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showRedeem, setShowRedeem] = useState(false);
  const [selected, setSelected] = useState<GiftCardRow | null>(null);
  const [searchCode, setSearchCode] = useState("");
  const limit = 20;

  useEffect(() => {
    loadList();
  }, [page]);

  const loadList = async () => {
    try {
      setLoading(true);
      const data = await apiClient.listGiftCards({ page, limit });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      toast({
        title: "Error al cargar gift cards",
        description: err?.message ?? "Inténtalo de nuevo",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const euros = parseFloat(form.get("initialAmount") as string);
    if (Number.isNaN(euros) || euros < 1) {
      toast({
        title: "Importe inválido",
        description: "Mínimo 1 €",
        variant: "destructive",
      });
      return;
    }
    try {
      await apiClient.createGiftCard({
        initialAmount: Math.round(euros * 100),
        recipientName: (form.get("recipientName") as string) || undefined,
        recipientEmail: (form.get("recipientEmail") as string) || undefined,
        message: (form.get("message") as string) || undefined,
        expiresAt: (form.get("expiresAt") as string) || undefined,
      });
      setShowCreate(false);
      await loadList();
      toast({ title: "Gift card creada" });
    } catch (err: any) {
      toast({
        title: "No se pudo crear",
        description: err?.response?.data?.message ?? err?.message,
        variant: "destructive",
      });
    }
  };

  const handleRedeem = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const code = (form.get("code") as string).trim();
    if (!code) return;
    try {
      const card = await apiClient.lookupGiftCard(code);
      setSelected(card);
      setShowRedeem(true);
      setSearchCode("");
    } catch (err: any) {
      toast({
        title: "Gift card no encontrada",
        description: err?.response?.data?.message ?? err?.message,
        variant: "destructive",
      });
    }
  };

  const confirmRedeem = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selected) return;
    const form = new FormData(e.currentTarget);
    const euros = parseFloat(form.get("amount") as string);
    if (Number.isNaN(euros) || euros <= 0) return;
    try {
      await apiClient.redeemGiftCard({
        giftCardId: selected.id,
        amount: Math.round(euros * 100),
        note: (form.get("note") as string) || undefined,
      });
      setShowRedeem(false);
      setSelected(null);
      await loadList();
      toast({ title: "Importe aplicado" });
    } catch (err: any) {
      toast({
        title: "No se pudo aplicar",
        description: err?.response?.data?.message ?? err?.message,
        variant: "destructive",
      });
    }
  };

  const handleDeactivate = async (id: string) => {
    if (!confirm("¿Desactivar esta gift card?")) return;
    try {
      await apiClient.deleteGiftCard(id);
      await loadList();
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message,
        variant: "destructive",
      });
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <PlanGate feature="gift_cards">
      <div className="p-6 space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Gift className="w-6 h-6" /> Gift Cards
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Crea, busca y aplica gift cards. Disponible desde Pro (49 €/mes).
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowRedeem(true)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-md border border-violet-300 hover:bg-violet-50"
            >
              <Search className="w-4 h-4" /> Canjear
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-md bg-violet-700 text-white hover:bg-violet-800"
            >
              <Plus className="w-4 h-4" /> Nueva gift card
            </button>
          </div>
        </header>

        <section className="rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left">
              <tr>
                <th className="px-3 py-2">Código</th>
                <th className="px-3 py-2">Destinatario</th>
                <th className="px-3 py-2 text-right">Saldo</th>
                <th className="px-3 py-2 text-right">Inicial</th>
                <th className="px-3 py-2">Caduca</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                    Cargando…
                  </td>
                </tr>
              )}
              {!loading && items.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    Aún no has creado gift cards.
                  </td>
                </tr>
              )}
              {!loading &&
                items.map((gc) => (
                  <tr key={gc.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(gc.code);
                          toast({ title: "Código copiado" });
                        }}
                        className="inline-flex items-center gap-1 hover:underline"
                        title="Copiar"
                      >
                        <Copy className="w-3 h-3" /> {gc.code}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      {gc.recipientName || "—"}
                      {gc.recipientEmail && (
                        <span className="block text-xs text-muted-foreground">
                          {gc.recipientEmail}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {(gc.currentBalance / 100).toFixed(2)} €
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {(gc.initialAmount / 100).toFixed(2)} €
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {gc.expiresAt
                        ? new Date(gc.expiresAt).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {gc.isActive ? (
                        <span className="inline-flex items-center gap-1 text-green-700">
                          <CheckCircle2 className="w-3 h-3" /> activa
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-gray-500">
                          <XCircle className="w-3 h-3" /> inactiva
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleDeactivate(gc.id)}
                        className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
                      >
                        <Power className="w-3 h-3" /> Desactivar
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground border-t">
            <span>
              {total} gift card{total === 1 ? "" : "s"}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2 py-1 rounded border disabled:opacity-50"
              >
                ←
              </button>
              <span>
                Página {page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-2 py-1 rounded border disabled:opacity-50"
              >
                →
              </button>
            </div>
          </div>
        </section>

        {/* Create modal */}
        {showCreate && (
          <Modal title="Nueva gift card" onClose={() => setShowCreate(false)}>
            <form onSubmit={handleCreate} className="space-y-3">
              <Field label="Importe (€)" name="initialAmount" type="number" min="1" step="0.01" required />
              <Field label="Nombre destinatario" name="recipientName" />
              <Field label="Email destinatario" name="recipientEmail" type="email" />
              <Field label="Mensaje" name="message" textarea />
              <Field label="Caduca (opcional)" name="expiresAt" type="date" />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-3 py-2 text-sm rounded border"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-2 text-sm rounded bg-violet-700 text-white hover:bg-violet-800"
                >
                  Crear
                </button>
              </div>
            </form>
          </Modal>
        )}

        {/* Redeem / lookup modal */}
        {showRedeem && !selected && (
          <Modal title="Canjear gift card" onClose={() => setShowRedeem(false)}>
            <form onSubmit={handleRedeem} className="space-y-3">
              <Field
                label="Código"
                name="code"
                required
                placeholder="ej. A1B2C3D4E5F6"
              />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRedeem(false)}
                  className="px-3 py-2 text-sm rounded border"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-2 text-sm rounded bg-violet-700 text-white hover:bg-violet-800"
                >
                  Buscar
                </button>
              </div>
            </form>
          </Modal>
        )}

        {showRedeem && selected && (
          <Modal
            title={`Aplicar saldo · ${selected.code}`}
            onClose={() => {
              setShowRedeem(false);
              setSelected(null);
            }}
          >
            <form onSubmit={confirmRedeem} className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Saldo disponible:{" "}
                <strong>{(selected.currentBalance / 100).toFixed(2)} €</strong>
              </p>
              <Field
                label="Importe a aplicar (€)"
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
              <Field label="Nota (opcional)" name="note" />
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowRedeem(false);
                    setSelected(null);
                  }}
                  className="px-3 py-2 text-sm rounded border"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-2 text-sm rounded bg-violet-700 text-white hover:bg-violet-800"
                >
                  Aplicar
                </button>
              </div>
            </form>
          </Modal>
        )}
      </div>
    </PlanGate>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  textarea,
  ...rest
}: {
  label: string;
  name: string;
  type?: string;
  textarea?: boolean;
  [k: string]: any;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {textarea ? (
        <textarea
          name={name}
          rows={3}
          className="w-full rounded border px-2 py-1 text-sm"
          {...rest}
        />
      ) : (
        <input
          name={name}
          type={type}
          className="w-full rounded border px-2 py-1 text-sm"
          {...rest}
        />
      )}
    </label>
  );
}
