# Política de privacidad — KiraRoom

Este documento ya no contiene el texto de la política. La política de privacidad vive en un solo sitio:

[`packages/frontend/app/legal/privacy/page.tsx`](../packages/frontend/app/legal/privacy/page.tsx)

Se publica en `https://app.kiraroom.net/legal/privacy`. Edita esa página, no este fichero. Los proveedores que se citan salen de `SUB_PROCESSORS` en [`packages/frontend/lib/salon-legal.ts`](../packages/frontend/lib/salon-legal.ts), y los plazos de conservación se leen del código (ver `packages/backend/src/saas/retention/`).

Si cambias la política, cambia también los Términos del Servicio ([`terms/page.tsx`](../packages/frontend/app/legal/terms/page.tsx)) cuando afecte a lo mismo, la fecha de "Última actualización" y `TERMS_VERSION` en `packages/backend/src/auth/legal-terms.ts`.
