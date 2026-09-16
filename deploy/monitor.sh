#!/usr/bin/env bash
set -euo pipefail

API_URL="${DUBROOM_MONITOR_API_URL:-http://127.0.0.1:5180}"
health="$(curl --fail --silent --show-error --max-time 10 "${API_URL}/v1/health/ready")"
metrics="$(curl --fail --silent --show-error --max-time 10 "${API_URL}/v1/metrics")"

if [[ "${health}" != *'"status":"ready"'* ]]; then
  echo "Dubroom readiness is not ready" >&2
  exit 1
fi

dead_letters="$(awk '$1 == "dubroom_job_dead_letter" { print $2 }' <<< "${metrics}")"
if [[ ! "${dead_letters}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "Dubroom metrics are incomplete" >&2
  exit 1
fi
if awk -v value="${dead_letters}" 'BEGIN { exit !(value > 0) }'; then
  echo "Dubroom has ${dead_letters} dead-letter jobs" >&2
  exit 1
fi

echo "Dubroom monitor check passed"
