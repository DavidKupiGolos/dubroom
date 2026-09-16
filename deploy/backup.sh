#!/usr/bin/env bash
set -euo pipefail

umask 027

DATA_ROOT="${DUBROOM_DATA_ROOT:-/var/lib/dubroom/projects}"
BACKUP_ROOT="${DUBROOM_BACKUP_ROOT:-/var/backups/dubroom}"
RETENTION_DAYS="${DUBROOM_BACKUP_RETENTION_DAYS:-14}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

case "${DATA_ROOT}:${BACKUP_ROOT}" in
  /*:/*) ;;
  *) echo "Backup paths must be absolute" >&2; exit 1 ;;
esac
if [[ "${DATA_ROOT}" == "/" || "${BACKUP_ROOT}" == "/" ]]; then
  echo "Refusing to use the filesystem root" >&2
  exit 1
fi
if [[ ! "${RETENTION_DAYS}" =~ ^[0-9]+$ ]]; then
  echo "DUBROOM_BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
  exit 1
fi

mkdir -p "${BACKUP_ROOT}"
if [[ ! -d "${DATA_ROOT}/recommendations" ]]; then
  echo "Recommendations directory is missing: ${DATA_ROOT}/recommendations" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_name="dubroom-permanent-${timestamp}.tar.gz"
archive="${BACKUP_ROOT}/${archive_name}"
temporary_archive="${archive}.tmp"
temporary_checksum="${archive}.sha256.tmp"
paths=(recommendations)
if [[ -f "${DATA_ROOT}/settings.json" ]]; then
  paths+=(settings.json)
fi

cleanup() {
  rm -f -- "${temporary_archive}" "${temporary_checksum}"
}
trap cleanup EXIT

tar -C "${DATA_ROOT}" -czf "${temporary_archive}" -- "${paths[@]}"
tar -tzf "${temporary_archive}" >/dev/null
digest="$(sha256sum "${temporary_archive}" | awk '{print $1}')"
printf '%s  %s\n' "${digest}" "${archive_name}" > "${temporary_checksum}"
mv -- "${temporary_archive}" "${archive}"
mv -- "${temporary_checksum}" "${archive}.sha256"

"${SCRIPT_DIR}/verify-backup.sh" "${archive}"

find "${BACKUP_ROOT}" -maxdepth 1 -type f \
  \( -name 'dubroom-permanent-*.tar.gz' -o -name 'dubroom-permanent-*.tar.gz.sha256' \) \
  -mtime "+${RETENTION_DAYS}" -delete

echo "Verified backup created: ${archive}"
