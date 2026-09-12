import {
  TEST_BUSINESS_CONTEXT,
  TEST_RECOMMENDATION_CONTEXT,
  TEST_SITUATION_PROVENANCE,
} from './helpers/proactiveContext'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTACT_COOLDOWN_HOURS,
  eligibilityDecision,
} from '../lib/prospector/proactive/eligibility'
import type { Situation } from '../lib/prospector/proactive/types'

const BASE_SITUATION: Situation = {
  ...TEST_SITUATION_PROVENANCE,
  id: 'sit_1',
  accountId: 'acc_1',
  personId: 'person_1',
  type: 'sales_scale_up',
  evidenceIds: ['ev_1'],
  confidence: 0.9,
  relevance: 0.85,
  urgency: 0.8,
  rationale: 'Accélération commerciale détectée.',
  ruleId: 'sales-scale-up',
  ruleVersion: 'v0.1',
  createdAt: '2026-08-18T08:00:00.000Z',
  lastEvaluatedAt: '2026-08-18T08:00:00.000Z',
  expiresAt: '2026-08-25T08:00:00.000Z',
}

const NOW = new Date('2026-08-18T12:00:00.000Z')

describe('JARVIS-PROACTIVE-01A — eligibility engine', () => {
  it('autorise une situation éligible', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
    })

    expect(decision).toEqual({
      eligible: true,
      reason: 'eligible',
    })
  })

  it('bloque une situation expirée', () => {
    const decision = eligibilityDecision(
      {
        ...BASE_SITUATION,
        expiresAt: '2026-08-18T11:59:59.000Z',
      },
      {
        now: NOW,
      },
    )

    expect(decision).toEqual({
      eligible: false,
      reason: 'situation_expired',
    })
  })

  it('considère également expirée une situation exactement à expiresAt', () => {
    const decision = eligibilityDecision(
      {
        ...BASE_SITUATION,
        expiresAt: NOW.toISOString(),
      },
      {
        now: NOW,
      },
    )

    expect(decision).toEqual({
      eligible: false,
      reason: 'situation_expired',
    })
  })

  it('respecte un opt-out comme veto absolu', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      optedOut: true,
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'opt_out',
    })
  })

  it('bloque si un rendez-vous est déjà planifié', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      meetingScheduled: true,
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'meeting_already_scheduled',
    })
  })

  it('bloque si une action est déjà planifiée', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      actionScheduled: true,
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'action_already_scheduled',
    })
  })

  it('bloque si une recommandation active existe déjà', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      activeRecommendationExists: true,
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'active_recommendation_exists',
    })
  })

  it('bloque un contact trop récent', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      lastContactAt: '2026-08-17T12:00:00.000Z',
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'recent_contact',
      blockedUntil: '2026-08-20T12:00:00.000Z',
    })
  })

  it('redevient éligible exactement à la fin du cooldown', () => {
    const lastContactAt = new Date(
      NOW.getTime() - DEFAULT_CONTACT_COOLDOWN_HOURS * 60 * 60 * 1000,
    ).toISOString()

    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      lastContactAt,
    })

    expect(decision).toEqual({
      eligible: true,
      reason: 'eligible',
    })
  })

  it('accepte un cooldown personnalisé', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      lastContactAt: '2026-08-18T08:00:00.000Z',
      contactCooldownHours: 2,
    })

    expect(decision).toEqual({
      eligible: true,
      reason: 'eligible',
    })
  })

  it('fail closed si expiresAt est invalide', () => {
    const decision = eligibilityDecision(
      {
        ...BASE_SITUATION,
        expiresAt: 'date-invalide',
      },
      {
        now: NOW,
      },
    )

    expect(decision).toEqual({
      eligible: false,
      reason: 'invalid_context',
    })
  })

  it('fail closed si lastContactAt est invalide', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      lastContactAt: 'date-invalide',
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'invalid_context',
    })
  })

  it('fail closed si le dernier contact est dans le futur', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      lastContactAt: '2026-08-18T13:00:00.000Z',
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'invalid_context',
    })
  })

  it('fail closed si le cooldown est négatif', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: NOW,
      lastContactAt: '2026-08-10T12:00:00.000Z',
      contactCooldownHours: -1,
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'invalid_context',
    })
  })

  it('fail closed si now est invalide', () => {
    const decision = eligibilityDecision(BASE_SITUATION, {
      now: new Date('invalid'),
    })

    expect(decision).toEqual({
      eligible: false,
      reason: 'invalid_context',
    })
  })
})