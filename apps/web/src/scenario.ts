import { Array, Option, pipe } from 'effect'

import { INSTRUMENT_KINDS, type InstrumentKind, type Scenario } from '@instruments/domain'

export const DEFAULT_SCENARIO: Scenario = {
  ticker: 'BTC',
  capitalUsd: 10_000,
  horizonDays: 90,
  entryDate: '2026-01-01',
}

const parsePositive = (input: string, fallback: number): number => {
  const parsed = Number(input.replace(/[^0-9.]/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const scenarioFromInputs = (inputs: {
  tickerInput: string
  capitalInput: string
  horizonInput: string
  entryDate: string
}): Scenario => ({
  ticker: inputs.tickerInput.trim().toUpperCase() || DEFAULT_SCENARIO.ticker,
  capitalUsd: parsePositive(inputs.capitalInput, DEFAULT_SCENARIO.capitalUsd),
  horizonDays: Math.min(730, Math.round(parsePositive(inputs.horizonInput, DEFAULT_SCENARIO.horizonDays))),
  entryDate: inputs.entryDate,
})

export const chartHostId = (kind: InstrumentKind): string => `chart-${kind}`

export const kindFromChartHostId = (hostId: string): Option.Option<InstrumentKind> =>
  pipe(
    INSTRUMENT_KINDS,
    Array.findFirst(kind => chartHostId(kind) === hostId),
  )
