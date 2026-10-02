#!/usr/bin/env bash
set -euo pipefail

readonly release_root="/opt/dubroom/releases"
readonly public_api="https://choicer.kupigolos.ru"
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

NEXT_PUBLIC_PROJECT_API="${public_api}" bash "${stage_script}" "${archive}" "${release}"
"${release}/deploy/activate-release.sh" "${release}" "choicer.kupigolos.ru"
