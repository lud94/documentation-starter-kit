// JARVIS-PROACTIVE V0
// Situation Engine.
//
// Transforme des EvidenceEvent valides en Situations commerciales.
// Fonction pure et déterministe :
// - aucun LLM
// - aucun réseau
// - aucune mutation
// - aucune situation inventée si les preuves sont insuffisantes

import type {
  EvidenceEvent,
  EvidenceType,
  Situation,
  SituationType,
} from './types'

export const SITUATION_RULE_VERSION = 'v0.1'

export const MIN_EVIDENCE_CONFIDENCE = 0.6
export const STRONG_EVIDENCE_CONFIDENCE = 0.75
export const MIN_SITUATION_CONFIDENCE = 0.7

const DAY_MS = 24 * 60 * 60 * 1000

const SALES_SCALE_TYPES: EvidenceType[] = [
  'recent_funding',
  'sales_hiring',
  'new_sales_leader',
  'headcount_acceleration',
]

const EVIDENCE_LABELS: Partial<Record<EvidenceType, string>> = {
  recent_funding: 'levée récente',
  sales_hiring: 'recrutement Sales',
  new_sales_leader: 'nouveau responsable Sales',
  headcount_acceleration: 'accélération des effectifs',
  positive_reply: 'réponse positive',
  hot_lead: 'lead chaud',
  no_next_step: 'absence de prochain engagement',
  relationship_inactive: 'relation commerciale inactive',
  missing_context: 'contexte insuffisant',
}

export interface SituationEvaluationContext {
  now: Date
  accountId: string

  // Requis pour les situations liées à une relation commerciale précise.
  personId?: string

  // 0..1 — pertinence ICP / offre / objectif.
  // Cette valeur vient du contexte Prospector, pas du Situation Engine.
  relevance: number
}

function validDateMs(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}

function validScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function stableSituationId(
  accountId: string,
  personId: string | undefined,
  type: SituationType,
): string {
  const raw = `${accountId}_${personId ?? 'account'}_${type}`
  return `sit_${raw.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function evidenceIsUsable(
  evidence: EvidenceEvent,
  context: SituationEvaluationContext,
): boolean {
  const nowMs = context.now.getTime()

  if (evidence.accountId !== context.accountId) return false

  // Une evidence rattachée à une autre personne ne doit jamais contaminer
  // le raisonnement sur la personne actuellement évaluée.
  if (
    evidence.personId &&
    context.personId &&
    evidence.personId !== context.personId
  ) {
    return false
  }

  // Sans personne ciblée, on ne transforme pas des données relationnelles
  // individuelles en vérité générale sur le compte.
  if (
    !context.personId &&
    (evidence.scope === 'person' || evidence.scope === 'relationship')
  ) {
    return false
  }

  if (!validScore(evidence.confidence)) return false
  if (evidence.confidence < MIN_EVIDENCE_CONFIDENCE) return false

  // Une hypothèse seule ne doit jamais déclencher une situation.
  if (evidence.assertionType === 'assumption') return false

  const occurredMs = validDateMs(evidence.occurredAt)
  const observedMs = validDateMs(evidence.observedAt)

  if (occurredMs === null || observedMs === null) return false

  // Fail closed sur les événements prétendument futurs.
  if (occurredMs > nowMs || observedMs > nowMs) return false

  if (evidence.expiresAt) {
    const expiresMs = validDateMs(evidence.expiresAt)

    if (expiresMs === null) return false
    if (nowMs >= expiresMs) return false
  }

  return true
}

function bestEvidenceByType(
  evidence: EvidenceEvent[],
  types: EvidenceType[],
): EvidenceEvent[] {
  const selected: EvidenceEvent[] = []

  for (const type of types) {
    const candidates = evidence
      .filter((item) => item.type === type)
      .sort((a, b) => {
        if (b.confidence !== a.confidence) {
          return b.confidence - a.confidence
        }

        return (
          Date.parse(b.observedAt) -
          Date.parse(a.observedAt)
        )
      })

    if (candidates[0]) selected.push(candidates[0])
  }

  return selected
}

function averageConfidence(evidence: EvidenceEvent[]): number {
  if (evidence.length === 0) return 0

  return roundScore(
    evidence.reduce((sum, item) => sum + item.confidence, 0) /
      evidence.length,
  )
}

function hasFact(evidence: EvidenceEvent[]): boolean {
  return evidence.some((item) => item.assertionType === 'fact')
}

function freshnessScore(
  evidence: EvidenceEvent,
  now: Date,
): number {
  const occurredMs = Date.parse(evidence.occurredAt)
  const ageDays = (now.getTime() - occurredMs) / DAY_MS

  if (ageDays <= 7) return 1
  if (ageDays <= 30) return 0.8
  if (ageDays <= 90) return 0.6

  return 0.4
}

function urgencyFromEvidence(
  evidence: EvidenceEvent[],
  now: Date,
): number {
  if (evidence.length === 0) return 0

  return roundScore(
    Math.max(
      ...evidence.map((item) => freshnessScore(item, now)),
    ),
  )
}

function situationExpiry(
  evidence: EvidenceEvent[],
  now: Date,
  ttlDays: number,
): string {
  const ruleExpiryMs = now.getTime() + ttlDays * DAY_MS

  const evidenceExpiries = evidence
    .map((item) =>
      item.expiresAt ? Date.parse(item.expiresAt) : null,
    )
    .filter(
      (value): value is number =>
        value !== null && Number.isFinite(value),
    )

  const expiresMs =
    evidenceExpiries.length > 0
      ? Math.min(ruleExpiryMs, ...evidenceExpiries)
      : ruleExpiryMs

  return new Date(expiresMs).toISOString()
}

function evidenceDescription(
  evidence: EvidenceEvent[],
): string {
  return evidence
    .map((item) => EVIDENCE_LABELS[item.type] ?? item.type)
    .join(', ')
}

function buildSituation(
  type: SituationType,
  evidence: EvidenceEvent[],
  context: SituationEvaluationContext,
  ruleId: string,
  ttlDays: number,
  rationale: string,
): Situation {
  const nowIso = context.now.toISOString()

  return {
    id: stableSituationId(
      context.accountId,
      context.personId,
      type,
    ),
    accountId: context.accountId,
    personId: context.personId,
    type,
    evidenceIds: evidence.map((item) => item.id),
    confidence: averageConfidence(evidence),
    relevance: roundScore(context.relevance),
    urgency: urgencyFromEvidence(evidence, context.now),
    rationale,
    ruleId,
    ruleVersion: SITUATION_RULE_VERSION,
    createdAt: nowIso,
    lastEvaluatedAt: nowIso,
    expiresAt: situationExpiry(
      evidence,
      context.now,
      ttlDays,
    ),
  }
}

function detectSalesScaleUp(
  evidence: EvidenceEvent[],
  context: SituationEvaluationContext,
): Situation | null {
  const matched = bestEvidenceByType(
    evidence,
    SALES_SCALE_TYPES,
  )

  // Deux familles distinctes minimum.
  if (matched.length < 2) return null
  if (!hasFact(matched)) return null

  const confidence = averageConfidence(matched)

  if (confidence < MIN_SITUATION_CONFIDENCE) {
    return null
  }

  return buildSituation(
    'sales_scale_up',
    matched,
    context,
    'sales-scale-up',
    30,
    `Accélération commerciale probable fondée sur plusieurs signaux distincts : ${evidenceDescription(matched)}.`,
  )
}

function detectCommercialMomentumStalled(
  evidence: EvidenceEvent[],
  context: SituationEvaluationContext,
): Situation | null {
  // Une relation commerciale doit être rattachée à une personne.
  if (!context.personId) return null

  const momentum = bestEvidenceByType(evidence, [
    'positive_reply',
    'hot_lead',
  ])

  const stalled = bestEvidenceByType(evidence, [
    'no_next_step',
    'relationship_inactive',
  ])

  if (momentum.length === 0 || stalled.length === 0) {
    return null
  }

  const matched = [...momentum, ...stalled]

  if (!hasFact(matched)) return null

  const confidence = averageConfidence(matched)

  if (confidence < MIN_SITUATION_CONFIDENCE) {
    return null
  }

  return buildSituation(
    'commercial_momentum_stalled',
    matched,
    context,
    'commercial-momentum-stalled',
    7,
    `Un intérêt commercial est présent mais la relation risque de perdre son momentum : ${evidenceDescription(matched)}.`,
  )
}

function detectStrongSignalLowContext(
  evidence: EvidenceEvent[],
  context: SituationEvaluationContext,
): Situation | null {
  const strongSignals = bestEvidenceByType(
    evidence.filter(
      (item) =>
        item.confidence >= STRONG_EVIDENCE_CONFIDENCE,
    ),
    SALES_SCALE_TYPES,
  )

  const missingContext = bestEvidenceByType(evidence, [
    'missing_context',
  ])

  if (
    strongSignals.length === 0 ||
    missingContext.length === 0
  ) {
    return null
  }

  const matched = [
    strongSignals[0],
    missingContext[0],
  ]

  if (!hasFact(matched)) return null

  const confidence = averageConfidence(matched)

  if (confidence < MIN_SITUATION_CONFIDENCE) {
    return null
  }

  return buildSituation(
    'strong_signal_low_context',
    matched,
    context,
    'strong-signal-low-context',
    14,
    `Un signal commercial fort existe, mais le contexte disponible reste insuffisant pour recommander une approche directe : ${evidenceDescription(matched)}.`,
  )
}

export function evaluateSituations(
  evidence: EvidenceEvent[],
  context: SituationEvaluationContext,
): Situation[] {
  const nowMs = context.now.getTime()

  // Fail closed sur le contexte d'évaluation.
  if (
    !Number.isFinite(nowMs) ||
    !context.accountId ||
    !validScore(context.relevance)
  ) {
    return []
  }

  const usable = evidence.filter((item) =>
    evidenceIsUsable(item, context),
  )

  if (usable.length === 0) return []

  const situations: Situation[] = []

  const scaleUp = detectSalesScaleUp(
    usable,
    context,
  )

  if (scaleUp) {
    situations.push(scaleUp)
  } else {
    // LOW_CONTEXT sert volontairement de fallback :
    // un signal fort existe, mais nous n'avons pas assez de preuves
    // pour établir SALES_SCALE_UP.
    const lowContext = detectStrongSignalLowContext(
      usable,
      context,
    )

    if (lowContext) {
      situations.push(lowContext)
    }
  }

  const stalled = detectCommercialMomentumStalled(
    usable,
    context,
  )

  if (stalled) {
    situations.push(stalled)
  }

  return situations
}