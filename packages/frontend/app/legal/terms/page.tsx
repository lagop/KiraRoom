export default function TermsPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        Términos del Servicio
      </h1>
      <p style={{ color: "#64748b", marginBottom: 16 }}>
        Última actualización: 17 de julio de 2026
      </p>

      <Section title="1. Aceptación">
        <p>
          Al crear una cuenta o utilizar el servicio SaaS KiraStudio,
          acepta estos Términos del Servicio. Si no está de acuerdo, no
          use el servicio.
        </p>
      </Section>

      <Section title="2. Descripción del servicio">
        <p>
          KiraStudio es una plataforma SaaS de gestión de citas,
          profesionales, clientes y facturación para negocios de belleza y
          bienestar en España. Incluye:
        </p>
        <ul>
          <li>Agenda de citas y gestión de profesionales y servicios.</li>
          <li>Emisión de facturas conformes a la normativa española.</li>
          <li>Remisión a la AEAT (Verifactu, SII) o a las diputaciones forales (TicketBAI).</li>
          <li>Sincronización opcional con software contable (Holded, Sage, A3, NCS).</li>
          <li>Recordatorios automáticos por email/WhatsApp.</li>
          <li>Panel SaaS para multi-tenant y multi-localización.</li>
        </ul>
      </Section>

      <Section title="3. Planes y precios">
        <p>
          El servicio se ofrece bajo suscripción mensual. Los precios
          vigentes están publicados en <code>/dashboard/billing</code>.
          Las suscripciones se renuevan automáticamente al final de cada
          período salvo que el cliente cancele.
        </p>
        <p>
          Durante el período de prueba (14 días), todas las funciones
          están disponibles sin coste. Transcurrido el período, la cuenta
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

      <Section title="5. Obligaciones de KiraStudio">
        <p>KiraStudio se compromete a:</p>
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
          KiraStudio no será responsable de:
        </p>
        <ul>
          <li>Daños indirectos o lucro cesante derivados de la indisponibilidad del servicio.</li>
          <li>Errores en los datos fiscales si el cliente los facilitó incorrectamente (NIF mal escrito, dirección, etc.).</li>
          <li>Reclamaciones de la AEAT derivadas de una facturación incorrecta por datos erróneos del cliente.</li>
          <li>Cumplimiento de obligaciones legales específicas del sector del cliente que no estén expresamente incluidas en el servicio.</li>
        </ul>
        <p>
          La responsabilidad agregada de KiraStudio queda limitada al
          importe de las tarifas satisfechas por el cliente en los
          últimos <strong>12 meses</strong>.
        </p>
      </Section>

      <Section title="7. Suspensión y terminación">
        <p>
          KiraStudio puede suspender o terminar el servicio en caso de:
        </p>
        <ul>
          <li>Incumplimiento de pago tras 7 días desde el segundo aviso.</li>
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
          KiraStudio puede modificar el servicio previa notificación con
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
