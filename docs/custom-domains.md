# Dominio propio de los salones (custom domains)

Estado: **el código está hecho (dominio propio y subdominio gratuito); falta configurar los certificados en Traefik**.
Hasta que exista, el complemento `web_domain` no se vende (`WITHHELD_ADDON_KEYS`
en `packages/backend/src/payments/services/addons.service.ts`).

## Qué hace la aplicación

1. En **Ajustes → Web y dominio** (`/dashboard/settings/domain`) el salón escribe un
   dominio que ya es suyo (p. ej. `reservas.misalon.com`). No vendemos ni registramos
   dominios.
2. La aplicación le muestra dos registros DNS:
   - `CNAME reservas.misalon.com → <CUSTOM_DOMAIN_TARGET>` (por defecto, el host de
     `APP_BASE_URL`, es decir `app.kiraroom.net`). Para un dominio raíz, donde no se
     permite CNAME, un registro `A` hacia las mismas IP que el destino.
   - `TXT _kiraroom.reservas.misalon.com = kiraroom-verify=<token>`: demuestra que el
     dominio es de ese salón (que el dominio apunte a nosotros no dice de qué salón es).
3. «Comprobar ahora» (`POST /web-domain/verify`) hace consultas DNS reales
   (`node:dns`). Si ambos registros están bien, el dominio queda verificado. Si otro
   salón lo tenía verificado, lo pierde (quien demuestra la titularidad ahora gana).
4. Cada día a las 04:00 se vuelven a comprobar los dominios verificados; tras **dos**
   fallos seguidos se desverifican (uno solo puede ser un fallo del resolvedor).
5. El middleware del frontend (`packages/frontend/middleware.ts`) mira el `Host` de
   cada petición. Si no es de la plataforma, pregunta a
   `GET /public-site/domain/:host` (con caché en memoria: 5 min aciertos, 1 min fallos)
   y reescribe la ruta a `/sites/<slug>` (la URL que ve el visitante no cambia).
6. Mientras `CUSTOM_DOMAINS_TLS_READY` no sea `1`, el panel dice «Verificado; activo
   cuando se configure el certificado», y la URL canónica y el sitemap siguen usando
   `https://app.kiraroom.net/sites/<slug>`.

## Subdominio gratuito de cada salón

Todos los salones, tengan o no dominio propio, pueden tener `<slug>.kiraroom.net`
(p. ej. `salon-lucia.kiraroom.net`):

- La regla común está en `packages/shared/src/utils/salon-subdomain.ts`. Un slug sirve
  como subdominio si es una etiqueta DNS válida (1-63 caracteres, minúsculas, dígitos y
  guiones interiores) y no está en `RESERVED_SUBDOMAINS` (`app`, `api`, `www`,
  `admin`…). Un salón nuevo no puede tener un nombre reservado, y `slugify` quita las
  tildes ("Salón Lucía" → `salon-lucia`).
- El middleware del frontend sirve `<slug>.<SALON_SUBDOMAIN_BASE>` como `/sites/<slug>`
  sin consultar la API, porque el propio host dice qué salón es.
- Con `SALON_SUBDOMAINS_READY=1`:
  - la URL canónica, el sitemap y el panel usan el subdominio;
  - `app.kiraroom.net/sites/<slug>` redirige (308) a `https://<slug>.kiraroom.net/`.

  Solo se redirige la página pública. El área de cliente se queda donde está, porque la
  sesión del cliente vive en el almacenamiento del navegador del host donde entró.
- Orden de la URL canónica: dominio propio activo, luego subdominio activo, luego
  `/sites/<slug>`.

## Certificados: Traefik consulta a KiraRoom

Traefik (`root-traefik-1`, compartido con otros proyectos del servidor) solo tenía
certificados para `app`, `api`, `kiraroom.net` y `www`. Ahora el backend le sirve su
configuración dinámica en `GET /api/v1/internal/traefik/dynamic`
(`packages/backend/src/web-domain/traefik-provider.ts`):

- **Un router por dominio propio verificado** (`Host(\`reservas.misalon.com\`)`), con
  `TRAEFIK_CERTRESOLVER` (`mytlschallenge`). Traefik pide el certificado a Let's
  Encrypt la primera vez. Solo aparecen dominios verificados: un `Host` cualquiera
  nunca hace que se pida un certificado.
- **Un router comodín** para `^[a-z0-9-]+\.kiraroom\.net$`, con prioridad 2 y
  certificado `kiraroom.net` + `*.kiraroom.net` del resolver `TRAEFIK_DNS_CERTRESOLVER`.
  Un certificado comodín solo se puede validar por DNS, y Hostinger está soportado
  (proveedor `hostinger` de lego, desde la versión 4.27).
- El redirector de `kiraroom.net` y `www` pasa a prioridad 10 (en
  `docker-compose.prod.yml`), por encima del comodín, para que `www` siga yendo a él.
  `app` y `api` tienen prioridad mayor por la longitud de su regla.
- La ruta exige `TRAEFIK_PROVIDER_TOKEN`, en la cabecera `Authorization: Bearer` o en
  `?token=`. Sin él responde 404.

