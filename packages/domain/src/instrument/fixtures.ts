import { Option } from "effect";

import type { BorrowState } from "./borrow";
import type { OptionQuote, OptionState } from "./option";
import type { PerpState } from "./perp";

export const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

export const perpState = (overrides: Partial<PerpState> = {}): PerpState => ({
  venueId: "hyperliquid",
  assetId: "BTC",
  observedAt: OBSERVED_AT,
  funding: {
    venueId: "hyperliquid",
    assetId: "BTC",
    periodStart: OBSERVED_AT,
    periodHours: 1,
    rate: 0.0000125, // 0.01% per 8h = 0.00125% per hour, the Hyperliquid interest floor
    premium: Option.none(),
    notionalPrice: 100_000,
    markPrice: Option.some(100_000),
  },
  marginTiers: [{ notionalUpTo: Option.none(), maxLeverage: 40, maintenanceMarginFraction: 0.0125 }],
  trailingFundingRate: Option.none(),
  fundingPeriodsPerYear: 8760,
  ...overrides,
});

export const borrowState = (overrides: Partial<BorrowState> = {}): BorrowState => ({
  venueId: "sofr",
  assetId: "ETH",
  observedAt: OBSERVED_AT,
  // 1 Jan is a holiday, so the rate for Wed 31 Dec is published Fri 2 Jan around 08:00 ET.
  rate: { effectiveDate: "2025-12-31", publishedAt: "2026-01-02T13:00:00.000Z", apr: 0.045, source: "SOFR", termDays: Option.none() },
  ...overrides,
});

export const call = (overrides: Partial<OptionQuote> = {}): OptionQuote => ({
  venueId: "deribit",
  assetId: "BTC",
  observedAt: OBSERVED_AT,
  style: "European",
  type: "Call",
  strike: 100_000,
  expiry: Option.some("2026-03-27T08:00:00.000Z"),
  premium: 8_000,
  impliedVol: Option.some(0.6),
  delta: Option.some(0.55),
  gamma: Option.none(),
  theta: Option.none(),
  underlyingPrice: 100_000,
  bid: Option.some(7_900),
  ask: Option.some(8_100),
  ...overrides,
});

export const optionState = (chain: ReadonlyArray<OptionQuote>, overrides: Partial<OptionState> = {}): OptionState => ({
  venueId: "deribit",
  assetId: "BTC",
  observedAt: OBSERVED_AT,
  style: "European",
  chain,
  underlyingPrice: 100_000,
  discountRate: Option.none(),
  ...overrides,
});
