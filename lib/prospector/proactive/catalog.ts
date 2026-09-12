// ARCH-RULEPACK-001 — CATALOGUE FERMÉ, DÉRIVÉ DES PACKS ENREGISTRÉS.
//
// ── POURQUOI DÉRIVER PLUTÔT QUE DÉCLARER ────────────────────────────────────
// Une union écrite à la main dans `types.ts` devrait être tenue à jour à chaque
// pack : deux sources de vérité, donc une divergence garantie à terme. Ici, le
// catalogue se recalcule seul — un pack ajouté au registre étend les unions
// sans qu'aucune ligne du moteur métier ne bouge.
//
// ── CE QUE CELA FERME ───────────────────────────────────────────────────────
//   'space_expansion' déclaré par un pack  → compile
//   'space_expnsion'                       → ERREUR de typage
//   un pack non enregistré                 → ERREUR de typage
//
// ⚠️ Ce module importe le registre. Il ne doit donc JAMAIS être importé par
// `types.ts`, `rulePack.ts`, `ruleKit.ts` ni par un pack — ce serait le cycle
// que toute cette structure existe pour éviter.
import { PACK_REGISTRY, type RulePackId } from './packs/registry'
import type { EvidenceEvent } from './types'

type Packs = (typeof PACK_REGISTRY)[RulePackId]

/** Tous les `situationType` déclarés par les packs enregistrés. */
export type SituationType = Packs['declaredSituationTypes'][number]

/** Tous les `type` d'evidence déclarés par les packs enregistrés. */
export type EvidenceType = Packs['declaredEvidenceTypes'][number]

/**
 * EvidenceEvent FERMÉ sur le catalogue.
 *
 * C'est ce type — et non `EvidenceEvent` générique — qui doit être employé aux
 * frontières de production et d'ingestion. Le paramètre générique existe pour
 * casser un cycle d'imports, pas pour offrir une échappatoire.
 */
export type KnownEvidenceEvent = EvidenceEvent<EvidenceType>

/** Valeurs à l'exécution, pour les gardes et le futur harness. */
export const SITUATION_TYPES: readonly string[] = Object.values(PACK_REGISTRY)
  .flatMap((pack) => [...pack.declaredSituationTypes])

export const EVIDENCE_TYPES: readonly string[] = Array.from(
  new Set(
    Object.values(PACK_REGISTRY).flatMap((pack) => [...pack.declaredEvidenceTypes]),
  ),
)
