import { describe, expect, it } from 'vitest'
import {
  evaluateSituations,
  MIN_EVIDENCE_CONFIDENCE,
  SITUATION_RULE_VERSION,
} from '../lib/prospector/proactive/situationEngine'
import type {
  EvidenceEvent,
} from '../lib/prospector/proactive/types'
import type { EvidenceType } from '../lib/prospector/proactive/catalog'

const NOW = new Date('2026-08-18T12:00:00.000Z')

// La temporalité est désormais EXPLICITE et obligatoire (01D red-team). Ces cas
// historiques décrivent tous des faits datés — c'est leur `occurredAt` qui porte
// la fraîcheur qu'ils éprouvent — donc `dated_event` est la déclaration exacte,
// pas une formalité d'adaptation.
function evidence(
  id: string,
  type: EvidenceType,
  patch: Partial<EvidenceEvent> = {},
): EvidenceEvent {
  return {
    id,
    temporality: 'dated_event',
    accountId: 'acc_1',
    scope: 'account',
    type,
    value: true,
    source: {
      provider: 'test',
      reference: `ref_${id}`,
    },
    assertionType: 'fact',
    confidence: 0.85,
    occurredAt: '2026-08-17T10:00:00.000Z',
    observedAt: '2026-08-17T11:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  } as EvidenceEvent
}

const BASE_CONTEXT = {
  now: NOW,
  accountId: 'acc_1',
  lensId: 'sales-default',
      lensVersion: 'v0.1',
      relevance: 0.9,
}

describe('JARVIS-PROACTIVE-01B — situation engine', () => {
  it('détecte SALES_SCALE_UP avec deux familles de preuves distinctes', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'new_sales_leader'),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toHaveLength(1)

    expect(situations[0]).toMatchObject({
      accountId: 'acc_1',
      type: 'sales_scale_up',
      evidenceIds: ['ev_1', 'ev_2'],
      lensId: 'sales-default',
      lensVersion: 'v0.1',
      relevance: 0.9,
      ruleId: 'sales-scale-up',
      ruleVersion: SITUATION_RULE_VERSION,
    })

    expect(situations[0].confidence).toBeGreaterThanOrEqual(0.7)
  })

  it('ne crée aucune situation avec un seul signal SALES_SCALE_UP', () => {
    const situations = evaluateSituations(
      [evidence('ev_1', 'sales_hiring')],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('ne transforme pas plusieurs evidences du même type en faux croisement', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring', {
          confidence: 0.8,
        }),
        evidence('ev_2', 'sales_hiring', {
          confidence: 0.9,
        }),
        evidence('ev_3', 'sales_hiring', {
          confidence: 0.95,
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('ne crée aucune situation à partir d’hypothèses seules', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring', {
          assertionType: 'assumption',
        }),
        evidence('ev_2', 'recent_funding', {
          assertionType: 'assumption',
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('ignore une evidence expirée', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'new_sales_leader', {
          expiresAt: '2026-08-18T11:59:59.000Z',
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('ignore une evidence dont occurredAt est dans le futur', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'recent_funding', {
          occurredAt: '2026-08-18T13:00:00.000Z',
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('ignore une evidence dont observedAt est dans le futur', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'recent_funding', {
          observedAt: '2026-08-18T13:00:00.000Z',
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('ignore une evidence avec une date invalide', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'recent_funding', {
          occurredAt: 'date-invalide',
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('ignore une evidence sous le seuil minimal de confiance', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'recent_funding', {
          confidence: MIN_EVIDENCE_CONFIDENCE - 0.01,
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('isole strictement les comptes', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'new_sales_leader', {
          accountId: 'acc_2',
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('isole strictement les personnes dans le contexte relationnel', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'positive_reply', {
          scope: 'relationship',
          personId: 'person_1',
        }),
        evidence('ev_2', 'no_next_step', {
          scope: 'relationship',
          personId: 'person_2',
        }),
      ],
      {
        ...BASE_CONTEXT,
        personId: 'person_1',
      },
    )

    expect(situations).toEqual([])
  })

  it('ne généralise pas une evidence relationnelle au niveau Account sans personne ciblée', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'positive_reply', {
          scope: 'relationship',
          personId: 'person_1',
        }),
        evidence('ev_2', 'no_next_step', {
          scope: 'relationship',
          personId: 'person_1',
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('détecte COMMERCIAL_MOMENTUM_STALLED avec intérêt + stagnation', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'positive_reply', {
          scope: 'relationship',
          personId: 'person_1',
        }),
        evidence('ev_2', 'no_next_step', {
          scope: 'relationship',
          personId: 'person_1',
          assertionType: 'inference',
          confidence: 0.8,
        }),
      ],
      {
        ...BASE_CONTEXT,
        personId: 'person_1',
      },
    )

    expect(situations).toHaveLength(1)

    expect(situations[0]).toMatchObject({
      accountId: 'acc_1',
      personId: 'person_1',
      type: 'commercial_momentum_stalled',
      evidenceIds: ['ev_1', 'ev_2'],
      ruleId: 'commercial-momentum-stalled',
      ruleVersion: SITUATION_RULE_VERSION,
    })
  })

  it('ne détecte pas COMMERCIAL_MOMENTUM_STALLED sans preuve de stagnation', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'positive_reply', {
          scope: 'relationship',
          personId: 'person_1',
        }),
      ],
      {
        ...BASE_CONTEXT,
        personId: 'person_1',
      },
    )

    expect(situations).toEqual([])
  })

  it('détecte STRONG_SIGNAL_LOW_CONTEXT comme fallback', () => {
    // SIGNAL_EVIDENCE_STRENGTH_V0_001 : « fort » est STRUCTUREL — la fixture
    // modélise un Signal externe fondé/adjugé en déclarant sa classe (comme le
    // gate canonique le ferait en production), pas en gonflant un flottant.
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'recent_funding', {
          confidence: 0.9,
        }),
        evidence('ev_2', 'missing_context', {
          confidence: 0.8,
          assertionType: 'fact',
        }),
      ],
      {
        ...BASE_CONTEXT,
        evidenceStrengthByEvidenceId: { ev_1: { kind: 'EXTERNAL_CONFIRMED_CANONICAL' } },
      },
    )

    expect(situations).toHaveLength(1)

    expect(situations[0]).toMatchObject({
      type: 'strong_signal_low_context',
      evidenceIds: ['ev_1', 'ev_2'],
      ruleId: 'strong-signal-low-context',
      ruleVersion: SITUATION_RULE_VERSION,
    })
  })

  it('ne crée pas LOW_CONTEXT si le signal principal n’est pas assez fort', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'recent_funding', {
          confidence: 0.7,
        }),
        evidence('ev_2', 'missing_context', {
          confidence: 0.85,
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toEqual([])
  })

  it('préfère SALES_SCALE_UP à LOW_CONTEXT lorsque les preuves suffisent déjà', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring', {
          confidence: 0.9,
        }),
        evidence('ev_2', 'new_sales_leader', {
          confidence: 0.85,
        }),
        evidence('ev_3', 'missing_context', {
          confidence: 0.9,
        }),
      ],
      BASE_CONTEXT,
    )

    expect(situations).toHaveLength(1)
    expect(situations[0].type).toBe('sales_scale_up')
  })

  it('conserve un identifiant stable pour une même situation métier', () => {
    const input = [
      evidence('ev_1', 'sales_hiring'),
      evidence('ev_2', 'new_sales_leader'),
    ]

    const first = evaluateSituations(
      input,
      BASE_CONTEXT,
    )

    const second = evaluateSituations(
      input,
      {
        ...BASE_CONTEXT,
        now: new Date('2026-08-18T13:00:00.000Z'),
      },
    )

    expect(first[0].id).toBe(second[0].id)
  })

  it('trace la règle et les evidences ayant produit la situation', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_a', 'recent_funding'),
        evidence('ev_b', 'sales_hiring'),
      ],
      BASE_CONTEXT,
    )

    const situation = situations[0]

    expect(situation.ruleId).toBe('sales-scale-up')
    expect(situation.ruleVersion).toBe(
      SITUATION_RULE_VERSION,
    )
    expect(situation.evidenceIds).toEqual([
      'ev_a',
      'ev_b',
    ])
    expect(situation.rationale.length).toBeGreaterThan(0)
  })

  it('fail closed si le contexte possède une relevance invalide', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'recent_funding'),
      ],
      {
        ...BASE_CONTEXT,
        lensId: 'sales-default',
      lensVersion: 'v0.1',
      relevance: 1.5,
      },
    )

    expect(situations).toEqual([])
  })

  it('fail closed si now est invalide', () => {
    const situations = evaluateSituations(
      [
        evidence('ev_1', 'sales_hiring'),
        evidence('ev_2', 'recent_funding'),
      ],
      {
        ...BASE_CONTEXT,
        now: new Date('invalid'),
      },
    )

    expect(situations).toEqual([])
  })
})