"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Gift, Users, Star, Plus, Trash2, Award, Search, Loader2, Pencil } from "lucide-react";
import apiClient, {
  ApiError,
  LoyaltyMemberRow,
  LoyaltyProgram,
  LoyaltyProgramSettings,
  LoyaltyReward,
  LoyaltyRewardInput,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { EMPTY_REWARD_FORM, RewardForm, adjustmentOf, rewardFormOf, rewardPayload } from "@/lib/loyalty-rewards";

/**
 * The salon's loyalty programme. One per salon: how points are earned
 * (per euro or per visit), how clients join, the rewards they can spend
 * points on at the till, and the members.
 *
 * Points are no longer typed in by hand: a paid, completed appointment or a
 * till sale earns them, and a refund or cancellation takes them back. Manual
 * adjustments remain for corrections and are recorded with a reason.
 */

const DEFAULTS: LoyaltyProgramSettings = {
  name: "Programa de fidelización",
  description: "",
  isActive: true,
  earnMode: "per_euro",
  pointsPerEuro: 1,
  pointsPerVisit: 10,
  minPointsRedemption: 0,
  welcomePoints: 0,
  autoEnroll: true,
  allowSelfEnroll: true,
};

const REWARD_TYPES: Record<LoyaltyRewardInput["type"], string> = {
  discount: "Descuento en el ticket",
  free_service: "Servicio gratis",
  product: "Producto de regalo",
  voucher: "Otro regalo",
};

const euros = (cents: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100);

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 403 && /plan|loyalty/i.test(err.message)) {
    return "La fidelización no está incluida en tu plan actual. Puedes activarla desde Facturación.";
  }
  return err instanceof Error && err.message ? err.message : "Algo ha fallado. Inténtalo de nuevo.";
}

