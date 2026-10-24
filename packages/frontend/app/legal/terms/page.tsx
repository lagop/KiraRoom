import { Identification, LAST_UPDATED, LEGAL_ENTITY, Pending, ProcessorList, Section } from "../legal-entity";

/**
 * Terms of service, with the data processing agreement (RGPD art. 28).
 *
 * Rewritten on 1 October 2026. The previous text sold features that are not
 * built (sending invoices to the AEAT, accounting sync, WhatsApp
 * reminders), promised 99 % availability and point-in-time restores,
 * pointed to the EU online dispute platform (closed in July 2025) and had
 * no processing agreement, which KiraRoom needs as processor of each
 * salon's client data. Review with a lawyer.
 */
export default function TermsPage() {
  const email = LEGAL_ENTITY.email;
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Términos del Servicio</h1>
      <p style={{ color: "#64748b", marginBottom: 24 }}>Última actualización: {LAST_UPDATED}</p>

      <Section title="1. Quién presta el servicio">
        <Identification />
        <p>
          Estos términos regulan el uso de KiraRoom por los negocios que lo contratan (en adelante, "el
          salón"). Al crear una cuenta, el salón los acepta.
        </p>
      </Section>

      <Section title="2. El servicio">
        <p>KiraRoom es un programa en la nube para peluquerías y centros de belleza. Incluye:</p>
        <ul>
          <li>Agenda, profesionales, servicios y fichas de clientes.</li>
          <li>Reservas online en la web del salón y un recepcionista virtual con IA en el chat de esa web.</li>
          <li>Recordatorios por email y, en los planes que lo incluyen, por SMS.</li>
          <li>Caja (TPV), cobros y emisión de facturas con IVA o IGIC.</li>
          <li>Las demás funciones que describa el plan contratado.</li>
        </ul>
        <p>
          El envío de facturas a la Agencia Tributaria o a las diputaciones forales (Verifactu, TicketBAI,
          SII) no está disponible todavía. Mientras tanto, el salón sigue siendo responsable de cumplir esas
          obligaciones por otros medios. Las funciones anunciadas como "próximamente" no forman parte del
          servicio hasta que se lancen.
        </p>
      </Section>

      <Section title="3. Planes, precio y prueba">
        <ul>
          <li>El servicio se contrata por suscripción mensual al precio publicado en la web en el momento de contratar.</li>
          <li>La suscripción se renueva cada mes hasta que el salón la cancela. No hay permanencia.</li>
          <li>Los 14 primeros días son de prueba, sin coste y sin tarjeta. Si al terminar no se ha contratado un plan, la cuenta pasa a modo de solo lectura durante 30 días para que el salón pueda exportar sus datos.</li>
          <li>KiraRoom no cobra comisiones por las reservas ni por los clientes del salón.</li>
        </ul>
      </Section>

      <Section title="4. Obligaciones del salón">
        <ul>
          <li>Dar información veraz y mantenerla al día.</li>
          <li>No usar el servicio para actividades ilícitas ni para acceder a datos de otros salones.</li>
          <li>Custodiar las contraseñas de sus usuarios y dar a cada uno solo el rol que necesita.</li>
          <li>Cumplir las obligaciones legales de su actividad, incluidas las fiscales y las de protección de datos como responsable de los datos de sus clientes.</li>
        </ul>
      </Section>

      <Section title="5. Obligaciones de KiraRoom">
        <ul>
          <li>Prestar el servicio con diligencia y mantenerlo disponible en la medida de lo razonable. No se garantiza un porcentaje mínimo de disponibilidad.</li>
          <li>Avisar con antelación de los mantenimientos que se puedan prever.</li>
          <li>Hacer copias de seguridad diarias de la base de datos.</li>
          <li>Tratar los datos de los clientes del salón según el contrato de encargo del apartado 11.</li>
        </ul>
      </Section>

      <Section title="6. Responsabilidad">
        <p>KiraRoom no responde de:</p>
        <ul>
          <li>Daños indirectos o lucro cesante por la indisponibilidad del servicio.</li>
          <li>Errores derivados de datos incorrectos introducidos por el salón.</li>
          <li>Las respuestas del recepcionista virtual que el salón no haya revisado: es una herramienta automática y puede equivocarse. Las reservas siempre se confirman en el sistema.</li>
        </ul>
        <p>La responsabilidad total de KiraRoom se limita al importe pagado por el salón en los últimos 12 meses.</p>
      </Section>

      <Section title="7. Suspensión y baja">
        <ul>
          <li>KiraRoom puede suspender la cuenta si un pago sigue sin hacerse 7 días después del primer intento fallido, por incumplimiento grave de estos términos o por actividad ilícita.</li>
          <li>El salón puede darse de baja en cualquier momento desde el panel. Tras la baja, la cuenta queda en modo de solo lectura 30 días para exportar los datos; después se suprimen o anonimizan, salvo lo que la ley obligue a conservar (como las facturas).</li>
        </ul>
      </Section>

      <Section title="8. Cambios en el servicio y en estos términos">
        <p>
          KiraRoom avisará por email con al menos 30 días de antelación de cualquier cambio relevante. Si un
          cambio reduce funciones sustanciales, el salón podrá darse de baja sin coste en ese plazo.
        </p>
      </Section>

      <Section title="9. Ley aplicable">
        <p>
          Estos términos se rigen por la ley española. Las controversias se someterán a los juzgados y
          tribunales que correspondan según la ley.
        </p>
      </Section>

      <Section title="10. Contacto">
        <p>
          Para cualquier cuestión sobre el servicio o estos términos: <Pending value={email} label="email de contacto" />.
        </p>
      </Section>

      <Section title="11. Contrato de encargo del tratamiento (art. 28 RGPD)">
        <p>
          El salón es el <strong>responsable</strong> de los datos de sus clientes y KiraRoom, el{" "}
          <strong>encargado</strong> que los trata para prestarle el servicio. Este apartado es el contrato
          que exige el artículo 28 del RGPD.
        </p>
        <ol>
          <li>
            <strong>Objeto y duración.</strong> Tratar los datos de los clientes del salón para prestar el
            servicio descrito en el apartado 2, mientras dure la suscripción.
          </li>
          <li>
            <strong>Datos y personas afectadas.</strong> Clientes del salón y personas que escriben al
            recepcionista virtual: datos identificativos y de contacto, citas, compras, pagos,
            consentimientos y las notas que el salón decida guardar, que pueden incluir datos de salud.
          </li>
          <li>
            <strong>Instrucciones.</strong> KiraRoom trata los datos solo según las instrucciones del salón,
            que son el uso que hace del servicio y estos términos, salvo que la ley le obligue a otra cosa.
          </li>
          <li>
            <strong>Confidencialidad.</strong> Las personas autorizadas por KiraRoom para tratar los datos
            están obligadas a guardar secreto.
          </li>
          <li>
            <strong>Seguridad.</strong> KiraRoom aplica las medidas descritas en la{" "}
            <a href="/legal/privacy">Política de Privacidad</a> (art. 32 RGPD).
          </li>
          <li>
            <strong>Subencargados.</strong> El salón autoriza a KiraRoom a recurrir a los proveedores
            siguientes. KiraRoom avisará de cualquier cambio con antelación, y el salón podrá oponerse y,
            en su caso, darse de baja.
            <ProcessorList />
          </li>
          <li>
            <strong>Derechos de las personas.</strong> KiraRoom ayudará al salón a atender las solicitudes de
            acceso, rectificación, supresión y demás derechos, y le trasladará las que reciba directamente.
          </li>
          <li>
            <strong>Brechas de seguridad.</strong> KiraRoom avisará al salón sin dilación indebida, y en todo
            caso en 48 horas, de cualquier brecha que afecte a sus datos, con la información disponible para
            que el salón pueda cumplir sus propias obligaciones de notificación.
          </li>
          <li>
            <strong>Fin del contrato.</strong> Al terminar, y tras los 30 días de solo lectura para exportar
            los datos, KiraRoom los suprimirá, salvo los que la ley obligue a conservar.
          </li>
          <li>
            <strong>Información y auditoría.</strong> KiraRoom pondrá a disposición del salón la información
            necesaria para demostrar que cumple este contrato.
          </li>
        </ol>
      </Section>
    </main>
  );
}
