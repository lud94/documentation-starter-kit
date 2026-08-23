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

/**
 * Lens Fabel — courtage en bureaux.
 *
 * ⚠️ `sales-core` N'EST PAS ACTIVÉ, et c'est un choix, pas un oubli. Un courtier
 * ne veut pas de `sales_scale_up` dans sa file. Les deux packs LISENT les mêmes
 * evidences transverses (`recent_funding`, `headcount_acceleration`) — une
 * evidence peut être comprise par plusieurs packs sans qu'une lens doive les
 * activer ensemble.
 *
 * C'est l'invariant « mêmes faits → interprétations distinctes » : `lensId` et
 * `rulePackId` entrent tous deux dans l'identité d'une Situation, donc les deux
 * lectures coexistent sans collision, et aucune ne modifie la vérité.
 */
export const FABEL_BROKER_LENS: LensDefinition = {
  lensId: 'fabel-broker',
  lensVersion: 'v0.1',
  rulePacks: ['real-estate-fabel'],
  relevance() {
    // DORMANTE, comme celle de `sales-default`. Le runner d'évaluation exige
    // `target.relevance` explicitement (EVAL-RUNNER-001a) ; aucun scoring ICP
    // Fabel n'est construit ici, et brancher cette fonction serait un
    // changement de politique déguisé en implémentation.
    return {
      value: 0.5,
      explanation:
        'Pertinence neutre par défaut (lens fabel-broker v0.1) : aucune politique ICP n’est définie.',
    }
  },
}

export const LENS_REGISTRY = {
  'sales-default': SALES_DEFAULT_LENS,
  'fabel-broker': FABEL_BROKER_LENS,
} as const

export type LensId = keyof typeof LENS_REGISTRY

export function isLensId(value: string): value is LensId {
  return Object.prototype.hasOwnProperty.call(LENS_REGISTRY, value)
}
