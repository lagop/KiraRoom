import type { Metadata } from "next";
import { CONVERSATION_RETENTION_MONTHS, SUB_PROCESSORS } from "@/lib/salon-legal";

// Its own title: it showed the root layout's, in English.
export const metadata: Metadata = { title: "Términos del servicio · KiraRoom" };

export default function TermsPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        Términos del Servicio
      </h1>
      <p style={{ color: "#64748b", marginBottom: 16 }}>
        Última actualización: 4 de noviembre de 2026
      </p>

      <Section title="1. Aceptación">
        <p>
          Al crear una cuenta o utilizar el servicio SaaS KiraRoom,
          acepta estos Términos del Servicio. Si no está de acuerdo, no
          use el servicio.
        </p>
      </Section>

      <Section title="2. Descripción del servicio">
        <p>
          KiraRoom es una plataforma SaaS de gestión de citas,
          profesionales, clientes y facturación para negocios de belleza y
          bienestar en España. Incluye:
        </p>
        <ul>
          <li>Agenda de citas y gestión de profesionales y servicios.</li>
          <li>Emisión de facturas con numeración correlativa y facturas rectificativas.</li>
          <li>Sincronización opcional con software contable (Holded, Sage, A3, NCS).</li>
          <li>Recordatorios automáticos por email/WhatsApp.</li>
          <li>Panel SaaS para multi-tenant y multi-localización.</li>
        </ul>
      </Section>

      <Section title="3. Planes y precios">
        <p>
          El servicio se ofrece bajo suscripción mensual. Los precios
          vigentes están publicados en <code>/dashboard/billing</code> y son
          el precio final, sin impuestos añadidos.
          Las suscripciones se renuevan automáticamente al final de cada
          período salvo que el cliente cancele.
        </p>
        <p>
          Durante el período de prueba (14 días) están disponibles sin
          coste las funciones del plan Pro, con 500 mensajes de la
          recepcionista IA. Transcurrido el período, la cuenta
          pasa a modo lectura si no se ha confirmado un método de pago.
        </p>
      </Section>

      <Section title="4. Obligaciones del cliente">
        <p>El cliente se compromete a:</p>
        <ul>
          <li>Proporcionar información veraz y mantenerla actualizada.</li>
          <li>No usar el servicio para actividades ilícitas, fraudulentas o que vulneren derechos de terceros.</li>
          <li>No intentar acceder a datos de otros tenants del sistema.</li>
          <li>Respetar los límites técnicos (rate limiting, almacenamiento) contratados.</li>
          <li>Realizar las obligaciones legales (fiscales, laborales, RGPD) que correspondan a su actividad.</li>
        </ul>
      </Section>

      <Section title="5. Obligaciones de KiraRoom">
        <p>KiraRoom se compromete a:</p>
        <ul>
          <li>Mantener el servicio disponible al menos el 99% del tiempo medido mensualmente, salvo mantenimientos programados (con aviso de 48h).</li>
          <li>Realizar backups diarios cifrados con posibilidad de restauración puntual (WAL archiving).</li>
          <li>Conservar las facturas durante 4 años conforme al Art. 66 RGGI.</li>
          <li>Cumplir las obligaciones del RGPD y la LOPDGDD, incluyendo atender las solicitudes de acceso, rectificación y supresión en plazo de 30 días.</li>
          <li>Notificar al cliente cualquier incidente de seguridad con impacto en sus datos en un plazo máximo de 72 horas.</li>
        </ul>
      </Section>

      <Section title="6. Limitación de responsabilidad">
        <p>
          KiraRoom no será responsable de:
        </p>
        <ul>
          <li>Daños indirectos o lucro cesante derivados de la indisponibilidad del servicio.</li>
          <li>Errores en los datos fiscales si el cliente los facilitó incorrectamente (NIF mal escrito, dirección, etc.).</li>
          <li>Reclamaciones de la AEAT derivadas de una facturación incorrecta por datos erróneos del cliente.</li>
          <li>Cumplimiento de obligaciones legales específicas del sector del cliente que no estén expresamente incluidas en el servicio.</li>
        </ul>
        <p>
          La responsabilidad agregada de KiraRoom queda limitada al
          importe de las tarifas satisfechas por el cliente en los
          últimos <strong>12 meses</strong>.
        </p>
      </Section>

      <Section title="7. Suspensión y terminación">
        <p>
          KiraRoom puede suspender o terminar el servicio en caso de:
        </p>
        <ul>
          <li>Impago que siga pendiente 7 días después del primer cobro fallido.</li>
          <li>Incumplimiento material de estos Términos.</li>
          <li>Actividad fraudulenta o ilegal detectada.</li>
        </ul>
        <p>
          El cliente puede cancelar el servicio en cualquier momento
          desde <code>/dashboard/billing</code>. Tras la cancelación:
        </p>
        <ul>
          <li>Acceso de lectura durante 30 días para exportar datos.</li>
          <li>Anonimización de PII tras 60 días de inactividad conforme a RGPD.</li>
          <li>Conservación de facturas 4 años conforme a la normativa fiscal.</li>
        </ul>
      </Section>

      <Section title="8. Modificaciones del servicio">
        <p>
          KiraRoom puede modificar el servicio previa notificación con
          al menos <strong>30 días</strong> de antelación. Las
          modificaciones que reduzcan funcionalidades sustanciales
          permitirán al cliente cancelar sin penalización durante esos 30
          días.
        </p>
      </Section>

      <Section title="9. Ley aplicable y jurisdicción">
        <p>
          Estos Términos se rigen por la legislación española y europea
          aplicable. Para cualquier controversia, las partes se someten
          a los Juzgados y Tribunales de la ciudad del domicilio del
          cliente, sin perjuicio de los derechos del consumidor ante los
          tribunales de su domicilio.
        </p>
        <p>
          Conforme al Reglamento (UE) 524/2013, los consumidores de la UE
          pueden acceder a la plataforma de resolución de litigios en
          línea en <code>ec.europa.eu/consumers/odr</code>.
        </p>
      </Section>

      <Section title="10. Cambios a estos términos">
        <p>
          Cualquier cambio material se notificará por email al propietario
          del salón con al menos <strong>30 días</strong> de antelación y
          se publicará una nueva versión en esta URL.
        </p>
      </Section>

      <Section title="11. Encargo del tratamiento (artículo 28 RGPD)">
        <p>
          De los datos personales de los clientes del salón (sus datos de
          contacto, sus citas, sus mensajes con la recepcionista virtual, sus
          elecciones de avisos y promociones), el <strong>salón es el
          responsable del tratamiento</strong> y KiraRoom el{" "}
          <strong>encargado del tratamiento</strong>. Al aceptar estos
          Términos, el salón y KiraRoom acuerdan este encargo, con el
          contenido del artículo 28.3 del RGPD:
        </p>
        <ul>
          <li>
            <strong>Objeto y duración</strong>: prestar el servicio contratado
            (agenda, web de reservas, widget, recepcionista virtual, avisos,
            facturación) mientras dure la suscripción y el período de lectura
            posterior.
          </li>
          <li>
            <strong>Instrucciones</strong>: KiraRoom trata los datos solo para
            prestar el servicio y siguiendo las instrucciones del salón, que
            son las que da al configurarlo y usarlo. No los usa para fines
            propios ni los vende.
          </li>
          <li>
            <strong>Confidencialidad</strong>: las personas autorizadas por
            KiraRoom para tratar los datos están obligadas a guardar secreto.
          </li>
          <li>
            <strong>Seguridad</strong>: KiraRoom aplica las medidas del
            artículo 32 RGPD descritas en la política de privacidad.
          </li>
          <li>
            <strong>Subencargados</strong>: el salón autoriza a KiraRoom a
            recurrir a estos proveedores:{" "}
            {SUB_PROCESSORS.map((sp) => sp.name).join(", ")}. KiraRoom
            avisará al salón con antelación de cualquier cambio en esta lista,
            para que pueda oponerse, y les impone las mismas obligaciones de
            protección de datos.
          </li>
          <li>
            <strong>Derechos de los interesados</strong>: KiraRoom ayuda al
            salón a atender las solicitudes de acceso, rectificación,
            supresión, oposición, limitación y portabilidad de sus clientes
            (el panel permite exportar y anonimizar los datos de un cliente).
          </li>
          <li>
            <strong>Brechas de seguridad</strong>: KiraRoom avisará al salón
            sin dilación indebida, y en todo caso en 72 horas, de cualquier
            brecha que afecte a sus datos, con la información que necesite
            para notificarla.
          </li>
          <li>
            <strong>Fin del encargo</strong>: al terminar el servicio, el
            salón puede exportar sus datos durante el período de lectura;
            después KiraRoom los suprime, salvo los que la ley obligue a
            conservar. Las conversaciones de la recepcionista virtual se
            borran a los {CONVERSATION_RETENTION_MONTHS} meses.
          </li>
          <li>
            <strong>Auditoría</strong>: KiraRoom pondrá a disposición del
            salón la información necesaria para demostrar el cumplimiento de
            estas obligaciones.
          </li>
        </ul>
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}
