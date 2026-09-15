# Custom KiraRoom nginx image.
#
# Bakes docker/nginx/nginx.conf into the image so the compose file
# doesn't need to volume-mount it from a host path. This eliminates the
# "nginx.conf: not a directory" failure that happens when the host path
# doesn't exist (Docker creates an empty directory, which can't be mounted
# onto a file inside the container).
#
# Built and pushed to ghcr.io/lagop/kiraroom-nginx:latest by CI on every
# push to main. The compose file references the image directly.
FROM nginx:1.27-alpine

# Pre-create the ssl directory so the volume mount doesn't have to
# create it. Certbot writes certs into this directory on first run
# (and on every successful renewal); the volume mount in the compose
# binds it to a named volume on the host so certs survive container
# restarts.
RUN mkdir -p /etc/nginx/ssl

# Bake the reverse-proxy config. The certbot companion's volume mount
# reads from /var/www/certbot (certbot webroot -- ACME challenge path).
COPY nginx.conf /etc/nginx/nginx.conf

# Healthcheck from the compose uses wget inside the container; the
# upstream nginx:1.27-alpine image ships with wget, no extra packages
# needed.
