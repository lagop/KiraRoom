export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        Política de Privacidad
      </h1>
      <p style={{ color: "#64748b", marginBottom: 16 }}>
        Última actualización: 17 de julio de 2026
      </p>
      {/* SOURCE OF TRUTH — keep in sync with docs/privacy.md until the
          Sprint 2 legal-sync generator lands. */}
      <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 24, fontStyle: "italic" }}>
        Modelo adaptado de las plantillas y orientaciones publicadas por
        la Agencia Española de Protección de Datos (AEPD) en{" "}
        <a
          href="https://www.aepd.es/es/areas-de-actuacion/internet-y-redes-sociales/modelos-de-politica-de-privacidad"
          target="_blank"
          rel="noopener noreferrer"
        >
          aepd.es
        </a>{" "}
        y de la Guía del RGPD de la AEPD para PYMEs. Esta política cumple
        el deber de información del <strong>Art. 13 del RGPD</strong> y
        se completa con la <a href="/legal/terms">Términos del Servicio</a>{" "}
        y la información sobre cookies que se muestra en el banner de
        consentimiento.
      </p>

      <Section title="1. Responsable del tratamiento">
        <p>
          <strong>KiraRoom SaaS</strong> (en adelante, "KiraRoom"),
          con sede en España, es el responsable del tratamiento de los
          datos personales recabados a través de la plataforma{" "}
          <code>app.kiraroom.com</code>.
        </p>
        <p>
          Para cualquier consulta relativa al tratamiento de datos, puede
          escribir a <code>privacy@kiraroom.com</code>.
        </p>
      </Section>

      <Section title="2. Datos que recabamos">
        <p>Para prestar el servicio de gestión de citas y facturación, recabamos:</p>
        <ul>
          <li>
            <strong>Datos de la cuenta del salón</strong>: nombre del
            negocio, dirección fiscal, NIF/CIF, email del propietario,
            contraseña (almacenada con hash + sal), teléfono de contacto.
          </li>
          <li>
            <strong>Datos de clientes finales</strong>: nombre, apellidos,
            email, teléfono, NIF (opcional), historial de citas y compras,
            consentimientos firmados (RGPD + LSSI).
          </li>
          <li>
            <strong>Datos de facturación</strong>: importes, fechas, NIF
            del receptor, número de serie de facturas. Conservados durante
            <strong>4 años</strong> conforme al Art. 66 del Reglamento
            General Tributario.
          </li>
          <li>
            <strong>Datos fiscales remitidos a la AEAT</strong>: facturas
            enviadas al sistema Verifactu o TicketBAI con su NIF, importe y
            hash de firma. Conservados mientras esté vigente la
            obligación fiscal.
          </li>
        </ul>
      </Section>

      <Section title="3. Finalidad del tratamiento">
        <p>Tratamos los datos personales con las siguientes finalidades:</p>
        <ol>
          <li>Prestar el servicio SaaS contratado (gestión de citas, profesionales, servicios).</li>
          <li>Emitir facturas y remitirlas a la AEAT o a las diputaciones forales.</li>
          <li>Sincronizar asientos contables con Holded o Sage Despachos (sólo si el cliente activa la integración).</li>
          <li>Detectar y prevenir fraude o abuso del servicio.</li>
          <li>Cumplir obligaciones legales (Art. 66 RGGI, Art. 24 LOPDGDD, LSSI).</li>
          <li>Enviar comunicaciones operativas del servicio (no marketing sin consentimiento).</li>
        </ol>
      </Section>

      <Section title="4. Base jurídica del tratamiento">
        <p>Tratamos los datos personales al amparo de:</p>
        <ul>
          <li>
            <strong>Ejecución del contrato</strong> (Art. 6.1.b RGPD): prestar
            el servicio contratado.
          </li>
          <li>
            <strong>Cumplimiento de obligaciones legales</strong> (Art. 6.1.c
            RGPD): facturación, conservación de facturas, llevanza de
            libros contables.
          </li>
          <li>
            <strong>Interés legítimo</strong> (Art. 6.1.f RGPD): detección
            de fraude, seguridad del servicio.
          </li>
        </ul>
      </Section>

      <Section title="5. Destinatarios de los datos">
        <p>Sus datos pueden ser comunicados a:</p>
        <ul>
          <li>
            <strong>AEAT (Agencia Tributaria)</strong> y diputaciones
            forales del País Vasco (Diputación de Bizkaia, Gipuzkoa y
            Álava) para el cumplimiento de obligaciones fiscales
            (Verifactu, TicketBAI, SII).
          </li>
          <li>
            <strong>Holded, Sage Despachos, A3 (Wolters Kluwer), NCS</strong>{" "}
            si el cliente activa la integración contable correspondiente.
          </li>
          <li>
            <strong>Resend</strong> (transaccional de email) y{" "}
            <strong>GlitchTip</strong> (monitorización de errores) —
            ambos con servidores en la UE.
          </li>
        </ul>
        <p>
          KiraRoom no vende datos personales. No se realizan transferencias
          internacionales fuera del EEE.
        </p>
      </Section>

      <Section title="6. Conservación de los datos">
        <ul>
          <li>Datos de cuenta del salón: mientras dure la relación contractual + 5 años (prescripción de acciones contractuales, Art. 1964 CC).</li>
          <li>Datos de clientes finales: mientras el salón mantenga la cuenta + 2 años desde la última interacción.</li>
          <li>Facturas y datos fiscales: <strong>4 años</strong> (Art. 66 RGGI).</li>
          <li>Datos de facturación remitidos a la AEAT: mientras esté vigente la obligación fiscal.</li>
        </ul>
      </Section>

      <Section title="7. Sus derechos (RGPD Arts. 15-22)">
        <p>Como titular de los datos, usted puede ejercer en cualquier momento:</p>
        <ul>
          <li>
            <strong>Acceso</strong> (Art. 15): confirmación de si
            tratamos sus datos y obtención de una copia. Ejercitable vía{" "}
            <code>POST /api/v1/saas/tenants/:id/export</code>{" "}
            (gestionado por el propietario del salón).
          </li>
          <li>
            <strong>Rectificación</strong> (Art. 16): corrección de
            datos inexactos.
          </li>
          <li>
            <strong>Supresión / Derecho al olvido</strong> (Art. 17):
            eliminación de sus datos, salvo excepciones legales (facturas).
            Ejercitable vía{" "}
            <code>POST /api/v1/saas/tenants/:id/anonymize</code>.
          </li>
          <li>
            <strong>Limitación</strong> (Art. 18): tratamiento limitado
            mientras se verifica la exactitud.
          </li>
          <li>
            <strong>Portabilidad</strong> (Art. 20): exportación de sus
            datos en formato estructurado (JSON + CSV).
          </li>
          <li>
            <strong>Oposición</strong> (Art. 21): oposición al
            tratamiento basado en interés legítimo.
          </li>
          <li>
            <strong>Reclamación ante la AEPD</strong> (Art. 77): si
            considera que hemos vulnerado sus derechos.
          </li>
        </ul>
        <p>
          Para ejercer estos derechos:{" "}
          <code>privacy@kiraroom.com</code>. Responderemos en un
          plazo máximo de <strong>30 días</strong>.
        </p>
      </Section>

      <Section title="8. Cookies">
        <p>
          Este sitio utiliza cookies propias y de terceros conforme al{" "}
          <strong>Art. 22.2 de la Ley 34/2002 de Servicios de la Sociedad
          de la Información y de Comercio Electrónico (LSSI)</strong> y
          al RGPD. Al visitar el sitio por primera vez se muestra un
          banner de consentimiento que permite aceptar todas las
          cookies, rechazar las no esenciales, o configurar las
          preferencias por categoría. Una vez expresado el
          consentimiento, el botón flotante "🍪 Configurar cookies"
          (esquina inferior derecha) permite modificar o retirar el
          consentimiento en cualquier momento.
        </p>
        <p>Las categorías de cookies utilizadas son:</p>
        <ul>
          <li>
            <strong>Necesarias</strong> (siempre activas, no requieren
            consentimiento): sesión, autenticación, token CSRF,
            equilibrio de carga.
          </li>
          <li>
            <strong>Preferencias</strong> (opt-in): idioma, tema visual,
            último salón visitado.
          </li>
          <li>
            <strong>Analítica</strong> (opt-in): páginas vistas y
            reporte de errores enviado a GlitchTip (autoalojado en la
            UE).
          </li>
          <li>
            <strong>Marketing</strong> (opt-in, actualmente no
            utilizada): píxeles de adquisición de Meta / Google Ads si
            en el futuro se activan campañas de pago.
          </li>
        </ul>
        <p>
          El consentimiento se almacena localmente en su navegador bajo
          la clave <code>kira-cookie-consent-v2</code>. Puede retirarlo
          en cualquier momento desde el botón "🍪 Configurar cookies"
          del pie de página.
        </p>
      </Section>

      <Section title="9. Medidas de seguridad">
        <p>
          Aplicamos las medidas del Art. 32 RGPD:
        </p>
        <ul>
          <li>Cifrado AES-256-GCM para datos personales en reposo.</li>
          <li>Tokens JWT firmados con HS256 (recomendamos HS256 con rotación de claves).</li>
          <li>Hash + sal con bcrypt en contraseñas.</li>
          <li>Backups diarios cifrados con retención 30 días hot + 1 año frío.</li>
          <li>Limitación de tasa (100 req/min/IP) para prevenir abuso.</li>
          <li>Logs de auditoría firmados (inmutables) para todas las acciones SaaS-owner.</li>
          <li>WAF/CORS restrictivo en producción.</li>
        </ul>
      </Section>

      <Section title="10. Cambios a esta política">
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
