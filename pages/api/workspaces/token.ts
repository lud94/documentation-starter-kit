import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminRequest } from '../../../lib/auth/guard'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { tokenForWorkspace } from '../../../lib/prospector/wstoken'

// Jeton d'extension d'un workspace (multi-tenant). Admin uniquement.
// À remettre au client : son extension écrira dans SON espace.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  await hydrateKeystore()
  const id = String((Array.isArray(req.query.id) ? req.query.id[0] : req.query.id) || '')
  if (!id) return res.status(400).json({ error: 'id requis' })
  res.status(200).json({ token: await tokenForWorkspace(id) })
}
