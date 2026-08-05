import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { enrichCompanyWeb } from '../../../lib/prospector/identify'
import { resolveTenantFromRequest } from '../../../lib/prospector/tenant'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Enrichit une entreprise via l'agent web (Claude seul) : site + résumé secteur/activité.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  // MT-0 — espace client obligatoire avant tout appel LLM. Fail closed.
  const tenant = await resolveTenantFromRequest(req)
  if (!tenant) return res.status(403).json({ error: 'Espace client indéterminé : appel IA refusé.' })

  const company = str(req.query.company).trim()
  const city = str(req.query.city).trim() || undefined
  const siren = str(req.query.siren).trim() || undefined
  if (!company) return res.status(400).json({ error: 'company requis' })
  try {
    const r = await enrichCompanyWeb(tenant, company, city, siren)
    res.status(200).json(r)
  } catch (e: any) {
    res.status(200).json({ mode: 'error', error: e?.message })
  }
}
