import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchSalonLegal } from "@/lib/public-site-server";
import { safeHttpUrl } from "@/lib/safe-url";
import {
  CONVERSATION_RETENTION_MONTHS,
  KIRAROOM_DOMAIN,
  SUB_PROCESSORS,
  controllerName,
  legalAddressLine,
  subProcessorText,
} from "@/lib/salon-legal";
import { LegalSection, SalonLegalLayout } from "../components/legal-layout";

/**
 * The salon's privacy policy (RGPD art. 13), generated from what it filled
 * in: the salon is the controller of its clients' data, KiraRoom the
 * processor. The booking page, the widget and the chat link here, unless
 * the salon set its own policy (privacyPolicyUrl). A model text: a legal
 * advisor must review it.
 */
export const revalidate = 300;

type Props = { params: { salonName: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const legal = await fetchSalonLegal(params.salonName);
  if (!legal) return { title: "Salón no encontrado", robots: { index: false } };
  return { title: `Política de privacidad · ${legal.name}`, robots: { index: false, follow: true } };
}

export default async function SalonPrivacyPage({ params }: Props) {
  const legal = await fetchSalonLegal(params.salonName);
  if (!legal) notFound();

  const who = controllerName(legal);
  const address = legalAddressLine(legal.address);
  const contact = [legal.email, legal.phone].filter(Boolean).join(" · ");

  return (
    <SalonLegalLayout slug={legal.slug} salonName={legal.name} title="Política de privacidad">
      {safeHttpUrl(legal.privacyPolicyUrl) && (
        <p className="rounded-lg bg-purple-50 p-3 text-sm">
          {legal.name} tiene su propia política de privacidad:{" "}
          <a href={safeHttpUrl(legal.privacyPolicyUrl)!} className="underline" rel="noopener noreferrer">
            {legal.privacyPolicyUrl}
          </a>
          . Esta página resume cómo se tratan tus datos en su web de reservas.
        </p>
      )}

      <LegalSection title="1. Quién es responsable de tus datos">
        <p>
          El responsable del tratamiento es <strong>{who}</strong>
          {legal.legalName && legal.legalName !== legal.name ? ` (${legal.name})` : ""}
          {legal.taxId ? `, con NIF ${legal.taxId}` : ""}
          {address ? `, ${address}` : ""}.
        </p>
        {contact && <p>Contacto: {contact}</p>}
        <p>
          La web de reservas, el chat y los avisos los presta KiraRoom ({KIRAROOM_DOMAIN}) por cuenta de {legal.name}, como
          encargado del tratamiento (art. 28 RGPD): solo usa tus datos para dar este servicio al salón y siguiendo sus
          instrucciones.
        </p>
      </LegalSection>

      <LegalSection title="2. Qué datos tratamos">
        <ul>
          <li>Tu nombre, teléfono y email, y las citas que reservas (servicio, profesional, fecha y hora).</li>
          <li>Lo que escribes en el chat de la recepcionista virtual y lo que te responde.</li>
          <li>Tus elecciones: si no quieres promociones, o si quieres los avisos por WhatsApp.</li>
        </ul>
      </LegalSection>

      <LegalSection title="3. Para qué y con qué base">
        <ul>
          <li>
            <strong>Gestionar tu cita</strong>: reservarla, confirmarla, cambiarla o cancelarla, y atenderte en el salón
            (art. 6.1.b RGPD: lo pides tú).
          </li>
          <li>
            <strong>Avisos y recordatorios de tus citas</strong> por email, y por WhatsApp si lo marcas al reservar (art.
            6.1.b RGPD).
          </li>
          <li>
            <strong>Promociones del salón por email</strong> y recordatorios para volver a reservar, sobre servicios
            parecidos a los que ya has recibido. Puedes decir que no al reservar (&quot;No quiero recibir
            promociones&quot;) o darte de baja en cualquier email (art. 21.2 LSSI y art. 6.1.f RGPD).
          </li>
          <li>
            <strong>Promociones por WhatsApp</strong>, solo si lo marcas expresamente (art. 6.1.a RGPD). Puedes retirarlo
            cuando quieras respondiendo BAJA.
          </li>
          <li>
            <strong>Responder en el chat</strong>: la recepcionista virtual es un asistente de inteligencia artificial
            que contesta y puede reservar por ti. No compartas en el chat datos de salud ni otros datos sensibles.
          </li>
          <li>
            <strong>Cumplir obligaciones legales</strong>, como las facturas (art. 6.1.c RGPD).
          </li>
        </ul>
      </LegalSection>

      <LegalSection title="4. Cuánto tiempo">
        <ul>
          <li>Tus datos de cliente, mientras sigas siendo cliente del salón o hasta que pidas que se borren.</li>
          <li>Las conversaciones del chat, {CONVERSATION_RETENTION_MONTHS} meses; después se borran.</li>
          <li>Las facturas y lo que exija la ley, durante los plazos que esta fija.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Quién más los trata">
        <p>
          Nadie compra ni recibe tus datos para sus propios fines. Para dar el servicio, KiraRoom se apoya en estos
          proveedores (subencargados):
        </p>
        <ul>
          {SUB_PROCESSORS.filter((s) => !s.platformOnly).map((s) => (
            <li key={s.name}>
              <strong>{s.name}</strong>: {subProcessorText(s)}
            </li>
          ))}
        </ul>
        <p>
          Algunos están en Estados Unidos: esas transferencias se hacen con las garantías que exige el RGPD (Marco de
          Privacidad de Datos UE-EE. UU. o cláusulas contractuales tipo de la Comisión Europea).
        </p>
      </LegalSection>

      <LegalSection title="6. Tus derechos">
        <p>
          Puedes pedir acceso a tus datos, corregirlos, borrarlos, oponerte a su uso, limitarlo, llevártelos a otro
          servicio y retirar un consentimiento que hayas dado. Pídelo a {legal.name}
          {contact ? ` (${contact})` : ""}
          {address ? ` o por escrito en ${address}` : ""}.
        </p>
        <p>
          Si crees que no se han respetado tus derechos, puedes reclamar ante la Agencia Española de Protección de Datos
          (
          <a href="https://www.aepd.es" className="underline" rel="noopener noreferrer">
            www.aepd.es
          </a>
          ).
        </p>
      </LegalSection>

      <LegalSection title="7. Cookies">
        <p>
          Esta web de reservas no usa cookies de analítica ni de publicidad. Solo guarda en tu navegador lo necesario
          para que funcione, como la conversación del chat abierta.
        </p>
      </LegalSection>
    </SalonLegalLayout>
  );
}
