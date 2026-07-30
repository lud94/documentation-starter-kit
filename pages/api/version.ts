import type { NextApiRequest, NextApiResponse } from 'next'
import { BUILD, buildTag } from '../../lib/version'

// « Quel code tourne ? » — une seule commande pour trancher :
//   curl -s https://<app>/api/version
// Comparer `build.sha` à `git rev-parse HEAD`. Identiques = déployé.
// Si `build.sha` ≠ `runtime.sha`, une ancienne fonction est encore servie.
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    tag: buildTag(),
    build: BUILD,
    runtime: {
      sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
      branch: process.env.VERCEL_GIT_COMMIT_REF || null,
      env: process.env.VERCEL_ENV || null,
    },
    now: new Date().toISOString(),
  })
}
