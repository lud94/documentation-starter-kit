import {
  TEST_BUSINESS_CONTEXT,
  TEST_RECOMMENDATION_CONTEXT,
  TEST_SITUATION_PROVENANCE,
} from './helpers/proactiveContext'
// JARVIS-PROACTIVE-01D — persistance du Decision Model.
//
// La couche testée ici est RÉELLE : `lib/supabase/store` est exercé pour de
// bon, via son repli mémoire (aucun Supabase configuré). Ce repli partage la
// même clé `(kind, ws, id)` que la table, donc les propriétés qui nous
// intéressent — cloisonnement par espace, isolation des kinds, idempotence de
// l'upsert — sont celles du vrai magasin, pas d'une imitation.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Aucun Supabase : `store.ts` bascule sur sa Map globale.
vi.mock('../lib/supabase/client', () => ({
  supabase: () => null,
  supabaseConfigured: () => false,
}))
// L'environnement n'est pas le sujet ici ; il a ses propres tests.
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))

import {
  PROACTIVE_KINDS,
  PROACTIVE_KIND_LIST,
  isProactiveKind,
  saveEvidence, readEvidence, listEvidence,
  saveSituation, readSituation, listSituations,
  saveRecommendation, readRecommendation, listRecommendations,
  saveOutcome, readOutcome, listOutcomes,
  deleteProactiveItem,
} from '../lib/prospector/proactive/persistence'
import type {
  EvidenceEvent, Outcome, Recommendation, Situation,
} from '../lib/prospector/proactive/types'

const WS = 'ws_alpha'
const AUTRE_WS = 'ws_beta'
const T0 = '2026-03-01T10:00:00.000Z'

const EVIDENCE: EvidenceEvent = {
  id: 'ev_hot_lead_acc_siren_123_ld_1',
  accountId: 'acc_siren_123',
  personId: 'ld_1',
  scope: 'relationship',
  type: 'hot_lead',
  value: 'hot',
  source: { provider: 'prospector_crm', reference: 'ld_1' },
  assertionType: 'fact',
  confidence: 0.8,
  temporality: 'undated_state',
  observedAt: T0,
}

const SITUATION: Situation = {
  ...TEST_SITUATION_PROVENANCE,
  id: 'sit_acc_siren_123_ld_1_commercial_momentum_stalled',
  accountId: 'acc_siren_123',
  personId: 'ld_1',
  type: 'commercial_momentum_stalled',
  evidenceIds: [EVIDENCE.id],
  confidence: 0.8,
  relevance: 0.7,
  urgency: 1,
  rationale: 'test',
  ruleId: 'commercial-momentum-stalled',
  ruleVersion: 'v0.1',
  createdAt: T0,
  lastEvaluatedAt: T0,
  expiresAt: '2026-03-08T10:00:00.000Z',
}

const RECOMMENDATION: Recommendation = {
  control: 'autonomous',
  controlReason: 'Toutes les capacités requises sont accordées.',
  requiredMotions: ['prepare_outreach', 'contact_prospect'],
  contextId: 'test-sales',
  contextVersion: 'v0.1',
  id: `rec_${SITUATION.id}`,
  situationId: SITUATION.id,
  accountId: 'acc_siren_123',
  personId: 'ld_1',
  decision: 'recommend',
  reason: 'test',
  whyNow: 'test',
  priority: 'medium',
  confidence: 0.7,
  play: 'follow_up',
  recommendedAction: 'Relancer.',
  ruleId: 'recommend-commercial_momentum_stalled',
  ruleVersion: 'v0.1',
  createdAt: T0,
}

const OUTCOME: Outcome = {
  id: 'out_rec_1_recommendation_accepted',
  recommendationId: RECOMMENDATION.id,
  accountId: 'acc_siren_123',
  personId: 'ld_1',
  type: 'recommendation_accepted',
  occurredAt: T0,
}

beforeEach(() => {
  // Le magasin mémoire vit sur `globalThis` pour survivre au hot-reload : il
  // faut donc le vider explicitement entre les cas.
  const g = globalThis as any
  if (g.__prospectorStore) g.__prospectorStore.clear()
})

