// Mode de la réservation budgétaire — OFF / OBSERVE / ENFORCE (lot C2a-2).
//
// POURQUOI TROIS ÉTATS ET NON UN DRAPEAU. L'estimation est volontairement
// majorante ; passer directement d'« aucun garde » à « garde armé » reviendrait
// à calibrer le plafond en production de staging, avec de vrais refus comme
// signal d'apprentissage. OBSERVE mesure ce qu'un plafond candidat AURAIT fait,
// sans rien empêcher.
//
// ── Séparation des deux variables, et pourquoi elle est indispensable ────────
//   ANTHROPIC_BUDGET        plafond RÉELLEMENT opposable. Lu par le garde C1
//                           (`budgetLeft`) et, en ENFORCE seulement, transmis à
//                           `prospector_ai_reserve`.
//   AI_BUDGET_OBSERVE_LIMIT seuil CANDIDAT. Strictement informatif : il ne peut
//                           emprunter aucun chemin qui refuse un appel.
//
// Sans cette séparation, une fenêtre OBSERVE menée avec un ANTHROPIC_BUDGET posé
// mesurerait un trafic déjà écrêté par C1 — donc un `would_have_blocked`
// sous-estimé, c'est-à-dire l'erreur dans le sens le plus dangereux pour une
// calibration. Une fenêtre OBSERVE se mène ANTHROPIC_BUDGET absent.
//
// ⚠️ DÉFAUT D'EXÉCUTION : OFF. Absente, vide, ou non reconnue ⇒ OFF. Jamais
// ENFORCE. Une faute de frappe doit désarmer un instrument de mesure — visible
// et sans conséquence financière — pas armer un plafond.
// « OBSERVE par défaut sur un nouvel environnement » est une PROCÉDURE
// d'activation, pas une valeur implicite du code.
import { getKey } from './keystore'
import { readBudgetConfig } from './money'

export type BudgetMode = 'OFF' | 'OBSERVE' | 'ENFORCE'

export const BUDGET_MODE_KEY = 'AI_BUDGET_RESERVATION'
export const OBSERVE_LIMIT_KEY = 'AI_BUDGET_OBSERVE_LIMIT'

export function budgetMode(): BudgetMode {
  const raw = (getKey(BUDGET_MODE_KEY) || '').trim().toUpperCase()
  if (raw === 'OBSERVE') return 'OBSERVE'
  if (raw === 'ENFORCE') return 'ENFORCE'
  return 'OFF'
}

// Forme PLATE, pas une union discriminée : le dépôt compile avec `strict: false`,
// où TypeScript ne rétrécit pas une union sur `!x.ok` (défaut rencontré en C2a-1b).
export interface ObserveLimit {
  /** Un seuil candidat exploitable est disponible. */
  ok: boolean
  micros: bigint
  /** Renseigné quand la saisie existe mais est illisible. */
  invalidReason?: string
}

/**
 * Seuil candidat pour OBSERVE. Une saisie illisible ne bloque RIEN : on rend
 * `ok:false` avec le motif, la ligne de télémétrie porte alors
 * `would_have_blocked: null`. Un seuil hypothétique mal saisi ne doit pas
 * produire un refus réel, ni une décision fabriquée.
 */
export function observeLimit(): ObserveLimit {
  const cfg = readBudgetConfig(getKey(OBSERVE_LIMIT_KEY))
  if (cfg.kind === 'valid') return { ok: true, micros: cfg.micros }
  if (cfg.kind === 'invalid') return { ok: false, micros: 0n, invalidReason: cfg.reason }
  return { ok: false, micros: 0n }
}

/**
 * Plafond opposable pour ENFORCE. Forme plate, même raison que ci-dessus.
 * `invalid` est distingué d'`absent` : une saisie cassée FERME (cohérent avec
 * `budgetLeft`), une saisie absente signifie « aucun plafond demandé ».
 */
/**
 * ⚠️ QUATRE cas, jamais trois — le zéro est le piège.
 *
 * `readBudgetConfig` distingue déjà « absent » de « 0 saisi », et le contrat de
 * C1 est explicite : **un budget saisi à 0 signifie « aucune dépense
 * autorisée », pas « dépense illimitée »** (`budgetLeft`, cas `budgetMicros === 0n`).
 *
 * Or `prospector_ai_reserve` interprète `p_budget_micros = 0` comme « aucun
 * plafond » (migration gelée, ligne 68). Confondre les deux zéros — celui de la
 * saisie et celui du RPC — retournerait la sémantique : un hard stop deviendrait
 * une autorisation illimitée. `callClaude` était couvert par C1, mais les
 * appelants directs d'`anthropicPost` (dont `/api/ai/diagnose`) ne l'étaient pas.
 *
 * D'où `zero`, porté séparément : c'est un refus, il se traite AVANT le RPC et
 * ne lui est jamais délégué.
 */
export interface EnforceBudget {
  ok: boolean             // faux ⇔ saisie illisible ⇒ fail closed
  micros: bigint
  configured: boolean     // un plafond a été SAISI (zéro compris)
  positive: boolean       // un plafond STRICTEMENT POSITIF a été saisi
  zero: boolean           // plafond saisi à 0 ⇒ hard stop, aucune dépense
  invalidReason?: string
}

export function enforceBudget(): EnforceBudget {
  const cfg = readBudgetConfig(getKey('ANTHROPIC_BUDGET'))
  if (cfg.kind === 'invalid') {
    return { ok: false, micros: 0n, configured: false, positive: false, zero: false, invalidReason: cfg.reason }
  }
  if (cfg.kind === 'absent') {
    return { ok: true, micros: 0n, configured: false, positive: false, zero: false }
  }
  return {
    ok: true, micros: cfg.micros, configured: true,
    positive: cfg.micros > 0n, zero: cfg.micros === 0n,
  }
}

/**
 * Avertissement de biais d'observation. N'échoue PAS : refuser de démarrer sur
 * une question de télémétrie serait disproportionné. Mais une fenêtre OBSERVE
 * menée avec cet avertissement dans les journaux ne compte pas pour les critères
 * d'entrée en ENFORCE.
 */
let biasWarned = false
export function warnIfObserveBiased(mode: BudgetMode): void {
  if (mode !== 'OBSERVE' || biasWarned) return
  const b = enforceBudget()
  if (!b.configured && b.ok) return
  biasWarned = true
  console.warn(
    '[c2a2] OBSERVE : ANTHROPIC_BUDGET est posé. En OBSERVE le garde C1 est '
    + 'NEUTRALISÉ pour que la mesure ne soit pas écrêtée — cette variable ne '
    + 'protège donc rien pendant la fenêtre d\'observation, et sa présence est '
    + 'une configuration incohérente. La retirer.',
  )
}

/** Réservé aux tests — l'avertissement n'est émis qu'une fois par instance. */
export function resetBiasWarning(): void { biasWarned = false }
