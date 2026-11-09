# instruments

**Know what you are betting on** Type a ticker. See what it would have cost, and risked, to hold that exposure as a perpetual future, as spot bought with borrowed money, or as an option.

## Why

Leverage is a trade. Every instrument that gives you more exposure than your capital takes something back: a floating funding bill, a fixed interest bill, a premium that decays, or a liquidation that fires on someone else's schedule. Retail traders usually see only one of these at a time, on the venue they happen to be on, and so cannot tell what they are paying for the leverage they chose.

A market is *complete* when every risk you want to hold or shed has an instrument that prices it. Crypto is close: perps, on-chain lending, and options now exist for the same assets. But nobody puts them side by side for one ticker, over one horizon, with the same capital. This project does that.

## Framing

Fix the question: *long exposure to X, with capital C, for horizon H, entered on date D.* Then every instrument is a counterfactual under those four inputs.

| Instrument | Payoff | Carry | Capital tied up | How you lose it all |
|---|---|---|---|---|
| **Perpetual future** | linear | floating, set hourly by crowding | margin only | liquidation on the venue's mark price |
| **Spot + borrow** | linear | fixed or benchmark-tracking interest | full notional minus loan-to-value | liquidation when collateral falls below the lender's threshold |
| **Call option** | convex | premium paid upfront, decays with time | premium only | expires worthless, but can never be liquidated |

Read across a row and you see what that instrument trades away. Read down a column and you see the same risk priced three ways. The gap between rows at the entry price is the cost of each kind of certainty.

For each instrument the dashboard shows three charts on shared axes:

1. **Cumulative carry** over the holding period, as a percent of capital.
2. **Payoff at horizon** against terminal price, net of carry.
3. **Path risk**: the days the position would have been liquidated or margin-called along the realized path.

## Status

Early, with real data. An hourly pipeline ingests Hyperliquid perps (funding, prices, leverage caps), Deribit option chains and SOFR from the New York Fed, keeps a rolling 90 days in Postgres, and publishes one precomputed bundle per ticker. The dashboard loads a ticker's bundle once and runs the instrument models in the browser, so slider moves never touch the network. There is no synthetic fallback: a ticker without a market, or data that fails to load, shows why (with a retry for load failures) instead of numbers.

## How data flows

```
Hyperliquid ─┐                 :00 ingest   (1 call for every coin, 1 per Deribit currency, SOFR)
Deribit ─────┼─► Jobs Worker ─► Postgres, 90 days, ~120 MB ─► :05 derive ─► R2: v/<hour>/t/<TICKER>.json, manifest.json last
NY Fed ──────┘                 00:20 settle (settled funding + candles per coin; also gap repair)        │
                                                                                                    CDN ─► browser
```

- `packages/pipeline`: sources, storage, derive and publish. Writes are batched multi-row upserts that skip unchanged rows; derive reads one REPEATABLE READ snapshot.
- `apps/api/src/Jobs.ts`: the cron Worker. Nothing a viewer does reaches Postgres.
- `packages/domain/src/real.ts`: the comparison built from a bundle, run in the browser.

## Stack

