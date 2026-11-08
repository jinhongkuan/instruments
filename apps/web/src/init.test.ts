import { describe, expect, it } from 'vitest'

import { init } from './init'

describe('init', () => {
  it('starts with one result per instrument on synthetic data', () => {
    const { model } = init()
    expect(model.comparison.instruments.map(result => result.kind)).toEqual(['Perp', 'SpotBorrow', 'Option'])
    expect(model.comparison.synthetic).toBe(true)
    expect(model.mountedChartHostIds).toEqual([])
  })
})
