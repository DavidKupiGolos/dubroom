#!/usr/bin/env bash
set -euo pipefail

archive="${1:-/tmp/dubroom-release.tar.gz}"
release="${2:?release directory is required}"
public_api="${NEXT_PUBLIC_PROJECT_API:?NEXT_PUBLIC_PROJECT_API is required}"

install -d -o root -g dubroom -m 0750 "$(dirname "$release")"
if [[ -e "$release" ]]; then
  echo "Release already exists: $release" >&2
  exit 1
fi

mkdir -p "$release"
tar -xzf "$archive" -C "$release"
cd "$release"

npm ci
NEXT_PUBLIC_PROJECT_API="$public_api" npm run build
node --test

chown -R root:dubroom "$release"
chmod -R o-rwx "$release"
printf 'RELEASE_READY=%s\n' "$release"
