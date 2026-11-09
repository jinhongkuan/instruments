// Infrastructure program. Names the provider and state store, then yields the
// Workers; every other resource (Hyperdrive, buckets, queues) is pulled in by
// what the Workers bind to. Run with `pnpm infra:dev`, `pnpm deploy`, `pnpm destroy`.
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import { Effect } from 'effect'

import Api from './apps/api/src/Api.ts'
import Jobs from './apps/api/src/Jobs.ts'
import { Bundles, DbTunnel, usesPrivateDatabase } from './apps/api/src/infra/resources.ts'

export default Alchemy.Stack(
  'instruments',
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const api = yield* Api
    const jobs = yield* Jobs
    const bundles = yield* Bundles
    // cloudflared inside the database's network runs with this token (infra/gcp/setup.sh reads it).
    const dbTunnel = usesPrivateDatabase ? yield* DbTunnel : undefined
    // The dashboard reads bundles from this bucket. Build it with VITE_BUNDLES_URL set to bundlesUrl.
    const web = yield* Cloudflare.Website.Foldkit('Web', { rootDir: 'apps/web' })

    return {
      stage,
      apiUrl: api.url,
      jobsUrl: jobs.url,
      bundlesUrl: bundles.publicDomain,
      dbTunnelId: dbTunnel?.tunnelId,
      dbTunnelToken: dbTunnel?.token,
      webUrl: web.url,
    }
  }),
)
