// FABEL-RULEPACK-001 — AGRÉGATION ET ARITHMÉTIQUE CALENDAIRE, AU NIVEAU DU PACK.
//
// ── POURQUOI NE PAS UTILISER `bestEvidenceByType` ───────────────────────────
// Ce helper du cœur ne retient qu'UNE evidence par type. C'est le bon choix
// pour `sales-core`, mais il serait faux ici : trois ouvertures de sites en six
// mois sont trois preuves distinctes d'un même mouvement. N'en garder qu'une
// amputerait `evidenceIds` de deux contributeurs réels et fausserait la
// confiance moyenne — l'auditabilité serait mensongère alors même que le
// verdict serait juste.
//
// Le cœur n'a pas eu à bouger pour autant : `detect()` reçoit DÉJÀ la totalité
// des evidences utilisables. `bestEvidenceByType` est un outil, jamais une
// contrainte.
import type { EvidenceEvent } from '../../types'

/** Toutes les evidences des types demandés — pas seulement la meilleure. */
export function toutesLesEvidencesDeTypes(
  evidence: readonly EvidenceEvent[],
  types: readonly string[],
): EvidenceEvent[] {
  return evidence.filter((item) => types.includes(item.type))
}

/**
 * Ordre STABLE des contributeurs.
 *
 * Deux évaluations identiques doivent produire les mêmes `evidenceIds`, DANS LE
 * MÊME ORDRE : ils sont persistés, et un ordre instable rendrait deux lignes
 * identiques visuellement différentes.
 */
export function ordonnerContributeurs(evidence: readonly EvidenceEvent[]): EvidenceEvent[] {
  return [...evidence].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** La plus récente evidence datée d'un lot, ou `null` si aucune n'est datée. */
export function plusRecenteDatee(
  evidence: readonly EvidenceEvent[],
): EvidenceEvent | null {
  const datees = evidence.filter((item) => item.temporality === 'dated_event')
  if (datees.length === 0) return null

  return datees.reduce((a, b) =>
    Date.parse((b as any).occurredAt) > Date.parse((a as any).occurredAt) ? b : a,
  )
}

// ── ARITHMÉTIQUE CALENDAIRE ─────────────────────────────────────────────────

const JOURS_PAR_MOIS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function estBissextile(annee: number): boolean {
  return (annee % 4 === 0 && annee % 100 !== 0) || annee % 400 === 0
}

function joursDansLeMois(annee: number, mois: number): number {
  if (mois === 1) return estBissextile(annee) ? 29 : 28
  return JOURS_PAR_MOIS[mois]
}

/**
 * Ajoute un nombre ENTIER de mois calendaires, en UTC.
 *
 * ── ⚠️ POURQUOI PAS `durée × 30 jours` ──────────────────────────────────────
 * Parce que ce n'est pas la même chose. Un décalage de « 30 jours par mois »
 * dérive d'environ cinq jours par an : sur un engagement de 24 mois, l'échéance
 * calculée serait fausse de plus d'une semaine. Une fenêtre de revue construite
 * sur une approximation n'est pas une fenêtre, c'est une estimation déguisée.
 *
 * ── CLAMP DE FIN DE MOIS ────────────────────────────────────────────────────
 * Le jour est ramené au dernier jour du mois cible lorsqu'il n'y existe pas :
 *
 *     31 janvier + 1 mois  →  28 février   (29 en année bissextile)
 *     31 mars    + 1 mois  →  30 avril
 *
 * Heure, minute, seconde et milliseconde sont CONSERVÉES : seule la composante
 * calendaire bouge.
 *
 * `mois` peut être négatif — c'est ainsi que l'ouverture de fenêtre se calcule
 * en reculant depuis l'échéance.
 */
export function addMonthsUTC(iso: string, mois: number): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  if (!Number.isInteger(mois)) return null

  const d = new Date(ms)

  const anneeSource = d.getUTCFullYear()
  const moisSource = d.getUTCMonth()
  const jourSource = d.getUTCDate()

  // Normalisation : un mois cible hors [0,11] déborde sur l'année.
  const moisAbsolu = moisSource + mois
  const anneeCible = anneeSource + Math.floor(moisAbsolu / 12)
  const moisCible = ((moisAbsolu % 12) + 12) % 12

  const jourCible = Math.min(jourSource, joursDansLeMois(anneeCible, moisCible))

  return new Date(
    Date.UTC(
      anneeCible,
      moisCible,
      jourCible,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  ).toISOString()
}

/**
 * Durée déclarée en MOIS — entier strictement positif.
 *
 * ⚠️ AUCUN NOMBRE SANS UNITÉ. L'unité vit dans le NOM du type d'evidence
 * (`…_duration_months_declared`) : un `value: 24` isolé pourrait signifier des
 * mois, des semaines ou des jours, et le moteur n'aurait aucun moyen de le
 * savoir. Ici, la seule lecture possible est « 24 mois ».
 */
export function dureeEnMois(evidence: EvidenceEvent): number | null {
  const brut = (evidence as any)?.value
  if (typeof brut !== 'number') return null
  if (!Number.isInteger(brut)) return null
  if (brut <= 0) return null
  return brut
}
