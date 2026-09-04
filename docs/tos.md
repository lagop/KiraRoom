# Términos del Servicio — KiraStudio

> ⚠️ **SOURCE OF TRUTH**: Este fichero **NO** se edita a mano. La versión canónica es la página React en [`packages/frontend/app/legal/terms/page.tsx`](../packages/frontend/app/legal/terms/page.tsx). Si necesitas cambiar el texto, edita esa página y regenera este markdown con `node scripts/legal-sync.ts` (TODO Sprint 2 — hasta entonces, sincroniza manualmente los dos ficheros tras cada cambio).

> Última actualización: 17 de julio de 2026.
>
> Estos Términos regulan el uso del servicio SaaS KiraStudio por parte del propietario del salón (en adelante, "el Cliente"). Se complementan con la [Política de Privacidad](privacy.md).

Esta versión también está publicada en formato web en [`packages/frontend/app/legal/terms/page.tsx`](../packages/frontend/app/legal/terms/page.tsx). El documento en este directorio es la fuente canónica para auditoría legal.

---

## 1. Aceptación

Al crear una cuenta o utilizar el servicio SaaS KiraStudio, acepta estos Términos del Servicio. Si no está de acuerdo, no use el servicio.

## 2. Descripción del servicio

KiraStudio es una plataforma SaaS de gestión de citas, profesionales, clientes y facturación para negocios de belleza y bienestar en España. Incluye:

- Agenda de citas y gestión de profesionales y servicios.
- Emisión de facturas conformes a la normativa española.
- Remisión a la AEAT (Verifactu, SII) o a las diputaciones forales (TicketBAI).
- Sincronización opcional con software contable (Holded, Sage, A3, NCS).
- Recordatorios automáticos por email/WhatsApp.
- Panel SaaS para multi-tenant y multi-localización.

## 3. Planes y precios

El servicio se ofrece bajo suscripción mensual. Los precios vigentes están publicados en `/dashboard/billing`. Las suscripciones se renuevan automáticamente al final de cada período salvo que el cliente cancele.

Durante el período de prueba (14 días), todas las funciones están disponibles sin coste. Transcurrido el período, la cuenta pasa a modo lectura si no se ha confirmado un método de pago.

## 4. Obligaciones del cliente

El cliente se compromete a:

- Proporcionar información veraz y mantenerla actualizada.
- No usar el servicio para actividades ilícitas, fraudulentas o que vulneren derechos de terceros.
- No intentar acceder a datos de otros tenants del sistema.
- Respetar los límites técnicos (rate limiting, almacenamiento) contratados.
- Realizar las obligaciones legales (fiscales, laborales, RGPD) que correspondan a su actividad.

## 5. Obligaciones de KiraStudio

KiraStudio se compromete a:

- Mantener el servicio disponible al menos el 99% del tiempo medido mensualmente, salvo mantenimientos programados (con aviso de 48h).
- Realizar backups diarios cifrados con posibilidad de restauración puntual (WAL archiving).
- Conservar las facturas durante 4 años conforme al Art. 66 RGGI.
- Cumplir las obligaciones del RGPD y la LOPDGDD, incluyendo atender las solicitudes de acceso, rectificación y supresión en plazo de 30 días.
- Notificar al cliente cualquier incidente de seguridad con impacto en sus datos en un plazo máximo de 72 horas.

## 6. Limitación de responsabilidad

KiraStudio no será responsable de:

- Daños indirectos o lucro cesante derivados de la indisponibilidad del servicio.
- Errores en los datos fiscales si el cliente los facilitó incorrectamente (NIF mal escrito, dirección, etc.).
- Reclamaciones de la AEAT derivadas de una facturación incorrecta por datos erróneos del cliente.
- Cumplimiento de obligaciones legales específicas del sector del cliente que no estén expresamente incluidas en el servicio.

La responsabilidad agregada de KiraStudio queda limitada al importe de las tarifas satisfechas por el cliente en los últimos **12 meses**.

## 7. Suspensión y terminación

KiraStudio puede suspender o terminar el servicio en caso de:

- Incumplimiento de pago tras 7 días desde el segundo aviso.
- Incumplimiento material de estos Términos.
- Actividad fraudulenta o ilegal detectada.

El cliente puede cancelar el servicio en cualquier momento desde `/dashboard/billing`. Tras la cancelación:

- Acceso de lectura durante 30 días para exportar datos.
- Anonimización de PII tras 60 días de inactividad conforme a RGPD.
- Conservación de facturas 4 años conforme a la normativa fiscal.

## 8. Modificaciones del servicio

KiraStudio puede modificar el servicio previa notificación con al menos **30 días** de antelación. Las modificaciones que reduzcan funcionalidades sustanciales permitirán al cliente cancelar sin penalización durante esos 30 días.

## 9. Ley aplicable y jurisdicción

Estos Términos se rigen por la legislación española y europea aplicable. Para cualquier controversia, las partes se someten a los Juzgados y Tribunales de la ciudad del domicilio del cliente, sin perjuicio de los derechos del consumidor ante los tribunales de su domicilio.

Conforme al Reglamento (UE) 524/2013, los consumidores de la UE pueden acceder a la plataforma de resolución de litigios en línea en `ec.europa.eu/consumers/odr`.

## 10. Cambios a estos términos

Cualquier cambio material se notificará por email al propietario del salón con al menos **30 días** de antelación y se publicará una nueva versión en esta URL.

---

*Documento generado como parte del Sprint 1 del plan [`1784285888087-zero-budget-launch-roadmap.md`](../../Users/operd/.local/share/kilo/plans/1784285888087-zero-budget-launch-roadmap.md), Workstream 1.4 (GDPR minimal compliance).*