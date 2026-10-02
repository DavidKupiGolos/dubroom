#!/usr/bin/env bash
set -euo pipefail

readonly release_root="/opt/dubroom/releases"
readonly public_api="https://choicer.kupigolos.ru"
readonly certificate_domain="dubroom.188-120-240-205.sslip.io"
readonly stage_script="/opt/dubroom/app/deploy/stage-release.sh"

if [[ "${SSH_ORIGINAL_COMMAND:-}" != deploy\ * ]]; then
  echo "Only deploy <git-sha> is permitted" >&2
  exit 64
fi

release_sha="${SSH_ORIGINAL_COMMAND#deploy }"
if [[ ! "${release_sha}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Invalid release SHA" >&2
  exit 64
fi

if [[ ! -f "${stage_script}" ]]; then
  echo "Deployment staging script is unavailable" >&2
  exit 69
fi

release="${release_root}/${release_sha}"
archive="$(mktemp /tmp/dubroom-release.XXXXXX.tar.gz)"

cleanup() {
  rm -f -- "${archive}"
}
trap cleanup EXIT

cat > "${archive}"
test -s "${archive}"
install -d -o root -g dubroom -m 0750 "${release_root}"

if [[ -d "${release}" ]]; then
  if [[ ! -d "${release}/dist" || ! -f "${release}/deploy/activate-release.sh" ]]; then
    echo "Existing release is incomplete: ${release}" >&2
    exit 65
  fi
  echo "Reusing verified staged release: ${release}"
else
  NEXT_PUBLIC_PROJECT_API="${public_api}" bash "${stage_script}" "${archive}" "${release}"
fi

bash "${release}/deploy/activate-release.sh" "${release}" "choicer.kupigolos.ru" "${certificate_domain}"
