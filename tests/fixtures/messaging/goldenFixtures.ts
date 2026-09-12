// JS-015 B1 R4 — FIXTURES MESSAGING (SURFACE TEST/EVAL SEULE).
//
// ── R4-C1 : TROIS GENRES STRUCTURELLEMENT DISTINCTS ─────────────────────────
// CONTRACT_MECHANICS : cas SYNTHÉTIQUES ANONYMES (CONTRACT_CASE_00X) dont le
// seul objet est d'exercer la MÉCANIQUE du contrat (actions/objectifs/canaux
// contrôlés, budgets, refus). Ils ne prétendent à AUCUNE vérité de compte.
//
// NAMED_GOLDEN_PLACEHOLDER : REDSEN / AEROW_KIMEIA / WALLIX — registre des cas
// comportementaux NOMMÉS. Le repo ne porte NI leurs faits NI leurs décisions
// gelées : AUCUN selectedAction, AUCUN outreachObjective, AUCUN canal, AUCUN
// compte d'évidence, AUCUN mode d'échec n'est inventé ici. Chaque assertion
// comportementale spécifique au compte attend sa SOURCE GOLDEN AUTORITATIVE.
// Ces entrées ne peuvent PAS fabriquer un MessageReadyContext valide : elles
// n'ont structurellement aucun champ de décision.
//
// DOMAIN_NON_ACTIVATION : SQUAD — l'invariant gelé « STRATÉGIQUEMENT
// INTÉRESSANT ≠ COMMERCIALEMENT PRIORISÉ » : arrêt AVANT MessageReadyContext.
//
// ── HONNÊTETÉ DES FAITS ─────────────────────────────────────────────────────
// Aucun fait d'entreprise fabriqué : companyFacts = UNSUPPORTED_FACT partout ;
// les refs d'évidence des cas mécaniques sont synthétiques et préfixées.
import type {
  MessageChannelV0,
  OutreachObjectiveV0,
  SelectedActionV0,
} from '../../../lib/prospector/messaging/messageContext'

export const UNSUPPORTED_FACT = 'UNSUPPORTED_FACT' as const
export const PENDING_GOLDEN_SOURCE = 'PENDING_AUTHORITATIVE_GOLDEN_SOURCE' as const

/** Cas mécanique ANONYME — décisions contrôlées car explicitement synthétiques. */
export interface ContractMechanicsCaseV0 {
  readonly fixtureKind: 'CONTRACT_MECHANICS'
  readonly caseId: `CONTRACT_CASE_${string}`
  readonly selectedAction: SelectedActionV0
  readonly outreachObjective: OutreachObjectiveV0
  readonly channel: MessageChannelV0
  readonly usableEvidenceRefs: readonly string[]
  readonly showableEvidenceRefs: readonly string[]
  /** Refs portant une VRAIE incertitude (⇒ uncertainAssertionRefs). */
  readonly uncertainRefs: readonly string[]
  /** Refs ne portant QUE des contre-signaux (⇏ uncertainAssertionRefs). */
  readonly counterSignalOnlyRefs: readonly string[]
  readonly forbiddenTerms: readonly string[]
  readonly failureModeWhenIncomplete:
    | 'MISSING_WHY_NOW'
    | 'MISSING_WHY_TALK'
    | 'IDENTITY_NOT_RESOLVED'
    | 'UNSUPPORTED_CHANNEL'
}

export type GoldenMessagingFixtureV0 =
  | ContractMechanicsCaseV0
  | {
      readonly fixtureKind: 'NAMED_GOLDEN_PLACEHOLDER'
      readonly fixtureId: 'REDSEN' | 'AEROW_KIMEIA' | 'WALLIX'
      readonly companyFacts: typeof UNSUPPORTED_FACT
      /**
       * AUCUNE décision amont n'est inventée pour un Golden nommé : les
       * attentes comportementales exactes (action, objectif, canal, évidence,
       * modes d'échec) exigent leur source Golden autoritative. Ce registre
       * n'autorise RIEN — il nomme le cas et marque l'attente de sa source.
       */
      readonly behavioralExpectations: typeof PENDING_GOLDEN_SOURCE
    }
  | {
      readonly fixtureKind: 'DOMAIN_NON_ACTIVATION'
      readonly fixtureId: 'SQUAD'
      readonly companyFacts: typeof UNSUPPORTED_FACT
      readonly nonActivation: {
        readonly expectation: 'STOP_BEFORE_MESSAGE_READY_CONTEXT'
        readonly invariant: 'STRATEGICALLY_INTERESTING_IS_NOT_COMMERCIALLY_PRIORITIZED'
      }
    }

const ref = (cas: string, n: number) => `ev_synthetic_${cas.toLowerCase()}_${n}`