### Lo que hay que hacer en el servidor

1. **Hostinger:**
   - Crear un token de API con acceso al DNS de kiraroom.net (hPanel → Cuenta → API).
   - Añadir el registro `A *` → `72.62.53.68`. Los registros existentes (`app`, `api`,
     `www`…) tienen prioridad sobre el comodín.
2. **Versión de Traefik:** comprobar que su lego es 4.27 o posterior, para que exista
   el proveedor `hostinger`. Si es más antigua, actualizar Traefik.
3. **`/opt/kiraroom/.env`:**
   - `TRAEFIK_PROVIDER_TOKEN=<openssl rand -hex 32>`
   - `TRAEFIK_DNS_CERTRESOLVER=hostinger`
   - `SALON_SUBDOMAIN_BASE=kiraroom.net`
   - `TRAEFIK_MAJOR_VERSION` según la versión de Traefik.
   - Redesplegar.
4. **Configuración estática de Traefik** (compose de `root-traefik-1`). Hacer copia antes,
   porque el reinicio corta unos segundos a todos los proyectos del servidor:

   ```yaml
   command:
     # Configuración dinámica de KiraRoom (dominios y subdominios de salones)
     - "--providers.http.endpoint=http://kiraroom-backend-prod:3001/api/v1/internal/traefik/dynamic?token=<TRAEFIK_PROVIDER_TOKEN>"
     - "--providers.http.pollInterval=30s"
     # Resolver con reto DNS de Hostinger, para el certificado comodín
     - "--certificatesresolvers.hostinger.acme.dnschallenge=true"
     - "--certificatesresolvers.hostinger.acme.dnschallenge.provider=hostinger"
     - "--certificatesresolvers.hostinger.acme.email=<tu email>"
     - "--certificatesresolvers.hostinger.acme.storage=/letsencrypt/acme-hostinger.json"
   environment:
     - HOSTINGER_API_TOKEN=<token de Hostinger>
   ```

   Traefik llega a `kiraroom-backend-prod:3001` porque los dos están en la red
   `root_default`.
5. **Comprobar:**
   - `https://<slug-de-prueba>.kiraroom.net/` muestra la página del salón con
     certificado válido;
   - un dominio de prueba verificado abre con candado;
   - `www.kiraroom.net` sigue redirigiendo.
6. **Activar:**
   - `SALON_SUBDOMAINS_READY=1` y `CUSTOM_DOMAINS_TLS_READY=1` en `.env`, y redesplegar;
   - el panel pasa a "Activo" y la URL canónica, el sitemap y la redirección usan las
     direcciones nuevas.
7. **Si se quiere cobrar el dominio propio:**
   - quitar `web_domain` de `WITHHELD_ADDON_KEYS`;
   - volver a añadirlo en `upsellableAddOnsForPlan`;
   - darle precio.

### Alternativa descartada: Caddy con on-demand TLS

Funciona igual para los dominios propios: `GET /public-site/domain-check?domain=` sirve
de filtro `ask` para Caddy. Pero añade un servicio más y un paso TCP en Traefik, y no
resuelve el comodín. Se mantiene el endpoint por si se quiere usar.

## Variables

| Variable | Dónde | Para qué |
| --- | --- | --- |
| `CUSTOM_DOMAIN_TARGET` | backend | Host al que apuntan los CNAME. Vacío = host de `APP_BASE_URL`. |
| `CUSTOM_DOMAINS_TLS_READY` | backend | `1` solo cuando el HTTPS de dominios de salones funcione. |
| `INTERNAL_API_URL` | frontend (runtime) | Backend en la red Docker para renders del servidor y el middleware. En `docker-compose.prod.yml`. |
| `NEXT_PUBLIC_APP_URL` | frontend (build) | URL pública de la app para URLs canónicas, sitemap y robots. |
| `NEXT_PUBLIC_PLATFORM_HOSTS` | frontend (build, opcional) | Hosts extra que nunca son dominios de salón (p. ej. un staging). |
| `SALON_SUBDOMAIN_BASE` | backend y frontend (runtime) | Base de los subdominios gratuitos, p. ej. `kiraroom.net`. Vacío = sin subdominios. |
| `SALON_SUBDOMAINS_READY` | backend y frontend (runtime) | `1` solo cuando el certificado comodín funcione: URL canónica, sitemap, panel y redirección de `/sites/<slug>`. |
| `TRAEFIK_PROVIDER_TOKEN` | backend | Token que Traefik envía a `/internal/traefik/dynamic`. Vacío = la ruta responde 404. |
| `TRAEFIK_CERTRESOLVER` | backend (y etiquetas) | Resolver de certificados por dominio (por defecto `mytlschallenge`). |
| `TRAEFIK_DNS_CERTRESOLVER` | backend | Resolver con reto DNS (Hostinger) para `*.<base>`. Vacío = sin router comodín. |
| `TRAEFIK_MAJOR_VERSION` | backend | `3` (por defecto) o `2`: cambia la sintaxis de `HostRegexp`. |
