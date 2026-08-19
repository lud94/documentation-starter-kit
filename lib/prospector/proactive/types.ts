// JARVIS-PROACTIVE V0
// Contrats métier du Decision Model.
// Chaîne cible : EvidenceEvent -> Situation -> Eligibility -> Recommendation -> Outcome.
//
// Règle : ces objets décrivent des faits, interprétations et décisions.
// Ils ne contiennent volontairement aucune logique d'exécution.

export type EvidenceScope =
  | 'account'
  | 'person'
  | 'relationship'

export type AssertionType =
  | 'fact'
  | 'inference'
  | 'assumption'

export type EvidenceType =
  | 'recent_funding'
  | 'sales_hiring'
  | 'new_sales_leader'
  | 'headcount_acceleration'
  | 'positive_reply'
  | 'hot_lead'
  | 'no_next_step'
  | 'relationship_inactive'
  | 'missing_context'

export interface EvidenceSource {
  provider: string
  reference?: string
  url?: string
}

export interface EvidenceEvent {
  id: string

  // ACCOUNT reste la racine métier.
  accountId: string
  personId?: string

  scope: EvidenceScope
  type: EvidenceType

  // Valeur observable associée à l'événement.
  value?: string | number | boolean

  // Provenance : d'où vient l'information ?
  source: EvidenceSource

  // Nature épistémique : fait, inférence ou hypothèse.
  assertionType: AssertionType

  // 0..1 — confiance dans l'information elle-même.
  confidence: number

  // Quand l'événement a réellement eu lieu.
  occurredAt: string

  // Quand Prospector/Jarvis l'a découvert.
  observedAt: string

  // Dernière vérification éventuelle.
  lastVerifiedAt?: string

  // Après cette date, l'evidence ne doit plus être considérée fraîche.
  expiresAt?: string
}

export type SituationType =
  | 'sales_scale_up'
  | 'commercial_momentum_stalled'
  | 'strong_signal_low_context'

export interface Situation {
  id: string
  accountId: string
  personId?: string

  type: SituationType

  // Les EvidenceEvent qui justifient cette interprétation.
  evidenceIds: string[]

  // 0..1 — crédibilité de l'interprétation.
  confidence: number

  // 0..1 — pertinence pour ICP / offre / objectif commercial.
  relevance: number

  // 0..1 — nécessité d'agir maintenant.
  urgency: number

  // Explication déterministe / auditable.
  rationale: string

  // Traçabilité de la règle ayant produit la situation.
  ruleId: string
  ruleVersion: string

  createdAt: string
  lastEvaluatedAt: string
  expiresAt?: string
}

export type RecommendationDecision =
  | 'recommend'
  | 'no_action'

export type RecommendationPriority =
  | 'low'
  | 'medium'
  | 'high'

export type PlayType =
  | 'engage_or_reengage'
  | 'follow_up'
  | 'investigate'

export interface Recommendation {
  id: string
  situationId: string
  accountId: string
  personId?: string

  // Une situation valide peut volontairement produire NO_ACTION.
  decision: RecommendationDecision

  // Pourquoi Jarvis recommande — ou ne recommande pas — d'agir.
  reason: string
  whyNow: string

  priority: RecommendationPriority
  confidence: number

  // Absent lorsque decision = no_action.
  play?: PlayType
  recommendedAction?: string

  ruleId: string
  ruleVersion: string

  createdAt: string
  expiresAt?: string
}

export type OutcomeType =
  | 'recommendation_accepted'
  | 'recommendation_dismissed'
  | 'action_completed'
  | 'reply_received'
  | 'meeting_booked'
  | 'no_response'

export interface Outcome {
  id: string
  recommendationId: string
  accountId: string
  personId?: string

  type: OutcomeType

  // Résultat observé, jamais présenté comme une causalité prouvée.
  note?: string

  occurredAt: string
}