describe('A. Aller-retour de chacun des quatre objets', () => {
  it('EvidenceEvent : écrit, relu à l\'identique', async () => {
    expect(await saveEvidence(EVIDENCE, WS)).toEqual({ ok: true })
    expect(await readEvidence(EVIDENCE.id, WS)).toEqual({ ok: true, value: EVIDENCE })
    expect(await listEvidence(WS)).toEqual([EVIDENCE])
  })

  it('Situation : écrite, relue à l\'identique', async () => {
    expect(await saveSituation(SITUATION, WS)).toEqual({ ok: true })
    expect(await readSituation(SITUATION.id, WS)).toEqual({ ok: true, value: SITUATION })
    expect(await listSituations(WS)).toEqual([SITUATION])
  })

  it('Recommendation : écrite, relue à l\'identique', async () => {
    expect(await saveRecommendation(RECOMMENDATION, WS)).toEqual({ ok: true })
    expect(await readRecommendation(RECOMMENDATION.id, WS)).toEqual({ ok: true, value: RECOMMENDATION })
    expect(await listRecommendations(WS)).toEqual([RECOMMENDATION])
  })

  it('Outcome : écrit, relu à l\'identique', async () => {
    expect(await saveOutcome(OUTCOME, WS)).toEqual({ ok: true })
    expect(await readOutcome(OUTCOME.id, WS)).toEqual({ ok: true, value: OUTCOME })
    expect(await listOutcomes(WS)).toEqual([OUTCOME])
  })

  it('un objet absent est une ABSENCE, pas un échec', async () => {
    expect(await readEvidence('ev_inexistant', WS)).toEqual({ ok: true, value: null })
  })
})

describe('B. Isolation des kinds', () => {
  it('un même identifiant sous deux kinds ne se mélange jamais', async () => {
    const idPartage = 'identifiant_partage'
    await saveEvidence({ ...EVIDENCE, id: idPartage }, WS)
    await saveSituation({ ...SITUATION, id: idPartage }, WS)

    const evidence = await readEvidence(idPartage, WS)
    const situation = await readSituation(idPartage, WS)

    expect(evidence.ok && evidence.value?.type).toBe('hot_lead')
    expect(situation.ok && situation.value?.type).toBe('commercial_momentum_stalled')
    expect(await listEvidence(WS)).toHaveLength(1)
    expect(await listSituations(WS)).toHaveLength(1)
  })

  it('une collection ne déborde pas sur les autres', async () => {
    await saveEvidence(EVIDENCE, WS)
    expect(await listSituations(WS)).toEqual([])
    expect(await listRecommendations(WS)).toEqual([])
    expect(await listOutcomes(WS)).toEqual([])
  })

  it('les quatre kinds sont préfixés et reconnaissables', () => {
    expect(PROACTIVE_KIND_LIST).toEqual([
      'proactive_evidence', 'proactive_situation',
      'proactive_recommendation', 'proactive_outcome',
    ])
    for (const kind of PROACTIVE_KIND_LIST) expect(isProactiveKind(kind)).toBe(true)
    // Les kinds historiques ne deviennent pas « proactifs » par accident.
    for (const kind of ['task', 'mission', 'notification', 'sequence']) {
      expect(isProactiveKind(kind)).toBe(false)
    }
  })
})

describe('C. Cloisonnement par espace — non-régression tenant', () => {
  it('un espace ne lit jamais les objets d\'un autre', async () => {
    await saveEvidence(EVIDENCE, WS)
    expect(await readEvidence(EVIDENCE.id, AUTRE_WS)).toEqual({ ok: true, value: null })
    expect(await listEvidence(AUTRE_WS)).toEqual([])
    // …et l'espace d'origine n'a pas été affecté par la tentative.
    expect(await listEvidence(WS)).toHaveLength(1)
  })

  it('le même identifiant peut coexister dans deux espaces, sans fuite', async () => {
    await saveEvidence(EVIDENCE, WS)
    await saveEvidence({ ...EVIDENCE, confidence: 0.6 }, AUTRE_WS)

    const a = await readEvidence(EVIDENCE.id, WS)
    const b = await readEvidence(EVIDENCE.id, AUTRE_WS)
    expect(a.ok && a.value?.confidence).toBe(0.8)
    expect(b.ok && b.value?.confidence).toBe(0.6)
  })

  it('un espace vide ou blanc est REFUSÉ, jamais remplacé par un défaut', async () => {
    for (const ws of ['', '   ']) {
      expect(await saveEvidence(EVIDENCE, ws)).toEqual({ ok: false, reason: 'denied' })
      expect(await readEvidence(EVIDENCE.id, ws)).toEqual({ ok: false })
      expect(await listEvidence(ws)).toEqual([])
    }
    // Rien n'a été écrit nulle part.
    expect(await listEvidence(WS)).toEqual([])
  })

  it('la suppression est elle aussi cloisonnée', async () => {
    await saveEvidence(EVIDENCE, WS)
    await deleteProactiveItem(PROACTIVE_KINDS.evidence, EVIDENCE.id, AUTRE_WS)
    expect(await listEvidence(WS)).toHaveLength(1)

    await deleteProactiveItem(PROACTIVE_KINDS.evidence, EVIDENCE.id, WS)
    expect(await listEvidence(WS)).toEqual([])
  })
})

