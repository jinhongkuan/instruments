// Black–Scholes on the forward with zero rates (Black-76, undiscounted). This
// is how Deribit quotes: every expiry has its own forward as the underlying
// price, so no carry or discounting enters. Used to derive delta from mark IV,
// to mark a held contract at the horizon, and for ATM premium per tenor.

/** Standard normal CDF, Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7). */
export const normalCdf = (x: number): number => {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-(x * x) / 2)
  return 0.5 * (1 + (x < 0 ? -erf : erf))
}

const d1d2 = (forward: number, strike: number, years: number, vol: number): readonly [number, number] => {
  const sd = vol * Math.sqrt(years)
  const d1 = (Math.log(forward / strike) + (sd * sd) / 2) / sd
  return [d1, d1 - sd]
}

/** Call value per unit of underlying. At or past expiry it is intrinsic value. */
export const callPrice = (forward: number, strike: number, years: number, vol: number): number => {
  if (years <= 0 || vol <= 0) {
    return Math.max(0, forward - strike)
  }
  const [d1, d2] = d1d2(forward, strike, years, vol)
  return forward * normalCdf(d1) - strike * normalCdf(d2)
}

/** ∂C/∂F: the fraction of the underlying a call moves with. */
export const callDelta = (forward: number, strike: number, years: number, vol: number): number => {
  if (years <= 0 || vol <= 0) {
    return forward > strike ? 1 : 0
  }
  return normalCdf(d1d2(forward, strike, years, vol)[0])
}

/** Probability, under the pricing measure, that the call finishes out of the money. */
export const probabilityExpiresOtm = (forward: number, strike: number, years: number, vol: number): number => {
  if (years <= 0 || vol <= 0) {
    return forward > strike ? 0 : 1
  }
  return normalCdf(-d1d2(forward, strike, years, vol)[1])
}

/** ATM (strike = forward) call premium as a fraction of the forward: 2Φ(σ√T / 2) − 1. */
export const atmPremiumFraction = (years: number, vol: number): number =>
  years <= 0 || vol <= 0 ? 0 : 2 * normalCdf((vol * Math.sqrt(years)) / 2) - 1
