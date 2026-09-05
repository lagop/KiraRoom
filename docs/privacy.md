# Política de Privacidad — KiraRoom

> ⚠️ **SOURCE OF TRUTH**: Este fichero **NO** se edita a mano. La versión canónica es la página React en [`packages/frontend/app/legal/privacy/page.tsx`](../packages/frontend/app/legal/privacy/page.tsx). Si necesitas cambiar el texto, edita esa página y regenera este markdown con `node scripts/legal-sync.ts` (TODO Sprint 2 — hasta entonces, sincroniza manualmente los dos ficheros tras cada cambio).

> Última actualización: 17 de julio de 2026.
>
> *Modelo adaptado de las plantillas y orientaciones publicadas por la Agencia Española de Protección de Datos (AEPD) en [aepd.es](https://www.aepd.es/es/areas-de-actuacion/internet-y-redes-sociales/modelos-de-politica-de-privacidad) y de la Guía del RGPD de la AEPD para PYMEs. Esta política cumple el deber de información del **Art. 13 del RGPD** y se completa con los [Términos del Servicio](tos.md) y la información sobre cookies que se muestra en el banner de consentimiento.*

Esta política también está publicada en formato web en [`packages/frontend/app/legal/privacy/page.tsx`](../packages/frontend/app/legal/privacy/page.tsx). El documento en este directorio es la fuente canónica para auditoría legal.

---

## 1. Responsable del tratamiento

**KiraRoom SaaS** (en adelante, "KiraRoom"), con sede en España, es el responsable del tratamiento de los datos personales recabados a través de la plataforma `app.kiraroom.com`.

Para cualquier consulta relativa al tratamiento de datos, puede escribir a `privacy@kiraroom.com`.

## 2. Datos que recabamos

Para prestar el servicio de gestión de citas y facturación, recabamos:

- **Datos de la cuenta del salón**: nombre del negocio, dirección fiscal, NIF/CIF, email del propietario, contraseña (almacenada con hash + sal), teléfono de contacto.
- **Datos de clientes finales**: nombre, apellidos, email, teléfono, NIF (opcional), historial de citas y compras, consentimientos firmados (RGPD + LSSI).
- **Datos de facturación**: importes, fechas, NIF del receptor, número de serie de facturas. Conservados durante **4 años** conforme al Art. 66 del Reglamento General Tributario.
- **Datos fiscales remitidos a la AEAT**: facturas enviadas al sistema Verifactu o TicketBAI con su NIF, importe y hash de firma. Conservados mientras esté vigente la obligación fiscal.

## 3. Finalidad del tratamiento

Tratamos los datos personales con las siguientes finalidades:

1. Prestar el servicio SaaS contratado (gestión de citas, profesionales, servicios).
2. Emitir facturas y remitirlas a la AEAT o a las diputaciones forales.
3. Sincronizar asientos contables con Holded o Sage Despachos (sólo si el cliente activa la integración).
4. Detectar y prevenir fraude o abuso del servicio.
5. Cumplir obligaciones legales (Art. 66 RGGI, Art. 24 LOPDGDD, LSSI).
6. Enviar comunicaciones operativas del servicio (no marketing sin consentimiento).

## 4. Base jurídica del tratamiento

Tratamos los datos personales al amparo de:

- **Ejecución del contrato** (Art. 6.1.b RGPD): prestar el servicio contratado.
- **Cumplimiento de obligaciones legales** (Art. 6.1.c RGPD): facturación, conservación de facturas, llevanza de libros contables.
- **Interés legítimo** (Art. 6.1.f RGPD): detección de fraude, seguridad del servicio.

## 5. Destinatarios de los datos

Sus datos pueden ser comunicados a:

- **AEAT (Agencia Tributaria)** y diputaciones forales del País Vasco (Diputación de Bizkaia, Gipuzkoa y Álava) para el cumplimiento de obligaciones fiscales (Verifactu, TicketBAI, SII).
- **Holded, Sage Despachos, A3 (Wolters Kluwer), NCS** si el cliente activa la integración contable correspondiente.
- **Resend** (transaccional de email) y **GlitchTip** (monitorización de errores) — ambos con servidores en la UE.

KiraRoom no vende datos personales. No se realizan transferencias internacionales fuera del EEE.

## 6. Conservación de los datos

- Datos de cuenta del salón: mientras dure la relación contractual + 5 años (prescripción de acciones contractuales, Art. 1964 CC).
- Datos de clientes finales: mientras el salón mantenga la cuenta + 2 años desde la última interacción.
- Facturas y datos fiscales: **4 años** (Art. 66 RGGI).
- Datos de facturación remitidos a la AEAT: mientras esté vigente la obligación fiscal.

## 7. Sus derechos (RGPD Arts. 15-22)

Como titular de los datos, usted puede ejercer en cualquier momento:

- **Acceso** (Art. 15): confirmación de si tratamos sus datos y obtención de una copia. Ejercitable vía `POST /api/v1/saas/tenants/:id/export` (gestionado por el propietario del salón).
- **Rectificación** (Art. 16): corrección de datos inexactos.
- **Supresión / Derecho al olvido** (Art. 17): eliminación de sus datos, salvo excepciones legales (facturas). Ejercitable vía `POST /api/v1/saas/tenants/:id/anonymize`.
- **Limitación** (Art. 18): tratamiento limitado mientras se verifica la exactitud.
- **Portabilidad** (Art. 20): exportación de sus datos en formato estructurado (JSON + CSV).
- **Oposición** (Art. 21): oposición al tratamiento basado en interés legítimo.
- **Reclamación ante la AEPD** (Art. 77): si considera que hemos vulnerado sus derechos.

Para ejercer estos derechos: `privacy@kiraroom.com`. Responderemos en un plazo máximo de **30 días**.

## 8. Cookies

Este sitio utiliza cookies propias y de terceros conforme al **Art. 22.2 de la Ley 34/2002 de Servicios de la Sociedad de la Información y de Comercio Electrónico (LSSI)** y al RGPD. Al visitar el sitio por primera vez se muestra un banner de consentimiento que permite aceptar todas las cookies, rechazar las no esenciales, o configurar las preferencias por categoría. Una vez expresado el consentimiento, el botón flotante "🍪 Configurar cookies" (esquina inferior derecha) permite modificar o retirar el consentimiento en cualquier momento.

Las categorías de cookies utilizadas son:

- **Necesarias** (siempre activas, no requieren consentimiento): sesión, autenticación, token CSRF, equilibrio de carga.
- **Preferencias** (opt-in): idioma, tema visual, último salón visitado.
- **Analítica** (opt-in): páginas vistas y reporte de errores enviado a GlitchTip (autoalojado en la UE).
- **Marketing** (opt-in, actualmente no utilizada): píxeles de adquisición de Meta / Google Ads si en el futuro se activan campañas de pago.

El consentimiento se almacena localmente en su navegador bajo la clave `kira-cookie-consent-v2`. Puede retirarlo en cualquier momento desde el botón "🍪 Configurar cookies" del pie de página.

## 9. Medidas de seguridad

Aplicamos las medidas del Art. 32 RGPD:

- Cifrado AES-256-GCM para datos personales en reposo.
- Tokens JWT firmados con HS256 (recomendamos HS256 con rotación de claves).
- Hash + sal con bcrypt en contraseñas.
- Backups diarios cifrados con retención 30 días hot + 1 año frío.
- Limitación de tasa (100 req/min/IP) para prevenir abuso.
- Logs de auditoría firmados (inmutables) para todas las acciones SaaS-owner.
- WAF/CORS restrictivo en producción.

## 10. Cambios a esta política

Cualquier cambio material se notificará por email al propietario del salón con al menos **30 días** de antelación y se publicará una nueva versión en esta URL.

---

*Documento generado como parte del Sprint 1 del plan [`1784285888087-zero-budget-launch-roadmap.md`](../../Users/operd/.local/share/kilo/plans/1784285888087-zero-budget-launch-roadmap.md), Workstream 1.4 (GDPR minimal compliance).*