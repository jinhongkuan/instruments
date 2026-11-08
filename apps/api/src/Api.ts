// Api Worker: the composition root. Domain ports meet Cloudflare bindings here
// and nowhere else. Today the routes serve synthetic comparisons; the Hyperdrive
// binding is declared so the Postgres-backed engine slots in without touching
// the routes.
import * as Cloudflare from '@alchemy.run/cloudflare'
import { Effect } from 'effect'

import { routes } from './http'
import { Database } from './infra/resources'

export default Cloudflare.Worker(
  'Api',
  { main: import.meta.url },
  Effect.gen(function* () {
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(Database)
    return { fetch: routes(hyperdrive) }
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
)
