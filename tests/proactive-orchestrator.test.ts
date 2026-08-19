// JARVIS-PROACTIVE-01D — chaîne complète.
//
//   leads réels → EvidenceEvent[] → evaluateSituations() → recommendationDecision()
//
// Les quatre moteurs sont RÉELS ici : rien n'est simulé. Ce fichier vérifie deux
// choses que les tests unitaires de chaque moteur ne peuvent pas voir : que la
// chaîne est déterministe de bout en bout, et qu'elle n'exécute jamais rien.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/supabase/client', () => ({
  supabase: () => null,
  supabaseConfigured: () => false,
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))

import type { Lead } from '../types/prospector'
import {
  evaluate,
  persistEvaluation,
  type ProactiveEvaluationInput,
} from '../lib/prospector/proactive/orchestrator'
import type { TaskSnapshot } from '../lib/prospector/proactive/dataBridge'
import {
  listEvidence,
  listRecommendations,
  listSituations,
} from '../lib/prospector/proactive/persistence'

const NOW = new Date('2026-03-01T10:00:00.000Z')
const WS = 'ws_alpha'
const COMPLET: TaskSnapshot = { complete: true, openTaskLeadIds: [] }

function lead(patch: Partial<Lead> = {}): Lead {
  return {
    id: 'ld_1',
    firstName: 'Alice',
    lastName: 'Martin',
    title: 'VP Sales',
    company: 'Acme SAS',
    siren: '552100554',
    score: 80,
    temperature: 'hot',
    status: 'chaud',
    stage: 'in_sequence',
    email: 'alice@acme.test',
    phone: null,
    ...patch,
  }
}

function run(patch: Partial<ProactiveEvaluationInput> = {}) {
  return evaluate({ leads: [lead()], now: NOW, tasks: COMPLET, ...patch })
}

beforeEach(() => {
  const g = globalThis as any
  if (g.__prospectorStore) g.__prospectorStore.clear()
})

describe('A. Chaîne end-to-end déterministe', () => {
  it('lead chaud + aucune prochaine étape ⇒ situation puis recommandation', () => {
    const out = run()

    expect(out.evidence.map((e) => e.type).sort()).toEqual(['hot_lead', 'no_next_step'])

    expect(out.situations).toHaveLength(1)
    const situation = out.situations[0]
    expect(situation.type).toBe('commercial_momentum_stalled')
    expect(situation.accountId).toBe('acc_siren_552100554')
    expect(situation.personId).toBe('ld_1')
    // La traçabilité est conservée jusqu'au bout.
    expect(situation.ruleId).toBe('commercial-momentum-stalled')
    expect(situation.ruleVersion).toBe('v0.1')
    expect(situation.evidenceIds.sort()).toEqual(out.evidence.map((e) => e.id).sort())

    expect(out.recommendations).toHaveLength(1)
    const reco = out.recommendations[0]
    expect(reco.decision).toBe('recommend')
    expect(reco.play).toBe('follow_up')
    expect(reco.situationId).toBe(situation.id)
    expect(reco.ruleId).toBe('recommend-commercial_momentum_stalled')
  })

  it('deux exécutions identiques rendent un résultat STRICTEMENT identique', () => {
    expect(run()).toEqual(run())
  })

  it('l\'ordre des leads en entrée ne change pas la sortie', () => {
    const a = lead({ id: 'ld_1' })
    const b = lead({ id: 'ld_2', firstName: 'Bruno', company: 'Beta SARL', siren: '552100555' })

    const ordre1 = evaluate({ leads: [a, b], now: NOW, tasks: COMPLET })
    const ordre2 = evaluate({ leads: [b, a], now: NOW, tasks: COMPLET })

    expect(ordre1.situations.map((s) => s.id)).toEqual(ordre2.situations.map((s) => s.id))
    expect(ordre1.recommendations.map((r) => r.id)).toEqual(ordre2.recommendations.map((r) => r.id))
  })

  it('la relevance vient du score réellement persisté, et peut être surchargée', () => {
    expect(run({ leads: [lead({ score: 40 })] }).situations[0].relevance).toBe(0.4)
    expect(run({ relevanceFor: () => 0.1 }).situations[0].relevance).toBe(0.1)
    // Une relevance hors bornes est ramenée, jamais propagée telle quelle.
    expect(run({ relevanceFor: () => 7 }).situations[0].relevance).toBe(1)
    expect(run({ relevanceFor: () => Number.NaN }).situations[0].relevance).toBe(0)
  })
})

