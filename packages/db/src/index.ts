import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

export { schema }

/**
 * Build a Drizzle client from a connection string. In Cloudflare Workers pass
 * the Hyperdrive binding's `connectionString`; locally pass `DATABASE_URL`.
 */
export const makeDb = (connectionString: string) =>
  drizzle(postgres(connectionString, { max: 5, prepare: false }), { schema })

export type Db = ReturnType<typeof makeDb>
