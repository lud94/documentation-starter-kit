// RULE PACK — `sales-core` (ARCH-RULEPACK-001).
//
// ⚠️ DÉPLACEMENT, PAS RÉÉCRITURE. Les trois détecteurs, leurs seuils, leurs
// durées de vie et leurs libellés sont ceux de `situationEngine.ts` avant ce
// lot, à l'identique. Les 158 tests existants sont l'oracle d'équivalence :
// s'ils exigeaient la moindre retouche d'assertion métier, ce serait la preuve
// que le déplacement a changé quelque chose.
import { defineRulePack, type SituationEvaluationContext } from '../../rulePack'
import type { EvidenceEvent, Situation } from '../../types'
import {
  averageConfidence,
  bestEvidenceByType,
  buildSituation,
  hasFact,
} from '../../ruleKit'

export const SALES_CORE_ID = 'sales-core'
// v0.2 — SIGNAL_TEMPORAL_WINDOW_V0_001 : fenêtres temporelles déclarées sur
// `sales-scale-up` et `strong-signal-low-context`. Les fenêtres changent la
// sémantique des règles : la provenance de version doit dire la vérité.
export const SALES_CORE_VERSION = 'v0.2'

export const MIN_EVIDENCE_CONFIDENCE = 0.6
export const STRONG_EVIDENCE_CONFIDENCE = 0.75
export const MIN_SITUATION_CONFIDENCE = 0.7

const SITUATION_TYPES = [
  'sales_scale_up',
  'commercial_momentum_stalled',
  'strong_signal_low_context',
] as const

const EVIDENCE_TYPES = [
  'recent_funding',
  'sales_hiring',
  // ⚠️ PRODUCTEUR RÉEL : `mapClaim` V2 (SIGNAL_ACQUISITION_CONTRACT_002).
  // La DIRECTION vient d'un champ clos du contrat d'acquisition V2, jamais
  // d'une lecture de prose — contrairement à `new_sales_leader`, qui reste
  // sans producteur faute de champ de séniorité prouvé à l'époque V1.
  'executive_appointment',
  'executive_departure',
  'new_sales_leader',
  'headcount_acceleration',
  'positive_reply',
  'hot_lead',
  'no_next_step',
  'relationship_inactive',
  'missing_context',
] as const

type SalesSituationType = (typeof SITUATION_TYPES)[number]
type SalesEvidenceType = (typeof EVIDENCE_TYPES)[number]

/**
 * ⚠️ LES DÉTECTEURS DOIVENT ÊTRE TYPÉS SUR LE CATALOGUE DU PACK, PAS SUR
 * `EvidenceEvent` GÉNÉRIQUE.
 *
 * `E` de `RulePack<S, E>` s'infère depuis les signatures de `detect`, qui sont
 * une position contravariante. Écrire `readonly EvidenceEvent[]` y élargissait
 * `E` à `string` — et le catalogue dérivé `EvidenceType` s'ouvrait en silence :
 * `'lease_expiry'` compilait alors qu'aucun pack ne le déclare. Détecté par la
 * preuve négative de `tests/rulepack-typecheck.test.ts`, pas par relecture.
 */
type SalesEvidence = EvidenceEvent<SalesEvidenceType>

const SALES_SCALE_TYPES: readonly SalesEvidenceType[] = [
  'recent_funding',
  'sales_hiring',
  'new_sales_leader',
  'headcount_acceleration',
]

