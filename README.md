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

Early. This repository holds the public framing, the infrastructure scaffold, and a mock dashboard with synthetic data. Data ingestion and the carry engine are specified first, in [`spec/`](./spec), then built.

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

Deploying to Cloudflare uses Alchemy: `pnpm alchemy login`, then `pnpm deploy`.

## License

MIT
