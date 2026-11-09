import { describe, expect, it } from 'vitest'

import type { Manifest, TickerBundle } from '@instruments/domain'

import { init } from './init'
import { Message } from './message'
import { update } from './update'

const manifest: Manifest = { version: 1, generatedAt: '2026-11-09T04:05:00.000Z', prefix: 'v/2026-11-09T04', tickers: ['BTC', 'ETH'] }

const bundle: TickerBundle = {
  version: 1,
  ticker: 'BTC',
  generatedAt: '2026-11-09T04:05:00.000Z',
  conventionsVersion: '2026-11-v1',
  perp: {
    venue: 'Hyperliquid',
    venueSymbol: 'BTC',
    maxLeverage: 40,
    maintenanceMarginFraction: 0.0125,
    fundingRateHourly: 0.0000125,
    latestFundingSettled: false,
    markPrice: 75_000,
    dayNotionalVolumeUsd: 2_200_000_000,
    openInterestUsd: 3_100_000_000,
    historyHours: 2160,
    maxHorizonDays: 30,
    fundingWindows: [{ horizonDays: 14, windows: 1800, independent: 6, p10: 0.001, p50: 0.002, p90: 0.003 }],
    ruinCurves: [{ leverage: 5, byHorizon: [{ days: 14, probability: 0.01, starts: 1800 }] }],
    realizedVol: 0.37,
  },
  option: null,
  benchmark: { source: 'SOFR', apr: 0.0392, effectiveDate: '2026-11-05', publishedAt: '2026-11-06T13:00:00.000Z' },
  sources: [{ source: 'hyperliquid', asOf: '2026-11-09T05:00:00.000Z' }],
}

const comparisonOf = (model: ReturnType<typeof init>['model']) => {
  if (model.maybeComparison._tag === 'None') throw new Error('expected a comparison')
  return model.maybeComparison.value
}

describe('market data loading', () => {
  it('fetches the bundle once the manifest lists the ticker, then draws real data', () => {
    const listed = update(init().model, Message.SucceededFetchManifest({ manifest }))
    expect(listed.model.dataSource._tag).toBe('LoadingMarketData')
    expect(listed.model.maybeComparison._tag).toBe('None')
    expect(listed.commands?.length).toBeGreaterThan(0)
    const loaded = update(listed.model, Message.SucceededFetchBundle({ bundle }))
    expect(loaded.model.dataSource._tag).toBe('Live')
    expect(comparisonOf(loaded.model).synthetic).toBe(false)
    expect(comparisonOf(loaded.model).instruments[0]!.carryBand.basis).toMatch(/realized 14-day funding/)
  })

  it('a slider move recomputes from the same bundle without a fetch', () => {
    const live = update(update(init().model, Message.SucceededFetchManifest({ manifest })).model, Message.SucceededFetchBundle({ bundle })).model
    const moved = update(live, Message.UpdatedLeverageSlider({ position: 0.5 }))
    expect(moved.commands?.some(command => command.name === 'FetchBundle') ?? false).toBe(false)
    expect(comparisonOf(moved.model).instruments[0]!.exposureMultiple).not.toBe(comparisonOf(live).instruments[0]!.exposureMultiple)
  })

  it('a ticker with no market shows no numbers and offers no retry', () => {
    const listed = update(init().model, Message.SucceededFetchManifest({ manifest })).model
    const unknown = update(listed, Message.UpdatedTickerInput({ value: 'ZZZ' })).model
    expect(unknown.maybeComparison._tag).toBe('None')
    expect(unknown.dataSource).toMatchObject({ _tag: 'Unavailable', retryable: false })
  })

  it('a failed fetch shows no numbers and offers a retry that refetches the manifest', () => {
    const failed = update(init().model, Message.FailedFetchManifest({ reason: 'HTTP 404' })).model
    expect(failed.maybeComparison._tag).toBe('None')
    expect(failed.dataSource).toMatchObject({ _tag: 'Unavailable', retryable: true })
    const retried = update(failed, Message.ClickedRetryMarketData())
    expect(retried.model.dataSource._tag).toBe('LoadingMarketData')
    expect(retried.commands?.map(command => command.name)).toEqual(['FetchManifest'])
  })

  it('ignores a late bundle for a ticker the user already left', () => {
    const listed = update(init().model, Message.SucceededFetchManifest({ manifest })).model
    const moved = update(listed, Message.UpdatedTickerInput({ value: 'ETH' })).model
    const late = update(moved, Message.SucceededFetchBundle({ bundle }))
    expect(late.model.dataSource._tag).toBe('LoadingMarketData')
    expect(late.model.maybeComparison._tag).toBe('None')
  })
})
