import { Array, Option, pipe } from 'effect'

import { INSTRUMENT_KINDS, type InstrumentKind, type Scenario } from '@instruments/domain'

export const DEFAULT_SCENARIO: Scenario = {
  ticker: 'BTC',
  capitalUsd: 10_000,
  horizonDays: 90,
  entryDate: '2026-01-01',
  leverage: 3,
}

export const LEVERAGE_MIN = 1
export const LEVERAGE_MAX = 50

/** Slider position in [0, 1] <-> leverage on a log scale. */
export const leverageFromSlider = (position: number): number =>
  Math.exp(Math.log(LEVERAGE_MIN) + position * (Math.log(LEVERAGE_MAX) - Math.log(LEVERAGE_MIN)))

export const sliderFromLeverage = (leverage: number): number =>
  (Math.log(leverage) - Math.log(LEVERAGE_MIN)) / (Math.log(LEVERAGE_MAX) - Math.log(LEVERAGE_MIN))

/** Soft snap: if a discrete pin sits just below the requested value, land on it. */
export const softSnapDown = (requested: number, pins: ReadonlyArray<number>, relativeWindow: number): number =>
  pins
    .filter(pin => pin <= requested && (requested - pin) / requested <= relativeWindow)
    .sort((a, b) => b - a)[0] ?? requested

const parsePositive = (input: string, fallback: number): number => {
  const parsed = Number(input.replace(/[^0-9.]/g, ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const scenarioFromInputs = (inputs: {
  tickerInput: string
  capitalInput: string
  horizonInput: string
  entryDate: string
  leverage: number
}): Scenario => ({
  ticker: inputs.tickerInput.trim().toUpperCase() || DEFAULT_SCENARIO.ticker,
  capitalUsd: parsePositive(inputs.capitalInput, DEFAULT_SCENARIO.capitalUsd),
  horizonDays: Math.min(730, Math.round(parsePositive(inputs.horizonInput, DEFAULT_SCENARIO.horizonDays))),
  entryDate: inputs.entryDate,
  leverage: inputs.leverage,
})

export const chartHostId = (kind: InstrumentKind): string => `chart-${kind}`

export const kindFromChartHostId = (hostId: string): Option.Option<InstrumentKind> =>
  pipe(
    INSTRUMENT_KINDS,
    Array.findFirst(kind => chartHostId(kind) === hostId),
  )
