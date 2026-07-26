import type { NextApiRequest, NextApiResponse } from 'next'
import { fetchCompanyDetail } from '../../../lib/prospector/datagouv'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Fiche compte détaillée (data.gouv) : dirigeants, CA/résultat, effectif, adresse.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const siren = str(req.query.siren)
  try {
    res.status(200).json(await fetchCompanyDetail(siren))
  } catch (e: any) {
    res.status(200).json({ found: false, dirigeants: [], error: e?.message })
  }
}
