// JS-015 B1 — PROJECTION D'ÉVIDENCE DE COMMUNICATION.
//
// Projette des primitives d'évidence ÉLIGIBLES existantes vers
// CommunicationEvidenceItemV0 en PRÉSERVANT la lignée : ref, source, date
// d'observation, force, autorité temporelle, incertitude, contre-signaux.
//
// ⚠️ CE QUE CETTE PROJECTION REFUSE STRUCTURELLEMENT :
//   - un `Lead.icebreaker` brut (texte LLM SANS ref/source/date) — la lignée
//     est perdue à la frontière Lead, donc l'item est INADMISSIBLE ;
//   - tout énoncé sans ref d'évidence ou sans provenance reconstructible.
// Elle ne réécrit PAS l'architecture canonique : elle en consomme la surface.
import type { EvidenceStrengthV0, SignalTemporalAuthority } from '../proactive/types'
import type { CommunicationEvidenceItemV0 } from './messageContext'

/** Entrée BORNÉE : la surface minimale qu'une évidence éligible sait fournir. */
export interface EligibleEvidenceInputV0 {
  readonly evidenceRef: string
  readonly statement: string
  readonly sourceRef: string
  readonly observedAt: string
  readonly strength?: EvidenceStrengthV0
  readonly temporalAuthority?: SignalTemporalAuthority
  readonly uncertainty?: string
  readonly counterSignalRefs?: readonly string[]
}

export type EvidenceProjectionResult =
  | { ok: true; items: readonly CommunicationEvidenceItemV0[]; rejected: readonly { index: number; reason: string }[] }
  | { ok: false; reason: 'NO_ELIGIBLE_EVIDENCE' }

const nonVide = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/**
 * PURE. Un item sans lignée complète est REJETÉ (listé, jamais réparé) :
 * l'incertitude ne devient pas silencieusement de la certitude, et un texte
 * orphelin ne devient pas une évidence communicable.
 */
export function projectCommunicationEvidence(
  inputs: readonly EligibleEvidenceInputV0[],
): EvidenceProjectionResult {
  const items: CommunicationEvidenceItemV0[] = []
  const rejected: { index: number; reason: string }[] = []
  inputs.forEach((input, index) => {
    if (!nonVide(input?.evidenceRef)) { rejected.push({ index, reason: 'missing_evidence_ref' }); return }
    if (!nonVide(input?.statement)) { rejected.push({ index, reason: 'missing_statement' }); return }
    if (!nonVide(input?.sourceRef)) { rejected.push({ index, reason: 'missing_source_ref' }); return }
    if (!nonVide(input?.observedAt)) { rejected.push({ index, reason: 'missing_observed_at' }); return }
    items.push(Object.freeze({
      evidenceRef: input.evidenceRef,
      statement: input.statement,
      provenance: Object.freeze({ sourceRef: input.sourceRef, observedAt: input.observedAt }),
      ...(input.strength !== undefined ? { strength: input.strength } : {}),
      ...(input.temporalAuthority !== undefined ? { temporalAuthority: input.temporalAuthority } : {}),
      ...(input.uncertainty !== undefined ? { uncertainty: input.uncertainty } : {}),
      ...(input.counterSignalRefs !== undefined ? { counterSignalRefs: input.counterSignalRefs } : {}),
    }))
  })
  if (items.length === 0) return { ok: false, reason: 'NO_ELIGIBLE_EVIDENCE' }
  return { ok: true, items: Object.freeze(items), rejected: Object.freeze(rejected) }
}
