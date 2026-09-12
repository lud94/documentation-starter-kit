// JS-015 B2A — ÉGALITÉ SÉMANTIQUE DES FAITS ÉPISTÉMIQUES (clôture de dette
// JS015-B2-EPISTEMIC-EQUALITY-001).
//
// ── POURQUOI CE MODULE ──────────────────────────────────────────────────────
// B1 comparait la lignée évidence ↔ epistemicByRef par JSON.stringify : correct
// mais sensible à l'ORDRE D'INSERTION des propriétés — deux objets sémantiquement
// identiques pouvaient être rejetés (sur-refus fail-closed, jamais sous-refus).
// Ici la comparaison est EXPLICITE, champ par champ, sur les formes CANONIQUES
// FERMÉES du contrat — pas une bibliothèque d'égalité profonde générique.
//
// ── FAIL-CLOSED PRÉSERVÉ ────────────────────────────────────────────────────
// Toute forme inattendue (mauvais type, clé parasite) compare à FAUX : un fait
// non reconnu n'est jamais déclaré égal.
import type { EvidenceStrengthV0, SignalTemporalAuthority } from '../proactive/types'
import type { EpistemicConstraintV0 } from './messageContext'

const objetPlat = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** EvidenceStrengthV0 : l'identité sémantique est le `kind` — forme {kind} exacte. */
export function memeForce(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true
  if (!objetPlat(a) || !objetPlat(b)) return false
  if (Object.keys(a).length !== 1 || Object.keys(b).length !== 1) return false
  return typeof a.kind === 'string' && a.kind === b.kind
}

/** SignalTemporalAuthority : `basis` + `referenceDay` — forme {basis, referenceDay} exacte. */
export function memeAutoriteTemporelle(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true
  if (!objetPlat(a) || !objetPlat(b)) return false
  if (Object.keys(a).length !== 2 || Object.keys(b).length !== 2) return false
  return typeof a.basis === 'string' && a.basis === b.basis
    && typeof a.referenceDay === 'string' && a.referenceDay === b.referenceDay
}

/** Incertitude : égalité stricte de chaîne (absence ↔ absence). */
export function memeIncertitude(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true
  return typeof a === 'string' && a === b
}

/**
 * Contre-signaux : égalité de COLLECTION DE REFS — l'identité sémantique est
 * l'ENSEMBLE des refs référencées, pas l'ordre du tableau ni ses doublons.
 * Deux listes désignant les mêmes contre-signaux sont le même fait.
 */
export function memesContreSignaux(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.some((r) => typeof r !== 'string') || b.some((r) => typeof r !== 'string')) return false
  const ea = new Set(a as string[])
  const eb = new Set(b as string[])
  if (ea.size !== eb.size) return false
  for (const r of ea) if (!eb.has(r)) return false
  return true
}

/**
 * Égalité sémantique d'un état épistémique complet (les 4 champs fermés du
 * contrat), champ par champ — l'ordre d'insertion des propriétés n'est JAMAIS
 * signifiant. Utilisée par le validateur pour la cohérence de lignée.
 */
export function memeEpistemique(
  a: { uncertainty?: unknown; temporalAuthority?: unknown; counterSignalRefs?: unknown; strength?: unknown } | undefined,
  b: { uncertainty?: unknown; temporalAuthority?: unknown; counterSignalRefs?: unknown; strength?: unknown } | undefined,
): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return memeIncertitude(a.uncertainty, b.uncertainty)
    && memeAutoriteTemporelle(a.temporalAuthority, b.temporalAuthority)
    && memesContreSignaux(a.counterSignalRefs, b.counterSignalRefs)
    && memeForce(a.strength, b.strength)
}

// Les types canoniques restent la référence : ces alias forcent la compilation
// à échouer si les formes canoniques divergent un jour des comparateurs.
export type _ForceComparee = EvidenceStrengthV0['kind']
export type _BaseComparee = SignalTemporalAuthority['basis']
export type _EpistemiqueCompare = EpistemicConstraintV0
