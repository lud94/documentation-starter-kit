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
  // ── DEUX JETONS, DEUX CAPACITÉS (lot SEC-EXT-0) ──────────────────────────
  // `capture` alimente le popup « ajouter un lead » ; `jarvis` alimente le
  // compagnon flottant. Séparer les deux borne le rayon d'explosion d'un vol :
  // un jeton de capture dérobé n'obtient pas l'agent, et réciproquement.
  //
  // `null` quand APP_SESSION_SECRET est absent ou la version non vérifiable :
  // on ne délivre jamais un jeton qu'on ne saurait pas révoquer.
  if (req.method === 'POST') {
    const v = await bumpTokenVersion(id)
    if (v === null) return res.status(503).json({ error: 'Révocation impossible : configuration ou base indisponible.' })
    return res.status(200).json({ ...(await bothTokens(id)), regenerated: true })
  }
  const tokens = await bothTokens(id)
  if (!tokens.capture || !tokens.jarvis) {
    return res.status(503).json({ error: 'Jetons indisponibles : APP_SESSION_SECRET absent ou base injoignable.' })
  }
  res.status(200).json(tokens)
}
async function bothTokens(id: string) {
  return {
    capture: await tokenForWorkspace(id, 'capture'),
    jarvis: await tokenForWorkspace(id, 'jarvis'),
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