describe('D. Idempotence', () => {
  it('réécrire le même identifiant REMPLACE, il ne duplique pas', async () => {
    await saveEvidence(EVIDENCE, WS)
    await saveEvidence(EVIDENCE, WS)
    await saveEvidence({ ...EVIDENCE, confidence: 0.9 }, WS)

    const items = await listEvidence(WS)
    expect(items).toHaveLength(1)
    expect(items[0].confidence).toBe(0.9)
  })

  it('vaut pour les quatre collections', async () => {
    for (let i = 0; i < 3; i++) {
      await saveSituation(SITUATION, WS)
      await saveRecommendation(RECOMMENDATION, WS)
      await saveOutcome(OUTCOME, WS)
    }
    expect(await listSituations(WS)).toHaveLength(1)
    expect(await listRecommendations(WS)).toHaveLength(1)
    expect(await listOutcomes(WS)).toHaveLength(1)
  })
})

describe('E. Un objet invalide n\'entre pas en base', () => {
  it('EvidenceEvent : champs manquants ou hors bornes ⇒ refus', async () => {
    const invalides: any[] = [
      { ...EVIDENCE, id: '' },
      { ...EVIDENCE, accountId: '' },
      { ...EVIDENCE, confidence: 1.4 },
      { ...EVIDENCE, confidence: -0.1 },
      { ...EVIDENCE, confidence: Number.NaN },
      { ...EVIDENCE, observedAt: undefined },
      // Temporalité absente : INVALIDE, jamais promue en `dated_event`.
      { ...EVIDENCE, temporality: undefined },
      { ...EVIDENCE, temporality: 'recent' },
      // Un état non daté ne peut pas porter une date de survenue.
      { ...EVIDENCE, occurredAt: T0 },
      // Un événement daté DOIT en porter une.
      { ...EVIDENCE, temporality: 'dated_event' },
      { ...EVIDENCE, temporality: 'dated_event', occurredAt: 'pas-une-date' },
      { ...EVIDENCE, source: undefined },
      { ...EVIDENCE, source: { provider: '' } },
      { ...EVIDENCE, expiresAt: 'jamais' },
      null,
      'chaîne',
    ]
    for (const item of invalides) {
      expect(await saveEvidence(item, WS), JSON.stringify(item)).toEqual({ ok: false, reason: 'denied' })
    }
    expect(await listEvidence(WS)).toEqual([])
  })

  it('Recommendation : un `no_action` porteur d\'un play est contradictoire ⇒ refus', async () => {
    const contradictoire: any = { ...RECOMMENDATION, decision: 'no_action' }
    expect(await saveRecommendation(contradictoire, WS)).toEqual({ ok: false, reason: 'denied' })

    // La même, débarrassée du play, est acceptée.
    const coherente: any = {
      ...RECOMMENDATION, decision: 'no_action',
      play: undefined, recommendedAction: undefined,
    }
    expect(await saveRecommendation(coherente, WS)).toEqual({ ok: true })
  })

  it('Situation et Outcome : formes invalides refusées', async () => {
    expect(await saveSituation({ ...SITUATION, evidenceIds: [''] } as any, WS))
      .toEqual({ ok: false, reason: 'denied' })
    expect(await saveSituation({ ...SITUATION, relevance: 2 } as any, WS))
      .toEqual({ ok: false, reason: 'denied' })
    expect(await saveOutcome({ ...OUTCOME, occurredAt: '' } as any, WS))
      .toEqual({ ok: false, reason: 'denied' })
    expect(await saveOutcome({ ...OUTCOME, recommendationId: '' } as any, WS))
      .toEqual({ ok: false, reason: 'denied' })
  })

  it('une ligne corrompue déjà en base est IGNORÉE à la lecture, jamais réparée', async () => {
    // On force une ligne malformée directement dans le magasin, comme aurait pu
    // le faire une version antérieure du code.
    const g = globalThis as any
    g.__prospectorStore.set(
      `${PROACTIVE_KINDS.evidence}|${WS}|ev_corrompue`,
      { id: 'ev_corrompue', accountId: 'acc', confidence: 'beaucoup' },
    )
    expect(await readEvidence('ev_corrompue', WS)).toEqual({ ok: true, value: null })
    expect(await listEvidence(WS)).toEqual([])
  })
})
