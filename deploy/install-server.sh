#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-dubroom.186-246-46-242.sslip.io}"
APP_DIR="${DUBROOM_APP_DIR:-/opt/dubroom/app}"
ENV_FILE="/etc/dubroom/dubroom.env"

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  echo "Project is missing at ${APP_DIR}" >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Server environment is missing at ${ENV_FILE}" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl ffmpeg nginx certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
chmod 0755 /usr/local/bin/yt-dlp

id -u dubroom >/dev/null 2>&1 || useradd --system --home-dir /var/lib/dubroom --create-home --shell /usr/sbin/nologin dubroom
chown root:dubroom /etc/dubroom
chmod 0750 /etc/dubroom
install -d -o dubroom -g dubroom -m 0750 /var/lib/dubroom/projects
install -d -o dubroom -g dubroom -m 0750 /var/backups/dubroom
install -d -o root -g dubroom -m 0750 /usr/local/lib/dubroom
install -o root -g dubroom -m 0750 deploy/backup.sh /usr/local/lib/dubroom/backup.sh
install -o root -g dubroom -m 0750 deploy/verify-backup.sh /usr/local/lib/dubroom/verify-backup.sh
install -o root -g dubroom -m 0750 deploy/monitor.sh /usr/local/lib/dubroom/monitor.sh
chmod 0600 "${ENV_FILE}"
chown root:dubroom "${ENV_FILE}"
if [[ -f /etc/dubroom/youtube-cookies.txt ]]; then
  chmod 0640 /etc/dubroom/youtube-cookies.txt
  chown root:dubroom /etc/dubroom/youtube-cookies.txt
fi

cd "${APP_DIR}"
npm ci
NEXT_PUBLIC_PROJECT_API="https://${DOMAIN}" npm run build
chown -R root:dubroom "${APP_DIR}"
chmod -R o-rwx "${APP_DIR}"

sed "s|__APP_DIR__|${APP_DIR}|g" deploy/dubroom-api.service > /etc/systemd/system/dubroom-api.service
sed "s|__APP_DIR__|${APP_DIR}|g" deploy/dubroom-web.service > /etc/systemd/system/dubroom-web.service
install -o root -g root -m 0644 deploy/dubroom-backup.service /etc/systemd/system/dubroom-backup.service
install -o root -g root -m 0644 deploy/dubroom-backup.timer /etc/systemd/system/dubroom-backup.timer
install -o root -g root -m 0644 deploy/dubroom-monitor.service /etc/systemd/system/dubroom-monitor.service
install -o root -g root -m 0644 deploy/dubroom-monitor.timer /etc/systemd/system/dubroom-monitor.timer
sed "s|__DOMAIN__|${DOMAIN}|g" deploy/nginx.conf.template > /etc/nginx/sites-available/dubroom
ln -sfn /etc/nginx/sites-available/dubroom /etc/nginx/sites-enabled/dubroom
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl daemon-reload
systemctl enable --now dubroom-api dubroom-web nginx dubroom-backup.timer dubroom-monitor.timer

certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d "${DOMAIN}"
systemctl reload nginx

curl --fail --silent --show-error "http://127.0.0.1:5180/v1/health/ready"
curl --fail --silent --show-error "https://${DOMAIN}/v1/health/ready"
systemctl start dubroom-backup.service
echo
echo "Dubroom is ready at https://${DOMAIN}"
