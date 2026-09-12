// FABEL-RULEPACK-001 — PROVENANCE FIRST-PARTY, CONVENTION V0.
//
// ── ⚠️ CE N'EST PAS UNE CLASSIFICATION DE PROVENANCE ────────────────────────
//
//     V0 TEST/PILOT CONVENTION
//     NOT A UNIVERSAL PROVENANCE CLASSIFICATION
//
// `EvidenceSource` ne porte aujourd'hui que `provider`, `reference` et `url` :
// il n'existe AUCUNE notion native de « first-party » dans le cœur, et
// prétendre le contraire serait faux. Ce module ne fait donc qu'une chose —
// comparer une chaîne à une liste blanche déclarée ICI, dans le pack.
//
// ── CE QUE CETTE CONVENTION NE VAUT PAS ─────────────────────────────────────
// Elle ne survit pas à un renommage de provider, ne se compose pas entre packs,
// et n'est vérifiable par aucune instance extérieure. Elle est acceptable
// UNIQUEMENT parce que les fixtures V0 sont écrites à la main et qu'aucun flux
// automatique n'alimente encore ce pack.
//
// ── POURQUOI ELLE EST MALGRÉ TOUT NÉCESSAIRE ────────────────────────────────
// `assertionType` répond à « quelle est la force épistémique de l'affirmation ? »
// mais pas à « QUI l'affirme ? ». Les deux axes sont orthogonaux : un scraper
// peut produire un `fact`, un client peut émettre une `assumption`. Or les deux
// raccourcis les plus puissants de ce pack — la pression de capacité déclarée
// et la fenêtre flex — n'ont de sens que si le compte lui-même l'a dit.
//
// Le vrai modèle de provenance appartient à `SIGNAL-EVIDENCE-BRIDGE-001`, pas
// à ce lot.
import type { EvidenceEvent } from '../../types'

/**
 * Providers considérés comme first-party pour le pilote Fabel.
 *
 * Liste FERMÉE : un provider absent n'emprunte JAMAIS le raccourci
 * first-party, quelle que soit sa confiance ou son `assertionType`.
 */
export const FIRST_PARTY_PROVIDERS: readonly string[] = [
  'client-declared',
  'fabel-crm',
]

/** L'evidence provient-elle du compte lui-même ? */
export function estFirstParty(evidence: EvidenceEvent): boolean {
  const provider = evidence?.source?.provider
  if (typeof provider !== 'string') return false
  return FIRST_PARTY_PROVIDERS.includes(provider)
}

/**
 * Le trio exigé par les raccourcis les plus engageants du pack :
 * une affirmation FACTUELLE, émise par le COMPTE, et suffisamment fiable.
 *
 * ⚠️ Les trois conditions sont cumulatives. En retirer une reviendrait à
 * laisser une inférence de tiers déclencher une prise de contact.
 */
export function estDeclarationFiable(
  evidence: EvidenceEvent,
  confianceMinimale: number,
): boolean {
  if (!evidence) return false
  if (evidence.assertionType !== 'fact') return false
  if (!estFirstParty(evidence)) return false
  if (typeof evidence.confidence !== 'number') return false
  return evidence.confidence >= confianceMinimale
}