describe('B. NO_ACTION est un résultat, pas un échec', () => {
  it('un rendez-vous avec UNE personne ne bloque pas la relation d\'une AUTRE', () => {
    // Deux personnes du MÊME compte : Bruno a un rendez-vous, Alice non. Les
    // relations sont individuelles — bloquer Alice parce que Bruno a un
    // rendez-vous reviendrait à confondre le compte et la personne.
    const out = evaluate({
      leads: [
        lead({ id: 'ld_1', stage: 'in_sequence' }),
        lead({ id: 'ld_2', firstName: 'Bruno', stage: 'meeting' }),
      ],
      now: NOW,
      tasks: COMPLET,
    })

    const alice = out.recommendations.filter((r) => r.personId === 'ld_1')
    expect(alice).toHaveLength(1)
    expect(alice[0].decision).toBe('recommend')

    // Bruno, lui, ne produit aucune situation : l'étape `meeting` EST le
    // prochain engagement, donc aucune evidence `no_next_step` n'est émise.
    expect(out.situations.filter((s) => s.personId === 'ld_2')).toEqual([])
  })

  it('un rendez-vous fourni par l\'appelant bloque bien la recommandation', () => {
    const out = run({ eligibilityFor: () => ({ meetingScheduled: true }) })
    expect(out.situations).toHaveLength(1)
    const reco = out.recommendations[0]
    expect(reco.decision).toBe('no_action')
    expect(reco.ruleId).toBe('eligibility-meeting_already_scheduled')
    // Un `no_action` ne propose jamais d'action.
    expect(reco.play).toBeUndefined()
    expect(reco.recommendedAction).toBeUndefined()
  })

  it('un opt-out fourni par l\'appelant produit NO_ACTION', () => {
    const out = run({ eligibilityFor: () => ({ optedOut: true }) })
    expect(out.situations).toHaveLength(1)
    expect(out.recommendations[0].decision).toBe('no_action')
    expect(out.recommendations[0].ruleId).toBe('eligibility-opt_out')
  })

  it('l\'appelant ne peut pas décaler l\'horloge d\'éligibilité', () => {
    const out = run({
      eligibilityFor: () => ({ now: new Date('2030-01-01T00:00:00.000Z') } as any),
    })
    // L'horloge du lot prime : la situation n'est pas expirée, la reco est active.
    expect(out.recommendations[0].decision).toBe('recommend')
  })

  it('une recommandation active déjà existante évite le doublon', () => {
    const out = run({ eligibilityFor: () => ({ activeRecommendationExists: true }) })
    expect(out.recommendations[0].decision).toBe('no_action')
    expect(out.recommendations[0].ruleId).toBe('eligibility-active_recommendation_exists')
  })
})

