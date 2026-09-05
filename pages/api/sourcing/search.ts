import type { NextApiRequest, NextApiResponse } from 'next'
import { fetchCompanies, debugSearch } from '../../../lib/prospector/datagouv'
import { logSafeError } from '../../../lib/observability/safeError'

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''

// SEC-LOG-01 — CETTE ROUTE RENVOYAIT LE CORPS DU FOURNISSEUR AU CLIENT.
//
// Deux chemins fuyaient, et le second était le pire :
//
//   catch { res.status(502).json({ error: e?.message }) }
//   catch { res.status(200).json({ error: e?.message, stack: String(e) }) }
//
// `e.message` venait de `datagouv.ts`, qui y interpolait la réponse brute de
// l'API. Le corps d'un fournisseur, et une pile d'exécution, franchissaient donc
// la frontière applicative dans une réponse HTTP — pas seulement dans un journal.
//
// Une erreur publique est désormais DÉTERMINISTE et GÉNÉRIQUE : elle dit qu'une
// dépendance a échoué, elle ne dit pas ce que cette dépendance a répondu. Le
// détail exploitable — fournisseur, opération, statut — part dans les journaux
// serveur sous forme de champs autorisés.
const ERREUR_PUBLIQUE = 'Recherche indisponible pour le moment.'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const query = {
    sector: str(req.query.sector),
    location: str(req.query.location),
    size: str(req.query.size),
    page: Math.max(1, parseInt(str(req.query.page) || '1', 10) || 1),
    activeOnly: str(req.query.activeOnly) !== '0',
  }
  if (req.query.debug) {
    try {
      const d = await debugSearch(query)
      // ⚠️ NI `body`, NI `url`. Le corps est du contenu fournisseur ; l'URL porte
      // la requête construite et n'a rien à faire dans une réponse de diagnostic
      // publique. Le statut suffit à savoir si la dépendance répond.
      return res.status(200).json({ status: d.status })
    } catch (e) {
      logSafeError('sourcing.debug_error', e, { provider: 'datagouv', operation: 'search' })
      return res.status(200).json({ error: ERREUR_PUBLIQUE })
    }
  }
  try {
    const data = await fetchCompanies(query)
    // cache léger côté edge/CDN
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600')
    res.status(200).json(data)
  } catch (e) {
    logSafeError('sourcing.search_error', e, { provider: 'datagouv', operation: 'search' })
    res.status(502).json({ error: ERREUR_PUBLIQUE })
  }
}
