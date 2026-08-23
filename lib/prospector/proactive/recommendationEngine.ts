// JARVIS-PROACTIVE V0
// Recommendation Engine.
//
// Transforme une Situation en recommandation commerciale,
// mais UNIQUEMENT après passage par l'Eligibility Engine.
//
// Fonction pure et déterministe :
// - aucun LLM
// - aucun réseau
// - aucune mutation
// - une Situation valide peut volontairement produire NO_ACTION

import {
  eligibilityDecision,
  type EligibilityContext,
  type EligibilityReason,
} from './eligibility'
import type {
  PlayType,
  Recommendation,
  RecommendationPriority,
  Situation,
} from './types'
import { stableId } from './ruleKit'
import { rulePackById } from './packs/registry'
import type { RecommendationRule } from './rulePack'
import {
  resolveMotionControl,
  strictest,
  type AuthorizedMotion,
  type HumanControl,
  type MotionControl,
} from './motions'

export const RECOMMENDATION_RULE_VERSION = 'v0.1'

/**
 * ⚠️ LA TABLE `RULES` EXHAUSTIVE A DISPARU (ARCH-RULEPACK-001).
 *
 * Elle était un `Record<SituationType, …>` : ajouter un vertical cassait la
 * compilation de ce fichier, ce qui obligeait à modifier le moteur à chaque
 * pack. Le play est désormais lu sur le PACK qui a produit la situation, via
 * `situation.rulePackId`. Deux packs peuvent donc déclarer le même
 * `situationType` sans ambiguïté de résolution.
 */
function playForSituation(situation: Situation): RecommendationRule | null {
  const pack = rulePackById(situation.rulePackId)
  if (!pack) return null
  return pack.plays[situation.type] ?? null
}

/**
 * Plancher de contrôle déclaré par le pack pour ce type de situation.
 *
 * ⚠️ Un contexte peut le DURCIR, jamais l'assouplir — voir `resolveControl`.
 */
function controlFloorFor(situation: Situation): HumanControl | null {
  const pack = rulePackById(situation.rulePackId)
  return pack?.controlFloor?.[situation.type] ?? null
}

const ELIGIBILITY_REASON: Record<EligibilityReason, string> = {
  eligible:
    'La situation est éligible à une recommandation.',

  situation_expired:
    'La situation n’est plus suffisamment fraîche pour justifier une nouvelle action.',

  opt_out:
    'Le compte ou le contact ne doit pas être sollicité.',

  meeting_already_scheduled:
    'Un rendez-vous est déjà planifié ; aucune nouvelle sollicitation n’est nécessaire.',

  action_already_scheduled:
    'Une action commerciale est déjà programmée pour cette situation.',

  active_recommendation_exists:
    'Une recommandation active existe déjà ; Jarvis évite de créer un doublon.',

  recent_contact:
    'Le contact est trop récent ; Jarvis applique un délai avant de recommander une nouvelle sollicitation.',

  anticipated_window_not_open:
    'L’échéance anticipée est connue, mais sa fenêtre d’action n’est pas encore ouverte ; agir maintenant serait prématuré.',

  invalid_context:
    'Le contexte disponible est invalide ou insuffisant pour produire une recommandation fiable.',
}

/**
 * Contexte de décision.
 *
 * ⚠️ `businessContext` est OBLIGATOIRE et n'a AUCUNE valeur par défaut. Un
 * contexte absent ne se synthétise pas : ni `contextId: 'default'`, ni
 * capacités devinées. « L'appelant a oublié son contexte » ne doit jamais se
 * traduire par « on lui en fabrique un ».
 */
export interface RecommendationContext extends EligibilityContext {
  businessContext: RecommendationBusinessContext
}

/** Part du Business Context dont le moteur a réellement besoin. */
export interface RecommendationBusinessContext {
  contextId: string
  contextVersion: string
  authorizedMotions: Readonly<Partial<Record<AuthorizedMotion, MotionControl>>>
}

function validScore(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  )
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * IDENTITÉ CONTEXTUALISÉE (ARCH-RULEPACK-001).
 *
 * ⚠️ `rec_${situation.id}` NE SUFFISAIT PLUS. `control` dépend des capacités
 * accordées par le Business Context : deux contextes produisent deux
 * recommandations DIFFÉRENTES pour la même situation. Sans `contextId` dans
 * l'identité, la seconde écraserait silencieusement la première dans
 * `prospector_store`, dont la clé est `(kind, id, workspace_id)`.
 *
 * `contextVersion` reste hors identité : une évolution de politique REMPLACE
 * la ligne courante, elle n'en crée pas une seconde — même doctrine que
 * `ruleVersion`.
 *
 * Encodage à longueur préfixée, comme pour `Situation` : non ambigu, donc
 * injectif. Une concaténation naïve permettrait à deux couples distincts de
 * produire le même identifiant.
 */
function stableRecommendationId(
  situation: Situation,
  contextId: string,
): string {
  return stableId('rec', [situation.id, contextId])
}

function priorityForSituation(
  situation: Situation,
): RecommendationPriority {
  // La priorité n'est PAS une probabilité de signature.
  // Elle représente uniquement le niveau d'attention recommandé.

  if (
    situation.relevance >= 0.8 &&
    situation.urgency >= 0.8
  ) {
    return 'high'
  }

  if (
    situation.relevance >= 0.6 &&
    situation.urgency >= 0.5
  ) {
    return 'medium'
  }

  return 'low'
}

function recommendationConfidence(
  situation: Situation,
): number {
  // Approche volontairement conservatrice :
  // une recommandation ne peut pas être considérée
  // plus fiable que son maillon le plus faible.
  return roundScore(
    Math.min(
      situation.confidence,
      situation.relevance,
    ),
  )
}

