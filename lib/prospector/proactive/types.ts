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

/**
 * NATURE TEMPORELLE d'une evidence — « quand » est-il connu ?
 *
 * ── LE DÉFAUT QUE CE CHAMP FERME (JARVIS-PROACTIVE-01D, red-team) ───────────
 * `occurredAt` est obligatoire, donc toute evidence doit porter une date. Une
 * donnée d'ÉTAT non horodatée — « la fiche dit que ce lead est chaud » — n'en a
 * pourtant aucune : on sait qu'on l'observe maintenant, on ignore depuis quand
 * elle est vraie. La dater de `now` la rendait indiscernable d'un événement
 * survenu à l'instant, et le Situation Engine, qui lit la fraîcheur de
 * `occurredAt`, en tirait une urgence maximale.
 *
 * ── LE CHAMP EST OBLIGATOIRE, ET SANS VALEUR PAR DÉFAUT ────────────────────
 * Une première version le rendait optionnel, « absent ⇒ dated_event ». C'était
 * un fail-open sémantique : une future ingestion qui oublierait le champ verrait
 * ses evidences promues au rang d'événements datés, donc porteuses d'urgence,
 * sans que personne ne l'ait décidé. Oublier de dire ce qu'on sait ne doit pas
 * valoir affirmation.
 *
 *   `dated_event`   — `occurredAt` est OBLIGATOIRE et porte la date métier
 *                     réelle du fait. `observedAt` reste la date de découverte.
 *   `undated_state` — `occurredAt` est ABSENT, et le type l'interdit. Seul
 *                     `observedAt` existe : on constate un état, on ignore
 *                     depuis quand il est vrai. Aucune urgence n'en découle.
 *
 * « Observé maintenant » ne signifie jamais « survenu maintenant ».
 */
export type EvidenceTemporality = 'dated_event' | 'undated_state'

/** Champs communs aux deux natures temporelles. */
interface EvidenceBase {
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

  // Quand Prospector/Jarvis a constaté l'information. TOUJOURS présent : même
  // sans date métier, on sait quand on a regardé.
  observedAt: string

  // Dernière vérification éventuelle.
  lastVerifiedAt?: string

  // Après cette date, l'evidence ne doit plus être considérée fraîche.
  expiresAt?: string
}

/** Un fait daté : la date de survenue est connue, et elle est exigée. */
export interface DatedEventEvidence extends EvidenceBase {
  temporality: 'dated_event'

  // Quand l'événement a RÉELLEMENT eu lieu. Obligatoire : un événement daté
  // sans date n'est pas un événement daté.
  occurredAt: string
}

/**
 * Un état constaté dont la date de survenue est inconnue.
 *
 * ⚠️ `occurredAt?: never` n'est pas une coquetterie de typage : il rend
 * IMPOSSIBLE, à la compilation, de glisser une date de survenue inventée sur un
 * état non daté. L'ancienne version y recopiait `now`, et c'est exactement ce
 * qui faisait passer une fiche vieille de dix-huit mois pour un fait du jour.
 */
export interface UndatedStateEvidence extends EvidenceBase {
  temporality: 'undated_state'
  occurredAt?: never
}

export type EvidenceEvent = DatedEventEvidence | UndatedStateEvidence

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