// FACTUAL_MEMORY_INSPECTOR_V0_001 — MODÈLE DE VUE PUR (feuille sans I/O).
//
// ⚠️ CE MODULE N'IMPORTE AUCUNE PERSISTANCE. La page Next.js l'importe côté
// client pour partager types et reconstruction de soutien ; `inspector.ts`
// (serveur) l'importe aussi. Une seule définition de la règle de soutien —
// deux implémentations divergeraient.
import type { SourceAssertion } from './sourceAssertion'
import type {
  CanonicalEvent, CanonicalExecutiveEvent, CanonicalStateSnapshot,
} from './canonicalFact'

export interface InspectorRejectedRow { kind: string; id: string; reason: 'MALFORMED_ROW' }

export interface InspectorClaimGroup {
  canonicalClaimKey: string
  assertions: SourceAssertion[]
  /**
   * ⚠️ N ASSERTIONS ≠ N SOURCES INDÉPENDANTES. Deux versions sémantiques de la
   * même URL restent deux assertions VISIBLES séparément, mais une seule URL
   * normalisée. Aucune corroboration ni confiance n'est calculée ici.
   */
  uniqueSourceUrls: number
}

export interface FactualMemoryView {
  accountId: string
  /** SIREN dérivé de l'identifiant de compte VÉRIFIÉ. */
  siren: string
  /** Nom reconstruit depuis un candidat VALIDE du même SIREN — sinon null. */
  company: string | null
  events: Array<CanonicalEvent | CanonicalExecutiveEvent>
  snapshots: CanonicalStateSnapshot[]
  claims: InspectorClaimGroup[]
  rejected: InspectorRejectedRow[]
}

/**
 * Assertions SOUTENANT une ancre donnée — reconstruction en LECTURE SEULE.
 * Événement : même clé canonique. Instantané d'état : même clé ET même jour
 * d'observation (chaque jour est un fait distinct). Aucun tableau de sources
 * n'est matérialisé dans l'ancre.
 */
export function supportingAssertions(
  anchor: CanonicalEvent | CanonicalExecutiveEvent | CanonicalStateSnapshot,
  claims: readonly InspectorClaimGroup[],
): SourceAssertion[] {
  const groupe = claims.find((c) => c.canonicalClaimKey === anchor.canonicalClaimKey)
  if (!groupe) return []
  if (anchor.type === 'HIRING_SNAPSHOT') {
    return groupe.assertions.filter((a) => a.sourceObservedDay === (anchor as CanonicalStateSnapshot).stateObservedDay)
  }
  return groupe.assertions
}
