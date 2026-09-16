#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
if [[ -z "${archive}" || ! -f "${archive}" ]]; then
  echo "Usage: verify-backup.sh /path/to/dubroom-permanent-*.tar.gz" >&2
  exit 1
fi
if [[ ! -f "${archive}.sha256" ]]; then
  echo "Checksum is missing: ${archive}.sha256" >&2
  exit 1
fi

archive_directory="$(cd -- "$(dirname -- "${archive}")" && pwd)"
archive_name="$(basename -- "${archive}")"
(
  cd "${archive_directory}"
  sha256sum -c -- "${archive_name}.sha256"
)
tar -tzf "${archive}" >/dev/null
mapfile -t archive_members < <(tar -tzf "${archive}")
if [[ ! "${archive_members[*]}" =~ (^|[[:space:]])recommendations/ ]]; then
  echo "Backup does not contain recommendations" >&2
  exit 1
fi

for member in "${archive_members[@]}"; do
  if [[ "${member}" == *.json ]]; then
    tar -xOzf "${archive}" -- "${member}" | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => { JSON.parse(input); });
    '
  fi
done

echo "Backup verification passed: ${archive}"
