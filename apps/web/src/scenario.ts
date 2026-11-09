import type { Scenario } from '@instruments/domain'

export const DEFAULT_SCENARIO: Scenario = {
  ticker: 'BTC',
  capitalUsd: 10_000,
  horizonDays: 14,
  entryDate: '2026-01-01',
  leverage: 3,
}

/** A log-scale slider axis: position in [0, 1] <-> value in [min, max]. */
export type LogAxis = Readonly<{ min: number; max: number }>

export const LEVERAGE_AXIS: LogAxis = { min: 1, max: 50 }
// Real funding and ruin history covers 90 days, enough for horizons up to about 30 days.
export const HORIZON_AXIS: LogAxis = { min: 1, max: 60 }

export const valueFromSlider = (axis: LogAxis, position: number): number =>
  Math.exp(Math.log(axis.min) + Math.min(1, Math.max(0, position)) * (Math.log(axis.max) - Math.log(axis.min)))

export const sliderFromValue = (axis: LogAxis, value: number): number =>
  (Math.log(Math.min(axis.max, Math.max(axis.min, value))) - Math.log(axis.min)) /
  (Math.log(axis.max) - Math.log(axis.min))

/** Soft snap down: if a pin sits just below the requested value, land on it. */
export const softSnapDown = (requested: number, pins: ReadonlyArray<number>, relativeWindow: number): number =>
  pins
    .filter(pin => pin <= requested && (requested - pin) / requested <= relativeWindow)
    .sort((a, b) => b - a)[0] ?? requested

/** Soft snap to the nearest pin in either direction within the window. */
export const softSnapNearest = (requested: number, pins: ReadonlyArray<number>, relativeWindow: number): number =>
  pins
    .filter(pin => Math.abs(pin - requested) / requested <= relativeWindow)
    .sort((a, b) => Math.abs(a - requested) - Math.abs(b - requested))[0] ?? requested

export const KNOWN_TICKERS: ReadonlyArray<string> = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'BNB', 'AVAX', 'LINK', 'ARB']

export const normalizeTicker = (input: string): string =>
  input.trim().toUpperCase().replace(/[^A-Z0-9:-]/g, '')

export const CHART_HOST_ID = 'chart-combined'
