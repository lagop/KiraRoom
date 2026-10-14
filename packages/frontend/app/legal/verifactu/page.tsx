"use client";

import { useEffect, useState } from "react";
import apiClient, { VerifactuDeclaration } from "@/lib/api";

/**
 * Declaración responsable del sistema informático de facturación (Orden
 * HAC/1177/2024 art. 15), in the order and wording of the AEAT's own
 * example ("EjemplosDeclaracionResponsable", example 1: SOLO VERI*FACTU).
 * It must be readable inside the software and outside it: this page is
 * public, and linked from the fiscal settings.
 *
 * The name, code and version come from the backend, the same values every
 * billing record carries; the producer's details from its environment.
 */
const PENDING = "[pendiente de completar por la entidad productora]";

export default function VerifactuDeclarationPage() {
  const [d, setD] = useState<VerifactuDeclaration | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    apiClient.getVerifactuDeclaration().then(setD).catch(() => setError(true));
  }, []);

  if (error) return <main style={page}>No se ha podido cargar la declaración responsable.</main>;
  if (!d) return <main style={page}>Cargando…</main>;

  const producerName = d.producer?.name ?? PENDING;
  return (
    <main style={page}>
      <h1 style={{ fontSize: 24, fontWeight: 700, textAlign: "center", marginBottom: 24 }}>
        DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN
      </h1>

      <Item n="1.a" q="Nombre del sistema informático a que se refiere esta declaración responsable:">
        {d.system.name}
      </Item>
      <Item n="1.b" q="Código identificador del sistema informático a que se refiere el apartado a) de esta declaración responsable:">
        {d.system.id}
      </Item>
      <Item n="1.c" q="Identificador completo de la versión concreta del sistema informático a que se refiere esta declaración responsable:">
        {d.system.version}
      </Item>
      <Item
        n="1.d"
        q="Componentes, hardware y software, de que consta el sistema informático a que se refiere esta declaración responsable, junto con una breve descripción de lo que hace dicho sistema informático y de sus principales funcionalidades:"
      >
        <p>
          Se trata de un software de gestión para salones de belleza y peluquerías que se presta como servicio en la
          nube (SaaS): se usa desde el navegador y se ejecuta en servidores gestionados por la entidad productora, con
          una base de datos PostgreSQL. El usuario no instala nada en sus equipos.
        </p>
        <p>
          Entre sus funcionalidades están la agenda de citas, la gestión de clientes, profesionales y servicios, el
          punto de venta y la facturación: expedición de facturas completas y simplificadas, facturas rectificativas
          y anulación de facturas, con el código QR tributario en cada factura.
        </p>
        <p>
          Cada factura genera, en la misma transacción de base de datos que la expide, su registro de facturación,
          encadenado al anterior mediante la huella SHA-256 definida por la Agencia Tributaria, y el sistema lo remite
          automáticamente a la Agencia Tributaria, respetando el control de flujo y reintentando el envío si hay una
          incidencia.
        </p>
        <p>
          Este software permite gestionar de forma independiente la facturación de varios obligados tributarios
          (cada salón), cumpliendo separadamente con la normativa mencionada en el apartado 1.k) de esta declaración
          responsable para cada una de ellas, con su propia cadena de registros y su propio número de instalación,
          como si, en la práctica, se tratara de sistemas informáticos de facturación distintos.
        </p>
      </Item>
      <Item
        n="1.e"
        q="Indicación de si el sistema informático a que se refiere esta declaración responsable se ha producido de tal manera que, a los efectos de cumplir con el Reglamento, solo pueda funcionar exclusivamente como «VERI*FACTU»:"
      >
        {d.system.onlyVerifactu ? "S - Sí" : "N - No"}
      </Item>
      <Item
        n="1.f"
        q="Indicación de si el sistema informático a que se refiere la declaración responsable permite ser usado por varios obligados tributarios o por un mismo usuario para dar soporte a la facturación de varios obligados tributarios:"
      >
        {d.system.multipleTaxpayers ? "S - Sí" : "N - No"}
      </Item>
      <Item
        n="1.g"
        q="Tipos de firma utilizados para firmar los registros de facturación y de evento en el caso de que el sistema informático a que se refiere esta declaración responsable no sea utilizado como «VERI*FACTU»:"
      >
        Dado que se trata de un producto de facturación que solo puede ser utilizado exclusivamente en la modalidad
        de «VERI*FACTU», no se realiza una firma electrónica expresa de los registros de facturación generados, ya que
        la normativa considera que quedan firmados al ser remitidos correctamente a los servicios electrónicos de la
        Agencia Tributaria con la debida autenticación mediante el adecuado certificado electrónico cualificado.
      </Item>
      <Item n="1.h" q="Razón social de la entidad productora del sistema informático a que se refiere esta declaración responsable:">
        {producerName}
      </Item>
      <Item
        n="1.i"
        q="Número de identificación fiscal (NIF) español de la entidad productora del sistema informático a que se refiere esta declaración responsable:"
      >
        {d.producer?.nif ?? PENDING}
      </Item>
      <Item
        n="1.j"
        q="Dirección postal completa de contacto de la entidad productora del sistema informático a que se refiere esta declaración responsable:"
      >
        {d.address ?? PENDING}
      </Item>
      <Item n="1.k" q="">
        La entidad productora del sistema informático a que se refiere esta declaración responsable hace constar que
        dicho sistema informático, en la versión indicada en ella, cumple con lo dispuesto en el artículo 29.2.j) de la
        Ley 58/2003, de 17 de diciembre, General Tributaria, en el Reglamento que establece los requisitos que deben
        adoptar los sistemas y programas informáticos o electrónicos que soporten los procesos de facturación de
        empresarios y profesionales, y la estandarización de formatos de los registros de facturación, aprobado por
        el Real Decreto 1007/2023, de 5 de diciembre, en la Orden HAC/1177/2024, de 17 de octubre, y en la sede
        electrónica de la Agencia Estatal de Administración Tributaria para todo aquello que complete las
        especificaciones de dicha orden.
      </Item>
      <Item n="1.l" q="Fecha y lugar en que la entidad productora de este sistema informático suscribe esta declaración responsable del mismo:">
        {d.signedOn ?? PENDING}. {d.signedAt ?? PENDING}.
      </Item>

      <h2 style={{ fontSize: 18, fontWeight: 700, textAlign: "center", margin: "32px 0 16px" }}>ANEXO</h2>
      {d.contactEmail && (
        <Item n="2.a" q="Otras formas de contacto con la entidad productora del sistema informático a que se refiere esta declaración responsable:">
          Correo electrónico: {d.contactEmail}
        </Item>
      )}
      <Item
        n="2.c"
        q="El sistema informático a que se refiere esta declaración responsable cumple las diferentes especificaciones técnicas y funcionales contenidas en la Orden HAC/1177/2024, de 17 de octubre, y en la sede electrónica de la Agencia Estatal de Administración Tributaria para todo aquello que complete las especificaciones de dicha orden, de la siguiente manera:"
      >
        <ul style={{ paddingLeft: 20, listStyle: "disc" }}>
          <li>
            La expedición de la factura y la generación de su registro de facturación se realizan en una sola unidad
            transaccional de la base de datos: no puede existir una factura sin su registro.
          </li>
          <li>
            Los registros de facturación no pueden modificarse ni borrarse una vez generados: la base de datos lo
            impide. Los errores se corrigen con nuevos registros (subsanación, anulación o factura rectificativa).
          </li>
          <li>
            La remisión a la Agencia Tributaria se hace por el servicio web VERI*FACTU con autenticación mediante
            certificado electrónico cualificado, respetando el tiempo de espera y el número máximo de registros por
            envío. Si no es posible remitir, la facturación continúa, se reintenta el envío al menos una vez cada hora
            y se avisa al usuario de cuántos registros quedan pendientes.
          </li>
        </ul>
      </Item>

      {d.environment !== "production" && (
        <p style={{ marginTop: 24, color: "#92400e", background: "#fffbeb", padding: 12, borderRadius: 6 }}>
          Este servidor envía los registros al entorno de pruebas de la Agencia Tributaria.
        </p>
      )}
    </main>
  );
}

const page: React.CSSProperties = { maxWidth: 760, margin: "0 auto", padding: "32px 16px", lineHeight: 1.6 };

function Item({ n, q, children }: { n: string; q: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <p style={{ fontWeight: 600 }}>
        {n}) {q}
      </p>
      <div style={{ marginTop: 6, paddingLeft: 12 }}>{children}</div>
    </section>
  );
}
