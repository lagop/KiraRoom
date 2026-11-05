"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, ShieldCheck, UserX } from "lucide-react";
import apiClient from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";

/** The name the server gives an anonymised client (client-anonymize.ts). */
const ANONYMIZED = { firstName: "Clienta", lastName: "anonimizada" };

function fileSlug(text: string) {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "clienta"
  );
}

/**
 * The client's data-protection rights, in her file (owner / admin only):
 * a copy of everything the salon holds about her, and erasure.
 */
export function ClientGdprCard({
  clientId,
  firstName,
  lastName,
  email,
  phone,
}: {
  clientId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [downloading, setDownloading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [anonymizing, setAnonymizing] = useState(false);
  const anonymized =
    firstName === ANONYMIZED.firstName && lastName === ANONYMIZED.lastName && !email && !phone;

  async function download() {
    setDownloading(true);
    try {
      const doc = await apiClient.exportClientData(clientId);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `datos-${fileSlug(`${firstName} ${lastName}`)}-${String(doc.generatedAt).slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Datos descargados", description: "Entrégale el archivo a la clienta por un medio seguro." });
    } catch (err: any) {
      toast({ title: "No se pudieron descargar sus datos", description: err?.message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }

  async function anonymize() {
    setAnonymizing(true);
    try {
      await apiClient.anonymizeClient(clientId);
      setConfirming(false);
      toast({ title: "Datos anonimizados", description: "La ficha ya no la identifica. Sus citas y facturas se conservan." });
      qc.invalidateQueries({ queryKey: ["clients"] });
      qc.invalidateQueries({ queryKey: ["rebooking"] });
    } catch (err: any) {
      setConfirming(false);
      toast({ title: "No se pudieron anonimizar sus datos", description: err?.message, variant: "destructive" });
    } finally {
      setAnonymizing(false);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
        <ShieldCheck className="h-4 w-4 text-purple-600" /> Protección de datos (RGPD)
      </h2>
      <p className="mt-2 text-sm text-gray-600">
        {anonymized
          ? "Sus datos personales ya están anonimizados."
          : "Si la clienta pide una copia de sus datos o que se borren, hazlo desde aquí. Tienes un mes para responderle."}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={downloading}
          onClick={download}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {downloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          Descargar sus datos (RGPD)
        </button>
        {!anonymized && (
          <button
            type="button"
            disabled={anonymizing}
            onClick={() => setConfirming(true)}
            className="inline-flex items-center gap-2 rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <UserX className="h-3 w-3" />
            Anonimizar sus datos
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title={`¿Anonimizar los datos de ${firstName} ${lastName}?`}
        description={
          <div className="space-y-2">
            <p>
              <strong>Se borran</strong> su nombre, email, teléfono, NIF, fecha de nacimiento, foto,
              alergias y condiciones médicas, notas y etiquetas; las respuestas y la firma de sus
              consentimientos y sus preferencias de promociones; las conversaciones con la
              recepcionista, la lista de espera, los recordatorios y avisos, y su acceso a la cuenta
              online. No volverá a recibir ningún mensaje del salón.
            </p>
            <p>
              <strong>Se conservan</strong> sus citas, pagos y facturas, sin datos que la identifiquen
              en la ficha. Las facturas emitidas no se modifican: la ley obliga a guardarlas tal como
              se emitieron, con su nombre y NIF.
            </p>
            <p>No se puede deshacer. Si te ha pedido una copia de sus datos, descárgala antes.</p>
          </div>
        }
        confirmLabel="Anonimizar"
        destructive
        loading={anonymizing}
        onCancel={() => setConfirming(false)}
        onConfirm={anonymize}
      />
    </section>
  );
}
