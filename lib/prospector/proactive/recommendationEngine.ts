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
  SituationType,
} from './types'

export const RECOMMENDATION_RULE_VERSION = 'v0.1'

interface RecommendationRule {
  play: PlayType
  recommendedAction: string
  reason: string
}

const RULES: Record<SituationType, RecommendationRule> = {
  sales_scale_up: {
    play: 'engage_or_reengage',
    recommendedAction:
      'Engager ou réengager le compte avec une approche contextualisée.',
    reason:
      'Le compte présente plusieurs éléments cohérents avec une phase d’accélération commerciale.',
  },

  commercial_momentum_stalled: {
    play: 'follow_up',
    recommendedAction:
      'Relancer la relation et obtenir un prochain engagement explicite.',
    reason:
      'Un intérêt commercial existe mais la relation risque de perdre son momentum.',
  },

  strong_signal_low_context: {
    play: 'investigate',
    recommendedAction:
      'Enrichir le compte et le contexte relationnel avant toute prise de contact.',
    reason:
      'Un signal commercial intéressant existe mais les informations disponibles sont insuffisantes pour recommander une approche directe.',
  },
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

  invalid_context:
    'Le contexte disponible est invalide ou insuffisant pour produire une recommandation fiable.',
}

export interface RecommendationContext
  extends EligibilityContext {}

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

function stableRecommendationId(
  situation: Situation,
): string {
  return `rec_${situation.id}`
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
    id: stableRecommendationId(situation),
    situationId: situation.id,
    accountId: situation.accountId,
    personId: situation.personId,

    decision: 'no_action',

    reason: ELIGIBILITY_REASON[eligibilityReason],

    whyNow:
      eligibilityReason === 'recent_contact' &&
      blockedUntil
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

  const rule = RULES[situation.type]

  const nowIso = context.now.toISOString()

  return {
    id: stableRecommendationId(situation),
    situationId: situation.id,
    accountId: situation.accountId,
    personId: situation.personId,

    decision: 'recommend',

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