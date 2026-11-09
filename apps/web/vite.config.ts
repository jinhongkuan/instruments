import { createReadStream, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, normalize, sep } from 'node:path'

import { type Plugin, defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

const LOCAL_BUNDLES = fileURLToPath(new URL('./.bundles', import.meta.url))

/**
 * Dev only: serve bundles written by `pipeline cli derive` at /bundles. They
 * live outside public/ so a production build never ships stale data.
 */
const localBundles = (): Plugin => ({
  name: 'instruments-local-bundles',
  apply: 'serve',
  configureServer: server => {
    server.middlewares.use('/bundles', (request, response) => {
      const path = normalize(join(LOCAL_BUNDLES, decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')))
      const isFile = path.startsWith(LOCAL_BUNDLES + sep) && statSync(path, { throwIfNoEntry: false })?.isFile() === true
      if (!isFile) {
        response.statusCode = 404
        response.end('no local bundle; run `pnpm --filter @instruments/pipeline cli derive`')
        return
      }
      response.setHeader('content-type', 'application/json')
      createReadStream(path).pipe(response)
    })
  },
})

export default defineConfig({
  plugins: [tailwindcss(), foldkit(), localBundles()],
  optimizeDeps: {
    entries: ['src/entry.ts'],
    exclude: ['@instruments/domain'],
  },
})
