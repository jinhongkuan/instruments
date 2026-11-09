import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// Reference data ----------------------------------------------------------

export const instrumentKind = pgEnum('instrument_kind', ['perp', 'benchmark', 'option'])

/** Canonical asset, independent of any venue's naming. */
export const assets = pgTable('assets', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull().unique(),
  name: text('name').notNull(),
})

export const venues = pgTable('venues', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  kind: instrumentKind('kind').notNull(),
})

/**
 * A venue's listing of an asset, with a validity range so renames, delistings,
 * and HIP-3 namespace collisions do not corrupt history.
 */
export const venueInstruments = pgTable(
  'venue_instruments',
  {
    id: serial('id').primaryKey(),
    venueId: integer('venue_id').notNull().references(() => venues.id),
    assetId: integer('asset_id').notNull().references(() => assets.id),
    venueSymbol: text('venue_symbol').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  table => [
    index('venue_instruments_lookup').on(table.venueId, table.venueSymbol, table.validFrom),
    // At most one open listing per venue symbol; closed rows keep history for renamed or reused tickers.
    uniqueIndex('venue_instruments_open_symbol').on(table.venueId, table.venueSymbol).where(sql`valid_to is null`),
  ],
)

// Time series -------------------------------------------------------------
// Every time series keeps a rolling 90 days (RETENTION_DAYS); ingest deletes
// older rows each run. At ~120 MB steady state, partitioning is not worth it.

export const RETENTION_DAYS = 90

/**
 * Hourly perp funding. `settled` is false while the value comes from the
 * hourly all-coin snapshot (the venue's current rate); the daily per-coin pull
 * overwrites it with the rate actually charged and sets it true.
 */
export const fundingRates = pgTable(
  'funding_rates',
  {
    venueInstrumentId: integer('venue_instrument_id').notNull().references(() => venueInstruments.id),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    rate: doublePrecision('rate').notNull(),
    premium: doublePrecision('premium'),
    oraclePrice: doublePrecision('oracle_price'),
    settled: boolean('settled').notNull().default(true),
  },
  table => [primaryKey({ columns: [table.venueInstrumentId, table.hour] })],
)

/**
 * Dollar interest rate benchmark (SOFR, T-bill, stablecoin term rate). Spot +
 * borrow is modeled as unlimited credit at this rate, so no lending-market
 * tables are needed. Keyed by the business day the rate describes, so a
 * same-day revision from the publisher overwrites the row it corrects.
 */
export const benchmarkRates = pgTable(
  'benchmark_rates',
  {
    source: text('source').notNull(),
    /** Business day the rate describes. It applies until the next business day, so Friday covers the weekend. */
    effectiveDate: date('effective_date').notNull(),
    apr: doublePrecision('apr').notNull(),
    termDays: integer('term_days'),
    /** When ingest first saw the value; at least one business day after effective_date for SOFR. */
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    /** Set when the publisher revised the value after it was first stored. */
    revisedAt: timestamp('revised_at', { withTimezone: true }),
  },
  table => [primaryKey({ columns: [table.source, table.effectiveDate] })],
)

export const optionType = pgEnum('option_type', ['call', 'put'])

/**
 * The newest snapshot of every listed option contract per underlying: one row
 * per contract, replaced wholesale each hour (DELETE + INSERT in one
 * transaction, so readers see the old chain or the new one, never a mix).
 * Prices are in USD per unit of underlying, converted from coin for inverse
 * contracts. Full chain history is kept only as raw JSON in object storage.
 */
export const latestChain = pgTable(
  'latest_chain',
  {
    venueInstrumentId: integer('venue_instrument_id').notNull().references(() => venueInstruments.id),
    instrumentName: text('instrument_name').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiry: timestamp('expiry', { withTimezone: true }).notNull(),
    strike: doublePrecision('strike').notNull(),
    type: optionType('type').notNull(),
    markUsd: doublePrecision('mark_usd').notNull(),
    bidUsd: doublePrecision('bid_usd'),
    askUsd: doublePrecision('ask_usd'),
    /** Annualized implied volatility as a fraction (0.44, not 44). */
    markIv: doublePrecision('mark_iv').notNull(),
    /** Forward for the contract's expiry, which is what the venue prices against. */
    underlyingPrice: doublePrecision('underlying_price').notNull(),
  },
  table => [primaryKey({ columns: [table.venueInstrumentId, table.instrumentName] })],
)

/**
 * At-the-money implied volatility and premium per fixed tenor, one point per
 * underlying per hour. Interpolated in total variance between the listed
 * expiries that bracket the tenor. The only option history kept in Postgres:
 * it cannot be rebuilt later, because the venue keeps no quote history.
 */
export const atmByTenor = pgTable(
  'atm_by_tenor',
  {
    venueInstrumentId: integer('venue_instrument_id').notNull().references(() => venueInstruments.id),
    tenorDays: integer('tenor_days').notNull(),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    iv: doublePrecision('iv').notNull(),
    /** ATM call premium as a fraction of the underlying, at exactly this tenor. */
    premiumFraction: doublePrecision('premium_fraction').notNull(),
  },
  table => [primaryKey({ columns: [table.venueInstrumentId, table.tenorDays, table.hour] })],
)

/** Hourly OHLC per perp listing, from the venue's own candles. Lows feed the liquidation-touch test. */
export const pricesHourly = pgTable(
  'prices_hourly',
  {
    venueInstrumentId: integer('venue_instrument_id').notNull().references(() => venueInstruments.id),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    open: doublePrecision('open').notNull(),
    high: doublePrecision('high').notNull(),
    low: doublePrecision('low').notNull(),
    close: doublePrecision('close').notNull(),
  },
  table => [primaryKey({ columns: [table.venueInstrumentId, table.hour] })],
)

// Model parameters ----------------------------------------------------------

/**
 * Versioned parameters for the counterfactual engine (trailing window, dealer
 * spread, leverage assumptions). Every computed result is stamped with the
 * version it used, so parameter changes never silently rewrite history.
 */
export const parameterVersions = pgTable('parameter_versions', {
  id: serial('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  active: boolean('active').notNull().default(false),
  description: text('description').notNull(),
  parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull(),
})
