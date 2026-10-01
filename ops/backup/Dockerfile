# The database's own image, so pg_dump always matches the server version,
# plus age (encryption) and rclone (off-site copy). See backup.sh.
FROM postgres:15-alpine
RUN apk add --no-cache age rclone \
 && mkdir -p /root/.config/rclone && touch /root/.config/rclone/rclone.conf
COPY backup.sh /usr/local/bin/kiraroom-backup
RUN chmod +x /usr/local/bin/kiraroom-backup
ENTRYPOINT ["/usr/local/bin/kiraroom-backup"]