- [Foldkit](https://foldkit.dev) on [Effect](https://effect.website) for the dashboard
- [Alchemy](https://alchemy.run) for Cloudflare Workers infrastructure as Effect programs
- Postgres with [Drizzle](https://orm.drizzle.team) for schema and queries
- [Quint](https://quint-lang.org) for executable specifications of the aggregation and analytics engines

## Develop

```sh
pnpm install
pnpm db up            # start Postgres in Docker
pnpm db migrate       # apply Drizzle migrations
pnpm dev              # dashboard at http://localhost:5173
pnpm db psql          # psql against the local database
pnpm spec             # typecheck and run the Quint specs
```

Real data locally (about 10 seconds for a few coins; drop `--coins` for every perp, rate-limited to stay inside Hyperliquid's per-IP budget):

```sh
pnpm --filter @instruments/pipeline cli all --coins BTC,ETH,SOL,HYPE   # ingest + 90-day backfill + derive
pnpm --filter @instruments/pipeline cli derive                         # rebuild bundles into apps/web/.bundles (served at /bundles by the dev server)
TEST_DATABASE_URL=postgres://… pnpm --filter @instruments/pipeline test  # includes the Postgres integration test (truncates tables)
```

## Self-hosting

The system needs four things, and the pipeline does not care who provides them:

| Need | What it does | GCP + GitHub Pages (deployed) | Cloudflare (alternative) | Anywhere else |
|---|---|---|---|---|
| Postgres 14+ | rolling 90 days, about 120 MB | Cloud SQL, private IP only | any host, through Hyperdrive | any host |
| A scheduler | ingest at :00, derive at :05, settle daily | Cloud Scheduler → Cloud Run jobs | Cron Triggers on the `Jobs` Worker | cron, systemd timers, Kubernetes CronJob |
| Object storage | bundles plus `manifest.json`, and 90 days of raw responses | Cloud Storage bucket, public read | R2 bucket | a directory, S3, any static host |
| A static host | the dashboard build | GitHub Pages | Workers static assets | nginx, Caddy, any CDN |

`packages/pipeline` is platform-neutral: its jobs take a Postgres connection, `fetch`, and an `ObjectStore` (one `put` method), and `src/cli.ts` is its single entry point. On GCP the CLI runs unchanged in a container. On Cloudflare, `apps/api/src/Jobs.ts` (about 60 lines) binds the same jobs to Workers.

### Option 1: GCP and GitHub Pages (what this repo deploys)

```
Cloud Scheduler ─► Cloud Run job (pipeline CLI) ─► Cloud SQL private IP        same VPC; the database has no public address
                                                 ├► Cloud NAT static IP ─► Hyperliquid, Deribit, NY Fed
                                                 └► gs://<project>-bundles ◄── the dashboard on GitHub Pages
```

The jobs share the database's private network, so nothing bridges into it. Cloud NAT gives them one static egress IP, so Hyperliquid's per-IP rate limit is ours alone. Expect roughly $13 a month, mostly Cloud SQL.

```sh
gcloud auth login
PROJECT=my-project infra/gcp/setup.sh database      # private VPC + Cloud SQL Postgres 17; writes DB_* to .env
PROJECT=my-project infra/gcp/setup.sh jobs          # NAT, bucket, Secret Manager, image (Cloud Build), jobs, schedules
PROJECT=my-project infra/gcp/setup.sh run migrate
PROJECT=my-project infra/gcp/setup.sh run backfill  # 90 days for every perp, ~45 min
PROJECT=my-project infra/gcp/setup.sh run derive
```

Then point the dashboard at the bucket and turn on Pages:

```sh
gh variable set BUNDLES_URL --body https://storage.googleapis.com/my-project-bundles
gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
```

`.github/workflows/pages.yml` builds and publishes the dashboard on every push to `main`. Re-run `setup.sh jobs` after changing the pipeline; it rebuilds the image and updates the jobs in place.

### Option 2: Cloudflare, with Alchemy

Alchemy needs Node 22.22.3+ or 24.11.1+ (`nvm use`). Sign in with `pnpm exec alchemy profile edit` using an **API token**, not the OAuth login: OAuth does not cover Hyperdrive or Tunnels. The token needs Workers Scripts, Workers R2 Storage, Hyperdrive and Cloudflare Tunnel (Edit), Connectivity Directory (Admin), and Account Settings (Read). Then:

1. Provision Postgres reachable from Cloudflare. Put its URL in `.env` as `HYPERDRIVE_ORIGIN_URL` and set `ALCHEMY_PASSWORD`. For a private database, set `DB_PRIVATE_HOST`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` instead. The stack then creates a Tunnel, a Workers VPC service and Hyperdrive's private origin, and you run `cloudflared` with the `dbTunnelToken` output on a host inside the database's network.
2. Migrate and backfill: `DATABASE_URL=… pnpm --filter @instruments/pipeline cli migrate`, then `… cli backfill`.
3. `pnpm deploy`. The stack outputs `bundlesUrl`. Build the dashboard with `VITE_BUNDLES_URL` set to it.

### Option 3: one machine, no cloud account

Any box with Node 22+, Postgres and cron. The dashboard and bundles are static files, so one web server serves both.

```sh
pnpm install && pnpm --filter web build                 # dashboard into apps/web/dist
export DATABASE_URL=postgres://user:pass@localhost:5432/instruments
pnpm db migrate
pnpm --filter @instruments/pipeline cli backfill        # 90 days for every perp (~45 min, rate-limited)
pnpm --filter @instruments/pipeline cli derive --out /srv/www/bundles
```

```cron
# m  h  * * *  command (run from the repo, with DATABASE_URL in the environment)
0    *  * * *  pnpm --filter @instruments/pipeline cli ingest
5    *  * * *  pnpm --filter @instruments/pipeline cli derive --out /srv/www/bundles
20   0  * * *  pnpm --filter @instruments/pipeline cli settle
30   0  * * *  find /srv/www/bundles/v -mindepth 1 -maxdepth 1 -mmin +2880 -exec rm -rf {} +
```

Serve `apps/web/dist` at `/` and `/srv/www/bundles` at `/bundles`. That is the dashboard's default `VITE_BUNDLES_URL`, so no build variable is needed. Cache `manifest.json` for a minute and everything under `bundles/v/` for a year: bundle folders are immutable per hour, and the manifest is what moves. The last cron line replaces R2's lifecycle rule. Raw responses land under `bundles/raw/`; delete them after 90 days, or don't serve that folder at all.

## License

MIT