export default function LoyaltyPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [form, setForm] = useState<LoyaltyProgramSettings>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<"programme" | "members">("programme");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { program } = await apiClient.getLoyaltyProgram();
      setProgram(program);
      if (program) {
        setForm({
          name: program.name,
          description: program.description ?? "",
          isActive: program.isActive,
          earnMode: program.earnMode,
          pointsPerEuro: program.pointsPerEuro,
          pointsPerVisit: program.pointsPerVisit,
          minPointsRedemption: program.minPointsRedemption,
          welcomePoints: program.welcomePoints,
          autoEnroll: program.autoEnroll,
          allowSelfEnroll: program.allowSelfEnroll,
        });
      }
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      const { program } = await apiClient.saveLoyaltyProgram(form);
      setProgram(program);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">Fidelización</h1>
        <p className="text-gray-600">
          Los puntos se suman solos cuando una cita se completa y se cobra, o con cada venta en
          caja. Si se devuelve el pago o se cancela la cita, se restan. Se canjean en caja como
          descuento.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
          {error.includes("Facturación") && (
            <a href="/dashboard/billing" className="ml-2 underline">
              Ir a Facturación
            </a>
          )}
        </div>
      )}

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-x-8">
          {(
            [
              ["programme", "Programa y recompensas", Gift],
              ["members", `Socios${program ? ` (${program._count?.members ?? 0})` : ""}`, Users],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              disabled={key === "members" && !program}
              className={`py-4 px-1 border-b-2 font-medium text-sm disabled:opacity-40 ${
                tab === key
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              <Icon className="w-4 h-4 inline mr-2" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {tab === "programme" && (
        <div className="space-y-6">
          <form onSubmit={save} className="bg-white rounded-lg shadow p-6 space-y-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-semibold text-gray-900">
                {program ? "Tu programa" : "Crea tu programa"}
              </h2>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Activo
              </label>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-medium text-gray-700">Nombre</span>
                <input
                  required
                  maxLength={120}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-gray-700">Descripción para tus clientes</span>
                <input
                  maxLength={1000}
                  value={form.description ?? ""}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </label>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-gray-700">Cómo se ganan los puntos</legend>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="earnMode"
                    checked={form.earnMode === "per_euro"}
                    onChange={() => setForm({ ...form, earnMode: "per_euro" })}
                  />
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={form.pointsPerEuro}
                    onChange={(e) => setForm({ ...form, pointsPerEuro: Number(e.target.value) || 0 })}
                    className="w-20 px-2 py-1 border border-gray-300 rounded-md"
                  />
                  puntos por cada euro pagado
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="earnMode"
                    checked={form.earnMode === "per_visit"}
                    onChange={() => setForm({ ...form, earnMode: "per_visit" })}
                  />
                  <input
                    type="number"
                    min={0}
                    max={100000}
                    value={form.pointsPerVisit}
                    onChange={(e) => setForm({ ...form, pointsPerVisit: Number(e.target.value) || 0 })}
                    className="w-20 px-2 py-1 border border-gray-300 rounded-md"
                  />
                  puntos por visita pagada (tipo tarjeta de sellos)
                </label>
              </div>
            </fieldset>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-medium text-gray-700">Puntos de bienvenida</span>
                <input
                  type="number"
                  min={0}
                  value={form.welcomePoints}
                  onChange={(e) => setForm({ ...form, welcomePoints: Number(e.target.value) || 0 })}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </label>
              <label className="block text-sm">
                <span className="font-medium text-gray-700">Saldo mínimo para canjear</span>
                <input
                  type="number"
                  min={0}
                  value={form.minPointsRedemption}
                  onChange={(e) => setForm({ ...form, minPointsRedemption: Number(e.target.value) || 0 })}
                  className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </label>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-gray-700">Alta de socios</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.autoEnroll}
                  onChange={(e) => setForm({ ...form, autoEnroll: e.target.checked })}
                />
                <span>
                  Dar de alta automáticamente a cada cliente en su primera visita pagada.
                  <span className="block text-gray-500">
                    Si lo desactivas, solo suman puntos los clientes que des de alta tú (desde su
                    ficha o desde Socios).
                  </span>
                </span>
              </label>
              {/* No "se apunten ellos": clients have no account on the salon's
                  site any more, so there is nowhere for them to do it. */}
            </fieldset>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md disabled:opacity-50"
              >
                {saving ? "Guardando…" : program ? "Guardar cambios" : "Crear programa"}
              </button>
              {saved && <span className="text-sm text-green-700">Guardado</span>}
            </div>
          </form>

          {program && <RewardsSection program={program} onChange={load} onError={setError} />}
          {program && <TiersSection program={program} onChange={load} onError={setError} />}
        </div>
      )}

      {tab === "members" && program && <MembersSection onError={setError} />}
    </div>
  );
}

function RewardsSection({
  program,
  onChange,
  onError,
}: {
  program: LoyaltyProgram;
  onChange: () => void;
  onError: (e: string | null) => void;
}) {
  const { toast } = useToast();
  const [services, setServices] = useState<Array<{ id: string; name: string }>>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<RewardForm>(EMPTY_REWARD_FORM);
  const [creating, setCreating] = useState(false);
  // The reward being edited, in its own dialog.
  const [editing, setEditing] = useState<LoyaltyReward | null>(null);
  const [editForm, setEditForm] = useState<RewardForm>(EMPTY_REWARD_FORM);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // The reward about to be deleted, confirmed in the panel's dialog.
  const [pendingDelete, setPendingDelete] = useState<LoyaltyReward | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    apiClient
      .getServices()
      .then((s: any[]) => setServices(s.map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => setServices([]));
  }, []);

  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);

  const performDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const out = await apiClient.deleteLoyaltyReward(pendingDelete.id);
      toast({ title: out.deactivated ? "Recompensa desactivada: ya se había canjeado" : "Recompensa borrada" });
      onChange();
    } catch (err) {
      onError(errorText(err));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const describe = (r: LoyaltyReward) => {
    let what: string = REWARD_TYPES[r.type];
    if (r.type === "discount") {
      if (r.discountPercent) what = `${r.discountPercent} % de descuento`;
      else if (r.discountAmount) what = `${euros(r.discountAmount)} de descuento`;
      else what = "Descuento";
    } else if (r.type === "free_service") {
      what = `Gratis: ${serviceName.get(r.freeServiceId ?? "") ?? "servicio"}`;
    }
    const used = r.maxRedemptions
      ? `canjeada ${r.currentRedemptions ?? 0} de ${r.maxRedemptions} veces`
      : `canjeada ${r.currentRedemptions ?? 0} veces`;
    const until = r.expiresAt ? ` · hasta el ${new Date(r.expiresAt).toLocaleDateString("es-ES")}` : "";
    return `${what} · ${r.pointsCost} puntos · ${used}${until}`;
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = rewardPayload(draft);
    if (!payload.ok) {
      onError(payload.error);
      return;
    }
    setCreating(true);
    try {
      await apiClient.createLoyaltyReward(payload.body);
      setAdding(false);
      setDraft(EMPTY_REWARD_FORM);
      onError(null);
      toast({ title: "Recompensa creada" });
      onChange();
    } catch (err) {
      onError(errorText(err));
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (r: LoyaltyReward) => {
    setEditing(r);
    setEditForm(rewardFormOf(r));
    setEditError(null);
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const payload = rewardPayload(editForm, editing.currentRedemptions ?? 0);
    if (!payload.ok) {
      setEditError(payload.error);
      return;
    }
    setSavingEdit(true);
    try {
      await apiClient.updateLoyaltyReward(editing.id, payload.body);
      setEditing(null);
      toast({ title: "Recompensa guardada" });
      onChange();
    } catch (err) {
      setEditError(errorText(err));
    } finally {
      setSavingEdit(false);
    }
  };

  return (
    <section className="bg-white rounded-lg shadow p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Recompensas</h2>
        <button
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800"
        >
          <Plus className="w-4 h-4" /> Nueva recompensa
        </button>
      </div>
      <p className="text-sm text-gray-500">
        Se canjean en Caja: al elegir al cliente aparecen las que puede pagar con sus puntos, y el
        descuento sale del ticket.
      </p>

      {adding && (
        <form onSubmit={create} className="rounded-md border border-gray-200 p-4">
          <RewardFields form={draft} onChange={setDraft} services={services} />
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="px-3 py-1.5 border rounded-md text-sm">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm disabled:opacity-50"
            >
              {creating ? "Añadiendo…" : "Añadir"}
            </button>
          </div>
        </form>
      )}

      {program.rewards.length === 0 ? (
        <p className="text-sm text-gray-500">Aún no hay recompensas.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {program.rewards.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className={`font-medium ${r.isActive ? "text-gray-900" : "text-gray-400 line-through"}`}>
                  <Award className="w-4 h-4 inline mr-1 text-amber-500" />
                  {r.name}
                </p>
                <p className="text-sm text-gray-500">{describe(r)}</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => openEdit(r)}
                  aria-label={`Editar ${r.name}`}
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
                >
                  <Pencil className="w-4 h-4" /> Editar
                </button>
                <button
                  onClick={async () => {
                    try {
                      await apiClient.updateLoyaltyReward(r.id, { isActive: !r.isActive });
                      onChange();
                    } catch (err) {
                      onError(errorText(err));
                    }
                  }}
                  className="text-sm text-gray-600 hover:text-gray-900"
                >
                  {r.isActive ? "Desactivar" : "Activar"}
                </button>
                <button
                  aria-label="Borrar recompensa"
                  onClick={() => setPendingDelete(r)}
                  className="text-red-600 hover:text-red-800"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <Modal title={`Editar «${editing.name}»`} onClose={() => !savingEdit && setEditing(null)}>
          <form onSubmit={saveEdit} className="space-y-3">
            <RewardFields form={editForm} onChange={setEditForm} services={services} showActive />
            {editError && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
                {editError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(null)}
                disabled={savingEdit}
                className="px-3 py-1.5 border rounded-md text-sm"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={savingEdit}
                className="px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm disabled:opacity-50"
              >
                {savingEdit ? "Guardando…" : "Guardar"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={`¿Borrar la recompensa «${pendingDelete?.name ?? ""}»?`}
        description="Si algún cliente ya la ha canjeado, solo se desactiva."
        confirmLabel="Borrar recompensa"
        destructive
        loading={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={performDelete}
      />
    </section>
  );
}

/** The reward's fields, for a new one and in the edit dialog (lib/loyalty-rewards.ts). */
function RewardFields({
  form,
  onChange,
  services,
  showActive,
}: {
  form: RewardForm;
  onChange: (f: RewardForm) => void;
  services: Array<{ id: string; name: string }>;
  showActive?: boolean;
}) {
  const set = (patch: Partial<RewardForm>) => onChange({ ...form, ...patch });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="block text-sm sm:col-span-2">
        <span className="font-medium text-gray-700">Nombre</span>
        <input
          required
          maxLength={120}
          placeholder="p. ej. 10 % en tu próxima visita"
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium text-gray-700">Tipo</span>
        <select
          value={form.type}
          onChange={(e) => set({ type: e.target.value as RewardForm["type"] })}
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
        >
          {Object.entries(REWARD_TYPES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="font-medium text-gray-700">Cuesta (puntos)</span>
        <input
          type="number"
          min={1}
          required
          value={form.pointsCost}
          onChange={(e) => set({ pointsCost: e.target.value })}
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
        />
      </label>

      {form.type === "discount" && (
        <fieldset className="space-y-2 text-sm sm:col-span-2">
          <legend className="font-medium text-gray-700">Descuento: un porcentaje o un importe fijo</legend>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="discountKind"
                checked={form.discountKind === "percent"}
                onChange={() => set({ discountKind: "percent" })}
              />
              <input
                type="number"
                min={1}
                max={100}
                aria-label="Porcentaje de descuento"
                value={form.percent}
                disabled={form.discountKind !== "percent"}
                onChange={(e) => set({ percent: e.target.value })}
                className="w-20 px-2 py-1 border border-gray-300 rounded-md disabled:bg-gray-100"
              />
              %
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="discountKind"
                checked={form.discountKind === "amount"}
                onChange={() => set({ discountKind: "amount" })}
              />
              <input
                inputMode="decimal"
                placeholder="5,00"
                aria-label="Importe del descuento en euros"
                value={form.euros}
                disabled={form.discountKind !== "amount"}
                onChange={(e) => set({ euros: e.target.value })}
                className="w-24 px-2 py-1 border border-gray-300 rounded-md disabled:bg-gray-100"
              />
              €
            </label>
          </div>
        </fieldset>
      )}
      {form.type === "free_service" && (
        <select
          required
          value={form.freeServiceId}
          onChange={(e) => set({ freeServiceId: e.target.value })}
          className="px-3 py-2 border border-gray-300 rounded-md text-sm sm:col-span-2"
        >
          <option value="">Elige el servicio que regala</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {(form.type === "product" || form.type === "voucher") && (
        <p className="text-xs text-gray-500 sm:col-span-2">
          Se entrega en el mostrador: el canje descuenta los puntos pero no cambia el importe del ticket.
        </p>
      )}

      <label className="block text-sm">
        <span className="font-medium text-gray-700">Límite de canjes (opcional)</span>
        <input
          type="number"
          min={1}
          placeholder="Sin límite"
          value={form.maxRedemptions}
          onChange={(e) => set({ maxRedemptions: e.target.value })}
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
        />
        <span className="mt-1 block text-xs text-gray-500">Entre todos los clientes.</span>
      </label>
      <label className="block text-sm">
        <span className="font-medium text-gray-700">Válida hasta (opcional)</span>
        <input
          type="date"
          value={form.expiresOn}
          onChange={(e) => set({ expiresOn: e.target.value })}
          className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
        />
        <span className="mt-1 block text-xs text-gray-500">Incluido ese día. Vacío: no caduca.</span>
      </label>
      {showActive && (
        <label className="inline-flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          Activa (se puede canjear en Caja)
        </label>
      )}
    </div>
  );
}

/** A dialog in the panel's style (as in Tarjetas regalo): Escape or a click outside closes it. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="text-gray-500 hover:text-gray-800">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TiersSection({
  program,
  onChange,
  onError,
}: {
  program: LoyaltyProgram;
  onChange: () => void;
  onError: (e: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [minPoints, setMinPoints] = useState(500);
  const [multiplier, setMultiplier] = useState(1.5);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiClient.createLoyaltyTier({ name, minPoints, pointsMultiplier: multiplier });
      setName("");
      onError(null);
      onChange();
    } catch (err) {
      onError(errorText(err));
    }
  };

  return (
    <section className="bg-white rounded-lg shadow p-6 space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">Niveles (opcional)</h2>
      <p className="text-sm text-gray-500">
        Un socio sube de nivel al acumular puntos, y desde ese nivel gana más puntos por visita o por
        euro. Canjear puntos no le baja de nivel; si se devuelve un pago o se cancela una cita, los
        puntos que se le restan cuentan.
      </p>
      {program.tiers.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {program.tiers.map((t) => (
            <li key={t.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                <strong>{t.name}</strong> · desde {t.minPoints} puntos acumulados · ×{t.pointsMultiplier}
              </span>
              <button
                aria-label="Borrar nivel"
                onClick={async () => {
                  try {
                    await apiClient.deleteLoyaltyTier(t.id);
                    onChange();
                  } catch (err) {
                    onError(errorText(err));
                  }
                }}
                className="text-red-600 hover:text-red-800"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-center gap-2 text-sm">
        <input
          required
          placeholder="Nombre (p. ej. Oro)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-md"
        />
        desde
        <input
          type="number"
          min={0}
          value={minPoints}
          onChange={(e) => setMinPoints(Number(e.target.value) || 0)}
          className="w-24 px-2 py-1.5 border border-gray-300 rounded-md"
        />
        puntos, ×
        <input
          type="number"
          min={1}
          max={10}
          step={0.1}
          value={multiplier}
          onChange={(e) => setMultiplier(Number(e.target.value) || 1)}
          className="w-20 px-2 py-1.5 border border-gray-300 rounded-md"
        />
        <button type="submit" className="px-3 py-1.5 border border-gray-300 rounded-md hover:bg-gray-50">
          Añadir nivel
        </button>
      </form>
    </section>
  );
}

function MembersSection({ onError }: { onError: (e: string | null) => void }) {
  const [members, setMembers] = useState<LoyaltyMemberRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [clients, setClients] = useState<Array<{ id: string; firstName: string; lastName: string; email?: string }>>([]);
  const [clientQuery, setClientQuery] = useState("");

  const load = useCallback(
    async (q?: string) => {
      try {
        setLoading(true);
        setMembers(await apiClient.getLoyaltyMembers(q));
      } catch (err) {
        onError(errorText(err));
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    load();
    apiClient
      .getClients()
      .then((c: any[]) => setClients(c))
      .catch(() => setClients([]));
  }, [load]);

  const memberIds = new Set(members.map((m) => m.client.id));
  const candidates = clientQuery.trim()
    ? clients
        .filter((c) => !memberIds.has(c.id))
        .filter((c) =>
          `${c.firstName} ${c.lastName} ${c.email ?? ""}`.toLowerCase().includes(clientQuery.trim().toLowerCase()),
        )
        .slice(0, 8)
    : [];

  const enroll = async (clientId: string) => {
    try {
      await apiClient.enrollLoyaltyMember(clientId);
      setClientQuery("");
      onError(null);
      load(search);
    } catch (err) {
      onError(errorText(err));
    }
  };

  // The member whose points are being adjusted, in the dialog.
  const [adjusting, setAdjusting] = useState<LoyaltyMemberRow | null>(null);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-4 space-y-2">
        <label className="block text-sm font-medium text-gray-700">Dar de alta a un cliente</label>
        <input
          value={clientQuery}
          onChange={(e) => setClientQuery(e.target.value)}
          placeholder="Busca por nombre o email"
          className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-md"
        />
        {candidates.length > 0 && (
          <ul className="max-w-md divide-y divide-gray-100 rounded-md border border-gray-200">
            {candidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span>
                  {c.firstName} {c.lastName}
                  {c.email && <span className="text-gray-500"> · {c.email}</span>}
                </span>
                <button onClick={() => enroll(c.id)} className="text-blue-600 hover:text-blue-800">
                  Dar de alta
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="flex items-center gap-2 border-b border-gray-100 p-4">
          <Search className="w-4 h-4 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(search)}
            placeholder="Buscar socio y pulsa Intro"
            className="flex-1 outline-none text-sm"
          />
          {loading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
        </div>
        {members.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-500">Aún no hay socios.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[720px] w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">Cliente</th>
                  <th className="px-4 py-3 text-left">Puntos</th>
                  <th className="px-4 py-3 text-left">Acumulados</th>
                  <th className="px-4 py-3 text-left">Gastado</th>
                  <th className="px-4 py-3 text-left">Alta</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {members.map((m) => (
                  <tr key={m.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <a href={`/dashboard/clients/${m.client.id}`} className="font-medium text-gray-900 hover:underline">
                        {m.client.firstName} {m.client.lastName}
                      </a>
                      <div className="text-gray-500">{m.client.email ?? m.client.phone ?? ""}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Star className="w-4 h-4 inline text-yellow-500 mr-1" />
                      <strong>{m.currentPoints}</strong>
                      {m.tier && <span className="ml-2 text-xs text-gray-500">{m.tier.name}</span>}
                    </td>
                    <td className="px-4 py-3">{m.lifetimePoints}</td>
                    <td className="px-4 py-3">{euros(Math.round(Number(m.totalSpent) * 100))}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(m.joinedAt).toLocaleDateString("es-ES")}
                      {m.enrolledVia && (
                        <span className="block text-xs">
                          {{ auto: "automática", portal: "desde su área", staff: "en el salón" }[m.enrolledVia] ??
                            m.enrolledVia}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setAdjusting(m)} className="text-blue-600 hover:text-blue-800">
                        Ajustar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adjusting && (
        <AdjustPointsDialog
          member={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={() => {
            setAdjusting(null);
            load(search);
          }}
        />
      )}
    </div>
  );
}

/** A manual correction of a member's points: how many, add or take, and why (it stays in their history). */
function AdjustPointsDialog({
  member,
  onClose,
  onDone,
}: {
  member: LoyaltyMemberRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const [sign, setSign] = useState<"add" | "take">("add");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const name = `${member.client.firstName} ${member.client.lastName ?? ""}`.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const out = adjustmentOf(amount, sign, reason, member.currentPoints);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setSaving(true);
    try {
      await apiClient.adjustLoyaltyPoints(member.id, out.points, out.reason);
      toast({ title: out.points > 0 ? `Sumados ${out.points} puntos a ${name}` : `Restados ${-out.points} puntos a ${name}` });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Ajustar puntos de ${name}`} onClose={() => !saving && onClose()}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <p className="text-gray-600">
          Tiene <strong>{member.currentPoints}</strong> puntos. Los ajustes son para corregir: los puntos de
          las visitas y las ventas se suman solos.
        </p>
        <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
          <legend className="sr-only">Sumar o restar</legend>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="adjustSign" checked={sign === "add"} onChange={() => setSign("add")} />
            Sumar
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="adjustSign" checked={sign === "take"} onChange={() => setSign("take")} />
            Restar
          </label>
        </fieldset>
        <label className="block">
          <span className="font-medium text-gray-700">Puntos</span>
          <input
            type="number"
            min={1}
            required
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
          />
        </label>
        <label className="block">
          <span className="font-medium text-gray-700">Motivo</span>
          <input
            required
            maxLength={300}
            placeholder="p. ej. Puntos de una visita cobrada fuera del sistema"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
          />
          <span className="mt-1 block text-xs text-gray-500">Queda en su historial.</span>
        </label>
        {error && (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-3 py-1.5 border rounded-md">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-md disabled:opacity-50"
          >
            {saving ? "Guardando…" : sign === "add" ? "Sumar puntos" : "Restar puntos"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
