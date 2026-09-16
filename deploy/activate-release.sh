#!/usr/bin/env bash
set -euo pipefail

release="${1:?release directory is required}"
domain="${2:?public domain is required}"
app_path="/opt/dubroom/app"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
previous="/opt/dubroom/releases/previous-${timestamp}"
backup_dir="/etc/dubroom/deploy-backups/${timestamp}"
temporary_dir="$(mktemp -d)"
app_switched=0
previous_moved=0
service_units=(
  dubroom-api.service
  dubroom-web.service
  dubroom-backup.service
  dubroom-backup.timer
  dubroom-monitor.service
  dubroom-monitor.timer
)

cleanup() {
  rm -rf -- "${temporary_dir}"
}

rollback() {
  exit_code=$?
  trap - ERR
  set +e
  echo "Activation failed; restoring the previous release" >&2
  systemctl stop dubroom-web.service dubroom-api.service
  if [[ "${app_switched}" == "1" && -L "${app_path}" && -d "${previous}" ]]; then
    rm -- "${app_path}"
    if [[ "${previous_moved}" == "1" ]]; then
      mv -- "${previous}" "${app_path}"
    else
      ln -s -- "${previous}" "${app_path}"
    fi
  fi
  cp -a -- "${backup_dir}/nginx-dubroom" /etc/nginx/sites-available/dubroom
  rm -f -- /etc/nginx/sites-enabled/dubroom
  cp -a -- "${backup_dir}/nginx-enabled" /etc/nginx/sites-enabled/dubroom
  for unit in "${service_units[@]}"; do
    rm -f -- "/etc/systemd/system/${unit}"
    if [[ -f "${backup_dir}/${unit}" ]]; then
      cp -a -- "${backup_dir}/${unit}" "/etc/systemd/system/${unit}"
    fi
  done
  systemctl daemon-reload
  systemctl start dubroom-api.service dubroom-web.service
  nginx -t && systemctl reload nginx
  cleanup
  exit "${exit_code}"
}

trap rollback ERR
trap cleanup EXIT

if [[ "$(id -u)" != "0" ]]; then
  echo "Activation must run as root" >&2
  exit 1
fi
if [[ ! -d "${release}" || ! -d "${release}/dist" ]]; then
  echo "Built release is missing: ${release}" >&2
  exit 1
fi
if [[ -L "${app_path}" ]]; then
  previous="$(readlink -f -- "${app_path}")"
  if [[ ! -d "${previous}" ]]; then
    echo "Previous release is missing: ${previous}" >&2
    exit 1
  fi
elif [[ ! -d "${app_path}" ]]; then
  echo "Current application is missing: ${app_path}" >&2
  exit 1
fi

install -d -m 0700 "${backup_dir}"
cp -a -- /etc/nginx/sites-available/dubroom "${backup_dir}/nginx-dubroom"
cp -a -- /etc/nginx/sites-enabled/dubroom "${backup_dir}/nginx-enabled"
for unit in "${service_units[@]}"; do
  if [[ -f "/etc/systemd/system/${unit}" ]]; then
    cp -a -- "/etc/systemd/system/${unit}" "${backup_dir}/${unit}"
  fi
done

if [[ -d "${app_path}/private" && ! -e "${release}/private" ]]; then
  cp -a -- "${app_path}/private" "${release}/private"
fi

sed "s|__DOMAIN__|${domain}|g" "${release}/deploy/nginx-ssl.conf.template" > "${temporary_dir}/nginx-dubroom"
sed 's|__APP_DIR__|/opt/dubroom/app|g' "${release}/deploy/dubroom-api.service" > "${temporary_dir}/dubroom-api.service"
sed 's|__APP_DIR__|/opt/dubroom/app|g' "${release}/deploy/dubroom-web.service" > "${temporary_dir}/dubroom-web.service"

install -m 0644 "${temporary_dir}/nginx-dubroom" /etc/nginx/sites-available/dubroom
rm -f -- /etc/nginx/sites-enabled/dubroom
ln -s -- /etc/nginx/sites-available/dubroom /etc/nginx/sites-enabled/dubroom
nginx -t
install -m 0644 "${temporary_dir}/dubroom-api.service" /etc/systemd/system/dubroom-api.service
install -m 0644 "${temporary_dir}/dubroom-web.service" /etc/systemd/system/dubroom-web.service
install -m 0644 "${release}/deploy/dubroom-backup.service" /etc/systemd/system/dubroom-backup.service
install -m 0644 "${release}/deploy/dubroom-backup.timer" /etc/systemd/system/dubroom-backup.timer
install -m 0644 "${release}/deploy/dubroom-monitor.service" /etc/systemd/system/dubroom-monitor.service
install -m 0644 "${release}/deploy/dubroom-monitor.timer" /etc/systemd/system/dubroom-monitor.timer
install -d -m 0755 /usr/local/lib/dubroom
install -m 0755 "${release}/deploy/backup.sh" /usr/local/lib/dubroom/backup.sh
install -m 0755 "${release}/deploy/verify-backup.sh" /usr/local/lib/dubroom/verify-backup.sh
install -m 0755 "${release}/deploy/monitor.sh" /usr/local/lib/dubroom/monitor.sh
install -d -o dubroom -g dubroom -m 0750 /var/backups/dubroom

systemctl stop dubroom-web.service dubroom-api.service
if [[ -L "${app_path}" ]]; then
  rm -- "${app_path}"
else
  mv -- "${app_path}" "${previous}"
  previous_moved=1
fi
ln -s -- "${release}" "${app_path}"
app_switched=1

systemctl daemon-reload
systemctl start dubroom-api.service dubroom-web.service

ready=0
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:5180/v1/health/ready >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "${ready}" != "1" ]]; then
  echo "New API did not become ready" >&2
  exit 1
fi

nginx -t
systemctl reload nginx
systemctl enable --now dubroom-backup.timer dubroom-monitor.timer
trap - ERR

printf 'ACTIVE_RELEASE=%s\n' "${release}"
printf 'PREVIOUS_RELEASE=%s\n' "${previous}"
printf 'CONFIG_BACKUP=%s\n' "${backup_dir}"