/** Cas MÉCANIQUES anonymes — couvrent les 3 actions, les 2 canaux, les 3 objectifs. */
export const CONTRACT_MECHANICS_CASES_V0: readonly ContractMechanicsCaseV0[] = Object.freeze([
  Object.freeze({
    fixtureKind: 'CONTRACT_MECHANICS' as const,
    caseId: 'CONTRACT_CASE_001' as const,
    selectedAction: 'START_OUTREACH' as const,
    outreachObjective: 'OPEN_CONVERSATION' as const,
    channel: 'email' as const,
    usableEvidenceRefs: Object.freeze([ref('c001', 1), ref('c001', 2), ref('c001', 3)]),
    showableEvidenceRefs: Object.freeze([ref('c001', 1), ref('c001', 2)]),
    uncertainRefs: Object.freeze([ref('c001', 3)]),
    counterSignalOnlyRefs: Object.freeze([]),
    forbiddenTerms: Object.freeze(['copilote IA']),
    failureModeWhenIncomplete: 'MISSING_WHY_NOW' as const,
  }),
  Object.freeze({
    fixtureKind: 'CONTRACT_MECHANICS' as const,
    caseId: 'CONTRACT_CASE_002' as const,
    selectedAction: 'FOLLOW_UP' as const,
    outreachObjective: 'LEARN_HIGH_VALUE_UNKNOWN' as const,
    channel: 'linkedin' as const,
    usableEvidenceRefs: Object.freeze([ref('c002', 1), ref('c002', 2)]),
    showableEvidenceRefs: Object.freeze([ref('c002', 1)]), // LinkedIn : exposition minimale
    uncertainRefs: Object.freeze([]),
    counterSignalOnlyRefs: Object.freeze([ref('c002', 2)]),
    forbiddenTerms: Object.freeze(['10x your pipeline']),
    failureModeWhenIncomplete: 'MISSING_WHY_TALK' as const,
  }),
  Object.freeze({
    fixtureKind: 'CONTRACT_MECHANICS' as const,
    caseId: 'CONTRACT_CASE_003' as const,
    selectedAction: 'REPLY' as const,
    outreachObjective: 'ADVANCE_CONVERSATION' as const,
    channel: 'linkedin' as const,
    usableEvidenceRefs: Object.freeze([ref('c003', 1)]),
    showableEvidenceRefs: Object.freeze([]),
    uncertainRefs: Object.freeze([]),
    counterSignalOnlyRefs: Object.freeze([]),
    forbiddenTerms: Object.freeze(['Revenue OS']),
    failureModeWhenIncomplete: 'IDENTITY_NOT_RESOLVED' as const,
  }),
  Object.freeze({
    fixtureKind: 'CONTRACT_MECHANICS' as const,
    caseId: 'CONTRACT_CASE_004' as const,
    selectedAction: 'START_OUTREACH' as const,
    outreachObjective: 'ADVANCE_CONVERSATION' as const,
    channel: 'email' as const,
    usableEvidenceRefs: Object.freeze([ref('c004', 1)]),
    showableEvidenceRefs: Object.freeze([ref('c004', 1)]),
    uncertainRefs: Object.freeze([]),
    counterSignalOnlyRefs: Object.freeze([]),
    forbiddenTerms: Object.freeze(["70-80% d'échec"]),
    failureModeWhenIncomplete: 'UNSUPPORTED_CHANNEL' as const,
  }),
])

export const GOLDEN_MESSAGING_FIXTURES_V0: readonly GoldenMessagingFixtureV0[] = Object.freeze([
  ...CONTRACT_MECHANICS_CASES_V0,
  Object.freeze({
    fixtureKind: 'NAMED_GOLDEN_PLACEHOLDER' as const,
    fixtureId: 'REDSEN' as const,
    companyFacts: UNSUPPORTED_FACT,
    behavioralExpectations: PENDING_GOLDEN_SOURCE,
  }),
  Object.freeze({
    fixtureKind: 'NAMED_GOLDEN_PLACEHOLDER' as const,
    fixtureId: 'AEROW_KIMEIA' as const,
    companyFacts: UNSUPPORTED_FACT,
    behavioralExpectations: PENDING_GOLDEN_SOURCE,
  }),
  Object.freeze({
    fixtureKind: 'DOMAIN_NON_ACTIVATION' as const,
    fixtureId: 'SQUAD' as const,
    companyFacts: UNSUPPORTED_FACT,
    nonActivation: Object.freeze({
      expectation: 'STOP_BEFORE_MESSAGE_READY_CONTEXT' as const,
      invariant: 'STRATEGICALLY_INTERESTING_IS_NOT_COMMERCIALLY_PRIORITIZED' as const,
    }),
  }),
  Object.freeze({
    fixtureKind: 'NAMED_GOLDEN_PLACEHOLDER' as const,
    fixtureId: 'WALLIX' as const,
    companyFacts: UNSUPPORTED_FACT,
    behavioralExpectations: PENDING_GOLDEN_SOURCE,
  }),
])
