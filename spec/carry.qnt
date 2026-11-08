// Carry ledger: one account, one asset, long only.
// Integers throughout: sizes in units, rates in basis points per hour.
// Floating carry accrues at the venue's hourly rate on the whole position.
// Fixed carry accrues per lot at the rate frozen when that lot was opened.
module carry {
  const MAX_SIZE: int
  const RATES: Set[int]

  type Lot = { size: int, entryRateBps: int }

  var lots: List[Lot]
  var positionSize: int
  var floatingPaidBps: int
  var fixedPaidBps: int
  var currentRateBps: int

  pure def sumSizes(ls: List[Lot]): int =
    ls.foldl(0, (acc, l) => acc + l.size)

  pure def fixedAccrual(ls: List[Lot]): int =
    ls.foldl(0, (acc, l) => acc + l.size * l.entryRateBps)

  // Close q units FIFO. Lots are kept in open order.
  pure def closeFifo(ls: List[Lot], q: int): List[Lot] =
    ls.foldl({ remaining: q, kept: [] }, (acc, l) =>
      if (acc.remaining <= 0)
        { remaining: 0, kept: acc.kept.append(l) }
      else if (l.size <= acc.remaining)
        { remaining: acc.remaining - l.size, kept: acc.kept }
      else
        { remaining: 0, kept: acc.kept.append({ size: l.size - acc.remaining, entryRateBps: l.entryRateBps }) }
    ).kept

  action init = all {
    lots' = [],
    positionSize' = 0,
    floatingPaidBps' = 0,
    fixedPaidBps' = 0,
    currentRateBps' = 0,
  }

  // A fill that adds to the position opens a lot at the rate prevailing now.
  action open(q: int): bool = all {
    q > 0,
    positionSize + q <= MAX_SIZE,
    lots' = lots.append({ size: q, entryRateBps: currentRateBps }),
    positionSize' = positionSize + q,
    floatingPaidBps' = floatingPaidBps,
    fixedPaidBps' = fixedPaidBps,
    currentRateBps' = currentRateBps,
  }

  // A fill that reduces the position closes lots FIFO.
  action reduce(q: int): bool = all {
    q > 0,
    q <= positionSize,
    lots' = closeFifo(lots, q),
    positionSize' = positionSize - q,
    floatingPaidBps' = floatingPaidBps,
    fixedPaidBps' = fixedPaidBps,
    currentRateBps' = currentRateBps,
  }

  // One funding hour passes at the current rate; then the rate may move.
  action accrueHour(nextRate: int): bool = all {
    floatingPaidBps' = floatingPaidBps + positionSize * currentRateBps,
    fixedPaidBps' = fixedPaidBps + fixedAccrual(lots),
    currentRateBps' = nextRate,
    lots' = lots,
    positionSize' = positionSize,
  }

  action step = any {
    { nondet q = 1.to(MAX_SIZE).oneOf()
      open(q) },
    { nondet q = 1.to(MAX_SIZE).oneOf()
      reduce(q) },
    { nondet r = RATES.oneOf()
      accrueHour(r) },
  }

  // Invariants -------------------------------------------------------------

  val positionMatchesLots = positionSize == sumSizes(lots)
  val lotsArePositive = lots.foldl(true, (acc, l) => acc and l.size > 0)
  val sizeBounded = positionSize >= 0 and positionSize <= MAX_SIZE
  val allInvariants = positionMatchesLots and lotsArePositive and sizeBounded

  // Witness: the two carry legs do diverge, so the counterfactual is not trivially zero.
  val legsDiverge = floatingPaidBps != fixedPaidBps
}

module carry_spec {
  import carry(MAX_SIZE = 5, RATES = Set(-2, 0, 1, 3)).*
}