function earliestDate(
  first?: string,
  second?: string,
): string | undefined {
  if (!first) return second
  if (!second) return first

  const firstMs = Date.parse(first)
  const secondMs = Date.parse(second)

  if (
    !Number.isFinite(firstMs) ||
    !Number.isFinite(secondMs)
  ) {
    return undefined
  }

  return new Date(
    Math.min(firstMs, secondMs),
  ).toISOString()
}

function noActionRecommendation(
  situation: Situation,
  context: RecommendationContext,
  eligibilityReason: EligibilityReason,
  blockedUntil?: string,
): Recommendation {
  const nowMs = context.now.getTime()
const fallbackMs = Date.parse(situation.lastEvaluatedAt)

const nowIso = Number.isFinite(nowMs)
  ? context.now.toISOString()
  : Number.isFinite(fallbackMs)
    ? new Date(fallbackMs).toISOString()
    : '1970-01-01T00:00:00.000Z'

  return {
    id: stableRecommendationId(situation, context.businessContext.contextId),
    situationId: situation.id,
    accountId: situation.accountId,
    personId: situation.personId,

    decision: 'no_action',

    // Aucune action n'est recommandée : aucune capacité n'est requise, et le
    // contrôle est sans objet. `blocked` serait trompeur — rien n'est bloqué,
    // il n'y a simplement rien à faire.
    control: 'autonomous',
    controlReason: 'Aucune action recommandée : aucune capacité n’est engagée.',
    requiredMotions: [],

    contextId: context.businessContext.contextId,
    contextVersion: context.businessContext.contextVersion,

    reason: ELIGIBILITY_REASON[eligibilityReason],

    // Tout blocage DATÉ dit quand réévaluer, quelle qu'en soit la raison.
    // La condition portait sur `recent_contact` ; elle porte désormais sur la
    // présence d'une date, ce qui couvre aussi la fenêtre d'action non encore
    // ouverte. Le texte des cas existants est INCHANGÉ.
    whyNow: blockedUntil
      ? `Ne pas agir maintenant. Réévaluation possible après ${blockedUntil}.`
      : 'Aucune action commerciale ne doit être recommandée dans le contexte actuel.',

    priority: 'low',

    confidence:
      validScore(situation.confidence) &&
      validScore(situation.relevance)
        ? recommendationConfidence(situation)
        : 0,

    ruleId: `eligibility-${eligibilityReason}`,
    ruleVersion: RECOMMENDATION_RULE_VERSION,

    createdAt: nowIso,

    // Pour un blocage temporaire, on ne prolonge jamais la
    // recommandation au-delà de la durée de vie de la Situation.
    expiresAt: earliestDate(
      situation.expiresAt,
      blockedUntil,
    ),
  }
}

export function recommendationDecision(
  situation: Situation,
  context: RecommendationContext,
): Recommendation {
  const nowMs = context.now.getTime()

  // Fail closed avant toute décision métier.
  if (
    !Number.isFinite(nowMs) ||
    !situation.id ||
    !situation.accountId ||
    !validScore(situation.confidence) ||
    !validScore(situation.relevance) ||
    !validScore(situation.urgency)
  ) {
    return noActionRecommendation(
      situation,
      context,
      'invalid_context',
    )
  }

  const eligibility = eligibilityDecision(
    situation,
    context,
  )

  if (!eligibility.eligible) {
    return noActionRecommendation(
      situation,
      context,
      eligibility.reason,
      eligibility.blockedUntil,
    )
  }

  const rule = playForSituation(situation)

  // Un type de situation sans play déclaré par son pack n'est pas actionnable.
  // Fail closed : on ne devine pas quoi recommander.
  if (!rule) {
    return noActionRecommendation(situation, context, 'invalid_context')
  }

  const nowIso = context.now.toISOString()

  // ── CONTRÔLE HUMAIN — le plus STRICT de deux sources ──────────────────────
  // 1. les capacités accordées par le Business Context ;
  // 2. le plancher éventuellement imposé par le pack.
  // Un contexte ne peut jamais assouplir un plancher de pack.
  const verdict = resolveMotionControl(rule.play, context.businessContext.authorizedMotions)
  const floor = controlFloorFor(situation)
  const control = floor ? strictest(verdict.control, floor) : verdict.control
  const controlReason =
    floor && control === floor && floor !== verdict.control
      ? `Plancher de contrôle imposé par le pack « ${situation.rulePackId} » pour « ${situation.type} ».`
      : verdict.reason

  return {
    id: stableRecommendationId(situation, context.businessContext.contextId),
    situationId: situation.id,
    accountId: situation.accountId,
    personId: situation.personId,

    decision: 'recommend',

    // ⚠️ `decision` et `control` sont ORTHOGONAUX. `recommend` +
    // `approval_required` est un état parfaitement valide : la situation
    // justifie d'agir, un humain valide d'abord.
    control,
    controlReason,
    requiredMotions: verdict.requiredMotions,

    contextId: context.businessContext.contextId,
    contextVersion: context.businessContext.contextVersion,

    reason: rule.reason,

    whyNow:
      `La situation "${situation.type}" est active, ` +
      `pertinente et éligible. ${situation.rationale}`,

    priority: priorityForSituation(situation),

    confidence:
      recommendationConfidence(situation),

    play: rule.play,
    recommendedAction: rule.recommendedAction,

    ruleId: `recommend-${situation.type}`,
    ruleVersion: RECOMMENDATION_RULE_VERSION,

    createdAt: nowIso,
    expiresAt: situation.expiresAt,
  }
}