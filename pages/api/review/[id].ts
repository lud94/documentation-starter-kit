// DOMAIN_REVIEW_PROJECTION_V0_001 — DÉTAIL D'UNE REVUE, LECTURE SEULE.
//
// GET uniquement. L'item est RECALCULÉ (jamais lu d'un magasin de revues — il
// n'en existe pas), puis enrichi de la SEULE matière de décision SÛRE de la
// DPO cible : proofUrl, finalUrl, proofObservedAt, targetSirenFound,
// proofAnchor (extrait déjà borné par le serveur). JAMAIS le corps brut,
// JAMAIS les condensats d'intégrité, JAMAIS un document de magasin complet.
// La décision reste POST /api/internal/domain-adjudication — cette route ne
// fait que dire QUELLE observation adjuger et quels gestes sont permis.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { projectDomainReviews } from '../../../lib/prospector/proactive/reviewQueue'
import { readDomainProofObservation } from '../../../lib/prospector/proactive/domainBinding'
import { logSafeError } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ state: 'INVALID_REQUEST' })
  const acteur = await resolveActorFromRequest(req)
  if (!acteur || !acteur.tenant?.id) return res.status(403).json({ state: 'UNAUTHENTICATED' })
  const ws = acteur.tenant.id

  try {
    const id = req.query?.id
    if (typeof id !== 'string' || !/^rvw_[0-9a-f]{32}$/.test(id)) {
      return res.status(404).json({ state: 'REVIEW_UNKNOWN' })
    }

    // ⚠️ Recalcul CLOISONNÉ PAR L'ESPACE DE SESSION : un identifiant volé dans
    // un autre espace ne désigne rien ici — son condensat inclut l'espace.
    const projection = await projectDomainReviews(ws)
    if (projection.ok === false) return res.status(503).json({ state: projection.reason })
    const item = projection.items.find((i) => i.id === id)
    if (!item) return res.status(404).json({ state: 'REVIEW_UNKNOWN' })

    // Matière de décision sûre — relue STRICTEMENT du record autoritatif.
    const relu = await readDomainProofObservation(item.sourceRefs.domainProofObservationId, ws)
    if (relu.ok === false) {
      return relu.reason === 'STORE_UNAVAILABLE'
        ? res.status(503).json({ state: 'STORE_UNAVAILABLE' })
        : res.status(503).json({ state: 'HISTORY_INVALID' })
    }
    const o = relu.observation

    return res.status(200).json({
      contractVersion: 'review-read-v0',
      item,
      decisionMaterial: {
        proofUrl: o.proofUrl,
        finalUrl: o.finalUrl,
        proofObservedAt: o.proofObservedAt,
        targetSirenFound: o.targetSirenFound,
        proofAnchor: o.proofAnchor,
      },
    })
  } catch (e) {
    logSafeError('review.detail_failed', e, { operation: 'review_detail' })
    return res.status(503).json({ state: 'STORE_UNAVAILABLE' })
  }
}
