// Infrastructure program. Names the provider and state store, then yields the
// Workers; every other resource (Hyperdrive, buckets, queues) is pulled in by
// what the Workers bind to. Run with `pnpm infra:dev`, `pnpm deploy`, `pnpm destroy`.
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import { Effect } from 'effect'

import Api from './apps/api/src/Api.ts'

export default Alchemy.Stack(
  'instruments',
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    const api = yield* Api
    const web = yield* Cloudflare.Website.Foldkit('Web', { rootDir: 'apps/web' })

    return {
      stage,
      apiUrl: api.url,
      webUrl: web.url,
    }
  }),
)
