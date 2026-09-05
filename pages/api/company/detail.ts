import type { NextApiRequest, NextApiResponse } from 'next'
import { fetchCompanyDetail } from '../../../lib/prospector/datagouv'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Fiche compte détaillée (data.gouv) : dirigeants, CA/résultat, effectif, adresse.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const siren = str(req.query.siren)
  try {
    res.status(200).json(await fetchCompanyDetail(siren))
  } catch (e: any) {
    // Même distinction que /verify : une fiche momentanément injoignable n'est
    // pas une fiche inexistante. `fetchCompanyDetail` cesse d'avaler l'erreur en
    // amont, la frontière sûre la classe ici. Aucun détail fournisseur ne sort.
    logSafeError('company.detail_error', e, { provider: 'datagouv', operation: 'detail' })
    res.status(200).json({ found: false, resolution: 'provider_error', dirigeants: [], error: PUBLIC_ERROR })
  }
}
