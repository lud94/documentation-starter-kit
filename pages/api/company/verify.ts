import type { NextApiRequest, NextApiResponse } from 'next'
import { lookupBySiren, lookupByName, searchCandidates } from '../../../lib/prospector/datagouv'
import { logSafeError, PUBLIC_ERROR } from '../../../lib/observability/safeError'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// Vérifie/recherche une entreprise (data.gouv) par SIREN, par NOM (1 résultat), ou candidates=1 (liste).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const siren = str(req.query.siren)
  const name = str(req.query.name)
  const candidates = str(req.query.candidates) === '1'
  try {
    if (siren) return res.status(200).json(await lookupBySiren(siren))
    if (name && candidates) {
      const found = await searchCandidates(name)
      return res.status(200).json({ candidates: found, resolution: found.length ? 'resolved' : 'not_found' })
    }
    if (name) return res.status(200).json(await lookupByName(name))
    res.status(400).json({ found: false, resolution: 'not_found', error: 'siren ou name requis' })
  } catch (e: any) {
    // ⚠️ `provider_error` N'EST PAS `not_found` (OBS-DATAGOUV-001). Répondre
    // `{found:false}` seul faisait afficher « entreprise introuvable » alors que
    // data.gouv n'avait pas répondu — l'utilisateur corrigeait une saisie juste.
    //
    // Le contrat public reste strictement fermé : un code de résolution, un
    // message constant. Ni corps fournisseur, ni URL, ni pile, ni message tiers.
    logSafeError('company.verify_error', e, { provider: 'datagouv', operation: 'verify' })
    res.status(200).json({ found: false, resolution: 'provider_error', error: PUBLIC_ERROR })
  }
}
