// GOLDEN-SCHEMA-001a — CONSTRUCTEURS DE CAS GOLDEN POUR LES TESTS.
//
// ⚠️ CE FICHIER N'EST PAS DE LA GROUND TRUTH, et il ne doit jamais le devenir.
// Aucun `fixtures/golden/cases/*.golden.json` n'est créé dans ce lot : la
// matérialisation des 7 cas réels appartient à GOLDEN-MATERIALIZE-001. Écrire de
// la vraie ground truth pour éprouver une infrastructure la figerait avant son
// audit — et le premier cas signé serait signé par commodité de test.
//
// Ces objets sont volontairement SYNTHÉTIQUES : comptes « test-acct », URL en
// `.invalid`, identifiants « TEST-* ». Rien ici ne prétend décrire une
// entreprise réelle.
//
// ⚠️ `rawSource.originalCaseId = 'GD-006'` est le SEUL identifiant réel, et ce
// n'est qu'une ANCRE : `golden-raw-integrity.test.ts` en a besoin pour éprouver
// la couverture contre le dataset committé. Aucune attente, aucune claim, aucune
// date de ce fichier ne reproduit l'adjudication réelle de GD-006 — celle-ci
// n'existera qu'après GOLDEN-MATERIALIZE-001.
import { GOLDEN_SCHEMA_VERSION } from '../lib/prospector/proactive/eval/goldenSchema'

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

const CONTEXTE = {
  contextId: 'golden-fabel-semantic',
  contextVersion: 'v0.1',
  role: 'business_developer',
  scope: { mode: 'workspace' },
  authorizedMotions: {},
  lensId: 'fabel-broker',
  lensVersion: 'v0.1',
}

/** Cas SIGNÉ minimal — oracle PARTIEL : une seule assertion fermée. */
export function casSigne(): any {
  return {
    goldenSchemaVersion: GOLDEN_SCHEMA_VERSION,
    caseId: 'TEST-SIGNED',
    evaluationProfile: { rail: 'SEMANTIC', lensId: 'fabel-broker', lensVersion: 'v0.1' },
    provenance: {
      materializationTicket: 'GOLDEN-SCHEMA-001a',
      adjudicationProtocol: 'GOLDEN-SOURCE-REVIEW-001-R1',
      adjudicatedOn: '2026-08-23',
    },
    rawSource: {
      datasetPath: 'fixtures/golden/raw/prospector-v3-golden-dataset.v0.1.json',
      datasetSchemaVersion: 'prospector-v3-golden-dataset/0.1',
      datasetVersion: '0.1',
      datasetSha256: '131236360e882fc60b4dc077923983f7d6b8a071ce9c3b4e76bd253a5fb6803d',
      originalCaseId: 'GD-006',
    },
    assumptions: {
      now: { value: '2026-08-07', source: 'dataset.asOf', precision: 'DAY' },
      observedAt: { value: '2026-08-07', source: 'dataset.asOf' },
      targetRelevance: { value: 0.5, rationale: 'FIXED_REPLAY_CONSTANT' },
      evidenceConfidence: { value: 1.0, rationale: 'FIXTURE_SEMANTIC_CERTAINTY' },
      syntheticRuntimeProvider: {
        value: 'synthetic-historical-nonfirstparty',
        rationale: 'Aucune identité de provider d’ingestion historique n’existe pour ces faits.',
      },
    },
    adjudication: {
      rawEvidence: [
        {
          rawEvidenceId: 'TEST-ev1',
          decompositionStatus: 'COMPLETE',
          claims: [
            {
              claimIndex: 0,
              semanticClaim: 'Le compte a bouclé une levée de fonds le 2026-05-06.',
              mappingDecision: 'MAPPED',
              assertionType: 'fact',
              temporalNature: 'EVENT',
              temporalPrecision: 'DAY',
              occurredAt: '2026-05-06',
              evidenceType: 'recent_funding',
              evidenceId: 'test-ev1',
              evidenceScope: 'account',
              targetAccountId: 'test-acct',
              runtimeSource: {
                provider: 'synthetic-historical-nonfirstparty',
                url: 'https://example.invalid/levee',
              },
              sourceReview: [{ reviewClass: 'EXTERNAL_REVIEW_EVIDENCE' }],
            },
          ],
        },
      ],
    },
    executability: 'EXECUTABLE',
    executionContext: {
      businessContext: clone(CONTEXTE),
      targets: [{ accountId: 'test-acct' }],
    },
    expected: {
      situations: {
        space_expansion: {
          assertion: 'FORBIDDEN',
          rationale: 'Seule F1_CAPITAL est présente ; une levée finance une croissance possible.',
        },
        space_contraction: { assertion: 'UNSPECIFIED', rationale: 'Neutralité délibérée.' },
        flex_remove_window: { assertion: 'UNSPECIFIED', rationale: 'Neutralité délibérée.' },
      },
    },
    legacyAssessment: {
      items: [
        {
          rawRef: '/expected/primaryHypothesis',
          scope: 'RAIL_S',
          status: 'NOT_SUPPORTED',
          rationale: 'Une levée seule ne soutient pas SPACE_EXPANSION.',
        },
      ],
    },
    caseStatus: { state: 'SIGNED_SEMANTIC_GOLDEN', blockers: [] },
  }
}

/** Cas BLOQUÉ par un trou de taxonomie — la sémantique de la claim SURVIT. */
export function casTypeManquant(): any {
  const c = casSigne()
  c.caseId = 'TEST-TYPE-GAP'
  c.adjudication.rawEvidence.push({
    rawEvidenceId: 'TEST-ev2',
    decompositionStatus: 'COMPLETE',
    claims: [
      {
        claimIndex: 0,
        semanticClaim: 'Le compte a annoncé son intention de recruter.',
        mappingDecision: 'MISSING_TYPE',
        // ⚠️ Sémantique CONSERVÉE malgré l'absence de type : on sait que
        // l'annonce est un fait observé et daté.
        assertionType: 'fact',
        temporalNature: 'EVENT',
        temporalPrecision: 'DAY',
        occurredAt: '2026-05-20',
        rationale: 'Aucun EvidenceType ne porte une intention de recrutement annoncée.',
        sourceReview: [{ reviewClass: 'EXTERNAL_REVIEW_EVIDENCE' }],
      },
    ],
  })
  c.executability = 'ADJUDICATED_NON_EXECUTABLE'
  c.caseStatus = {
    state: 'BLOCKED',
    blockers: [
      { kind: 'EVIDENCE_TYPE_GAP', rawEvidenceId: 'TEST-ev2', claimIndex: 0, note: 'Intention annoncée.' },
    ],
  }
  return c
}
