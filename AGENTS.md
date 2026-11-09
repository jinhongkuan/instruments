# instruments: agent notes

Read `README.md` for the framing. Layout:

- `apps/web`: Foldkit dashboard (Effect + Elm architecture). Read `apps/web/FOLDKIT.md` before editing it.
- `apps/api`: Cloudflare Workers written as Effect programs, deployed by Alchemy. `Api.ts` serves HTTP; `Jobs.ts` runs the data pipeline on Cron Triggers.
- `packages/pipeline`: ingest (Hyperliquid, Deribit, NY Fed), the 90-day Postgres store, derive, and publishing bundles. `src/cli.ts` runs the same jobs locally.
- `packages/domain`: Effect Schemas shared by web and api (instruments, scenarios, comparison results) plus the synthetic data used by the mock dashboard.
- `packages/db`: Drizzle schema, migrations, and a Postgres client factory.
- `spec/`: Quint specifications. Use the `quint-llm-kit` skills (`quint-modeling`, `quint-lang`, `quint-execute-spec`). Verify with `quint typecheck` then `quint run`; never `quint verify` unless asked.
- `alchemy.run.ts`: the infrastructure program. Every Cloudflare resource is declared by the Worker that binds to it.
- `scripts/db`: local Postgres helper (`pnpm db psql`, `pnpm db explain < query.sql`).

Conventions: Effect everywhere, no `any`, Schemas for anything that crosses a boundary. The dashboard never shows synthetic numbers: without a live `TickerBundle` (`packages/domain/src/bundle.ts`) it shows the reason and, for load failures, a retry. `packages/domain/src/mock.ts` remains only for the Cloudflare API Worker's `/compare` demo route.

Postgres rules for this repo: batch writes into a few multi-row statements; upserts skip unchanged rows (`IS DISTINCT FROM`); replace `latest_chain` with DELETE + INSERT in one transaction, never TRUNCATE; derive reads inside REPEATABLE READ READ ONLY; primary keys are the only indexes unless a measured query needs more.
