#!/usr/bin/env bash
# Private Postgres on GCP for Instruments, reached from Cloudflare through a Tunnel.
#
#   Cloudflare Hyperdrive ─► Workers VPC service ─► Tunnel ─► cloudflared (e2-micro VM) ─► Cloud SQL private IP
#
# Nothing here has a public database address. Run the steps in order:
#
#   PROJECT=my-project infra/gcp/setup.sh database   # VPC, private Cloud SQL, db + user; writes DB_* to .env
#   pnpm deploy                                       # Alchemy creates the Tunnel, VPC service and Hyperdrive
#   PROJECT=my-project infra/gcp/setup.sh tunnel      # VM running cloudflared with the tunnel token
#   PROJECT=my-project infra/gcp/setup.sh forward     # localhost:15432 → Cloud SQL, for migrate and backfill
#
# Rough cost: Cloud SQL db-f1-micro + 10 GB SSD ≈ $9/month, e2-micro VM ≈ $0–6/month
# (free tier covers one in us-east1/us-central1/us-west1), external IPv4 for its egress ≈ $3.65/month.
set -euo pipefail

: "${PROJECT:?set PROJECT to the GCP project id}"
REGION="${REGION:-us-east1}"
ZONE="${ZONE:-${REGION}-b}"
NETWORK="instruments"
SUBNET="instruments-subnet"
INSTANCE="instruments-pg"
VM="instruments-tunnel"
DB_NAME="instruments"
DB_USER="instruments"
LOCAL_PORT="${LOCAL_PORT:-15432}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
g() { gcloud --project "$PROJECT" --quiet "$@"; }

# Run a create command; treat "already exists" as success so every step can be re-run.
ensure() {
  local output
  if ! output="$("$@" 2>&1)"; then
    if grep -qiE "already exists|alreadyExists" <<<"$output"; then return 0; fi
    echo "$output" >&2
    return 1
  fi
}

# Set KEY=VALUE in .env without printing the value.
set_env() {
  touch "$ENV_FILE"
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

database() {
  echo "Enabling APIs…"
  g services enable compute.googleapis.com sqladmin.googleapis.com servicenetworking.googleapis.com iap.googleapis.com

  echo "Private network…"
  ensure g compute networks create "$NETWORK" --subnet-mode=custom
  ensure g compute networks subnets create "$SUBNET" --network="$NETWORK" --region="$REGION" --range=10.20.0.0/24 --enable-private-ip-google-access
  # IAP's range only, port 22 only: the sole way in, used by `forward`.
  ensure g compute firewall-rules create instruments-allow-iap-ssh --network="$NETWORK" --direction=INGRESS --allow=tcp:22 --source-ranges=35.235.240.0/20

  echo "Private services access for Cloud SQL…"
  ensure g compute addresses create instruments-psa --global --purpose=VPC_PEERING --prefix-length=24 --network="$NETWORK"
  ensure g services vpc-peerings connect --service=servicenetworking.googleapis.com --ranges=instruments-psa --network="$NETWORK"

  echo "Cloud SQL (Postgres 17, private IP only; first run takes ~10 minutes)…"
  ensure g sql instances create "$INSTANCE" \
    --database-version=POSTGRES_17 --edition=ENTERPRISE --tier=db-f1-micro \
    --region="$REGION" --network="projects/$PROJECT/global/networks/$NETWORK" --no-assign-ip \
    --storage-type=SSD --storage-size=10 --availability-type=zonal \
    --backup-start-time=07:00 --retained-backups-count=7

  local password
  password="$(get_env DB_PASSWORD)"
  if [ -z "$password" ]; then
    password="$(openssl rand -base64 30 | tr -d '/+=' | cut -c1-32)"
  fi
  ensure g sql databases create "$DB_NAME" --instance="$INSTANCE"
  if g sql users list --instance="$INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
    g sql users set-password "$DB_USER" --instance="$INSTANCE" --password="$password" >/dev/null
  else
    g sql users create "$DB_USER" --instance="$INSTANCE" --password="$password" >/dev/null
  fi

  local ip
  ip="$(g sql instances describe "$INSTANCE" --format='value(ipAddresses[0].ipAddress)')"
  set_env DB_PRIVATE_HOST "$ip"
  set_env DB_NAME "$DB_NAME"
  set_env DB_USER "$DB_USER"
  set_env DB_PASSWORD "$password"
  echo "Done. Private IP $ip; DB_PRIVATE_HOST, DB_NAME, DB_USER, DB_PASSWORD written to .env."
  echo "Next: pnpm deploy (creates the Tunnel), then: PROJECT=$PROJECT $0 tunnel"
}

tunnel() {
  local token="${TUNNEL_TOKEN:-}"
  if [ -z "$token" ]; then
    echo "Set TUNNEL_TOKEN to the dbTunnelToken output of \`pnpm deploy\`." >&2
    exit 1
  fi
  echo "cloudflared VM (no inbound access; egress only)…"
  # The token travels as instance metadata, readable only by principals who can view this VM.
  ensure g compute instances create "$VM" \
    --zone="$ZONE" --machine-type=e2-micro \
    --subnet="$SUBNET" --image-family=debian-12 --image-project=debian-cloud \
    --metadata=tunnel-token="$token" \
    --metadata-from-file=startup-script=<(cat <<'STARTUP'
#!/bin/bash
set -e
if ! command -v cloudflared >/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' >/etc/apt/sources.list.d/cloudflared.list
  apt-get update && apt-get install -y cloudflared
fi
TOKEN="$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/tunnel-token)"
systemctl is-active --quiet cloudflared || cloudflared service install "$TOKEN"
STARTUP
)
  echo "Done. The VM installs cloudflared on boot and connects the tunnel within a minute or two."
}

forward() {
  local ip
  ip="$(get_env DB_PRIVATE_HOST)"
  echo "Forwarding localhost:$LOCAL_PORT → $ip:5432 through IAP. Leave this running; in another shell:"
  echo "  export DATABASE_URL=postgres://$DB_USER:\$DB_PASSWORD@localhost:$LOCAL_PORT/$DB_NAME"
  echo "  pnpm db migrate && pnpm --filter @instruments/pipeline cli backfill"
  g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap -- -N -L "$LOCAL_PORT:$ip:5432"
}

case "${1:-}" in
  database) database ;;
  tunnel) tunnel ;;
  forward) forward ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
