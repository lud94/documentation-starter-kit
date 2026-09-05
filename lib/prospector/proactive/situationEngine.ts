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
import type { AnyRulePack, SituationEvaluationContext, SituationRule } from './rulePack'
import { PACK_REGISTRY, type RulePackId } from './packs/registry'
import {
  freshnessDeadlineMs,
  temporalReference,
  temporalWindowLookup,
  validDateMs,
  validScore,
  withinMaxAgeDays,
} from './ruleKit'

export type { SituationEvaluationContext } from './rulePack'

/**
 * ⚠️ CONSERVÉ POUR COMPATIBILITÉ DE SURFACE.
 *
 * La version de règle appartient désormais au PACK (`packVersion`), puisque
 * c'est lui qui porte les règles. Cette constante reste exportée parce que du
 * code et des tests la référencent ; elle vaut la version de `sales-core`.
 */
export const SITUATION_RULE_VERSION = 'v0.3'

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
/**
 * L'evidence CONCERNE-T-ELLE cette cible ? — prédicat de CIBLAGE seul.
 *
 * ⚠️ EXTRAIT DE `evidenceIsUsable`, SANS MODIFICATION. Trois règles, et elles
 * décident à elles seules de la sémantique Evidence ↔ Target :
 *
 *   1. le compte doit correspondre ;
 *   2. une evidence PORTANT un `personId` ne vaut QUE pour cette personne —
 *      elle n'est donc jamais consommée par une cible « compte » ;
 *   3. une evidence de portée `person` SANS `personId` ne vaut pas pour une
 *      cible personne (on ignore de qui elle parle), mais reste valable au
 *      niveau compte.
 *
 * Exporté pour que le validateur du runner puisse vérifier qu'aucune evidence
 * n'est orpheline EN UTILISANT CETTE RÈGLE-CI, et non une reformulation qui
 * finirait par diverger. Le filtrage TEMPOREL, lui, reste hors de ce prédicat :
 * une evidence expirée est légitimement présente, simplement inexploitable.
 */
export function evidenceMatchesTarget(
  evidence: EvidenceEvent,
  target: { accountId: string; personId?: string },
): boolean {
  if (!evidence || !evidence.id || !evidence.accountId) return false
  if (evidence.accountId !== target.accountId) return false
  if (evidence.personId && evidence.personId !== target.personId) return false
  if (target.personId && evidence.scope === 'person' && !evidence.personId) {
    return false
  }
  return true
}

function evidenceIsUsable(
  evidence: EvidenceEvent,
  context: SituationEvaluationContext,
): boolean {
  const nowMs = context.now.getTime()

  if (!evidenceMatchesTarget(evidence, context)) return false

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
      // ── SIGNAL_TEMPORAL_WINDOW_V0_001 : LE CŒUR APPLIQUE LA FENÊTRE DE LA
      // RÈGLE, AVANT `detect`. La règle déclare le nombre ; elle ne filtre
      // jamais elle-même, et ne peut pas contourner sa propre déclaration —
      // l'evidence hors fenêtre n'atteint tout simplement pas le détecteur.
      // Une règle SANS politique voit l'entrée inchangée (comportement
      // antérieur préservé à l'identique).
      const admissible = admissibleForRule(usable, rule, context)
      const s = rule.detect(admissible, context)
      // ── BORNE DE VALIDITÉ PERSISTÉE. Filtrer à l'évaluation ne suffit pas :
      // une Situation produite au jour 89 d'une fenêtre de 90 ne doit pas
      // survivre 30 jours de TTL. Son `expiresAt` est ramené à la PLUS PROCHE
      // échéance de fraîcheur parmi les contributeurs réellement cités —
      // l'Eligibility existante la rejettera alors en `situation_expired`.
      if (s) produced.push(clampToFreshnessDeadlines(s, admissible, rule, context))
    }

    // Le pack ne voit QUE ses propres situations.
    const arbitrees = pack.arbitrate ? pack.arbitrate(produced) : produced
    situations.push(...arbitrees)
  }

  return situations
}

