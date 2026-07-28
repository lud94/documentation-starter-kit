import type { NextApiRequest, NextApiResponse } from 'next'
import { isAdminRequest } from '../../../lib/auth/guard'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { tokenForWorkspace, bumpTokenVersion } from '../../../lib/prospector/wstoken'

// Jeton d'extension d'un workspace (multi-tenant). Admin uniquement.
// GET  ?id=<ws>  → renvoie le jeton courant.
// POST { id }    → RÉGÉNÈRE (révoque l'ancien de ce workspace) et renvoie le nouveau.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!(await isAdminRequest(req))) return res.status(403).json({ error: 'forbidden' })
  await hydrateKeystore()
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const id = String((req.method === 'POST' ? body?.id : (Array.isArray(req.query.id) ? req.query.id[0] : req.query.id)) || '')
  if (!id) return res.status(400).json({ error: 'id requis' })
  if (req.method === 'POST') { await bumpTokenVersion(id); return res.status(200).json({ token: await tokenForWorkspace(id), regenerated: true }) }
  res.status(200).json({ token: await tokenForWorkspace(id) })
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
