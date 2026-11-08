// HTTP adapter: URL in, domain call, JSON out. Knows nothing about Cloudflare.
import * as Cloudflare from '@alchemy.run/cloudflare'
import { Effect, Redacted, Schema } from 'effect'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import { Comparison, Scenario, mockComparison } from '@instruments/domain'

const usage = `instruments api

  GET /health
  GET /db/health          (reports whether a Hyperdrive connection string is bound)
  GET /compare/:ticker?capital=10000&horizon=90&entry=2026-01-01
`

const encodeComparison = Schema.encodeSync(Comparison)

const parseScenario = (ticker: string, params: URLSearchParams) =>
  Schema.decodeUnknownEffect(Scenario)({
    ticker: ticker.toUpperCase(),
    capitalUsd: Number(params.get('capital') ?? 10_000),
    horizonDays: Number(params.get('horizon') ?? 90),
    entryDate: params.get('entry') ?? '2026-01-01',
  })

export const routes = (hyperdrive: Cloudflare.Hyperdrive.ConnectClient) =>
  Effect.gen(function* () {
  const request = yield* HttpServerRequest
  const url = new URL(request.url, 'http://localhost')

  if (request.method === 'GET' && url.pathname === '/') {
    return HttpServerResponse.text(usage)
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    return yield* HttpServerResponse.json({ ok: true, synthetic: true })
  }
  if (request.method === 'GET' && url.pathname === '/db/health') {
    const connectionString = yield* hyperdrive.connectionString
    const host = yield* hyperdrive.host
    return yield* HttpServerResponse.json({
      bound: Redacted.value(connectionString).length > 0,
      host,
    })
  }
  const match = /^\/compare\/([A-Za-z0-9:-]+)$/.exec(url.pathname)
  if (request.method === 'GET' && match) {
    const scenario = yield* parseScenario(match[1]!, url.searchParams)
    return yield* HttpServerResponse.json(encodeComparison(mockComparison(scenario)))
  }
  return HttpServerResponse.text('Not found', { status: 404 })
  }).pipe(
    Effect.catchTag('SchemaError', error =>
      HttpServerResponse.json({ error: String(error) }, { status: 400 }),
    ),
  )
