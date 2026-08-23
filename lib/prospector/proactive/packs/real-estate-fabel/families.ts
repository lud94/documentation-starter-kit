// FABEL-RULEPACK-001 — FAMILLES DE RAISONNEMENT ET CONTRADICTIONS.
//
// ── DOCTRINE ────────────────────────────────────────────────────────────────
//
//     EvidenceType  =  un FAIT atomique
//     Family        =  un regroupement DÉCISIONNEL, propre à ce pack
//
// C'est pourquoi `site_expansion` et `geo_expansion` restent DEUX types alors
// qu'ils appartiennent à UNE famille ici : un pack Finance ou RH pourra très
// bien vouloir les distinguer, et le catalogue ne doit pas être appauvri pour
// arranger un seul vertical. Idem pour `hiring_freeze` / `hiring_decline` — une
// décision explicite n'est pas une observation statistique — et pour
// `financial_distress` / `legal_pressure`.
//
// ── POURQUOI LES FAMILLES EXISTENT ──────────────────────────────────────────
// Le gate de convergence compte des FAMILLES, jamais des evidences. Sans cela,
// une seule réalité — une campagne de recrutement visible à la fois en offres
// publiées et en croissance d'effectif — satisferait seule un « ≥ 2 signaux
// indépendants ». Ce serait un faux positif structurel.
import type { EvidenceEvent } from '../../types'

// ── SEUILS DE CONFIANCE ─────────────────────────────────────────────────────
//
//     PROVISIONAL V0
//     TO BE CALIBRATED BY GOLDEN-MIGRATE-001
//
// Aucun de ces nombres n'est une vérité métier. Ils sont conservateurs par
// défaut : il vaut mieux manquer une opportunité que recommander une prise de
// contact sur une base fragile.
//
// ⚠️ Le filtre UNIVERSEL du cœur (0.6, dans `evidenceIsUsable`) reste inchangé
// et s'applique en amont. Les seuils ci-dessous ne font que DURCIR.

/** Une evidence sous ce seuil ne COMPTE PAS dans une famille. */
export const MIN_FAMILY_EVIDENCE_CONFIDENCE = 0.7

export const MIN_SITUATION_CONFIDENCE_EXPANSION = 0.7
export const MIN_SITUATION_CONFIDENCE_FLEX = 0.7

/** Plus haut : les conséquences d'un faux positif y sont plus lourdes. */
export const MIN_SITUATION_CONFIDENCE_CONTRACTION = 0.75

// ── FAMILLES — SPACE_EXPANSION ──────────────────────────────────────────────
export type ExpansionFamily = 'F1_CAPITAL' | 'F2_WORKFORCE' | 'F3_FOOTPRINT' | 'F4_FIRST_PARTY_CAPACITY'

export const EXPANSION_FAMILIES: Readonly<Record<string, ExpansionFamily>> = {
  recent_funding: 'F1_CAPITAL',

  headcount_acceleration: 'F2_WORKFORCE',
  hiring_volume_surge: 'F2_WORKFORCE',

  site_expansion: 'F3_FOOTPRINT',
  geo_expansion: 'F3_FOOTPRINT',

  'real_estate.capacity_pressure_reported': 'F4_FIRST_PARTY_CAPACITY',
}

/**
 * Familles DYNAMIQUES — celles qui affirment un changement d'échelle.
 *
 * ⚠️ `F1_CAPITAL` en est volontairement absente, et c'est la clé de l'invariant
 * « funding seul ≠ space_expansion ». Une levée FINANCE une croissance
 * possible ; elle n'en est pas une. En excluant F1 du gate dynamique, la règle
 * rend l'interdit mécaniquement vrai plutôt que déclaratif.
 */
export const EXPANSION_DYNAMIC_FAMILIES: readonly ExpansionFamily[] = [
  'F2_WORKFORCE',
  'F3_FOOTPRINT',
]

/** Faits qui contredisent une hypothèse d'expansion. */
export const EXPANSION_CONTRADICTIONS: readonly string[] = [
  'workforce_contraction',
  'restructuring_announced',
  'real_estate.space_reduction_reported',
  'financial_distress',
  'legal_pressure',
]

// ── FAMILLES — SPACE_CONTRACTION ────────────────────────────────────────────
export type ContractionFamily =
  | 'G1_WORKFORCE_DOWN'
  | 'G2_RESTRUCTURING'
  | 'G3_COST'
  | 'G4_DISTRESS'

export const CONTRACTION_FAMILIES: Readonly<Record<string, ContractionFamily>> = {
  workforce_contraction: 'G1_WORKFORCE_DOWN',
  hiring_freeze: 'G1_WORKFORCE_DOWN',
  hiring_decline: 'G1_WORKFORCE_DOWN',

  restructuring_announced: 'G2_RESTRUCTURING',

  cost_reduction_program: 'G3_COST',

  financial_distress: 'G4_DISTRESS',
  legal_pressure: 'G4_DISTRESS',
}

