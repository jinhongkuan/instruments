# instruments: agent notes

Read `README.md` for the framing. Layout:

- `apps/web`: Foldkit dashboard (Effect + Elm architecture). Read `apps/web/FOLDKIT.md` before editing it.
- `apps/api`: Cloudflare Worker written as an Effect program, deployed by Alchemy.
- `packages/domain`: Effect Schemas shared by web and api (instruments, scenarios, comparison results) plus the synthetic data used by the mock dashboard.
- `packages/db`: Drizzle schema, migrations, and a Postgres client factory.
- `spec/`: Quint specifications. Use the `quint-llm-kit` skills (`quint-modeling`, `quint-lang`, `quint-execute-spec`). Verify with `quint typecheck` then `quint run`; never `quint verify` unless asked.
- `alchemy.run.ts`: the infrastructure program. Every Cloudflare resource is declared by the Worker that binds to it.
- `scripts/db`: local Postgres helper (`pnpm db psql`, `pnpm db explain < query.sql`).

Conventions: Effect everywhere, no `any`, Schemas for anything that crosses a boundary. Mock data lives only in `packages/domain/src/mock.ts` and is replaced, not extended, when real ingestion lands.
