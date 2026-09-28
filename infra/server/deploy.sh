#!/bin/bash
# Releases one image on this server. Run as root by SSM Run Command, from
# inside the unpacked release bundle:
#
#   deploy.sh <image-uri>        e.g. 1234.dkr.ecr.eu-west-1.amazonaws.com/porchlight-api:<sha>
#
# Stop-then-start, not blue/green. The API holds every doorbell's socket
# in process memory, so two copies running at once would each believe
# they know who is connected. A few seconds of reconnecting is the price
# of exactly one truth; the doorbells retry on their own.
#
# If the new release does not become healthy it is rolled back to the
# previous image, and this exits non-zero so the pipeline goes red.
set -euo pipefail

# Run Command does not always set HOME, and without it docker cannot find
# /root/.docker/config.json - the file that routes ECR pulls through the
# instance role. The symptom would be "no basic auth credentials".
export HOME="${HOME:-/root}"

IMAGE="${1:?usage: deploy.sh <image-uri>}"
BUNDLE="$(cd "$(dirname "$0")" && pwd)"
ROOT=/opt/porchlight
HEALTH_TIMEOUT_S=150   # Atlas M0 can take several retries to connect

# The API refuses to be useful without these; see render-env.py.
REQUIRED_APP=(
  MONGODB_URI JWT_SECRET CLAIM_CODE_PEPPER PUBLIC_API_URL CLIENT_ORIGIN
  LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET
  R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
)
REQUIRED_PROXY=(API_DOMAIN ACME_EMAIL LOG_GROUP)

log() { echo "[deploy] $*"; }

imds() {
  local token
  token=$(curl -fsS -X PUT http://169.254.169.254/latest/api/token \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
  curl -fsS -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}
REGION=$(imds placement/region)

render() { # <parameter path> <output file> <required names...>
  local path="$1" out="$2"
  shift 2
  aws ssm get-parameters-by-path --region "$REGION" --path "$path" \
    --recursive --with-decryption --output json \
    | python3 "$BUNDLE/render-env.py" "$path" "$out" "$@"
}

compose() { docker compose --project-directory "$ROOT" -f "$ROOT/compose.yaml" "$@"; }

write_interpolation_env() { # <image>
  # LOG_GROUP comes out of proxy.env, which render() just wrote.
  local log_group
  log_group=$(sed -n "s/^LOG_GROUP='\(.*\)'$/\1/p" "$ROOT/proxy.env")
  printf "IMAGE=%s\nAWS_REGION=%s\nLOG_GROUP=%s\n" "$1" "$REGION" "$log_group" > "$ROOT/.env"
}

wait_healthy() {
  local id status deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while ((SECONDS < deadline)); do
    id=$(compose ps -q api)
    status=$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)
    case "$status" in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep 3
  done
  return 1
}

log "releasing $IMAGE"

# Configuration first: a missing secret stops the release before anything
# running is touched.
render "/porchlight/prod/app" "$ROOT/app.env.next" "${REQUIRED_APP[@]}"
render "/porchlight/prod/proxy" "$ROOT/proxy.env.next" "${REQUIRED_PROXY[@]}"
mv "$ROOT/app.env.next" "$ROOT/app.env"
mv "$ROOT/proxy.env.next" "$ROOT/proxy.env"

# Pull before stopping anything, so the old API keeps serving for as long
# as the download takes.
docker pull --quiet "$IMAGE"

PREVIOUS=$(cat "$ROOT/current-image" 2>/dev/null || true)

# cp, not mv: cp rewrites the file in place, and a single-file bind mount
# follows the inode - a replaced file would leave Caddy reading the old one.
CADDY_CHANGED=0
cmp -s "$BUNDLE/Caddyfile" "$ROOT/Caddyfile" || CADDY_CHANGED=1
cp "$BUNDLE/compose.yaml" "$BUNDLE/Caddyfile" "$ROOT/"

write_interpolation_env "$IMAGE"
compose up -d --remove-orphans

if ! wait_healthy; then
  log "new release is not healthy - last lines from it:"
  compose logs --tail 40 api 2>&1 | sed 's/^/  | /' || true
  if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$IMAGE" ]]; then
    log "rolling back to $PREVIOUS"
    write_interpolation_env "$PREVIOUS"
    compose up -d --remove-orphans
    if wait_healthy; then
      log "rollback healthy - still serving $PREVIOUS"
    else
      log "ROLLBACK ALSO UNHEALTHY - needs a human"
    fi
  fi
  exit 1
fi

echo "$IMAGE" > "$ROOT/current-image"

# `up` already recreated Caddy if its image or environment changed; a
# Caddyfile edit is the one change it cannot see through a bind mount.
if ((CADDY_CHANGED)) && [[ -n "$(compose ps -q caddy)" ]]; then
  log "Caddyfile changed - reloading"
  compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
fi

# Old images are only rollback targets, and ECR keeps twenty of those.
docker image prune -af --filter "until=168h" > /dev/null

log "live: $IMAGE"
