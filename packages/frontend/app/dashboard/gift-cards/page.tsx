"use client";

import { useState, useEffect } from "react";
import {
  Gift,
  Plus,
  Search,
  Eye,
  Power,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Copy,
} from "lucide-react";
import apiClient from "@/lib/api";
import { PlanGate } from "@/components/billing/PlanGate";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  GIFT_CARD_MOVEMENT_LABEL,
  GIFT_CARD_STATUS_LABEL,
  canDeactivate,
  createdEmailNote,
  defaultGiftCardExpiry,
  formatCents,
  formatDay,
  giftCardStatusOf,
  giftCardsPlanNote,
  todayDay,
  type GiftCardStatus,
} from "@/lib/gift-cards";

interface GiftCardRow {
  id: string;
  code: string;
  initialAmount: number;
  currentBalance: number;
  isActive: boolean;
  expiresAt: string | null;
  /** Salon calendar day the card is valid until ("YYYY-MM-DD"). */
  expiresOn?: string | null;
  status?: GiftCardStatus;
  recipientName: string | null;
  recipientEmail: string | null;
  message: string | null;
  createdAt: string;
}

interface GiftCardMovement {
  id: string;
  createdAt: string;
  type: string;
  amount: number;
  balanceAfter: number | null;
  note: string | null;
  createdByName: string | null;
}

interface GiftCardDetail extends GiftCardRow {
  transactions: GiftCardMovement[];
}

const errorText = (err: any) => err?.response?.data?.message ?? err?.message;

