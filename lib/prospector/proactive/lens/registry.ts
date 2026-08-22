// ARCH-RULEPACK-001 — LENS : CODE STATIQUE ET VERSIONNÉ.
//
// ── LENS ≠ BUSINESS CONTEXT ─────────────────────────────────────────────────
// Une `LensDefinition` est du CODE : quels packs lire, et comment calculer la
// pertinence. Un `BusinessContextV0` est une DONNÉE : qui regarde, avec quel
// périmètre et quelles capacités. Fondre les deux rendrait le contexte non
// sérialisable et ferait voyager des fonctions là où seules des données
// doivent circuler.
//
// ⚠️ LA LENS NE TOUCHE JAMAIS LA VÉRITÉ. Elle reçoit `readonly` evidences et
// rend un score. Elle ne peut modifier ni `assertionType`, ni `source`, ni
// `occurredAt`, ni `observedAt` — le typage l'en empêche, pas la discipline.
import type { RulePackId } from '../packs/registry'
import type { KnownEvidenceEvent } from '../catalog'

export interface EvaluationTargetRef {
  accountId: string
  personId?: string
}

export interface RelevanceVerdict {
  /** 0..1 */
  value: number
  /** ⚠️ OBLIGATOIRE. Un score sans explication n'est pas auditable. */
  explanation: string
}

export interface LensDefinition {
  lensId: string
  lensVersion: string
  /** Contraint aux packs RÉELLEMENT enregistrés. */
  rulePacks: readonly RulePackId[]
  relevance(
    target: EvaluationTargetRef,
    evidence: readonly KnownEvidenceEvent[],
  ): RelevanceVerdict
}

/**
 * Lens Sales par défaut.
 *
 * ⚠️ `relevance` reproduit le comportement ANTÉRIEUR à ce lot : la pertinence
 * était fournie de l'extérieur du moteur, sans explication. On la rend
 * explicable sans changer sa valeur — le lot est un refactor, pas un
 * changement de politique. Sa vraie conception appartient au Business Context.
 */
export const SALES_DEFAULT_LENS: LensDefinition = {
  lensId: 'sales-default',
  lensVersion: 'v0.1',
  rulePacks: ['sales-core'],
  relevance() {
    return {
      value: 0.5,
      explanation:
        'Pertinence neutre par défaut (lens sales-default v0.1) : aucune politique ICP n’est encore définie.',
    }
  },
}

export const LENS_REGISTRY = {
  'sales-default': SALES_DEFAULT_LENS,
} as const

export type LensId = keyof typeof LENS_REGISTRY

export function isLensId(value: string): value is LensId {
  return Object.prototype.hasOwnProperty.call(LENS_REGISTRY, value)
}
