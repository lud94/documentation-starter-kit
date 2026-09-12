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
  /**
   * SOUTIEN EXACT ancre → assertions, CALCULÉ CÔTÉ SERVEUR par les règles
   * d'identité de PRODUCTION (TRACEABILITY_FIX_001) : id d'ancre → ids
   * d'assertions. Le client ne fait que RENDRE cette relation déjà validée —
   * il ne la recalcule jamais (la clé de personne exige `personKeyV2` et
   * node:crypto, qui n'ont rien à faire dans le bundle navigateur).
   */
  support: Record<string, string[]>
}

/**
 * Assertions SOUTENANT une ancre — SIMPLE PROJECTION de la relation exacte
 * calculée côté serveur (`view.support`). Aucune règle d'identité ici :
 * une clé canonique partagée ne suffit PAS pour une ancre exécutive (deux
 * personnes distinctes partagent légitimement la même clé), et la clé de
 * personne appartient à la production, pas à la vue.
 */
export function supportingAssertions(
  anchor: CanonicalEvent | CanonicalExecutiveEvent | CanonicalStateSnapshot,
  view: Pick<FactualMemoryView, 'claims' | 'support'>,
): SourceAssertion[] {
  const ids = new Set(view.support[anchor.id] ?? [])
  const sorties: SourceAssertion[] = []
  for (const groupe of view.claims) {
    for (const a of groupe.assertions) if (ids.has(a.id)) sorties.push(a)
  }
  return sorties
}
