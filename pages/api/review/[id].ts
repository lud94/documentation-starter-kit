// DOMAIN_REVIEW_PROJECTION_V0_001 + ENTITY_REVIEW_PROJECTION_V0_001 —
// DÉTAIL D'UNE REVUE, LECTURE SEULE.
//
// GET uniquement. L'item est RECALCULÉ (jamais lu d'un magasin de revues — il
// n'en existe pas), puis enrichi de la SEULE matière de décision SÛRE :
//   Domaine : proofUrl, finalUrl, proofObservedAt, targetSirenFound,
//     proofAnchor (extrait déjà borné par le serveur) ;
//   Entité avec fenêtre : les champs sûrs de l'ERO lié (requête, instant,
//     fenêtre de candidats registre) + l'issue courante et, en remédiation,
//     le SIREN automatique en conflit ;
//   Conflit AUTO_EXACT : issue + SIREN + instant — AUCUNE fenêtre n'existe et
//     AUCUNE n'est inventée : le seul geste est la ré-observation ;
//   Historique bloqué : { reason: 'HISTORY_TAMPERED' } — rien de brut.
// JAMAIS le corps brut, JAMAIS les condensats d'intégrité, JAMAIS un document
// de magasin complet. Les décisions restent les routes d'adjudication
// existantes — cette route ne fait que dire QUOI adjuger et quels gestes sont
// permis.
import type { NextApiRequest, NextApiResponse } from 'next'

import { resolveActorFromRequest } from '../../../lib/prospector/tenant'
import {
  ENTITY_RESOLUTION_OUTCOME_KIND, isEntityResolutionOutcome,
} from '../../../lib/prospector/proactive/entityResolutionOutcome'
import { readEntityResolutionObservation } from '../../../lib/prospector/proactive/entityResolution'
import { projectDomainReviews, projectEntityReviews } from '../../../lib/prospector/proactive/reviewQueue'
import { readDomainProofObservation } from '../../../lib/prospector/proactive/domainBinding'
import { listItemsStrict } from '../../../lib/supabase/store'
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
    const domaine = await projectDomainReviews(ws)
    if (domaine.ok === false) return res.status(503).json({ state: domaine.reason })
    const entite = await projectEntityReviews(ws)
    if (entite.ok === false) return res.status(503).json({ state: entite.reason })
    const item = [...domaine.items, ...entite.items].find((i) => i.id === id)
    if (!item) return res.status(404).json({ state: 'REVIEW_UNKNOWN' })

    // ── MATIÈRE DE DÉCISION SÛRE, PAR FAMILLE ─────────────────────────────
    if (item.kind === 'DOMAIN_AUTHORITY_REVIEW') {
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
    }

    if (item.kind === 'ENTITY_HISTORY_BLOCKED') {
      // Aucune matière brute d'un historique corrompu ne sort d'ici.
      return res.status(200).json({
        contractVersion: 'review-read-v0',
        item,
        decisionMaterial: { reason: 'HISTORY_TAMPERED' },
      })
    }

    // ENTITY_IDENTITY_REVIEW — relire l'ERX cible strictement.
    const erxLus = await listItemsStrict<unknown>(ENTITY_RESOLUTION_OUTCOME_KIND, ws)
    if (erxLus.ok === false) return res.status(503).json({ state: 'STORE_UNAVAILABLE' })
    const erx = erxLus.values.find(
      (v) => isEntityResolutionOutcome(v, ws) && v.id === item.sourceRefs.entityResolutionOutcomeId,
    )
    if (!erx || !isEntityResolutionOutcome(erx, ws)) return res.status(503).json({ state: 'HISTORY_INVALID' })

    if (erx.observationId === undefined) {
      // Conflit AUTO_EXACT : pas de fenêtre — on n'en fabrique JAMAIS une.
      return res.status(200).json({
        contractVersion: 'review-read-v0',
        item,
        decisionMaterial: {
          outcome: 'AUTO_EXACT',
          siren: erx.siren,
          observedAt: erx.observedAt,
          requiredDecision: 'REOBSERVE_ENTITY',
        },
      })
    }

    const relu = await readEntityResolutionObservation(erx.observationId, ws)
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
        outcome: erx.outcome,
        ...(erx.outcome === 'CONFLICT_REMEDIATION' ? { conflictingAutoSiren: erx.siren } : {}),
        observationId: o.id,
        subjectCandidateId: o.subjectCandidateId,
        queryRaw: o.queryRaw,
        retrievedAt: o.retrievedAt,
        resultWindow: o.resultWindow,
        returnedCount: o.returnedCount,
        // Fenêtre SÛRE et BORNÉE — champs clos, jamais l'enveloppe du magasin.
        candidates: o.candidates.map((c) => ({
          siren: c.siren, name: c.name, city: c.city, naf: c.naf,
          ...(c.effectif !== undefined ? { effectif: c.effectif } : {}),
          ...(c.dirigeant !== undefined ? { dirigeant: c.dirigeant } : {}),
          ...(c.active !== undefined ? { active: c.active } : {}),
        })),
      },
    })
  } catch (e) {
    logSafeError('review.detail_failed', e, { operation: 'review_detail' })
    return res.status(503).json({ state: 'STORE_UNAVAILABLE' })
  }
}
