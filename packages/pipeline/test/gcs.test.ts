import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { gcsStore } from '../src/gcs'

describe('GCS object store', () => {
  it('fetches a token from the metadata server once and PUTs with cache headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = async (url: string, init?: RequestInit) => {
      calls.push(init === undefined ? { url } : { url, init })
      if (url.includes('metadata.google.internal')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
      }
      return new Response('', { status: 200 })
    }
    const store = gcsStore('bucket-x', fakeFetch)
    await Effect.runPromise(store.put('v/2026-11-09T05/t/BTC.json', '{}', { contentType: 'application/json', cacheControl: 'public, max-age=60' }))
    await Effect.runPromise(store.put('manifest.json', '{}', { contentType: 'application/json', cacheControl: 'public, max-age=60' }))
    expect(calls.filter(c => c.url.includes('metadata'))).toHaveLength(1)
    const put = calls.find(c => c.url.endsWith('/t/BTC.json'))!
    expect(put.url).toBe('https://storage.googleapis.com/bucket-x/v/2026-11-09T05/t/BTC.json')
    expect(put.init?.method).toBe('PUT')
    expect((put.init?.headers as Record<string, string>)['cache-control']).toBe('public, max-age=60')
  })

  it('fails the write when GCS refuses it', async () => {
    const fakeFetch = async (url: string) =>
      url.includes('metadata') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })) : new Response('denied', { status: 403 })
    const result = await Effect.runPromise(Effect.result(gcsStore('b', fakeFetch).put('k', 'v', { contentType: 'a', cacheControl: 'c' })))
    expect(result._tag).toBe('Failure')
  })
})
