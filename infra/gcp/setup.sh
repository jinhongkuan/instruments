#!/usr/bin/env bash
# Instruments on GCP: private Postgres, the pipeline as Cloud Run jobs, bundles in Cloud Storage.
#
#   Cloud Scheduler ─► Cloud Run job (pipeline CLI) ─► Cloud SQL private IP      (same VPC, no public DB address)
#                                                   └► Cloud NAT static IP ─► Hyperliquid, Deribit, NY Fed
#                                                   └► gs://<project>-bundles  ◄── browsers (public read, CORS)
#
#   PROJECT=my-project infra/gcp/setup.sh database   # VPC, private Cloud SQL, db + user; writes DB_* to .env
#   PROJECT=my-project infra/gcp/setup.sh jobs       # NAT, bucket, secret, image, Cloud Run jobs, schedules
#   PROJECT=my-project infra/gcp/setup.sh run migrate
#   PROJECT=my-project infra/gcp/setup.sh run backfill   # 90 days for every perp, ~45 min
#   PROJECT=my-project infra/gcp/setup.sh run derive
#
# Rough cost: Cloud SQL db-f1-micro + 10 GB ≈ $9/month, Cloud NAT + static IP ≈ $4/month,
# Cloud Run jobs and Scheduler ≈ cents, bucket egress ≈ cents at this bundle size.
set -euo pipefail

: "${PROJECT:?set PROJECT to the GCP project id}"
REGION="${REGION:-us-east1}"
ZONE="${ZONE:-${REGION}-b}"
NETWORK="instruments"
SUBNET="instruments-subnet"
INSTANCE="instruments-pg"
DB_NAME="instruments"
DB_USER="instruments"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
g() { gcloud --project "$PROJECT" --quiet "$@"; }

# Run a create command; treat "already exists" as success so every step can be re-run.
ensure() {
  local output
  if ! output="$("$@" 2>&1)"; then
    if grep -qiE "already exists|alreadyExists|already own|Duplicate .* name" <<<"$output"; then return 0; fi
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
  g services enable compute.googleapis.com sqladmin.googleapis.com servicenetworking.googleapis.com

  echo "Private network…"
  ensure g compute networks create "$NETWORK" --subnet-mode=custom
  ensure g compute networks subnets create "$SUBNET" --network="$NETWORK" --region="$REGION" --range=10.20.0.0/24 --enable-private-ip-google-access

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
  echo "Next: PROJECT=$PROJECT $0 jobs"
}