const EVIDENCE_LABELS: Readonly<Partial<Record<string, string>>> = {
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

function evidenceDescription(evidence: readonly EvidenceEvent[]): string {
  return evidence
    .map((item) => EVIDENCE_LABELS[item.type] ?? item.type)
    .join(', ')
}

/** Fabrique la situation avec la provenance de CE pack. */
function situationDe(
  type: SalesSituationType,
  evidence: readonly EvidenceEvent[],
  context: SituationEvaluationContext,
  ruleId: string,
  ttlDays: number,
  rationale: string,
): Situation {
  return buildSituation({
    type,
    evidence,
    context,
    ruleId,
    ruleVersion: SALES_CORE_VERSION,
    rulePackId: SALES_CORE_ID,
    rulePackVersion: SALES_CORE_VERSION,
    ttlDays,
    rationale,
  })
}

function detectSalesScaleUp(
  evidence: readonly SalesEvidence[],
  context: SituationEvaluationContext,
): Situation | null {
  const matched = bestEvidenceByType(evidence, SALES_SCALE_TYPES)

  // Deux familles distinctes minimum.
  if (matched.length < 2) return null
  if (!hasFact(matched)) return null

  const confidence = averageConfidence(matched)

  if (confidence < MIN_SITUATION_CONFIDENCE) {
    return null
  }

  return situationDe(
    'sales_scale_up',
    matched,
    context,
    'sales-scale-up',
    30,
    `Accélération commerciale probable fondée sur plusieurs signaux distincts : ${evidenceDescription(matched)}.`,
  )
}

function detectCommercialMomentumStalled(
  evidence: readonly SalesEvidence[],
  context: SituationEvaluationContext,
): Situation | null {
  // Une relation commerciale doit être rattachée à une personne.
  if (!context.personId) return null

  const momentum = bestEvidenceByType(evidence, ['positive_reply', 'hot_lead'])
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

  return situationDe(
    'commercial_momentum_stalled',
    matched,
    context,
    'commercial-momentum-stalled',
    7,
    `Un intérêt commercial est présent mais la relation risque de perdre son momentum : ${evidenceDescription(matched)}.`,
  )
}

function detectStrongSignalLowContext(
  evidence: readonly SalesEvidence[],
  context: SituationEvaluationContext,
): Situation | null {
  const strongSignals = bestEvidenceByType(
    evidence.filter((item) => item.confidence >= STRONG_EVIDENCE_CONFIDENCE),
    SALES_SCALE_TYPES,
  )

  const missingContext = bestEvidenceByType(evidence, ['missing_context'])

  if (strongSignals.length === 0 || missingContext.length === 0) {
    return null
  }

  const matched = [strongSignals[0], missingContext[0]]

  if (!hasFact(matched)) return null

  const confidence = averageConfidence(matched)

  if (confidence < MIN_SITUATION_CONFIDENCE) {
    return null
  }

  return situationDe(
    'strong_signal_low_context',
    matched,
    context,
    'strong-signal-low-context',
    14,
    `Un signal commercial fort existe, mais le contexte disponible reste insuffisant pour recommander une approche directe : ${evidenceDescription(matched)}.`,
  )
}

export const SALES_CORE = defineRulePack({
  packId: SALES_CORE_ID,
  packVersion: SALES_CORE_VERSION,
  declaredSituationTypes: SITUATION_TYPES,
  declaredEvidenceTypes: EVIDENCE_TYPES,

  rules: [
    {
      ruleId: 'sales-scale-up',
      situationType: 'sales_scale_up',
      // ── POLITIQUE TEMPORELLE V0 — PROVISOIRE, PAS UNE VÉRITÉ UNIVERSELLE.
      // « recent_funding » reçoit ENFIN un contrat de fraîcheur : 90 jours,
      // la borne finale des paliers historiques d'urgence, qui devient le sens
      // V0 réel de « récent ». `sales_hiring` est un ÉTAT externe mutable : il
      // doit être RÉ-OBSERVÉ — 30 jours est une politique opérationnelle V0, à
      // confronter au Golden Dataset. La règle DÉCLARE ; le cœur APPLIQUE.
      temporalPolicy: {
        maxAgeDaysByEvidenceType: { recent_funding: 90, sales_hiring: 30 },
      },
      detect: detectSalesScaleUp,
    },
    {
      ruleId: 'strong-signal-low-context',
      situationType: 'strong_signal_low_context',
      // Même politique que `sales-scale-up` : un « signal fort » périmé n'est
      // pas un signal fort à contexte faible — c'est un fait historique.
      temporalPolicy: {
        maxAgeDaysByEvidenceType: { recent_funding: 90, sales_hiring: 30 },
      },
      detect: detectStrongSignalLowContext,
    },
    {
      ruleId: 'commercial-momentum-stalled',
      situationType: 'commercial_momentum_stalled',
      detect: detectCommercialMomentumStalled,
    },
  ],

  /**
   * ARBITRATION INTRA-PACK — reproduit EXACTEMENT le `else` d'origine.
   *
   * `strong_signal_low_context` servait volontairement de REPLI : un signal
   * fort existe, mais les preuves ne suffisent pas à établir `sales_scale_up`.
   * Les deux ne coexistent donc jamais. Cette relation appartient au pack ; le
   * moteur n'en sait rien et ne doit rien en savoir.
   */
  arbitrate(produced) {
    const scaleUp = produced.some((s) => s.type === 'sales_scale_up')
    return produced.filter(
      (s) => s.type !== 'strong_signal_low_context' || !scaleUp,
    )
  },

  plays: {
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
  },
})
