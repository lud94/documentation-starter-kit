// ENTITY_RESOLUTION_ADJUDICATION_001 — OBSERVATION D'ENTITÉ, CADRÉE CANDIDAT.
//
// Le navigateur n'envoie QUE `candidateId`. Le serveur dérive tout : espace de
// session, candidat relu, requête (claim.company), interrogation du registre
// officiel, cliché, horloge. L'adjudication humaine existe pour résoudre une
// AMBIGUÏTÉ — jamais pour contourner une résolution automatique exacte sûre :
//   auto exact  ⇒ AUTO_RESOLVED, aucune observation créée ;
//   ambigu      ⇒ observation persistée + cliché rendu pour sélection ;
//   introuvable ⇒ ENTITY_NOT_FOUND, aucune fausse opportunité fabriquée ;
//   panne       ⇒ 503 explicite, rien persisté.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import { readCandidate } from '../../../lib/prospector/proactive/signalCandidates'
import { lookupByName } from '../../../lib/prospector/datagouv'
import { effectiveHumanDecision, recordEntityResolutionObservation } from '../../../lib/prospector/proactive/entityResolution'
import { logSafeError } from '../../../lib/observability/safeError'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ state: 'INVALID_REQUEST' })
  const acteur = await resolveActorFromRequest(req)
  if (!acteur || !acteur.tenant?.id) return res.status(403).json({ state: 'UNAUTHENTICATED' })
  const ws = acteur.tenant.id

  try {
    const corps: any = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})
    if (typeof corps?.candidateId !== 'string') return res.status(400).json({ state: 'INVALID_REQUEST' })

    const lecture = await readCandidate(corps.candidateId, ws)
    if (lecture.ok === false) {
      return lecture.state === 'CANDIDATE_STORE_UNAVAILABLE'
        ? res.status(503).json({ state: 'CANDIDATE_STORE_UNAVAILABLE' })
        : res.status(404).json({ state: 'CANDIDATE_UNKNOWN' })
    }
    const candidate = lecture.candidate
    const raison = String(candidate.claim.company || '').trim()
    if (!raison) return res.status(409).json({ state: 'ENTITY_NOT_FOUND' })

    let lookup: Awaited<ReturnType<typeof lookupByName>>
    try { lookup = await lookupByName(raison) } catch {
      return res.status(503).json({ state: 'ENTITY_REGISTRY_UNAVAILABLE' })
    }

    if (lookup?.found === true && lookup.resolution === 'resolved') {
      // ── REMÉDIATION D'UN CONFLIT D'IDENTITÉ ─────────────────────────────
      // Si une décision humaine EFFECTIVE contredit l'auto exact (ACCEPTED A
      // ≠ B, ou NONE ayant VU-ET-REJETÉ B), le résolveur échouera fermé — et
      // sans fenêtre fraîche, l'humain ne pourrait JAMAIS sélectionner B :
      // impasse. On persiste alors la fenêtre de LA MÊME recherche (aucune
      // seconde interrogation — pas de TOCTOU) pour permettre une NOUVELLE
      // adjudication append-only. Cette observation ne résout RIEN.
      const sirenAuto = String(lookup.siren || '')
      const humain = await effectiveHumanDecision(candidate.id, ws)
      if (humain.kind === 'STORE_UNAVAILABLE') return res.status(503).json({ state: 'CANDIDATE_STORE_UNAVAILABLE' })
      if (humain.kind === 'HISTORY_TAMPERED') return res.status(409).json({ state: 'ENTITY_RESOLUTION_HISTORY_TAMPERED' })
      const conflit =
        (humain.kind === 'ACCEPTED' && humain.siren !== sirenAuto)
        || (humain.kind === 'NONE' && humain.observation.candidates.some((c) => c.siren === sirenAuto))
      if (conflit && Array.isArray(lookup.candidates) && lookup.candidates.length > 0) {
        const enregistree = await recordEntityResolutionObservation({ candidate, lookup }, ws)
        if (enregistree.ok === false) return res.status(503).json({ state: 'WRITE_FAILED' })
        const o = enregistree.observation
        return res.status(200).json({
          state: 'IDENTITY_CONFLICT_OBSERVATION_RECORDED',
          observation: {
            id: o.id, subjectCandidateId: o.subjectCandidateId,
            queryRaw: o.queryRaw, retrievedAt: o.retrievedAt,
            resultWindow: o.resultWindow, returnedCount: o.returnedCount,
            candidates: o.candidates,
          },
        })
      }
      // Sans conflit humain : l'automatique exact SUFFIT, aucune observation.
      return res.status(200).json({ state: 'AUTO_RESOLVED', siren: lookup.siren })
    }
    if (!Array.isArray(lookup?.candidates) || lookup.candidates.length === 0) {
      return res.status(409).json({ state: 'ENTITY_NOT_FOUND' })
    }

    const r = await recordEntityResolutionObservation({ candidate, lookup }, ws)
    if (r.ok === false) return res.status(503).json({ state: 'WRITE_FAILED' })
    const o = r.observation
    return res.status(200).json({
      state: 'OBSERVATION_RECORDED',
      observation: {
        id: o.id, subjectCandidateId: o.subjectCandidateId,
        queryRaw: o.queryRaw, retrievedAt: o.retrievedAt,
        resultWindow: o.resultWindow, returnedCount: o.returnedCount,
        candidates: o.candidates, // cliché sûr — l'humain choisit PARMI ceci
      },
    })
  } catch (e) {
    logSafeError('entity-resolution-observation', e)
    return res.status(500).json({ state: 'INVALID_REQUEST' })
  }
}
