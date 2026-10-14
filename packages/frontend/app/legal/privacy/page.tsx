import { Identification, LAST_UPDATED, LEGAL_ENTITY, Pending, ProcessorList, Section } from "../legal-entity";

/**
 * Privacy policy (RGPD art. 13).
 *
 * Rewritten on 1 October 2026 to say what the service does. The previous
 * text named no company, used the .com domain, stated that no data left the
 * EEA (the receptionist chat is processed in the US), and promised
 * encryption at rest, backups kept a year, signed audit logs and a rate
 * limit that did not exist. Keep it to facts; review with a lawyer.
 */
export default function PrivacyPage() {
  const email = LEGAL_ENTITY.email;
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Política de Privacidad</h1>
      <p style={{ color: "#64748b", marginBottom: 24 }}>Última actualización: {LAST_UPDATED}</p>

      <Section title="1. Quién trata los datos">
        <Identification />
        <p>Según de quién sean los datos, KiraRoom actúa en dos papeles distintos:</p>
        <ul>
          <li>
            <strong>Responsable del tratamiento</strong> de los datos de los salones que contratan el
            servicio y de sus usuarios (dueños, administradores y personal): cuenta, facturación de la
            suscripción y uso del servicio.
          </li>
          <li>
            <strong>Encargado del tratamiento</strong> de los datos de los clientes de cada salón. El
            responsable es el salón: decide qué datos guarda y para qué, y es quien atiende a sus clientes.
            KiraRoom los trata solo para prestarle el servicio, según el contrato de encargo del apartado 11
            de los <a href="/legal/terms">Términos del Servicio</a>.
          </li>
        </ul>
      </Section>

      <Section title="2. Qué datos tratamos">
        <ul>
          <li>
            <strong>Cuenta del salón</strong>: nombre del negocio, dirección, NIF, nombre, email y teléfono de
            sus usuarios, y la contraseña, guardada solo como hash (bcrypt).
          </li>
          <li>
            <strong>Clientes del salón</strong>: nombre, teléfono, email (opcional), historial de citas,
            compras y pagos, consentimientos firmados, y las notas que el salón escriba. Si el salón anota
            alergias u otros datos de salud, son categorías especiales de datos (art. 9 RGPD) y es el salón
            quien debe contar con la base que lo permita.
          </li>
          <li>
            <strong>Conversaciones con el recepcionista virtual</strong>: los mensajes que una persona
            escribe en el chat de la web del salón, y los datos que da para reservar (nombre, teléfono,
            email).
          </li>
          <li>
            <strong>Facturación</strong>: facturas que el salón emite con KiraRoom (importes, fechas, NIF del
            destinatario) y facturas de la suscripción a KiraRoom.
          </li>
          <li>
            <strong>Datos técnicos</strong>: dirección IP y registros de acceso, para la seguridad del
            servicio.
          </li>
        </ul>
      </Section>

      <Section title="3. Para qué">
        <ol>
          <li>Prestar el servicio contratado: agenda, reservas online, clientes, cobros, facturas, recordatorios y recepcionista virtual.</li>
          <li>Cobrar la suscripción y emitir sus facturas.</li>
          <li>Mantener la seguridad del servicio y prevenir abusos.</li>
          <li>Cumplir obligaciones legales, como la conservación de facturas.</li>
          <li>Enviar avisos del servicio. No enviamos publicidad sin consentimiento.</li>
        </ol>
      </Section>

      <Section title="4. Base jurídica">
        <ul>
          <li><strong>Ejecución del contrato</strong> (art. 6.1.b RGPD): prestar el servicio contratado.</li>
          <li><strong>Obligación legal</strong> (art. 6.1.c RGPD): facturación y conservación de facturas.</li>
          <li><strong>Interés legítimo</strong> (art. 6.1.f RGPD): seguridad del servicio y prevención del fraude.</li>
          <li><strong>Consentimiento</strong> (art. 6.1.a RGPD): almacenamiento no necesario en el navegador (preferencias y analítica), cuando se pide.</li>
        </ul>
      </Section>

      <Section title="5. Quién más trata los datos">
        <p>
          Estos proveedores tratan datos por cuenta de KiraRoom, cada uno solo para su función y con un
          contrato que los obliga a protegerlos:
        </p>
        <ProcessorList />
        <p>
          Algunos están en Estados Unidos, así que hay <strong>transferencias internacionales</strong>. Se
          hacen con las cláusulas contractuales tipo aprobadas por la Comisión Europea (art. 46 RGPD).
          KiraRoom no vende datos personales.
        </p>
      </Section>

      <Section title="6. Cuánto tiempo">
        <ul>
          <li>Cuenta del salón: mientras dure el contrato y, después, el plazo de prescripción de las acciones derivadas de él.</li>
          <li>Datos de clientes del salón: mientras el salón mantenga la cuenta o hasta que pida suprimirlos. Al terminar el contrato se devuelven o suprimen como dice el contrato de encargo.</li>
          <li>Facturas: el plazo que exige la normativa fiscal (en general, 4 años).</li>
          <li>Copias de seguridad: se renuevan a diario y se conservan como máximo 400 días.</li>
        </ul>
      </Section>

      <Section title="7. Sus derechos">
        <p>
          Puede pedir el acceso, la rectificación, la supresión, la limitación, la portabilidad y oponerse al
          tratamiento (arts. 15 a 22 RGPD) escribiendo a <Pending value={email} label="email de contacto" />.
          Responderemos en el plazo de un mes.
        </p>
        <p>
          Si es cliente de un salón, el responsable de sus datos es ese salón: diríjase a él. Si nos escribe a
          nosotros, se lo trasladaremos y le ayudaremos a responder.
        </p>
        <p>
          Si cree que no se han respetado sus derechos, puede reclamar ante la Agencia Española de Protección
          de Datos (<a href="https://www.aepd.es" target="_blank" rel="noopener noreferrer">aepd.es</a>).
        </p>
      </Section>

      <Section title="8. Cookies y almacenamiento en el navegador">
        <p>
          KiraRoom guarda en el navegador lo necesario para funcionar: la sesión iniciada, el idioma y las
          preferencias de consentimiento. Para eso no hace falta consentimiento (art. 22.2 LSSI).
        </p>
        <p>
          Dentro del panel, un aviso permite aceptar o rechazar el almacenamiento de preferencias y de
          analítica, y cambiar la decisión después. Hoy no se usan cookies de publicidad ni de terceros con
          fines de marketing.
        </p>
      </Section>

      <Section title="9. Seguridad">
        <p>Medidas aplicadas (art. 32 RGPD):</p>
        <ul>
          <li>Conexiones cifradas (HTTPS con HSTS).</li>
          <li>Contraseñas guardadas solo como hash con bcrypt; enlaces de recuperación de un solo uso que caducan en una hora.</li>
          <li>Claves y tokens de terceros (canales, certificados) cifrados con AES-256-GCM.</li>
          <li>Cada salón solo accede a sus propios datos, y cada usuario según su rol.</li>
          <li>Límites de peticiones frente a abusos.</li>
          <li>Copias de seguridad diarias de la base de datos.</li>
          <li>Registro de las acciones del equipo de la plataforma sobre cuentas de salones.</li>
        </ul>
      </Section>

      <Section title="10. Cambios">
        <p>
          Si cambiamos esta política de forma relevante, lo avisaremos por email a los salones con antelación
          y publicaremos la nueva versión en esta página.
        </p>
      </Section>
    </main>
  );
}
