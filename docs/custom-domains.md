# Dominio propio de los salones (custom domains)

Estado: **el código está hecho; falta la infraestructura de certificados (HTTPS)**.
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

## Lo que falta: HTTPS para dominios arbitrarios

Hoy Traefik (`root-traefik-1`) solo tiene routers con `Host(\`app.kiraroom.net\`)` y
`Host(\`api.kiraroom.net\`)`, y Let's Encrypt emite certificados solo para los hosts de
esas reglas. Una petición a `https://reservas.misalon.com` no tiene certificado ni
router. Hace falta **emisión de certificados bajo demanda**, limitada a los dominios
verificados. Opciones:

### Opción A (recomendada): Caddy con *on-demand TLS* delante de los dominios de salones

- Un contenedor Caddy escuchando en una IP/puertos propios, o detrás de Traefik con
  un router TCP `HostSNI(\`*\`)` de prioridad baja y `tls.passthrough=true` para que los
  hosts que Traefik no conoce lleguen a Caddy con el TLS intacto.
- `Caddyfile` mínimo:

  ```
  {
    on_demand_tls {
      ask http://backend:3001/api/v1/public-site/domain-check
    }
  }
  https:// {
    tls {
      on_demand
    }
    reverse_proxy frontend:3000
  }
  ```

  Caddy llama a `ask?domain=<host>` antes de pedir un certificado; el endpoint
  `GET /public-site/domain-check?domain=` (ya hecho) responde 200 solo si el dominio
  está verificado y 404 si no. Sin ese filtro, cualquiera podría hacer que pidamos
  certificados para dominios al azar y agotar los límites de Let's Encrypt.
  Caddy tiene que estar en la red `kiraroom-network` para llegar a `backend:3001`
  y `frontend:3000`.
- `CUSTOM_DOMAIN_TARGET` puede apuntar a un nombre propio (p. ej. `sites.kiraroom.net`)
  con un registro A a la IP del VPS.

### Opción B: Traefik con un router por dominio

Cada dominio verificado requiere añadir un router (`Host(\`reservas.misalon.com\`)`,
`tls.certresolver=mytlschallenge`) por el proveedor de ficheros de Traefik
(configuración dinámica). Funciona, pero hay que regenerar ese fichero cuando se
verifica o se quita un dominio (un cron que lea `custom_domains` con `verifiedAt` no
nulo). Más piezas móviles que la opción A.

### Después

1. Comprobar con un dominio de prueba propio que `https://<dominio>/` muestra la página
   del salón con certificado válido.
2. Poner `CUSTOM_DOMAINS_TLS_READY=1` en el entorno del backend y redesplegar. El panel
   pasará a «Activo» y la URL canónica y el sitemap usarán el dominio del salón.
3. Si se quiere cobrar: quitar `web_domain` de `WITHHELD_ADDON_KEYS`, volver a añadirlo
   en `upsellableAddOnsForPlan`, darle un `stripePriceId` y decidir si la conexión del
   dominio se limita a quien tenga el complemento (hoy está abierta a cualquier salón,
   porque sin HTTPS no sirve aún).

## Variables

| Variable | Dónde | Para qué |
| --- | --- | --- |
| `CUSTOM_DOMAIN_TARGET` | backend | Host al que apuntan los CNAME. Vacío = host de `APP_BASE_URL`. |
| `CUSTOM_DOMAINS_TLS_READY` | backend | `1` solo cuando el HTTPS de dominios de salones funcione. |
| `INTERNAL_API_URL` | frontend (runtime) | Backend en la red Docker para renders del servidor y el middleware. En `docker-compose.prod.yml`. |
| `NEXT_PUBLIC_APP_URL` | frontend (build) | URL pública de la app para URLs canónicas, sitemap y robots. |
| `NEXT_PUBLIC_PLATFORM_HOSTS` | frontend (build, opcional) | Hosts extra que nunca son dominios de salón (p. ej. un staging). |