export default function GiftCardsPage() {
  const { toast } = useToast();
  // The card about to be deactivated, confirmed in the panel's dialog.
  const [pendingDeactivate, setPendingDeactivate] = useState<GiftCardRow | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [items, setItems] = useState<GiftCardRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showRedeem, setShowRedeem] = useState(false);
  const [selected, setSelected] = useState<GiftCardRow | null>(null);
  const [detail, setDetail] = useState<GiftCardDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const limit = 20;

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const loadList = async () => {
    try {
      setLoading(true);
      const data = await apiClient.listGiftCards({ page, limit });
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      toast({
        title: "Error al cargar las tarjetas regalo",
        description: errorText(err) ?? "Inténtalo de nuevo",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      setDetail(await apiClient.getGiftCard(id));
    } catch (err: any) {
      toast({
        title: "No se pudo abrir la tarjeta regalo",
        description: errorText(err),
        variant: "destructive",
      });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const euros = parseFloat(form.get("initialAmount") as string);
    if (Number.isNaN(euros) || euros < 1) {
      toast({
        title: "Importe no válido",
        description: "Mínimo 1 €",
        variant: "destructive",
      });
      return;
    }
    const recipientEmail = ((form.get("recipientEmail") as string) || "").trim() || undefined;
    try {
      const created = await apiClient.createGiftCard({
        initialAmount: Math.round(euros * 100),
        recipientName: (form.get("recipientName") as string) || undefined,
        recipientEmail,
        message: (form.get("message") as string) || undefined,
        // Empty: the server applies the default validity.
        expiresAt: (form.get("expiresAt") as string) || undefined,
        sendEmail: recipientEmail ? form.get("sendEmail") === "on" : undefined,
      });
      setShowCreate(false);
      setCreateEmail("");
      await loadList();
      toast({
        title: `Tarjeta regalo creada · ${created?.code ?? ""}`,
        description: createdEmailNote(created?.emailSent, recipientEmail),
        variant: created?.emailSent === false ? "destructive" : undefined,
      });
    } catch (err: any) {
      toast({
        title: "No se pudo crear",
        description: errorText(err),
        variant: "destructive",
      });
    }
  };

  const handleLookup = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const code = (form.get("code") as string).trim();
    if (!code) return;
    try {
      const card = await apiClient.lookupGiftCard(code);
      setSelected(card);
      setShowRedeem(true);
    } catch (err: any) {
      toast({
        title: "Tarjeta regalo no encontrada",
        description: errorText(err),
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
      const after = await apiClient.redeemGiftCard({
        giftCardId: selected.id,
        amount: Math.round(euros * 100),
        note: (form.get("note") as string) || undefined,
      });
      setShowRedeem(false);
      setSelected(null);
      await loadList();
      toast({
        title: "Importe aplicado",
        description: `Saldo restante: ${formatCents(after?.currentBalance ?? 0)}`,
      });
    } catch (err: any) {
      toast({
        title: "No se pudo aplicar",
        description: errorText(err),
        variant: "destructive",
      });
    }
  };

  const changeExpiry = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!detail) return;
    const day = (new FormData(e.currentTarget).get("expiresAt") as string) || null;
    try {
      await apiClient.updateGiftCard(detail.id, { expiresAt: day });
      await Promise.all([openDetail(detail.id), loadList()]);
      toast({ title: day ? `Válida hasta el ${formatDay(day)}` : "Sin fecha de caducidad" });
    } catch (err: any) {
      toast({
        title: "No se pudo cambiar la fecha",
        description: errorText(err),
        variant: "destructive",
      });
    }
  };

  const performDeactivate = async () => {
    if (!pendingDeactivate) return;
    setDeactivating(true);
    try {
      await apiClient.deleteGiftCard(pendingDeactivate.id);
      await loadList();
      if (detail?.id === pendingDeactivate.id) await openDetail(detail.id);
    } catch (err: any) {
      toast({
        title: "Error",
        description: errorText(err),
        variant: "destructive",
      });
    } finally {
      setDeactivating(false);
      setPendingDeactivate(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <PlanGate feature="gift_cards">
      <div className="p-4 sm:p-6 space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Gift className="w-6 h-6" /> Tarjetas regalo
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Crea, busca y canjea tarjetas regalo. {giftCardsPlanNote()}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
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
              <Plus className="w-4 h-4" /> Nueva tarjeta regalo
            </button>
          </div>
        </header>

        <section className="rounded-lg border bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2">Código</th>
                  <th className="px-3 py-2">Destinatario</th>
                  <th className="px-3 py-2 text-right">Saldo</th>
                  <th className="px-3 py-2 text-right">Inicial</th>
                  <th className="px-3 py-2">Válida hasta</th>
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
                    <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                      Aún no has creado tarjetas regalo.
                    </td>
                  </tr>
                )}
                {!loading &&
                  items.map((gc) => {
                    const status = giftCardStatusOf(gc);
                    return (
                      <tr key={gc.id} className="border-b last:border-b-0">
                        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
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
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {formatCents(gc.currentBalance)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground whitespace-nowrap">
                          {formatCents(gc.initialAmount)}
                        </td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap">
                          {gc.expiresOn !== undefined
                            ? formatDay(gc.expiresOn)
                            : gc.expiresAt
                              ? new Date(gc.expiresAt).toLocaleDateString("es-ES")
                              : "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <StatusBadge status={status} />
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => openDetail(gc.id)}
                              className="inline-flex items-center gap-1 text-xs text-violet-700 hover:underline"
                            >
                              <Eye className="w-3 h-3" /> Ver
                            </button>
                            {canDeactivate(status) && (
                              <button
                                type="button"
                                onClick={() => setPendingDeactivate(gc)}
                                className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
                              >
                                <Power className="w-3 h-3" /> Desactivar
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground border-t">
            <span>
              {total} {total === 1 ? "tarjeta regalo" : "tarjetas regalo"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2 py-1 rounded border disabled:opacity-50"
                aria-label="Página anterior"
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
                aria-label="Página siguiente"
              >
                →
              </button>
            </div>
          </div>
        </section>

        {/* Create modal */}
        {showCreate && (
          <Modal title="Nueva tarjeta regalo" onClose={() => setShowCreate(false)}>
            <form onSubmit={handleCreate} className="space-y-3">
              <Field label="Importe (€)" name="initialAmount" type="number" min="1" max="10000" step="0.01" required />
              <Field label="Nombre de quien la recibe" name="recipientName" maxLength={120} />
              <Field
                label="Email de quien la recibe"
                name="recipientEmail"
                type="email"
                value={createEmail}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCreateEmail(e.target.value)}
              />
              <label className={`flex items-center gap-2 text-sm ${createEmail.trim() ? "" : "opacity-50"}`}>
                <input type="checkbox" name="sendEmail" defaultChecked disabled={!createEmail.trim()} />
                Enviar la tarjeta por email
              </label>
              <Field label="Mensaje" name="message" textarea maxLength={500} />
              <Field
                label="Válida hasta"
                name="expiresAt"
                type="date"
                min={todayDay()}
                defaultValue={defaultGiftCardExpiry()}
                required
              />
              <p className="text-xs text-muted-foreground -mt-2">
                Por defecto, 2 años desde hoy. Puedes cambiarla. La tarjeta funciona todo ese día.
              </p>
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
          <Modal title="Canjear tarjeta regalo" onClose={() => setShowRedeem(false)}>
            <form onSubmit={handleLookup} className="space-y-3">
              <Field label="Código" name="code" required placeholder="ej. A1B2C3D4E5F6" />
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
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Saldo disponible: <strong>{formatCents(selected.currentBalance)}</strong>
                </span>
                <StatusBadge status={giftCardStatusOf(selected)} />
              </div>
              {selected.expiresOn && (
                <p className="text-xs text-muted-foreground">
                  Válida hasta el {formatDay(selected.expiresOn)}
                </p>
              )}
              <Field
                label="Importe a aplicar (€)"
                name="amount"
                type="number"
                min="0.01"
                max={(selected.currentBalance / 100).toFixed(2)}
                step="0.01"
                required
              />
              <Field label="Nota (opcional)" name="note" maxLength={500} />
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
                  disabled={giftCardStatusOf(selected) !== "active"}
                  className="px-3 py-2 text-sm rounded bg-violet-700 text-white hover:bg-violet-800 disabled:opacity-50"
                >
                  Aplicar
                </button>
              </div>
            </form>
          </Modal>
        )}

        {/* Detail: the card and its movements */}
        {(detail || detailLoading) && (
          <Modal
            title={detail ? `Tarjeta regalo · ${detail.code}` : "Tarjeta regalo"}
            onClose={() => setDetail(null)}
            wide
          >
            {!detail ? (
              <div className="py-8 text-center">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                Cargando…
              </div>
            ) : (
              <div className="space-y-4">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Estado</dt>
                  <dd>
                    <StatusBadge status={giftCardStatusOf(detail)} />
                  </dd>
                  <dt className="text-muted-foreground">Saldo</dt>
                  <dd>
                    <strong>{formatCents(detail.currentBalance)}</strong> de {formatCents(detail.initialAmount)}
                  </dd>
                  <dt className="text-muted-foreground">Válida hasta</dt>
                  <dd>{detail.expiresOn ? formatDay(detail.expiresOn) : "Sin caducidad"}</dd>
                  <dt className="text-muted-foreground">Para</dt>
                  <dd className="break-words">
                    {detail.recipientName || "—"}
                    {detail.recipientEmail && (
                      <span className="block text-xs text-muted-foreground">{detail.recipientEmail}</span>
                    )}
                  </dd>
                  {detail.message && (
                    <>
                      <dt className="text-muted-foreground">Mensaje</dt>
                      <dd className="whitespace-pre-line break-words">{detail.message}</dd>
                    </>
                  )}
                </dl>

                <form
                  key={detail.expiresOn ?? "none"}
                  onSubmit={changeExpiry}
                  className="flex flex-wrap items-end gap-2"
                >
                  <Field
                    label="Cambiar la fecha de caducidad"
                    name="expiresAt"
                    type="date"
                    min={todayDay()}
                    defaultValue={detail.expiresOn ?? ""}
                  />
                  <button type="submit" className="px-3 py-1.5 text-sm rounded border hover:bg-gray-50">
                    Guardar fecha
                  </button>
                </form>

                <div>
                  <h3 className="font-medium text-sm mb-2">Movimientos</h3>
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead className="bg-gray-50 text-left border-b">
                        <tr>
                          <th className="px-3 py-2">Fecha</th>
                          <th className="px-3 py-2">Tipo</th>
                          <th className="px-3 py-2 text-right">Importe</th>
                          <th className="px-3 py-2 text-right">Saldo</th>
                          <th className="px-3 py-2">Quién</th>
                          <th className="px-3 py-2">Nota</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.transactions.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                              Sin movimientos.
                            </td>
                          </tr>
                        )}
                        {detail.transactions.map((t) => (
                          <tr key={t.id} className="border-b last:border-b-0">
                            <td className="px-3 py-2 whitespace-nowrap text-xs">
                              {new Date(t.createdAt).toLocaleString("es-ES", {
                                dateStyle: "short",
                                timeStyle: "short",
                              })}
                            </td>
                            <td className="px-3 py-2">{GIFT_CARD_MOVEMENT_LABEL[t.type] ?? t.type}</td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {t.type === "applied" ? "−" : "+"}
                              {formatCents(t.amount)}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {t.balanceAfter === null ? "—" : formatCents(t.balanceAfter)}
                            </td>
                            <td className="px-3 py-2">{t.createdByName ?? "—"}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground break-words">{t.note ?? ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {canDeactivate(giftCardStatusOf(detail)) && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setPendingDeactivate(detail)}
                      className="inline-flex items-center gap-1 text-sm text-red-600 hover:underline"
                    >
                      <Power className="w-4 h-4" /> Desactivar
                    </button>
                  </div>
                )}
              </div>
            )}
          </Modal>
        )}

        <ConfirmDialog
          open={!!pendingDeactivate}
          title={`¿Desactivar la tarjeta regalo ${pendingDeactivate?.code ?? ""}?`}
          description={
            pendingDeactivate &&
            `Ya no se podrá canjear el saldo que le queda (${formatCents(pendingDeactivate.currentBalance)}).`
          }
          confirmLabel="Desactivar tarjeta regalo"
          destructive
          loading={deactivating}
          onCancel={() => setPendingDeactivate(null)}
          onConfirm={performDeactivate}
        />
      </div>
    </PlanGate>
  );
}

function StatusBadge({ status }: { status: GiftCardStatus }) {
  const label = GIFT_CARD_STATUS_LABEL[status];
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1 text-green-700">
        <CheckCircle2 className="w-3 h-3" /> {label}
      </span>
    );
  }
  if (status === "expired") {
    return (
      <span className="inline-flex items-center gap-1 text-amber-700">
        <Clock className="w-3 h-3" /> {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-gray-500">
      <XCircle className="w-3 h-3" /> {label}
    </span>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-white rounded-lg shadow-xl w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[90vh] overflow-y-auto p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
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
