import type { NextApiRequest, NextApiResponse } from 'next'
import { lookupBySiren, lookupByName } from '../../../lib/prospector/datagouv'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Vérifie une entreprise (data.gouv) par SIREN ou par NOM → existence + actif + dirigeant.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const siren = str(req.query.siren)
  const name = str(req.query.name)
  try {
    if (siren) return res.status(200).json(await lookupBySiren(siren))
    if (name) return res.status(200).json(await lookupByName(name))
    res.status(400).json({ found: false, error: 'siren ou name requis' })
  } catch (e: any) {
    res.status(200).json({ found: false, error: e?.message })
  }
}
