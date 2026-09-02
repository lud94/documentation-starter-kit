// ENTITY_RESOLUTION_ADJUDICATION_001 — ADJUDICATION HUMAINE, APPEND-ONLY.
//
// Le navigateur n'envoie QUE (observationId, verdict, selectedSiren? comme pur
// SÉLECTEUR). Espace/acteur/instant : session serveur. Le serveur vérifie que
// la sélection APPARTIENT au cliché persistant relu strictement — jamais un
// SIREN arbitraire, jamais un payload d'entreprise. La règle NONE (§8) est
// appliquée dans le module : un NONE ne révoque jamais une sélection courante
// que sa fenêtre n'a pas montrée.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { recordEntityResolutionAdjudication } from '../../../lib/prospector/proactive/entityResolution'
import { logSafeError } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ state: 'INVALID_REQUEST' })
  const acteur = await resolveActorFromRequest(req)
  if (!acteur || !acteur.tenant?.id || !acteur.actorId) {
    return res.status(403).json({ state: 'UNAUTHENTICATED' })
  }

  try {
    const corps: any = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    const r = await recordEntityResolutionAdjudication(
      { observationId: corps?.observationId, verdict: corps?.verdict, selectedSiren: corps?.selectedSiren },
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
        ...(a.selectedSiren !== undefined ? { selectedSiren: a.selectedSiren } : {}),
        adjudicatedBy: a.adjudicatedBy, adjudicatedAt: a.adjudicatedAt,
      },
    })
  } catch (e) {
    logSafeError('entity-resolution-adjudication', e)
    return res.status(500).json({ state: 'INVALID_REQUEST' })
  }
}
