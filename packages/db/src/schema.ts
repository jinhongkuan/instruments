import {
  boolean,
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
} from 'drizzle-orm/pg-core'

// Reference data ----------------------------------------------------------

export const instrumentKind = pgEnum('instrument_kind', ['perp', 'spot_borrow', 'option'])

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
  table => [index('venue_instruments_lookup').on(table.venueId, table.venueSymbol, table.validFrom)],
)

// Time series -------------------------------------------------------------
// NOTE: these tables will be range-partitioned by month in a hand-written
// migration once volumes justify it. Drizzle does not express partitioning.

/** Hourly perp funding as recorded by the venue. Rate is the hourly rate actually charged. */
export const fundingRates = pgTable(
  'funding_rates',
  {
    venueInstrumentId: integer('venue_instrument_id').notNull().references(() => venueInstruments.id),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    rate: doublePrecision('rate').notNull(),
    premium: doublePrecision('premium'),
    oraclePrice: doublePrecision('oracle_price'),
  },
  table => [primaryKey({ columns: [table.venueInstrumentId, table.hour] })],
)

/** Lending market borrow rate snapshots, annualized. */
export const borrowRates = pgTable(
  'borrow_rates',
  {
    venueInstrumentId: integer('venue_instrument_id').notNull().references(() => venueInstruments.id),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    borrowApr: doublePrecision('borrow_apr').notNull(),
    supplyApr: doublePrecision('supply_apr'),
    liquidationLtv: doublePrecision('liquidation_ltv'),
  },
  table => [primaryKey({ columns: [table.venueInstrumentId, table.observedAt] })],
)

export const optionType = pgEnum('option_type', ['call', 'put'])

/** Option chain quotes. Expect this to be the largest table by far. */
export const optionQuotes = pgTable(
  'option_quotes',
  {
    venueInstrumentId: integer('venue_instrument_id').notNull().references(() => venueInstruments.id),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    expiry: timestamp('expiry', { withTimezone: true }).notNull(),
    strike: doublePrecision('strike').notNull(),
    type: optionType('type').notNull(),
    bid: doublePrecision('bid'),
    ask: doublePrecision('ask'),
    mark: doublePrecision('mark'),
    impliedVol: doublePrecision('implied_vol'),
    underlyingPrice: doublePrecision('underlying_price'),
  },
  table => [
    primaryKey({
      columns: [table.venueInstrumentId, table.observedAt, table.expiry, table.strike, table.type],
    }),
    index('option_quotes_by_expiry').on(table.venueInstrumentId, table.expiry, table.observedAt),
  ],
)

/** Daily reference prices per asset, used for payoff and equity paths. */
export const dailyPrices = pgTable(
  'daily_prices',
  {
    assetId: integer('asset_id').notNull().references(() => assets.id),
    day: timestamp('day', { withTimezone: true }).notNull(),
    open: doublePrecision('open').notNull(),
    high: doublePrecision('high').notNull(),
    low: doublePrecision('low').notNull(),
    close: doublePrecision('close').notNull(),
    source: text('source').notNull(),
  },
  table => [primaryKey({ columns: [table.assetId, table.day] })],
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