jobs() {
  local number sa image bucket
  number="$(g projects describe "$PROJECT" --format='value(projectNumber)')"
  sa="instruments-jobs@$PROJECT.iam.gserviceaccount.com"
  image="$REGION-docker.pkg.dev/$PROJECT/instruments/pipeline:latest"
  bucket="$PROJECT-bundles"

  echo "Enabling APIs…"
  g services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    cloudscheduler.googleapis.com secretmanager.googleapis.com

  echo "Static egress IP through Cloud NAT (Hyperliquid limits per IP; this one is ours alone)…"
  ensure g compute addresses create instruments-nat-ip --region="$REGION"
  ensure g compute routers create instruments-router --network="$NETWORK" --region="$REGION"
  ensure g compute routers nats create instruments-nat --router=instruments-router --region="$REGION" \
    --nat-external-ip-pool=instruments-nat-ip --nat-all-subnet-ip-ranges

  echo "Service account for the jobs…"
  ensure g iam service-accounts create instruments-jobs --display-name="Instruments pipeline jobs"
  # New service accounts take a few seconds to become visible to IAM.
  local tries=0
  until g iam service-accounts describe "$sa" >/dev/null 2>&1 && \
        g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$sa" --role=roles/run.invoker --condition=None >/dev/null 2>&1; do
    tries=$((tries + 1)); [ "$tries" -gt 12 ] && { echo "service account $sa never became usable" >&2; exit 1; }
    sleep 5
  done
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$sa" --role=roles/run.invoker --condition=None >/dev/null
  # Cloud Build runs as the Compute default account in new projects; give it just what the build needs.
  for role in roles/artifactregistry.writer roles/storage.objectViewer roles/logging.logWriter; do
    g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$number-compute@developer.gserviceaccount.com" --role="$role" --condition=None >/dev/null
  done

  echo "Bundle bucket gs://$bucket (public read; the dashboard fetches from it)…"
  ensure g storage buckets create "gs://$bucket" --location="$REGION" --uniform-bucket-level-access
  g storage buckets add-iam-policy-binding "gs://$bucket" --member=allUsers --role=roles/storage.objectViewer >/dev/null
  g storage buckets add-iam-policy-binding "gs://$bucket" --member="serviceAccount:$sa" --role=roles/storage.objectAdmin >/dev/null
  # gcloud cannot read <(…) process substitution here, so go through temp files.
  local tmp
  tmp="$(mktemp -d)"
  echo '[{"origin":["*"],"method":["GET","HEAD"],"maxAgeSeconds":3600}]' >"$tmp/cors.json"
  echo '{"rule":[
    {"action":{"type":"Delete"},"condition":{"age":2,"matchesPrefix":["v/"]}},
    {"action":{"type":"Delete"},"condition":{"age":90,"matchesPrefix":["raw/"]}}]}' >"$tmp/lifecycle.json"
  g storage buckets update "gs://$bucket" --cors-file="$tmp/cors.json" --lifecycle-file="$tmp/lifecycle.json"
  rm -rf "$tmp"

  echo "DATABASE_URL in Secret Manager…"
  local url="postgres://$(get_env DB_USER):$(get_env DB_PASSWORD)@$(get_env DB_PRIVATE_HOST):5432/$(get_env DB_NAME)"
  if g secrets describe instruments-database-url >/dev/null 2>&1; then
    printf '%s' "$url" | g secrets versions add instruments-database-url --data-file=- >/dev/null
  else
    printf '%s' "$url" | g secrets create instruments-database-url --data-file=- --replication-policy=automatic >/dev/null
  fi
  g secrets add-iam-policy-binding instruments-database-url --member="serviceAccount:$sa" --role=roles/secretmanager.secretAccessor >/dev/null

  echo "Building the pipeline image with Cloud Build…"
  ensure g artifacts repositories create instruments --repository-format=docker --location="$REGION"
  g builds submit "$ROOT" --config="$ROOT/infra/gcp/cloudbuild.yaml" --substitutions=_IMAGE="$image"

  echo "Cloud Run jobs…"
  local name timeout
  for name in migrate ingest derive settle backfill; do
    timeout=900s
    [ "$name" = backfill ] && timeout=3600s
    g run jobs deploy "instruments-$name" --image="$image" --region="$REGION" --service-account="$sa" \
      --network="$NETWORK" --subnet="$SUBNET" --vpc-egress=all-traffic \
      --set-secrets=DATABASE_URL=instruments-database-url:latest --set-env-vars=BUNDLES_BUCKET="$bucket" \
      --args="$name" --tasks=1 --max-retries=1 --task-timeout="$timeout" --memory=1Gi --cpu=1 >/dev/null
  done

  echo "Schedules (UTC)…"
  local schedule
  for pair in "ingest|0 * * * *" "derive|5 * * * *" "settle|20 0 * * *"; do
    name="${pair%%|*}"; schedule="${pair#*|}"
    local uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/instruments-$name:run"
    if g scheduler jobs describe "instruments-$name" --location="$REGION" >/dev/null 2>&1; then
      g scheduler jobs update http "instruments-$name" --location="$REGION" --schedule="$schedule" --time-zone=UTC \
        --uri="$uri" --http-method=POST --oauth-service-account-email="$sa" >/dev/null
    else
      g scheduler jobs create http "instruments-$name" --location="$REGION" --schedule="$schedule" --time-zone=UTC \
        --uri="$uri" --http-method=POST --oauth-service-account-email="$sa" >/dev/null
    fi
  done

  echo "Done. Egress IP: $(g compute addresses describe instruments-nat-ip --region="$REGION" --format='value(address)')"
  echo "Bundles: https://storage.googleapis.com/$bucket/manifest.json (build the dashboard with VITE_BUNDLES_URL=https://storage.googleapis.com/$bucket)"
  echo "Next: $0 run migrate, then $0 run backfill, then $0 run derive."
}

run() {
  local name="${1:?usage: run <migrate|ingest|derive|settle|backfill>}"
  g run jobs execute "instruments-$name" --region="$REGION" --wait
}

case "${1:-}" in
  database) database ;;
  jobs) jobs ;;
  run) shift; run "$@" ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
