// Cloudflare resource declarations. Inert until a Worker binds to them.
import * as Cloudflare from '@alchemy.run/cloudflare'
import { Redacted } from 'effect'

const LOCAL_DATABASE_URL = 'postgres://instruments:instruments@localhost:5433/instruments'

const parseOrigin = (url: string) => {
  const parsed = new URL(url)
  return {
    scheme: 'postgres' as const,
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.replace(/^\//, ''),
    user: decodeURIComponent(parsed.username),
    password: Redacted.make(decodeURIComponent(parsed.password)),
  }
}

const originUrl = process.env.HYPERDRIVE_ORIGIN_URL ?? LOCAL_DATABASE_URL

if (process.env.HYPERDRIVE_ORIGIN_URL === undefined) {
  console.warn('HYPERDRIVE_ORIGIN_URL is not set; Hyperdrive origin falls back to the local docker Postgres.')
}

/** Postgres reached through Hyperdrive. Locally, `alchemy dev` connects straight to docker. */
export const Database = Cloudflare.Hyperdrive.Connection('Database', {
  origin: parseOrigin(originUrl),
  dev: { ...parseOrigin(LOCAL_DATABASE_URL), sslmode: 'disable' },
})
