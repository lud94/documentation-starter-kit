// ENTITY_OFFICIAL_DOMAIN_GROUNDING_001 — ADJUDICATION HUMAINE, APPEND-ONLY.
//
// Le navigateur n'envoie QUE (observationId, verdict). L'espace, l'acteur et
// l'instant viennent du SERVEUR. L'observation est relue strictement dans
// l'espace de session — une observation d'un autre espace n'existe pas ici.
// Une observation où le SIREN cible est absent ne peut pas être ACCEPTÉE.
// Aucune décision n'est jamais mise à jour : changer d'avis = nouvel
// enregistrement daté.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { recordDomainAdjudication } from '../../../lib/prospector/proactive/domainBinding'
import { logSafeError } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ state: 'INVALID_REQUEST' })

  const acteur = await resolveActorFromRequest(req)
  if (!acteur || !acteur.tenant?.id || !acteur.actorId) {
    return res.status(403).json({ state: 'UNAUTHENTICATED' })
  }

  try {
    const corps: any = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    const r = await recordDomainAdjudication(
      { observationId: corps?.observationId, verdict: corps?.verdict },
      acteur.actorId, acteur.tenant.id,
    )
    if (r.ok === false) {
      const code =
        r.reason === 'STORE_UNAVAILABLE' || r.reason === 'WRITE_FAILED' ? 503
          : r.reason === 'OBSERVATION_UNKNOWN' ? 404
            : r.reason === 'INVALID_INPUT' ? 400 : 409
      return res.status(code).json({ state: r.reason })
    }
    const a = r.adjudication
    return res.status(200).json({
      state: 'ADJUDICATION_RECORDED',
      adjudication: {
        id: a.id, observationId: a.observationId, verdict: a.verdict,
        adjudicatedBy: a.adjudicatedBy, adjudicatedAt: a.adjudicatedAt,
      },
    })
  } catch (e) {
    logSafeError('domain-adjudication', e)
    return res.status(500).json({ state: 'INVALID_REQUEST' })
  }
}
