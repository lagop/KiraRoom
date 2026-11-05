import type { Metadata } from "next";
import {
  CONVERSATION_RETENTION_MONTHS,
  KIRAROOM_DOMAIN,
  KIRAROOM_OWNER,
  KIRAROOM_PRIVACY_EMAIL,
  SUB_PROCESSORS,
  subProcessorText,
} from "@/lib/salon-legal";

// Its own title: it showed the root layout's, in English.
export const metadata: Metadata = { title: "Política de privacidad · KiraRoom" };

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>
        Política de Privacidad
      </h1>
      <p style={{ color: "#64748b", marginBottom: 16 }}>
        Última actualización: 5 de noviembre de 2026
      </p>
      {/* This page is the only source of the privacy policy: docs/privacy.md
          just points here. Keep it, the terms and SUB_PROCESSORS
          (lib/salon-legal.ts) telling the same story. */}
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
        se completa con los <a href="/legal/terms">Términos del Servicio</a>.
      </p>

      <Section title="1. Responsable del tratamiento">
        <p>
          <strong>KiraRoom</strong> (en adelante, "KiraRoom") es una
          plataforma titularidad de <strong>{KIRAROOM_OWNER.name}</strong>,
          con NIF {KIRAROOM_OWNER.nif} y domicilio en {KIRAROOM_OWNER.address}.
          Es el responsable del tratamiento de los datos de las cuentas de
          los salones que usan la plataforma <code>{KIRAROOM_DOMAIN}</code>.
          Más datos en el <a href="/legal/aviso-legal">Aviso legal</a>.
        </p>
        <p>
          De los datos de los <strong>clientes de cada salón</strong> (sus
          citas, sus mensajes en el chat, sus avisos), el responsable es el
          salón, y KiraRoom los trata por su cuenta como encargado del
          tratamiento (art. 28 RGPD). Cada salón tiene su propia política de
          privacidad, enlazada desde su web de reservas.
        </p>
        <p>
          Para cualquier consulta relativa al tratamiento de datos, puede
          escribir a <code>{KIRAROOM_PRIVACY_EMAIL}</code>.
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
            <strong>Datos del equipo del salón</strong>: nombre, email,
            teléfono y rol de las personas que usan el panel, y las
            acciones que hacen en él (registro de actividad).
          </li>
          <li>
            <strong>Datos de clientes finales</strong>: nombre, apellidos,
            email, teléfono, NIF (opcional), historial de citas y compras,
            consentimientos registrados (RGPD + LSSI).
          </li>
          <li>
            <strong>Conversaciones con la recepcionista virtual</strong>:
            lo que escribe el cliente del salón y lo que se le responde, por
            la web del salón o por los canales que el salón conecte.
          </li>
          <li>
            <strong>Dirección IP y fecha de aceptación</strong>: al aceptar
            los Términos y esta política se guardan la versión aceptada, la
            fecha y la IP desde la que se acepta, como prueba del
            consentimiento. Los servidores también registran datos técnicos
            de las visitas (IP, fecha y página) para la seguridad del
            servicio.
          </li>
          <li>
            <strong>Correos que nos envías</strong>: si escribes a{" "}
            <code>{KIRAROOM_PRIVACY_EMAIL}</code>, guardamos tu mensaje y tu
            dirección para atender tu consulta.
          </li>
          <li>
            <strong>Datos de facturación</strong>: importes, fechas, NIF
            del receptor, número de serie de facturas. Conservados durante
            <strong>4 años</strong> conforme al Art. 66 del Reglamento
            General Tributario.
          </li>
          <li>
            <strong>Datos fiscales de las facturas</strong>: NIF, importe y
            fecha de cada factura emitida, conservados mientras esté vigente
            la obligación fiscal. Hoy KiraRoom no envía las facturas a la
            AEAT ni a las diputaciones forales (Verifactu, TicketBAI): ese
            envío todavía no está disponible.
          </li>
        </ul>
      </Section>

      <Section title="3. Finalidad del tratamiento">
        <p>Tratamos los datos personales con las siguientes finalidades:</p>
        <ol>
          <li>Prestar el servicio SaaS contratado (gestión de citas, profesionales, servicios).</li>
          <li>Emitir facturas (el envío a la AEAT o a las diputaciones forales todavía no está disponible).</li>
          <li>Sincronizar asientos contables con Holded (sólo si el cliente activa la integración).</li>
          <li>Detectar y prevenir fraude o abuso del servicio, incluida la comprobación anti-robots del alta.</li>
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
            Álava) solo cuando una obligación legal lo exija. KiraRoom no
            les envía las facturas de forma automática (Verifactu,
            TicketBAI, SII): ese envío todavía no está disponible.
          </li>
        </ul>
        <p>
          Y a los proveedores en los que KiraRoom se apoya para prestar el
          servicio (encargados y subencargados del tratamiento):
        </p>
        <ul>
          {SUB_PROCESSORS.map((s) => (
            <li key={s.name}>
              <strong>{s.name}</strong>: {subProcessorText(s)}
            </li>
          ))}
        </ul>
        <p>
          Los mensajes que llegan por Telegram, WhatsApp, Messenger o
          Instagram pasan además por los servidores de esas plataformas,
          que tratan los datos según sus propias condiciones.
        </p>
        <p>
          KiraRoom no vende datos personales. Algunos de estos proveedores
          están en Estados Unidos: esas transferencias internacionales se
          hacen con las garantías del RGPD (Marco de Privacidad de Datos
          UE-EE. UU. o cláusulas contractuales tipo de la Comisión Europea).
        </p>
      </Section>

      <Section title="6. Conservación de los datos">
        <ul>
          <li>Datos de cuenta del salón y de su equipo: mientras dure la relación contractual.</li>
          <li>Datos de clientes finales: mientras el salón mantenga la cuenta.</li>
          <li>
            Conversaciones con la recepcionista virtual: se borran cuando
            llevan {CONVERSATION_RETENTION_MONTHS} meses sin actividad.
          </li>
          <li>Versión aceptada, fecha e IP de la aceptación de los Términos: mientras dure la cuenta; al anonimizarla se borra la IP y queda constancia de la aceptación.</li>
          <li>Correos que nos envías: el tiempo necesario para atender tu consulta.</li>
          <li>Facturas y datos fiscales: <strong>4 años</strong> (Art. 66 RGGI).</li>
          <li>Registros fiscales de las facturas: mientras esté vigente la obligación fiscal.</li>
        </ul>
        <p>
          <strong>Si un salón cancela, termina su prueba o borra su cuenta</strong>:
          durante <strong>30 días</strong> la cuenta queda en solo lectura para
          que pueda exportar sus datos. <strong>60 días en total</strong>{" "}
          después del final se anonimizan los datos personales del salón, de
          su equipo y de sus clientes (le avisamos por email 7 días antes).
          Las facturas emitidas y sus datos fiscales no se anonimizan: se
          conservan por obligación legal.
        </p>
        <p>
          <strong>Copias de seguridad</strong>: guardamos una copia diaria
          cifrada de la base de datos fuera del servidor. Las copias diarias
          se conservan 35 días, y la del día 1 de cada mes, 400 días (unos
          13 meses). Un dato anonimizado o borrado puede seguir en esas copias
          hasta que caduquen; se usan solo para recuperar el servicio ante un
          fallo.
        </p>
      </Section>

      <Section title="7. Sus derechos (RGPD Arts. 15-22)">
        <p>Como titular de los datos, usted puede ejercer en cualquier momento:</p>
        <ul>
          <li>
            <strong>Acceso</strong> (Art. 15): confirmación de si
            tratamos sus datos y obtención de una copia.
          </li>
          <li>
            <strong>Rectificación</strong> (Art. 16): corrección de
            datos inexactos.
          </li>
          <li>
            <strong>Supresión / Derecho al olvido</strong> (Art. 17):
            eliminación de sus datos, salvo excepciones legales (facturas).
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
          Para ejercer estos derechos, escriba a{" "}
          <code>{KIRAROOM_PRIVACY_EMAIL}</code>. Responderemos en un
          plazo máximo de <strong>un mes</strong>. Si es cliente de un
          salón, puede dirigirse directamente a él (sus datos de contacto
          están en su política de privacidad): el salón decide sobre sus
          datos y KiraRoom le ayuda a atender su solicitud.
        </p>
      </Section>

      <Section title="8. Cookies">
        <p>
          Las webs de reservas de los salones y estas páginas legales no
          usan cookies de analítica ni de publicidad: solo guardan en el
          navegador lo necesario para funcionar (por ejemplo, la
          conversación del chat abierta).
        </p>
        <p>
          En el panel de los salones (tras iniciar sesión) se usan las
          cookies y el almacenamiento necesarios para la sesión y la
          seguridad. Las demás categorías (preferencias, analítica) solo se
          usan si el usuario las acepta en el aviso de cookies del panel,
          que permite rechazarlas y cambiar la elección en cualquier
          momento desde &quot;Configurar cookies&quot;. Hoy no se usa
          ninguna cookie de publicidad.
        </p>
        <p>
          Al crear la cuenta, recuperar la contraseña o tras varios intentos
          fallidos de inicio de sesión, se carga la comprobación anti-robots
          de Cloudflare (Turnstile), mientras esté activada.
        </p>
      </Section>

      <Section title="9. Medidas de seguridad">
        <p>
          Aplicamos las medidas del Art. 32 RGPD:
        </p>
        <ul>
          <li>
            Los secretos que guardamos (códigos de doble factor, claves y
            tokens de conexión con otros servicios, certificados) se cifran
            en la base de datos con AES-256-GCM.
          </li>
          <li>Las contraseñas se guardan con hash + sal (bcrypt), nunca en claro.</li>
          <li>
            Copia diaria de la base de datos, comprobada, cifrada y guardada
            fuera del servidor (ver el apartado 6). Se restaura a la copia
            diaria más reciente; no hay restauración a un instante exacto.
          </li>
          <li>
            Límite de peticiones por dirección (300 por minuto) y límites más
            estrictos en el inicio de sesión, el alta y la recuperación de la
            contraseña, para prevenir abusos.
          </li>
          <li>Registro de auditoría de las acciones del administrador de la plataforma.</li>
          <li>CORS restrictivo en producción.</li>
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
