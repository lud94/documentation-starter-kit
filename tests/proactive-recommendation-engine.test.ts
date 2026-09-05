import {
  TEST_BUSINESS_CONTEXT,
  TEST_RECOMMENDATION_CONTEXT,
  TEST_CONTEXT_APPROVAL,
  TEST_SITUATION_PROVENANCE,
} from './helpers/proactiveContext'
import { describe, expect, it } from 'vitest'
import {
  RECOMMENDATION_RULE_VERSION,
  recommendationDecision,
} from '../lib/prospector/proactive/recommendationEngine'
import type { Situation } from '../lib/prospector/proactive/types'

const NOW = new Date('2026-08-18T12:00:00.000Z')

function situation(
  patch: Partial<Situation> = {},
): Situation {
  return {
    ...TEST_SITUATION_PROVENANCE,
    id: 'sit_acc_1_person_1_sales_scale_up',
    accountId: 'acc_1',
    personId: 'person_1',
    type: 'sales_scale_up',
    evidenceIds: ['ev_1', 'ev_2'],
    confidence: 0.9,
    relevance: 0.85,
    urgency: 0.8,
    rationale:
      'Accélération commerciale probable fondée sur plusieurs signaux distincts.',
    ruleId: 'sales-scale-up',
    ruleVersion: 'v0.1',
    createdAt: '2026-08-18T10:00:00.000Z',
    lastEvaluatedAt: '2026-08-18T10:00:00.000Z',
    expiresAt: '2026-08-25T10:00:00.000Z',
    ...patch,
  }
}

