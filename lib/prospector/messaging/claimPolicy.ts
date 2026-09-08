// JS-015 B1 — POLITIQUE DE CLAIMS : interdits BLOQUANTS + contraintes DÉRIVÉES.
//
// ── DEUX OBJETS, JAMAIS CONFONDUS ───────────────────────────────────────────
// `forbiddenClaims` : les termes/claims interdits — adaptés du référentiel
// existant (contenu PRÉSERVÉ), appliqués en BLOQUANT dans le nouveau chemin.
// `detectDealKillers` (capabilities) reste ce qu'il est : un avertissement
// UI hérité — il n'est NI renommé NI traité comme équivalent.
// `claimConstraints` : une politique NOUVELLE, DÉRIVÉE de l'évidence éligible,
// de l'incertitude, de l'autorité temporelle et des budgets — pas de
// l'improvisation de rédaction.
import type {
  ClaimConstraintsV0,
  CommunicationEvidenceItemV0,
  EpistemicConstraintV0,
  ForbiddenClaimsV0,
  MessagingBudgetsV0,
} from './messageContext'

/** Adaptation du contenu du référentiel existant (`Referentiel.forbidden`). */
export function forbiddenClaimsFromReferentiel(ref: { forbidden: readonly string[] }): ForbiddenClaimsV0 {
  return Object.freeze({
    terms: Object.freeze(ref.forbidden.filter((t) => typeof t === 'string' && t.trim().length > 0)),
  })
}

/**
 * Dérive les contraintes de claims — PURE, déterministe :
 *   - montrable = évidence éligible, tronquée à min(researchShownBudget,
 *     evidenceBudget) — Shown ⊆ Used PAR CONSTRUCTION ; budget 0 ⇒ [] ;
 *   - toute évidence portant une incertitude vivante rejoint
 *     `uncertainAssertionRefs` : sa formulation certaine est interdite ;
 *   - `maxAssertions` = assertionBudget (0 ⇒ 0 : aucune assertion octroyée) ;
 *   - R2-C3 : l'épistémique de CHAQUE ref est PRÉSERVÉ SANS PERTE et SANS
 *     INTERPRÉTATION — incertitude, autorité temporelle, contre-signaux
 *     (identifiables COMME contre-signaux, jamais aplatis) et force, dans les
 *     formes EXACTES portées par CommunicationEvidenceItemV0. Aucun seuil de
 *     fraîcheur, aucun score : B2 décidera de l'effet sur la formulation.
 */
export function deriveClaimConstraints(
  evidence: readonly CommunicationEvidenceItemV0[],
  budgets: MessagingBudgetsV0,
): ClaimConstraintsV0 {
  const octroiMontrable = Math.max(0, Math.min(budgets.researchShownBudget, budgets.evidenceBudget))
  const showable = evidence.slice(0, octroiMontrable).map((e) => e.evidenceRef)
  // R4-C4 — CONTRE-SIGNAL ≠ INCERTITUDE. Seule une VRAIE incertitude non vide
  // interdit la formulation certaine ; une ref ne portant QUE des
  // contre-signaux n'entre PAS ici — ses contre-signaux restent préservés,
  // identifiables comme tels, sous epistemicByRef[ref].counterSignalRefs.
  const uncertain = evidence
    .filter((e) => typeof e.uncertainty === 'string' && e.uncertainty.trim().length > 0)
    .map((e) => e.evidenceRef)
  const epistemicByRef: Record<string, EpistemicConstraintV0> = {}
  for (const e of evidence) {
    const contrainte = {
      ...(e.uncertainty !== undefined ? { uncertainty: e.uncertainty } : {}),
      ...(e.temporalAuthority !== undefined ? { temporalAuthority: e.temporalAuthority } : {}),
      ...(e.counterSignalRefs !== undefined ? { counterSignalRefs: e.counterSignalRefs } : {}),
      ...(e.strength !== undefined ? { strength: e.strength } : {}),
    }
    if (Object.keys(contrainte).length > 0) epistemicByRef[e.evidenceRef] = Object.freeze(contrainte)
  }
  return Object.freeze({
    showableEvidenceRefs: Object.freeze(showable),
    uncertainAssertionRefs: Object.freeze(uncertain),
    maxAssertions: budgets.assertionBudget,
    epistemicByRef: Object.freeze(epistemicByRef),
  })
}

export type ClaimCheck =
  | { ok: true }
  | { ok: false; violations: readonly { kind: 'FORBIDDEN_TERM'; term: string }[] }

/**
 * Vérification BLOQUANTE d'un texte contre les interdits. Contrairement au
 * garde-fou hérité (advisory), un `ok:false` ici DOIT empêcher toute suite —
 * c'est le contrat du nouveau chemin, pas un conseil.
 */
export function checkForbiddenClaims(text: string, forbidden: ForbiddenClaimsV0): ClaimCheck {
  const bas = text.toLowerCase()
  const violations = forbidden.terms
    .filter((t) => bas.includes(t.toLowerCase()))
    .map((term) => ({ kind: 'FORBIDDEN_TERM' as const, term }))
  if (violations.length > 0) return { ok: false, violations: Object.freeze(violations) }
  return { ok: true }
}