/**
 * Familles exigées pour qu'une contraction immobilière soit envisageable.
 *
 * ⚠️ Un programme de réduction de coûts SEUL, ou une difficulté financière
 * SEULE, ne suffisent jamais : il faut un changement d'ORGANISATION. Du
 * discours de coûts ne déplace pas des mètres carrés.
 */
export const CONTRACTION_REQUIRED_FAMILIES: readonly ContractionFamily[] = [
  'G1_WORKFORCE_DOWN',
  'G2_RESTRUCTURING',
]

/**
 * Familles SENSIBLES — celles qui rendent une prise de contact délicate.
 *
 * Conservé pour l'auditabilité et pour un futur plancher conditionnel. En V0,
 * le `controlFloor` du pack est appliqué à TOUTES les `space_contraction`
 * (cf. `index.ts`), ce qui est plus strict que ce que cette liste impliquerait.
 */
export const CONTRACTION_SENSITIVE_TYPES: readonly string[] = [
  'workforce_contraction',
  'restructuring_announced',
  'financial_distress',
  'legal_pressure',
]

/** Faits qui contredisent une hypothèse de contraction. */
export const CONTRACTION_CONTRADICTIONS: readonly string[] = [
  'site_expansion',
  'geo_expansion',
  'headcount_acceleration',
  'real_estate.capacity_pressure_reported',
]

// ── OUTILS DE FAMILLE ───────────────────────────────────────────────────────

/**
 * Familles DISTINCTES représentées par un lot d'evidences.
 *
 * Le filtre de confiance s'applique ICI : une evidence trop faible ne fait pas
 * entrer sa famille dans le décompte, même si elle a franchi le seuil universel
 * du cœur.
 */
export function famillesRepresentees<F extends string>(
  evidence: readonly EvidenceEvent[],
  table: Readonly<Record<string, F>>,
): Set<F> {
  const familles = new Set<F>()

  for (const item of evidence) {
    if (item.confidence < MIN_FAMILY_EVIDENCE_CONFIDENCE) continue
    const famille = table[item.type]
    if (famille) familles.add(famille)
  }

  return familles
}

/** Evidences appartenant à l'une des familles de la table, seuil compris. */
export function contributeursDeFamille<F extends string>(
  evidence: readonly EvidenceEvent[],
  table: Readonly<Record<string, F>>,
): EvidenceEvent[] {
  return evidence.filter(
    (item) =>
      item.confidence >= MIN_FAMILY_EVIDENCE_CONFIDENCE && !!table[item.type],
  )
}

/**
 * Une contradiction bloque-t-elle l'interprétation ?
 *
 * ── DOCTRINE TEMPORELLE, FAIL CLOSED ────────────────────────────────────────
 *
 *   • contradiction `undated_state`  → BLOQUE TOUJOURS. On ignore depuis quand
 *     elle est vraie ; la déclarer périmée serait inventer son ancienneté.
 *   • contradiction `dated_event`    → bloque si elle est AUSSI RÉCENTE ou plus
 *     récente que le plus récent signal positif daté.
 *   • aucun positif daté             → BLOQUE. Sans point de comparaison, on ne
 *     peut pas affirmer que la contradiction est dépassée.
 *
 * ⚠️ AUCUNE DATE N'EST FABRIQUÉE. `observedAt` n'est jamais lu comme une date
 * de survenue : une contradiction constatée aujourd'hui peut décrire un fait
 * ancien, et l'inverse est tout aussi vrai.
 */
export function contradictionBloquante(
  evidence: readonly EvidenceEvent[],
  typesContradictoires: readonly string[],
  positifs: readonly EvidenceEvent[],
): EvidenceEvent | null {
  const contradictions = evidence.filter((item) =>
    typesContradictoires.includes(item.type),
  )

  if (contradictions.length === 0) return null

  // Toute contradiction non datée bloque, sans autre examen.
  const nonDatee = contradictions.find((item) => item.temporality !== 'dated_event')
  if (nonDatee) return nonDatee

  const datesPositives = positifs
    .filter((item) => item.temporality === 'dated_event')
    .map((item) => Date.parse((item as any).occurredAt))
    .filter((ms) => Number.isFinite(ms))

  // Aucun positif daté : impossible de dire que la contradiction est dépassée.
  if (datesPositives.length === 0) return contradictions[0]

  const positifLePlusRecent = Math.max(...datesPositives)

  const bloquante = contradictions.find((item) => {
    const ms = Date.parse((item as any).occurredAt)
    if (!Number.isFinite(ms)) return true // date illisible ⇒ fail closed
    return ms >= positifLePlusRecent
  })

  return bloquante ?? null
}
