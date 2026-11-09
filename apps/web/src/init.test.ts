import { describe, expect, it } from 'vitest'

import { init } from './init'

describe('init', () => {
  it('starts with no numbers, loading market data, and no charts mounted', () => {
    const { model, commands } = init()
    expect(model.maybeComparison._tag).toBe('None')
    expect(model.dataSource._tag).toBe('LoadingMarketData')
    expect(model.mountedChartHostIds).toEqual([])
    expect(commands).toHaveLength(1)
  })
})
