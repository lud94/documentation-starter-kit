import type { NextApiRequest, NextApiResponse } from 'next'
import { searchSignals, buildThesis, SIGNAL_TYPES, type SignalQuery } from '../../../lib/prospector/signals'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Recherche longue (Exa + Claude web + réconciliation SIREN) → il faut laisser
// le temps à la fonction serverless, sinon timeout silencieux côté client.
export const config = { maxDuration: 60 }

// Recherche par signal. Deux modes :
//  • thèse libre (GET ?thesis=…) — mode expert, inchangé
//  • critères structurés (POST { types, sector, location, months, keywords })
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()

  // Catalogue des types de signaux, pour construire l'UI.
  if (req.method === 'GET' && str(req.query.catalog) === '1') {
    return res.status(200).json({ types: SIGNAL_TYPES.map(({ key, label, group }) => ({ key, label, group })) })
  }

  const body = req.method === 'POST' ? (typeof req.body === 'string' ? safeParse(req.body) : req.body) : null
  const q: SignalQuery = body ? {
    thesis: String(body.thesis || ''),
    types: Array.isArray(body.types) ? body.types.slice(0, 6) : [],
    sector: String(body.sector || ''),
    location: String(body.location || ''),
    months: Math.min(Math.max(Number(body.months) || 6, 1), 18),
    keywords: String(body.keywords || ''),
  } : { thesis: str(req.query.thesis).trim(), months: 6 }

  // MT-0 — espace client obligatoire avant tout appel LLM. Fail closed.
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'Espace client indéterminé : appel IA refusé.' })

  const thesis = buildThesis(q)
  if (!thesis || thesis.length < 5) return res.status(400).json({ error: 'Précise au moins un type de signal ou une thèse.' })

  try {
    res.status(200).json(await searchSignals(tenant, thesis, 25, q))
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Erreur agent signaux' })
  }
}
function safeParse(s: string) { try { return JSON.parse(s) } catch { return null } }
