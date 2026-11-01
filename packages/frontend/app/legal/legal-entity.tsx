/**
 * Who is behind KiraRoom, and who processes data on its behalf: shared by
 * the privacy policy and the terms so they cannot disagree.
 *
 * The identification fields are required by the LSSI (art. 10) and the
 * RGPD (art. 13) and must be filled in before these texts are published.
 * Empty ones are shown as "pendiente" rather than invented.
 */
export const LEGAL_ENTITY = {
  tradeName: "KiraRoom",
  /** Razón social, or the owner's full name if a sole trader. */
  legalName: "",
  /** NIF / CIF. */
  taxId: "",
  /** Domicilio. */
  address: "",
  /** Contact address for privacy requests and notices. */
  email: "",
  domain: "app.kiraroom.net",
};

export const LAST_UPDATED = "1 de octubre de 2026";

/** Providers that process personal data for KiraRoom (sub-processors). */
export const PROCESSORS: { name: string; purpose: string; where: string }[] = [
  {
    name: "Hostinger International Ltd.",
    purpose: "alojamiento de los servidores y de la base de datos",
    // The VPS region is chosen when it is ordered: confirm it before publishing.
    where: "empresa con sede en Chipre (UE); centro de datos del servidor: pendiente de confirmar",
  },
  {
    name: "Anthropic, PBC",
    purpose:
      "modelo de IA del recepcionista virtual y del copiloto: recibe los mensajes del chat y, en el copiloto, los datos de la ficha que se consultan",
    where: "Estados Unidos, con cláusulas contractuales tipo de la Comisión Europea (art. 46 RGPD)",
  },
  {
    name: "Stripe Payments Europe, Ltd.",
    purpose: "cobro de las suscripciones y, si el salón lo activa, de pagos online de sus clientes",
    where: "Irlanda; transferencias a EE. UU. con cláusulas contractuales tipo",
  },
  {
    name: "Resend",
    purpose: "envío de emails de servicio: confirmaciones, recordatorios, recuperación de contraseña",
    where: "Estados Unidos, con cláusulas contractuales tipo",
  },
  {
    name: "Twilio Inc.",
    purpose: "envío de SMS, cuando se active",
    where: "Estados Unidos, con cláusulas contractuales tipo",
  },
  {
    name: "Meta Platforms Ireland Ltd.",
    purpose: "mensajería de WhatsApp, Messenger e Instagram, solo si el salón conecta esos canales",
    where: "Irlanda; transferencias a EE. UU. con cláusulas contractuales tipo",
  },
];

export function Pending({ value, label }: { value: string; label: string }) {
  return value ? <>{value}</> : <em style={{ color: "#b45309" }}>[{label}: pendiente]</em>;
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{title}</h2>
      {/* Tailwind resets list and paragraph styles; legal text needs them back. */}
      <div className="[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_li]:mb-1 [&_p]:mb-2 [&_a]:text-violet-700 [&_a]:underline">
        {children}
      </div>
    </section>
  );
}

export function Identification() {
  const e = LEGAL_ENTITY;
  return (
    <ul>
      <li>
        Titular: <Pending value={e.legalName} label="razón social" />, que opera con el nombre comercial{" "}
        {e.tradeName}.
      </li>
      <li>
        NIF: <Pending value={e.taxId} label="NIF" />
      </li>
      <li>
        Domicilio: <Pending value={e.address} label="domicilio" />
      </li>
      <li>
        Contacto: <Pending value={e.email} label="email de contacto" />
      </li>
      <li>
        Sitio: <code>{e.domain}</code>
      </li>
    </ul>
  );
}

export function ProcessorList() {
  return (
    <ul>
      {PROCESSORS.map((p) => (
        <li key={p.name}>
          <strong>{p.name}</strong>: {p.purpose}. Ubicación: {p.where}.
        </li>
      ))}
    </ul>
  );
}