/**
 * La fenêtre déclarée par la règle pour ce type — lecture FERMÉE (R1).
 *
 * ⚠️ ABSENCE ≠ MALFORMATION. Une clé absente conserve le comportement
 * antérieur ; une clé présente mais illisible (`"90"`, NaN, Infinity, négatif,
 * non-entier) rend INVALID, et l'evidence de ce type n'atteint JAMAIS
 * `detect` sous cette règle. Représenter les deux par la même valeur ferait
 * d'une faute de frappe une fenêtre INFINIE — un échec ouvert.
 */
function fenetreDeRegle(
  rule: SituationRule<string, string>,
  evidenceType: string,
) {
  return temporalWindowLookup(
    rule.temporalPolicy?.maxAgeDaysByEvidenceType as
      Readonly<Record<string, unknown>> | undefined,
    evidenceType,
  )
}

/**
 * Les evidences temporellement ADMISSIBLES pour UNE règle.
 *
 * ⚠️ L'exclusion est PAR RÈGLE, jamais globale : le fait reste vrai, présent,
 * consommable par toute règle qui ne déclare pas de fenêtre pour son type.
 * L'âge n'invalide pas le fait — il retire seulement sa pertinence pour CETTE
 * hypothèse commerciale.
 */
function admissibleForRule(
  usable: readonly EvidenceEvent[],
  rule: SituationRule<string, string>,
  context: SituationEvaluationContext,
): EvidenceEvent[] {
  if (!rule.temporalPolicy) return [...usable]

  return usable.filter((item) => {
    const fenetre = fenetreDeRegle(rule, item.type)
    if (fenetre.kind === 'NONE') return true
    // ⚠️ POLITIQUE MALFORMÉE ⇒ FAIL CLOSED pour ce type sous cette règle. Une
    // fenêtre illisible ne peut que RETIRER de l'éligibilité — jamais en créer.
    if (fenetre.kind === 'INVALID') return false
    const reference = temporalReference(
      item,
      context.now,
      context.temporalAuthorityByEvidenceId?.[item.id],
    )
    return withinMaxAgeDays(reference, context.now, fenetre.maxAgeDays)
  })
}

/**
 * Ramène `Situation.expiresAt` à la PLUS PROCHE échéance de fraîcheur des
 * contributeurs cités soumis à une fenêtre. `min` uniquement — jamais un
 * report : la borne `anticipated.at` et le TTL réglementaire restent intacts
 * quand ils sont plus proches. Aucune Evidence n'est mutée.
 */
function clampToFreshnessDeadlines(
  situation: Situation,
  admissible: readonly EvidenceEvent[],
  rule: SituationRule<string, string>,
  context: SituationEvaluationContext,
): Situation {
  if (!rule.temporalPolicy) return situation

  const parId = new Map(admissible.map((item) => [item.id, item]))
  let borneMs: number | null = null

  for (const id of situation.evidenceIds) {
    const item = parId.get(id)
    if (!item) continue
    const fenetre = fenetreDeRegle(rule, item.type)
    // Sans fenêtre : aucun faux plafond. INVALID est INATTEIGNABLE ici — une
    // evidence sous politique malformée n'a pas franchi `admissibleForRule`,
    // donc ne peut pas être citée ; on n'invente pas d'échéance pour autant.
    if (fenetre.kind !== 'VALID') continue
    const echeance = freshnessDeadlineMs(
      temporalReference(item, context.now, context.temporalAuthorityByEvidenceId?.[item.id]),
      fenetre.maxAgeDays,
    )
    if (echeance === null) continue
    if (borneMs === null || echeance < borneMs) borneMs = echeance
  }

  if (borneMs === null) return situation
  const courantMs = validDateMs(situation.expiresAt ?? '')
  if (courantMs !== null && courantMs <= borneMs) return situation
  return { ...situation, expiresAt: new Date(borneMs).toISOString() }
}