describe('JARVIS-PROACTIVE-01C — recommendation engine', () => {
  it('mappe SALES_SCALE_UP vers ENGAGE_OR_REENGAGE', () => {
    const recommendation = recommendationDecision(
      situation(),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation).toMatchObject({
      decision: 'recommend',
      play: 'engage_or_reengage',
      priority: 'high',
      ruleId: 'recommend-sales_scale_up',
      ruleVersion: RECOMMENDATION_RULE_VERSION,
    })
  })

  it('mappe COMMERCIAL_MOMENTUM_STALLED vers FOLLOW_UP', () => {
    const recommendation = recommendationDecision(
      situation({
        type: 'commercial_momentum_stalled',
        ruleId: 'commercial-momentum-stalled',
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation).toMatchObject({
      decision: 'recommend',
      play: 'follow_up',
      ruleId: 'recommend-commercial_momentum_stalled',
    })
  })

  it('mappe STRONG_SIGNAL_LOW_CONTEXT vers INVESTIGATE', () => {
    const recommendation = recommendationDecision(
      situation({
        type: 'strong_signal_low_context',
        ruleId: 'strong-signal-low-context',
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation).toMatchObject({
      decision: 'recommend',
      play: 'investigate',
      ruleId: 'recommend-strong_signal_low_context',
    })
  })

  it('attribue une priorité HIGH si relevance et urgency sont fortes', () => {
    const recommendation = recommendationDecision(
      situation({
        relevance: 0.8,
        urgency: 0.8,
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation.priority).toBe('high')
  })

  it('attribue une priorité MEDIUM sur un niveau intermédiaire', () => {
    const recommendation = recommendationDecision(
      situation({
        relevance: 0.7,
        urgency: 0.6,
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation.priority).toBe('medium')
  })

  it('attribue une priorité LOW quand les seuils ne sont pas atteints', () => {
    const recommendation = recommendationDecision(
      situation({
        relevance: 0.59,
        urgency: 0.9,
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation.priority).toBe('low')
  })

  it('utilise le maillon le plus faible pour la confidence', () => {
    const recommendation = recommendationDecision(
      situation({
        confidence: 0.92,
        relevance: 0.74,
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation.confidence).toBe(0.74)
  })

  it('produit NO_ACTION sur opt-out', () => {
    const recommendation = recommendationDecision(
      situation(),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: NOW,
        optedOut: true,
      },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      priority: 'low',
      ruleId: 'eligibility-opt_out',
      ruleVersion: RECOMMENDATION_RULE_VERSION,
    })

    expect(recommendation.play).toBeUndefined()
    expect(recommendation.recommendedAction).toBeUndefined()
  })

  it('produit NO_ACTION lorsqu’un rendez-vous est déjà planifié', () => {
    const recommendation = recommendationDecision(
      situation(),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: NOW,
        meetingScheduled: true,
      },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      ruleId: 'eligibility-meeting_already_scheduled',
    })
  })

  it('produit NO_ACTION lorsqu’une action est déjà planifiée', () => {
    const recommendation = recommendationDecision(
      situation(),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: NOW,
        actionScheduled: true,
      },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      ruleId: 'eligibility-action_already_scheduled',
    })
  })

  it('produit NO_ACTION lorsqu’une recommandation active existe déjà', () => {
    const recommendation = recommendationDecision(
      situation(),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: NOW,
        activeRecommendationExists: true,
      },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      ruleId: 'eligibility-active_recommendation_exists',
    })
  })

  it('produit NO_ACTION pendant le cooldown relationnel', () => {
    const recommendation = recommendationDecision(
      situation(),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: NOW,
        lastContactAt: '2026-08-17T12:00:00.000Z',
      },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      ruleId: 'eligibility-recent_contact',
      expiresAt: '2026-08-20T12:00:00.000Z',
    })

    expect(recommendation.whyNow).toContain(
      '2026-08-20T12:00:00.000Z',
    )
  })

  it('ne prolonge jamais un NO_ACTION au-delà de la Situation', () => {
    const recommendation = recommendationDecision(
      situation({
        expiresAt: '2026-08-19T12:00:00.000Z',
      }),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: NOW,
        lastContactAt: '2026-08-17T12:00:00.000Z',
      },
    )

    expect(recommendation.expiresAt).toBe(
      '2026-08-19T12:00:00.000Z',
    )
  })

  it('produit NO_ACTION pour une Situation expirée', () => {
    const recommendation = recommendationDecision(
      situation({
        expiresAt: '2026-08-18T11:59:59.000Z',
      }),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: NOW,
      },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      ruleId: 'eligibility-situation_expired',
    })
  })

  it('fail closed si la confidence de Situation est invalide', () => {
    const recommendation = recommendationDecision(
      situation({
        confidence: 1.2,
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      confidence: 0,
      ruleId: 'eligibility-invalid_context',
    })
  })

  it('fail closed si la relevance est invalide', () => {
    const recommendation = recommendationDecision(
      situation({
        relevance: -0.1,
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      confidence: 0,
      ruleId: 'eligibility-invalid_context',
    })
  })

  it('fail closed si urgency est invalide', () => {
    const recommendation = recommendationDecision(
      situation({
        urgency: Number.NaN,
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      ruleId: 'eligibility-invalid_context',
    })
  })

  it('fail closed si now est invalide', () => {
    const recommendation = recommendationDecision(
      situation(),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: new Date('invalid'),
      },
    )

    expect(recommendation).toMatchObject({
      decision: 'no_action',
      ruleId: 'eligibility-invalid_context',
    })
  })

  it('conserve un identifiant stable pour une même Situation', () => {
    const first = recommendationDecision(
      situation(),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    const second = recommendationDecision(
      situation(),
      {
        businessContext: TEST_RECOMMENDATION_CONTEXT,
        now: new Date('2026-08-18T13:00:00.000Z'),
      },
    )

    // PROPRIÉTÉ MÉTIER — inchangée : même Situation + même Business Context
    // ⇒ même identifiant. C'est elle que ce test protège.
    expect(first.id).toBe(second.id)

    // ⚠️ ASSERTION LITTÉRALE MISE À JOUR (ARCH-RULEPACK-001), par décision de
    // contrat et non pour faire passer un test. L'identité de Recommendation
    // inclut désormais le `contextId` : `control` dépend des capacités
    // accordées, donc deux contextes produisent deux recommandations
    // différentes. Sans cela, la seconde écraserait la première dans
    // `prospector_store`, dont la clé est `(kind, id, workspace_id)`.
    //
    // L'encodage est à longueur préfixée — injectif, donc sans collision
    // possible entre deux couples (situation, contexte) distincts.
    expect(first.id).toBe(
      'rec_33:sit_acc_1_person_1_sales_scale_up|10:test-sales',
    )
  })

  it('un contextId DIFFÉRENT produit une recommandation DIFFÉRENTE', () => {
    // Le pendant du test précédent : sans cette propriété, deux configurations
    // — par exemple un profil autonome et un profil soumis à approbation —
    // écriraient sur la même ligne, et la dernière évaluation effacerait
    // silencieusement le verdict de l'autre.
    const autonome = recommendationDecision(situation(), {
      businessContext: TEST_RECOMMENDATION_CONTEXT,
      now: NOW,
    })

    const approbation = recommendationDecision(situation(), {
      businessContext: {
        contextId: TEST_CONTEXT_APPROVAL.contextId,
        contextVersion: TEST_CONTEXT_APPROVAL.contextVersion,
        authorizedMotions: TEST_CONTEXT_APPROVAL.authorizedMotions,
      },
      now: NOW,
    })

    expect(approbation.id).not.toBe(autonome.id)
    expect(approbation.contextId).toBe('test-sales-approval')

    // `decision` et `control` sont ORTHOGONAUX : la situation justifie
    // toujours d'agir, mais un humain doit valider.
    expect(autonome.decision).toBe('recommend')
    expect(approbation.decision).toBe('recommend')
    expect(autonome.control).toBe('autonomous')
    expect(approbation.control).toBe('approval_required')
  })

  it('conserve la durée de vie de la Situation pour une recommandation active', () => {
    const recommendation = recommendationDecision(
      situation({
        expiresAt: '2026-08-24T12:00:00.000Z',
      }),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation.expiresAt).toBe(
      '2026-08-24T12:00:00.000Z',
    )
  })

  it('trace la règle et génère une justification non vide', () => {
    const recommendation = recommendationDecision(
      situation(),
      { businessContext: TEST_RECOMMENDATION_CONTEXT, now: NOW },
    )

    expect(recommendation.ruleId).toBe(
      'recommend-sales_scale_up',
    )
    expect(recommendation.ruleVersion).toBe(
      RECOMMENDATION_RULE_VERSION,
    )
    expect(recommendation.reason.length).toBeGreaterThan(0)
    expect(recommendation.whyNow.length).toBeGreaterThan(0)
    expect(
      recommendation.recommendedAction?.length ?? 0,
    ).toBeGreaterThan(0)
  })
})