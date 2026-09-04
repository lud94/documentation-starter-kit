// DOMAIN_REVIEW_PROJECTION_V0_001 — FILE DE REVUE, LECTURE SEULE.
//
// GET uniquement. L'espace et l'acteur viennent de la SESSION — jamais de la
// requête. La réponse est une PROJECTION pure : aucune écriture, aucun réseau,
// aucune revalidation (voir reviewQueue.ts). Magasin muet ou histoire
// corrompue ⇒ 503 EXPLICITE — jamais `{ items: [] }` : « je ne sais pas »
// n'est pas « rien à revoir ».
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { projectDomainReviews } from '../../../lib/prospector/proactive/reviewQueue'
import { logSafeError } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ state: 'INVALID_REQUEST' })
  const acteur = await resolveActorFromRequest(req)
  if (!acteur || !acteur.tenant?.id) return res.status(403).json({ state: 'UNAUTHENTICATED' })
  const ws = acteur.tenant.id

  try {
    const projection = await projectDomainReviews(ws)
    if (projection.ok === false) {
      // Les deux échecs restent DISTINCTS pour l'appelant : muet se réessaie,
      // corrompu s'investigue.
      return res.status(503).json({ state: projection.reason })
    }

    // Filtres BORNÉS — vocabulaire clos, valeur inconnue refusée plutôt
    // qu'ignorée (une faute de frappe ne doit pas rendre « tout »).
    const kind = req.query?.kind
    if (kind !== undefined) {
      if (kind !== 'DOMAIN_AUTHORITY_REVIEW') return res.status(400).json({ state: 'INVALID_REQUEST' })
    }
    // ⚠️ NON SUPPORTÉ ≠ VIDE. La V0 ne projette QUE des items OPEN : accepter
    // `lifecycle=RESOLVED` et rendre `[]` affirmerait « aucune revue résolue »
    // là où la vérité est « cet historique n'est pas projeté ». Seul `OPEN`
    // est donc accepté ; tout le reste est refusé, jamais servi vide.
    const lifecycle = req.query?.lifecycle
    if (lifecycle !== undefined && lifecycle !== 'OPEN') {
      return res.status(400).json({ state: 'INVALID_REQUEST' })
    }

    return res.status(200).json({
      contractVersion: 'review-read-v0',
      items: projection.items, // la projection ne dérive que des items OPEN
    })
  } catch (e) {
    logSafeError('review.list_failed', e, { operation: 'review_list' })
    return res.status(503).json({ state: 'STORE_UNAVAILABLE' })
  }
}
