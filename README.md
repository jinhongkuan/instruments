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

Early, with real data. An hourly pipeline ingests Hyperliquid perps (funding, prices, leverage caps), Deribit option chains and SOFR from the New York Fed, keeps a rolling 90 days in Postgres, and publishes one precomputed bundle per ticker. The dashboard loads a ticker's bundle once and runs the instrument models in the browser, so slider moves never touch the network. Tickers without a bundle fall back to the synthetic model, and the footer says which you are looking at.

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

The system needs four things, and only one file knows which platform provides them:

| Need | What it does | Cloudflare (default) | Anywhere else |
|---|---|---|---|
| Postgres 14+ | rolling 90 days, about 120 MB | any host, reached through Hyperdrive | any host |
| A scheduler | ingest at :00, derive at :05, settle daily | Cron Triggers on the `Jobs` Worker | cron, systemd timers, Kubernetes CronJob |
| Object storage | bundles plus `manifest.json`, and 90 days of raw responses | R2 bucket | a directory, S3, any static host |
| A static host | the dashboard build | Workers static assets | nginx, Caddy, any CDN |

`packages/pipeline` is platform-neutral: its jobs take a Postgres connection, `fetch`, and an `ObjectStore` (one `put` method). `apps/api/src/Jobs.ts` (about 60 lines) is the only place that binds them to Cloudflare. Moving to another provider means writing that file again for its scheduler and object store, plus adding the provider's resources to `alchemy.run.ts`. Nothing else changes.

### Option 1: Cloudflare, with Alchemy

Alchemy needs Node 22.22.3+ or 24.11.1+ (`nvm use`).

1. Sign in once: `pnpm exec alchemy profile edit`. Add a Cloudflare account; it opens the browser. Check it with `pnpm exec alchemy profile show`.
2. Provision Postgres reachable from Cloudflare (Neon, Supabase, RDS, your own). Put its URL in `.env` as `HYPERDRIVE_ORIGIN_URL`, and set `ALCHEMY_PASSWORD`.
3. Migrate and backfill it: `DATABASE_URL=$HYPERDRIVE_ORIGIN_URL pnpm db migrate`, then `DATABASE_URL=$HYPERDRIVE_ORIGIN_URL pnpm --filter @instruments/pipeline cli backfill`.
4. `pnpm deploy`. The stack outputs `bundlesUrl`. Deploy again with `VITE_BUNDLES_URL` set to it, so the dashboard reads from the bucket. Only the first deploy needs this second pass.

**Private database (recommended).** Keep Postgres off the internet and let Hyperdrive reach it through a Cloudflare Tunnel:

```
Hyperdrive ─► Workers VPC service ─► Tunnel ─► cloudflared (small VM in the database's network) ─► Postgres private IP
```

When `DB_PRIVATE_HOST` is set, `alchemy.run.ts` creates the Tunnel, the VPC service and Hyperdrive's private origin. `infra/gcp/setup.sh` provisions the GCP side: a private VPC, Cloud SQL Postgres 17 with no public IP, an `e2-micro` running `cloudflared`, and SSH reachable only through IAP. Expect roughly $10–20 a month.

```sh
PROJECT=my-project infra/gcp/setup.sh database   # writes DB_PRIVATE_HOST, DB_NAME, DB_USER, DB_PASSWORD to .env
pnpm deploy                                       # outputs dbTunnelToken
TUNNEL_TOKEN=… PROJECT=my-project infra/gcp/setup.sh tunnel
PROJECT=my-project infra/gcp/setup.sh forward    # localhost:15432 → Cloud SQL; run migrate and backfill against it
```

The same shape works for AWS RDS: run `cloudflared` on an instance in the RDS VPC and set `DB_PRIVATE_HOST` to the RDS private IP.

### Option 2: one machine, no cloud account

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
