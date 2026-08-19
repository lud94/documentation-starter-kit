import type { NextApiRequest, NextApiResponse } from 'next'
import { unipileConfigured } from '../../../lib/prospector/unipile'
import { hydrateKeystore } from '../../../lib/prospector/keystore'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Recherche de PERSONNES sur LinkedIn (façon Sales Navigator) via Unipile.
// Mock tant qu'Unipile n'est pas connecté. Filtres : poste, secteur, localisation.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await hydrateKeystore()
  const role = str(req.query.role)
  const location = str(req.query.location)
  const sector = str(req.query.sector)

  // Sans Unipile connecté, on NE fabrique AUCUNE personne : recherche = 0 résultat.
  // (La recherche de personnes sur LinkedIn dépend strictement du connecteur.)
  if (!unipileConfigured()) {
    return res.status(200).json({ connected: false, people: [] })
  }

  try {
    // TODO câblage réel : Unipile /linkedin/search (people) — keywords = role + sector + location.
    // Tant que le format n'est pas validé, on renvoie une liste vide plutôt que du faux.
    const people: any[] = []
    void role; void location; void sector
    return res.status(200).json({ connected: true, people })
  } catch (e: any) {
    logSafeError('sourcing.people_error', e, { provider: 'unipile', operation: 'people' })
    return res.status(200).json({ connected: true, error: PUBLIC_ERROR, people: [] })
  }
}
