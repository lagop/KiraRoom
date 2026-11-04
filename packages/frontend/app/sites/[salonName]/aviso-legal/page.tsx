import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchSalonLegal } from "@/lib/public-site-server";
import { KIRAROOM_DOMAIN, controllerName, legalAddressLine, salonPrivacyPath } from "@/lib/salon-legal";
import { LegalSection, SalonLegalLayout } from "../components/legal-layout";

/**
 * The salon's aviso legal (LSSI art. 10): who runs the website, from what
 * the salon filled in. Until it fills in its business name and NIF (the
 * panel warns), the trade name and address are shown. A model text: a legal
 * advisor must review it.
 */
export const revalidate = 300;

type Props = { params: { salonName: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const legal = await fetchSalonLegal(params.salonName);
  if (!legal) return { title: "Salón no encontrado", robots: { index: false } };
  return { title: `Aviso legal · ${legal.name}`, robots: { index: false, follow: true } };
}

export default async function SalonLegalNoticePage({ params }: Props) {
  const legal = await fetchSalonLegal(params.salonName);
  if (!legal) notFound();

  const address = legalAddressLine(legal.address);

  return (
    <SalonLegalLayout slug={legal.slug} salonName={legal.name} title="Aviso legal">
      <LegalSection title="Titular de esta web">
        <ul>
          <li>
            Titular: <strong>{controllerName(legal)}</strong>
          </li>
          {legal.legalName && legal.legalName !== legal.name && <li>Nombre comercial: {legal.name}</li>}
          {legal.taxId && <li>NIF: {legal.taxId}</li>}
          {address && <li>Domicilio: {address}</li>}
          {legal.email && (
            <li>
              Email:{" "}
              <a href={`mailto:${legal.email}`} className="underline">
                {legal.email}
              </a>
            </li>
          )}
          {legal.phone && <li>Teléfono: {legal.phone}</li>}
        </ul>
      </LegalSection>

      <LegalSection title="Quién presta la web">
        <p>
          Esta web de reservas la presta KiraRoom ({KIRAROOM_DOMAIN}) por cuenta de {legal.name}. Los servicios, precios,
          horarios y textos los publica el salón, que responde de ellos.
        </p>
      </LegalSection>

      <LegalSection title="Uso de la web">
        <p>
          La web sirve para conocer el salón y reservar cita. Úsala de buena fe: no reserves en nombre de otra persona sin
          su permiso ni intentes alterar su funcionamiento.
        </p>
      </LegalSection>

      <LegalSection title="Tus datos">
        <p>
          Cómo se tratan los datos que das al reservar o en el chat está en la{" "}
          <a href={salonPrivacyPath(legal.slug)} className="underline">
            política de privacidad
          </a>
          .
        </p>
      </LegalSection>
    </SalonLegalLayout>
  );
}
