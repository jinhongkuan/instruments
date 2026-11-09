// Cloudflare resource declarations. Inert until a Worker binds to them.
//
// Postgres is reached through Hyperdrive in one of two ways, picked by env:
//
//   Private (DB_PRIVATE_HOST set): the database has no public address. A
//   Cloudflare Tunnel runs as `cloudflared` inside its network (see
//   infra/gcp/setup.sh), a Workers VPC TCP service points at the private IP
//   through that tunnel, and Hyperdrive egresses through the service.
//
//   Public (HYPERDRIVE_ORIGIN_URL set): Hyperdrive connects to the URL directly.
//
// With neither, Hyperdrive points at the local docker Postgres (dev only).
import * as Cloudflare from '@alchemy.run/cloudflare'
import { Effect, Redacted } from 'effect'

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

const devOrigin = { ...parseOrigin(LOCAL_DATABASE_URL), sslmode: 'disable' as const }

const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set when DB_PRIVATE_HOST is set (see infra/gcp/setup.sh)`)
  }
  return value
}

/** The tunnel `cloudflared` runs inside the database's network. Its token is a stack output. */
export const DbTunnel = Cloudflare.Tunnel.Tunnel('DbTunnel')

const privateDatabase = (host: string) =>
  Effect.gen(function* () {
    const tunnel = yield* DbTunnel
    const service = yield* Cloudflare.Connectivity.DirectoryService('Postgres', {
      type: 'tcp',
      tcpPort: 5432,
      appProtocol: 'postgresql',
      host: { ipv4: host, network: { tunnelId: tunnel.tunnelId } },
    })
    return yield* Cloudflare.Hyperdrive.Connection('Database', {
      origin: {
        scheme: 'postgres',
        serviceId: service.serviceId,
        database: requireEnv('DB_NAME'),
        user: requireEnv('DB_USER'),
        password: Redacted.make(requireEnv('DB_PASSWORD')),
      },
      dev: devOrigin,
    })
  })

const privateHost = process.env.DB_PRIVATE_HOST
const publicUrl = process.env.HYPERDRIVE_ORIGIN_URL

if (privateHost === undefined && publicUrl === undefined) {
  console.warn('Neither DB_PRIVATE_HOST nor HYPERDRIVE_ORIGIN_URL is set; Hyperdrive origin falls back to the local docker Postgres.')
}

export const usesPrivateDatabase = privateHost !== undefined

/** Postgres reached through Hyperdrive. Locally, `alchemy dev` connects straight to docker. */
export const Database =
  privateHost !== undefined
    ? privateDatabase(privateHost)
    : Cloudflare.Hyperdrive.Connection('Database', {
        origin: parseOrigin(publicUrl ?? LOCAL_DATABASE_URL),
        dev: devOrigin,
      })

/**
 * Per-ticker bundles and the manifest, served straight to browsers, plus 90
 * days of raw source responses for replay. Hourly bundle folders are dropped
 * after two days; the manifest only ever points at the newest one.
 */
export const Bundles = Cloudflare.R2.Bucket('Bundles', {
  publicAccess: true,
  cors: [{ allowedMethods: ['GET', 'HEAD'], allowedOrigins: ['*'] }],
  lifecycleRules: [
    { id: 'expire-old-bundle-hours', prefix: 'v/', deleteObjectsTransition: { condition: { type: 'Age', maxAge: 2 * 86_400 } } },
    { id: 'expire-raw-after-90-days', prefix: 'raw/', deleteObjectsTransition: { condition: { type: 'Age', maxAge: 90 * 86_400 } } },
  ],
})
