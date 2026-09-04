// DOMAIN_REVIEW_PROJECTION_V0_001 — FILE DE REVUE, LECTURE SEULE.
//
// GET uniquement. L'espace et l'acteur viennent de la SESSION — jamais de la
// requête. La réponse est une PROJECTION pure : aucune écriture, aucun réseau,
// aucune revalidation (voir reviewQueue.ts). Magasin muet ou histoire
// corrompue ⇒ 503 EXPLICITE — jamais `{ items: [] }` : « je ne sais pas »
// n'est pas « rien à revoir ».
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { projectDomainReviews, projectEntityReviews, type ReviewItemV0 } from '../../../lib/prospector/proactive/reviewQueue'
import { logSafeError } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ state: 'INVALID_REQUEST' })
  const acteur = await resolveActorFromRequest(req)
  if (!acteur || !acteur.tenant?.id) return res.status(403).json({ state: 'UNAUTHENTICATED' })
  const ws = acteur.tenant.id

  try {
    // ⚠️ L'UNION EXIGE LES DEUX FAMILLES. Si UNE projection échoue, la liste
    // entière échoue : rendre une liste partielle masquerait la panne d'une
    // autorité derrière le silence de l'autre.
    const domaine = await projectDomainReviews(ws)
    if (domaine.ok === false) return res.status(503).json({ state: domaine.reason })
    const entite = await projectEntityReviews(ws)
    if (entite.ok === false) return res.status(503).json({ state: entite.reason })
    let items: ReviewItemV0[] = [...domaine.items, ...entite.items]

    // Filtres BORNÉS — vocabulaire clos, valeur inconnue refusée plutôt
    // qu'ignorée (une faute de frappe ne doit pas rendre « tout »).
    const kind = req.query?.kind
    if (kind !== undefined) {
      if (kind !== 'DOMAIN_AUTHORITY_REVIEW' && kind !== 'ENTITY_IDENTITY_REVIEW' && kind !== 'ENTITY_HISTORY_BLOCKED') {
        return res.status(400).json({ state: 'INVALID_REQUEST' })
      }
      items = items.filter((i) => i.kind === kind)
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
      items, // les projections ne dérivent que des items OPEN
    })
  } catch (e) {
    logSafeError('review.list_failed', e, { operation: 'review_list' })
    return res.status(503).json({ state: 'STORE_UNAVAILABLE' })
  }
}
