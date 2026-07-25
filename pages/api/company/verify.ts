import type { NextApiRequest, NextApiResponse } from 'next'
import { lookupBySiren } from '../../../lib/prospector/datagouv'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Vérifie l'existence d'une entreprise par SIREN (data.gouv) avant de créer un lead.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const siren = str(req.query.siren)
  try {
    res.status(200).json(await lookupBySiren(siren))
  } catch (e: any) {
    res.status(200).json({ found: false, error: e?.message })
  }
}
