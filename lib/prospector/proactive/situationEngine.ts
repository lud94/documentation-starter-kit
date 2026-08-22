// JARVIS-PROACTIVE V0 · ARCH-RULEPACK-001
// Situation Engine — STABLE CORE.
//
// Transforme des EvidenceEvent valides en Situations commerciales.
// Fonction pure et déterministe :
// - aucun LLM
// - aucun réseau
// - aucune mutation
// - aucune situation inventée si les preuves sont insuffisantes
//
// ── CE QUE CE MODULE FAIT DÉSORMAIS, ET CE QU'IL NE FAIT PLUS ───────────────
// Il ne CONNAÎT plus aucune règle métier : les trois détecteurs Sales ont
// migré vers `packs/sales-core`, à l'identique. Ce qui reste ici est le cœur
// stable — validation temporelle des evidences, et orchestration des packs.
//
// Les helpers de calcul (fraîcheur, urgence, confiance, fabrique de Situation)
// vivent dans `./ruleKit` : les packs en ont besoin, et ce module doit importer
// le registre des packs. Les y laisser aurait produit le cycle
// packs → situationEngine → registry → packs.
import type { EvidenceEvent, Situation } from './types'
import type { AnyRulePack, SituationEvaluationContext } from './rulePack'
import { PACK_REGISTRY, type RulePackId } from './packs/registry'
import { validDateMs, validScore } from './ruleKit'

export type { SituationEvaluationContext } from './rulePack'

/**
 * ⚠️ CONSERVÉ POUR COMPATIBILITÉ DE SURFACE.
 *
 * La version de règle appartient désormais au PACK (`packVersion`), puisque
 * c'est lui qui porte les règles. Cette constante reste exportée parce que du
 * code et des tests la référencent ; elle vaut la version de `sales-core`.
 */
export const SITUATION_RULE_VERSION = 'v0.1'

// Seuils réexportés depuis le pack qui les possède réellement.
export {
  MIN_EVIDENCE_CONFIDENCE,
  STRONG_EVIDENCE_CONFIDENCE,
  MIN_SITUATION_CONFIDENCE,
} from './packs/sales-core'

/**
 * L'evidence est-elle utilisable au moment de l'évaluation ?
 *
 * Reste dans le CŒUR, et pour une raison de fond : un pack ne doit pas pouvoir
 * décider qu'une evidence périmée ou datée du futur est acceptable. Les
 * invariants temporels ne sont pas un choix métier.
 */
function evidenceIsUsable(
  evidence: EvidenceEvent,
  context: SituationEvaluationContext,
): boolean {
  const nowMs = context.now.getTime()

  if (!evidence || !evidence.id || !evidence.accountId) return false
  if (evidence.accountId !== context.accountId) return false

  // Une evidence de relation ne vaut que pour LA personne évaluée.
  if (evidence.personId && evidence.personId !== context.personId) return false
  if (context.personId && evidence.scope === 'person' && !evidence.personId) {
    return false
  }

  if (!validScore(evidence.confidence)) return false
  if (evidence.confidence < MIN_EVIDENCE_CONFIDENCE_VALUE) return false

  const observedMs = validDateMs(evidence.observedAt)
  if (observedMs === null) return false

  // Fail closed sur une observation prétendument future.
  if (observedMs > nowMs) return false

  if (evidence.temporality === 'dated_event') {
    const occurredMs = validDateMs(evidence.occurredAt)
    if (occurredMs === null) return false

    // NO HINDSIGHT : un fait qui n'a pas encore eu lieu ne prouve rien.
    if (occurredMs > nowMs) return false
  } else if (evidence.temporality !== 'undated_state') {
    // Temporalité absente ou inconnue : refusée. Oublier de dire ce qu'on sait
    // ne vaut pas affirmation.
    return false
  }

  if (evidence.expiresAt) {
    const expiresMs = validDateMs(evidence.expiresAt)
    if (expiresMs === null) return false
    if (nowMs >= expiresMs) return false
  }

  return true
}

// Valeur littérale, pour éviter une dépendance circulaire de valeur au pack.
const MIN_EVIDENCE_CONFIDENCE_VALUE = 0.6

/** Packs à exécuter. Par défaut : tous les packs enregistrés. */
function packsFor(ids?: readonly RulePackId[]): AnyRulePack[] {
  const retenus = ids && ids.length > 0 ? ids : (Object.keys(PACK_REGISTRY) as RulePackId[])
  return retenus.map((id) => PACK_REGISTRY[id] as AnyRulePack).filter(Boolean)
}

/**
 * Évalue les situations d'une cible.
 *
 * ⚠️ ARBITRATION STRICTEMENT INTRA-PACK. Chaque pack exécute SES règles, puis
 * arbitre SES propres résultats. Les sorties des packs sont ensuite
 * CONCATÉNÉES — jamais soumises à l'arbitration d'un autre. Un vertical ne peut
 * donc pas supprimer ni modifier les situations d'un autre : c'est garanti par
 * la boucle, pas par une convention.
 */
export function evaluateSituations(
  evidence: EvidenceEvent[],
  context: SituationEvaluationContext,
  rulePacks?: readonly RulePackId[],
): Situation[] {
  const nowMs = context.now.getTime()

  // Fail closed sur le contexte d'évaluation.
  if (
    !Number.isFinite(nowMs) ||
    !context.accountId ||
    !validScore(context.relevance) ||
    !context.lensId ||
    !context.lensVersion
  ) {
    return []
  }

  const usable = evidence.filter((item) => evidenceIsUsable(item, context))
  if (usable.length === 0) return []

  const situations: Situation[] = []

  for (const pack of packsFor(rulePacks)) {
    const produced: Situation[] = []

    for (const rule of pack.rules) {
      const s = rule.detect(usable, context)
      if (s) produced.push(s)
    }

    // Le pack ne voit QUE ses propres situations.
    const arbitrees = pack.arbitrate ? pack.arbitrate(produced) : produced
    situations.push(...arbitrees)
  }

  return situations
}
