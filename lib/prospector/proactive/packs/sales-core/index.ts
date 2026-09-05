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
  bestEvidenceByType,
  buildSituation,
  hasFact,
} from '../../ruleKit'

export const SALES_CORE_ID = 'sales-core'
// v0.2 — SIGNAL_TEMPORAL_WINDOW_V0_001 : fenêtres temporelles déclarées sur
// `sales-scale-up` et `strong-signal-low-context`.
// v0.3 — SIGNAL_EVIDENCE_STRENGTH_V0_001 : « fort » devient une AUTORITÉ
// STRUCTURELLE (force épistémique du gate canonique), plus une égalité de
// flottant.
// v0.4 — SITUATION_ENGINE_RELIABILITY_V0_001 : plancher PAR CONTRIBUTEUR sur
// `sales-scale-up` et `commercial-momentum-stalled` ; la MOYENNE n'autorise
// plus aucune création (elle masquait un contributeur faible derrière un
// fort). La provenance de version doit dire la vérité.
export const SALES_CORE_VERSION = 'v0.4'

export const MIN_EVIDENCE_CONFIDENCE = 0.6
/**
 * ⚠️ DÉPRÉCIÉE COMME AUTORITÉ DE DÉCISION (SIGNAL_EVIDENCE_STRENGTH_V0_001).
 * Exportée pour compatibilité de surface UNIQUEMENT : « signal fort » se
 * décide désormais STRUCTURELLEMENT (`EXTERNAL_CONFIRMED_CANONICAL` du gate
 * canonique), jamais par `confidence >= 0.75` — l'égalité numérique avec la
 * valeur externe héritée rendait ce seuil décoratif et fragile.
 */
export const STRONG_EVIDENCE_CONFIDENCE = 0.75
/**
 * ⚠️ N'AUTORISE PLUS AUCUNE CRÉATION (SITUATION_ENGINE_RELIABILITY_V0_001).
 * Exportée pour compatibilité de surface : la moyenne arithmétique pouvait
 * BLANCHIR un contributeur au ras du plancher universel (0.95 + 0.60 ⇒ 0.775)
 * derrière un contributeur fort. La suffisance se décide désormais par
 * CONTRIBUTEUR (`MIN_CONTRIBUTOR_CONFIDENCE`) ou par autorité STRUCTURELLE —
 * jamais par un agrégat qui dilue.
 */
export const MIN_SITUATION_CONFIDENCE = 0.7
/**
 * PLANCHER PAR CONTRIBUTEUR — CHAQUE evidence CITÉE par `sales-scale-up` et
 * `commercial-momentum-stalled` doit l'atteindre INDIVIDUELLEMENT. Aucun
 * contributeur fort ne peut compenser un faible : c'est la politique que le
 * pack Fabel applique déjà (`MIN_FAMILY_EVIDENCE_CONFIDENCE`), déclarée ici
 * pour CE pack. `strong-signal-low-context` n'y est PAS soumis : son autorité
 * est STRUCTURELLE (EXTERNAL_CONFIRMED_CANONICAL) — la re-coupler au flottant
 * hérité déferait SIGNAL_EVIDENCE_STRENGTH_V0_001.
 */
export const MIN_CONTRIBUTOR_CONFIDENCE = 0.7

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

  // ── PLANCHER PAR CONTRIBUTEUR — LA MOYENNE N'AUTORISE PLUS RIEN ─────────
  // CHAQUE evidence citée doit atteindre le plancher : 0.95 + 0.60 ne fait
  // plus 0.775 « suffisant », il fait UN contributeur insuffisant — refus.
  // `Situation.confidence` reste la moyenne DESCRIPTIVE (buildSituation),
  // elle ne décide plus de l'existence.
  if (matched.some((item) => item.confidence < MIN_CONTRIBUTOR_CONFIDENCE)) {
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

  // Même politique que `sales-scale-up` : plancher PAR CONTRIBUTEUR, la
  // moyenne ne décide plus de l'existence.
  if (matched.some((item) => item.confidence < MIN_CONTRIBUTOR_CONFIDENCE)) {
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
  // ── « FORT » EST STRUCTUREL, PAS NUMÉRIQUE (SIGNAL_EVIDENCE_STRENGTH_V0) ──
  // Un signal n'est fort que s'il porte l'autorité épistémique complète du
  // chemin externe : gate canonique passé + adjudication humaine + histoire
  // d'assertions durable — c'est la classe EXTERNAL_CONFIRMED_CANONICAL du
  // side-car. Side-car absent ⇒ PAS fort — échec fermé, jamais un repli sur
  // `confidence >= 0.75` (une coïncidence d'égalité avec la constante héritée
  // rendait tout signal externe « fort » par accident).
  const strongSignals = bestEvidenceByType(
    evidence.filter((item) =>
      context.evidenceStrengthByEvidenceId?.[item.id]?.kind === 'EXTERNAL_CONFIRMED_CANONICAL'),
    SALES_SCALE_TYPES,
  )

  const missingContext = bestEvidenceByType(evidence, ['missing_context'])

  if (strongSignals.length === 0 || missingContext.length === 0) {
    return null
  }

  const matched = [strongSignals[0], missingContext[0]]

  if (!hasFact(matched)) return null

  // ── AUCUN PLANCHER NUMÉRIQUE ICI, ET C'EST VOULU. L'autorité de cette
  // règle est STRUCTURELLE (EXTERNAL_CONFIRMED_CANONICAL) : exiger en plus
  // `confidence >= 0.70` re-coupleraît la force structurelle au flottant de
  // compatibilité que SIGNAL_EVIDENCE_STRENGTH_V0_001 a explicitement
  // découplé. La moyenne n'autorise rien non plus — elle reste descriptive.
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
