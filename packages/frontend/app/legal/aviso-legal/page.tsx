import type { Metadata } from "next";
import { KIRAROOM_DOMAIN, KIRAROOM_OWNER } from "@/lib/salon-legal";

export const metadata: Metadata = { title: "Aviso legal · KiraRoom" };

/**
 * KiraRoom's own aviso legal (LSSI art. 10: identification of the service
 * provider). The salons' own avisos legales live at /sites/<slug>/aviso-legal.
 * The identity data is KIRAROOM_OWNER (lib/salon-legal.ts); a legal advisor
 * must validate this text.
 */
export default function AvisoLegalPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Aviso legal</h1>
      <p style={{ color: "#64748b", marginBottom: 24 }}>
        Última actualización: 5 de noviembre de 2026
      </p>

      <Section title="1. Datos identificativos">
        <p>
          En cumplimiento del artículo 10 de la Ley 34/2002, de servicios de
          la sociedad de la información y de comercio electrónico (LSSI), se
          informa de que el titular de KiraRoom y de los sitios{" "}
          <code>kiraroom.com</code> y <code>{KIRAROOM_DOMAIN}</code> es:
        </p>
        <ul>
          <li><strong>Titular</strong>: {KIRAROOM_OWNER.name}</li>
          <li><strong>NIF</strong>: {KIRAROOM_OWNER.nif}</li>
          <li><strong>Domicilio</strong>: {KIRAROOM_OWNER.address}</li>
          <li>
            <strong>Correo electrónico</strong>:{" "}
            <a href={`mailto:${KIRAROOM_OWNER.email}`}>{KIRAROOM_OWNER.email}</a>
          </li>
        </ul>
      </Section>

      <Section title="2. Objeto">
        <p>
          KiraRoom es un servicio de software por suscripción para la gestión
          de citas, clientes, caja y facturación de negocios de belleza y
          bienestar. Su uso se rige por los{" "}
          <a href="/legal/terms">Términos del servicio</a>.
        </p>
      </Section>

      <Section title="3. Propiedad intelectual">
        <p>
          El software, los textos, el diseño y los signos distintivos de
          KiraRoom son de su titular o se usan con licencia. No se permite su
          reproducción o distribución sin autorización. Los datos que cada
          salón introduce siguen siendo del salón.
        </p>
      </Section>

      <Section title="4. Protección de datos">
        <p>
          El tratamiento de datos personales se describe en la{" "}
          <a href="/legal/privacy">Política de privacidad</a>. Para ejercer
          sus derechos puede escribir a{" "}
          <a href={`mailto:${KIRAROOM_OWNER.email}`}>{KIRAROOM_OWNER.email}</a>.
        </p>
      </Section>

      <Section title="5. Responsabilidad">
        <p>
          El titular procura que la información del sitio sea correcta y
          actual, pero no garantiza la ausencia de errores ni la
          disponibilidad ininterrumpida del servicio, salvo lo que digan los
          Términos del servicio. Los enlaces a sitios de terceros no implican
          responsabilidad sobre su contenido.
        </p>
      </Section>

      <Section title="6. Legislación y jurisdicción">
        <p>
          Este aviso se rige por la legislación española. Si quien contrata
          es un consumidor, serán competentes los tribunales de su domicilio;
          en los demás casos, los de Las Palmas de Gran Canaria.
        </p>
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{title}</h2>
      <div>{children}</div>
    </section>
  );
}
