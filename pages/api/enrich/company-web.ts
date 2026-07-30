import type { NextApiRequest, NextApiResponse } from 'next'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { enrichCompanyWeb } from '../../../lib/prospector/identify'

// Appels IA / recherche web : laisser du temps à la fonction (anti-timeout).
export const config = { maxDuration: 60 }

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Enrichit une entreprise via l'agent web (Claude seul) : site + résumé secteur/activité.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const company = str(req.query.company).trim()
  const city = str(req.query.city).trim() || undefined
  const siren = str(req.query.siren).trim() || undefined
  if (!company) return res.status(400).json({ error: 'company requis' })
  try {
    const r = await enrichCompanyWeb(company, city, siren)
    res.status(200).json(r)
  } catch (e: any) {
    res.status(200).json({ mode: 'error', error: e?.message })
  }
}