describe('C. Les situations non soutenues par les données restent VIDES', () => {
  it('sales_scale_up n\'est jamais atteinte depuis les données actuelles', () => {
    const out = evaluate({
      leads: [
        lead({ signal: 'levée de 12M€ et recrute un Head of Sales', effectif: '50 à 99' }),
        lead({ id: 'ld_2', signal: 'nouveau VP Sales', firstName: 'Bruno' }),
      ],
      now: NOW,
      tasks: COMPLET,
    })
    expect(out.situations.map((s) => s.type)).not.toContain('sales_scale_up')
  })

  it('strong_signal_low_context n\'est jamais atteinte non plus', () => {
    const out = evaluate({
      leads: [lead({
        signal: 'levée de 12M€', email: null, phone: null,
        linkedinUrl: undefined, summary: undefined,
      })],
      now: NOW,
      tasks: COMPLET,
    })
    expect(out.situations.map((s) => s.type)).not.toContain('strong_signal_low_context')
  })

  it('aucune evidence ⇒ aucune situation, aucune recommandation, sans erreur', () => {
    const out = evaluate({
      leads: [lead({ temperature: 'cold', status: 'froid', stage: 'to_invite' })],
      now: NOW,
      tasks: { complete: false },
    })
    expect(out).toEqual({ evidence: [], situations: [], recommendations: [] })
  })

  it('instantané de tâches incomplet ⇒ pas de momentum_stalled inventé', () => {
    const out = run({ tasks: { complete: false } })
    expect(out.evidence.map((e) => e.type)).toEqual(['hot_lead'])
    expect(out.situations).toEqual([])
    expect(out.recommendations).toEqual([])
  })
})

describe('D. Aucune action métier', () => {
  it('les leads d\'entrée ne sont jamais modifiés', () => {
    const entree = [lead(), lead({ id: 'ld_2', firstName: 'Bruno' })]
    const copie = JSON.parse(JSON.stringify(entree))
    evaluate({ leads: entree, now: NOW, tasks: COMPLET })
    expect(entree).toEqual(copie)
  })

  it('`evaluate` n\'écrit RIEN — la persistance est un appel séparé', async () => {
    run()
    expect(await listEvidence(WS)).toEqual([])
    expect(await listSituations(WS)).toEqual([])
    expect(await listRecommendations(WS)).toEqual([])
  })

  it('aucune recommandation ne porte de message rédigé : seulement un play', () => {
    const out = run()
    const reco = out.recommendations[0]
    // Les libellés viennent de constantes de règle, pas d'une génération.
    expect(reco.recommendedAction).toBe(
      'Relancer la relation et obtenir un prochain engagement explicite.',
    )
    expect(Object.keys(reco)).not.toContain('message')
  })
})

describe('E. Persistance et idempotence de bout en bout', () => {
  it('persiste les trois collections dans le bon espace', async () => {
    const out = run()
    expect(await persistEvaluation(out, WS)).toEqual({
      evidence: 2, situations: 1, recommendations: 1,
    })

    expect(await listEvidence(WS)).toHaveLength(2)
    expect(await listSituations(WS)).toHaveLength(1)
    expect(await listRecommendations(WS)).toHaveLength(1)
    // Aucune fuite vers un autre espace.
    expect(await listEvidence('ws_beta')).toEqual([])
  })

  it('réévaluer deux fois ne crée AUCUN doublon', async () => {
    await persistEvaluation(run(), WS)
    await persistEvaluation(run(), WS)
    await persistEvaluation(run(), WS)

    expect(await listEvidence(WS)).toHaveLength(2)
    expect(await listSituations(WS)).toHaveLength(1)
    expect(await listRecommendations(WS)).toHaveLength(1)
  })

  it('une réévaluation plus tardive remplace la même ligne, identifiants inchangés', async () => {
    await persistEvaluation(run(), WS)
    const avant = (await listSituations(WS))[0]

    const plusTard = new Date('2026-03-02T10:00:00.000Z')
    await persistEvaluation(run({ now: plusTard }), WS)
    const apres = (await listSituations(WS))[0]

    expect(await listSituations(WS)).toHaveLength(1)
    expect(apres.id).toBe(avant.id)
    expect(apres.lastEvaluatedAt).toBe(plusTard.toISOString())
  })

  it('un espace vide fait échouer la persistance sans rien écrire', async () => {
    expect(await persistEvaluation(run(), '')).toEqual({
      evidence: 0, situations: 0, recommendations: 0,
    })
    expect(await listEvidence(WS)).toEqual([])
  })
})
