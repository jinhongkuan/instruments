import { Effect } from 'effect'

import type { ObjectStore } from './publish'
import type { Fetch } from './sources/http'

// Google Cloud Storage as an ObjectStore, over the XML API with plain fetch.
// On Cloud Run the access token comes from the metadata server (the job's
// service account); locally, set GCS_ACCESS_TOKEN (e.g. `gcloud auth print-access-token`).

const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'

export const gcsStore = (bucket: string, fetchImpl: Fetch = globalThis.fetch): ObjectStore => {
  let cached: { token: string; expiresAt: number } | null = null

  const accessToken = Effect.tryPromise(async () => {
    const fromEnv = process.env.GCS_ACCESS_TOKEN
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
    if (cached !== null && cached.expiresAt > Date.now() + 60_000) return cached.token
    const response = await fetchImpl(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } })
    if (!response.ok) throw new Error(`metadata token: HTTP ${response.status}`)
    const body = (await response.json()) as { access_token: string; expires_in: number }
    cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
    return body.access_token
  })

  return {
    put: (key, body, { contentType, cacheControl }) =>
      accessToken.pipe(
        Effect.flatMap(token =>
          Effect.tryPromise(async () => {
            const path = key.split('/').map(encodeURIComponent).join('/')
            const response = await fetchImpl(`https://storage.googleapis.com/${bucket}/${path}`, {
              method: 'PUT',
              headers: { authorization: `Bearer ${token}`, 'content-type': contentType, 'cache-control': cacheControl },
              body,
            })
            if (!response.ok) throw new Error(`GCS PUT ${key}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
          }),
        ),
      ),
  }
}
