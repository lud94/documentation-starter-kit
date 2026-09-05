// SITUATION_ENGINE_RELIABILITY_V0_001 — LA MOYENNE N'AUTORISE PLUS RIEN.
//
// Trois politiques distinctes, et ces tests verrouillent leur frontière :
//   sales_scale_up / commercial_momentum_stalled
//       → plancher PAR CONTRIBUTEUR (0.70) : aucun contributeur fort ne
//         compense un faible ; la moyenne reste un agrégat DESCRIPTIF.
//   strong_signal_low_context
//       → autorité STRUCTURELLE (EXTERNAL_CONFIRMED_CANONICAL), JAMAIS
//         re-couplée au flottant hérité — pas de plancher 0.70 sur le fort.
//   Fabel
//       → politique propre INCHANGÉE (plancher famille + agrégat contraction).
import { describe, expect, it } from 'vitest'

import { evaluateSituations, SITUATION_RULE_VERSION } from '../lib/prospector/proactive/situationEngine'
import { MIN_CONTRIBUTOR_CONFIDENCE } from '../lib/prospector/proactive/packs/sales-core'
import { recommendationDecision } from '../lib/prospector/proactive/recommendationEngine'
import { validateEvalCase, EVAL_SCHEMA_VERSION } from '../lib/prospector/proactive/eval/caseSchema'
import { runEvalCase } from '../lib/prospector/proactive/eval/runCase'
import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'
import type { EvidenceEvent, EvidenceStrengthV0 } from '../lib/prospector/proactive/types'
import type { SituationEvaluationContext } from '../lib/prospector/proactive/rulePack'

const NOW = new Date('2026-09-05T12:00:00.000Z')
const COMPTE = 'acc_1'

function contexte(patch: Partial<SituationEvaluationContext> = {}): SituationEvaluationContext {
  return {
    now: NOW, accountId: COMPTE, relevance: 0.9,
    lensId: 'sales-default', lensVersion: 'v0.1', ...patch,
  }
}

function ev(id: string, type: string, confidence: number, patch: Record<string, unknown> = {}): EvidenceEvent {
  return {
    id, type, accountId: COMPTE, scope: 'account',
    temporality: 'dated_event', occurredAt: '2026-09-01',
    assertionType: 'fact', confidence,
    observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
    ...patch,
  } as unknown as EvidenceEvent
}

function etat(id: string, type: string, confidence: number, patch: Record<string, unknown> = {}): EvidenceEvent {
  return {
    id, type, accountId: COMPTE, scope: 'account',
    temporality: 'undated_state', assertionType: 'fact', confidence,
    observedAt: NOW.toISOString(), source: { provider: 'prospector_crm' },
    ...patch,
  } as unknown as EvidenceEvent
}

const sales = (evidence: EvidenceEvent[], ctx = contexte()) =>
  evaluateSituations(evidence, ctx, ['sales-core'])

/** Paire funding + hiring (deux familles) aux confidences choisies. */
const paireScale = (cFund: number, cHiring: number) => [
  ev('ev_fund', 'recent_funding', cFund),
  etat('ev_jobs', 'sales_hiring', cHiring),
]

describe('sales_scale_up — plancher PAR CONTRIBUTEUR, la moyenne ne décide plus', () => {
  it('A/B/C — 0.95+0.60, 0.90+0.65, 0.80+0.60 ⇒ AUCUNE sales_scale_up (le fort ne blanchit pas le faible)', () => {
    for (const [a, b] of [[0.95, 0.60], [0.90, 0.65], [0.80, 0.60]] as const) {
      const types = sales(paireScale(a, b)).map((s) => s.type)
      expect(types, `${a}+${b}`).not.toContain('sales_scale_up')
    }
  })

  it('D — 0.70 + 0.70 (borne incluse) ⇒ PASSE', () => {
    expect(sales(paireScale(0.7, 0.7)).map((s) => s.type)).toContain('sales_scale_up')
  })

  it('E — 0.75 + 0.80 (valeurs des producteurs réels) ⇒ inchangé, PASSE, moyenne DESCRIPTIVE conservée', () => {
    const s = sales(paireScale(0.75, 0.8)).find((x) => x.type === 'sales_scale_up')
    if (!s) throw new Error('sales_scale_up attendu')
    // La moyenne reste écrite telle quelle — descriptive, pas décisionnelle.
    expect(s.confidence).toBe(0.78)
  })

  it('un contributeur faible parmi PLUSIEURS forts reste bloquant (tous les cités comptent)', () => {
    const types = sales([
      ev('ev_fund', 'recent_funding', 0.95),
      etat('ev_jobs', 'sales_hiring', 0.9),
      ev('ev_head', 'headcount_acceleration', 0.65),
    ]).map((s) => s.type)
    expect(types).not.toContain('sales_scale_up')
  })
})

describe('commercial_momentum_stalled — même plancher par contributeur', () => {
  const relation = (cMomentum: number, cStalled: number) => [
    { ...etat('ev_hot', 'hot_lead', cMomentum), scope: 'relationship', personId: 'p_1' },
    { ...etat('ev_next', 'no_next_step', cStalled), scope: 'relationship', personId: 'p_1' },
  ] as unknown as EvidenceEvent[]
  const ctxPersonne = contexte({ personId: 'p_1' })

  it('contributeur fort + contributeur sous 0.70 ⇒ AUCUNE situation', () => {
    expect(sales(relation(0.95, 0.65), ctxPersonne).map((s) => s.type))
      .not.toContain('commercial_momentum_stalled')
    expect(sales(relation(0.65, 0.95), ctxPersonne).map((s) => s.type))
      .not.toContain('commercial_momentum_stalled')
  })

  it('les deux ≥ 0.70 ⇒ PASSE', () => {
    expect(sales(relation(0.7, 0.7), ctxPersonne).map((s) => s.type))
      .toContain('commercial_momentum_stalled')
  })
})

describe('strong_signal_low_context — autorité STRUCTURELLE, jamais re-couplée au flottant', () => {
  const FORCE: Record<string, EvidenceStrengthV0> = {
    ev_fund: { kind: 'EXTERNAL_CONFIRMED_CANONICAL' },
  }
  const externe = (confidence: number) => ev('ev_fund', 'recent_funding', confidence, {
    source: { provider: 'web_signal_search', url: 'https://acme.fr/p' },
    acceptance: {
      kind: 'human_confirmed', actorId: 'alice',
      confirmedAt: NOW.toISOString(), canonicalKey: 'k', sourceUrls: [],
    },
  })

  it('CRITIQUE — force structurelle avec confidence 0.60 ⇒ la Situation PEUT naître (aucun plancher 0.70 recréé)', () => {
    const types = sales(
      [externe(0.6), etat('ev_ctx', 'missing_context', 0.8)],
      contexte({ evidenceStrengthByEvidenceId: FORCE }),
    ).map((s) => s.type)
    expect(types).toContain('strong_signal_low_context')
  })

  it('confidence 0.99 SANS force structurelle ⇒ JAMAIS de strong_signal_low_context', () => {
    const types = sales(
      [externe(0.99), etat('ev_ctx', 'missing_context', 0.8)],
    ).map((s) => s.type)
    expect(types).not.toContain('strong_signal_low_context')
  })
})

describe('non-régression Fabel — politique d’agrégat PROPRE, intacte', () => {
  const fabelCtx = contexte({ lensId: 'fabel-broker' })
  const fabel = (evidence: EvidenceEvent[]) =>
    evaluateSituations(evidence, fabelCtx, ['real-estate-fabel']).map((s) => s.type)

  it('contraction 0.70 + 0.90 : le plancher famille (0.70) admet, l’agrégat (moyenne 0.80 ≥ 0.75) décide — INCHANGÉ', () => {
    // C'est PRÉCISÉMENT le cas qu'un « min » générique casserait (min 0.70 <
    // 0.75) : il verrouille que la politique Fabel n'a pas bougé.
    const types = fabel([
      ev('ev_down', 'workforce_contraction', 0.7),
      ev('ev_reorg', 'restructuring_announced', 0.9),
    ])
    expect(types).toContain('space_contraction')
  })

  it('expansion convergence 0.72 + 0.72 : plancher famille satisfait ⇒ INCHANGÉ', () => {
    const types = fabel([
      ev('ev_fund', 'recent_funding', 0.72, { occurredAt: '2026-08-20' }),
      ev('ev_site', 'site_expansion', 0.72),
    ])
    expect(types).toContain('space_expansion')
  })

  it('le source Fabel est BYTE-INCHANGÉ par ce ticket (aucune modification autorisée)', () => {
    const { execSync } = require('node:child_process')
    const diff = execSync(
      'git diff --name-only HEAD -- lib/prospector/proactive/packs/real-estate-fabel',
      { encoding: 'utf8' },
    ).trim()
    expect(diff).toBe('')
  })
})

describe('frontières aval et parité', () => {
  it('Recommendation inchangée pour une Situation inchangée (min(confidence, relevance) conservé)', () => {
    const s = sales(paireScale(0.75, 0.8)).find((x) => x.type === 'sales_scale_up')
    if (!s) throw new Error('sales_scale_up attendu')
    const r = recommendationDecision(s, {
      now: NOW,
      businessContext: TEST_BUSINESS_CONTEXT.contextId
        ? {
            contextId: TEST_BUSINESS_CONTEXT.contextId,
            contextVersion: TEST_BUSINESS_CONTEXT.contextVersion,
            authorizedMotions: TEST_BUSINESS_CONTEXT.authorizedMotions,
          }
        : (TEST_BUSINESS_CONTEXT as any),
    } as any)
    expect(r.decision).toBe('recommend')
    expect(r.confidence).toBe(Math.min(s.confidence, s.relevance))
  })

  it('parité runner — un contributeur sous 0.70 ne peut pas être blanchi via l’éval offline', () => {
    const cas = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      now: '2026-09-05T12:00:00.000Z',
      businessContext: {
        contextId: 'floor-smoke', contextVersion: 'v0.1', role: 'sales_rep',
        scope: { mode: 'workspace' },
        authorizedMotions: {
          prepare_outreach: 'allowed', contact_prospect: 'allowed',
          enrich_data: 'allowed', schedule_reminder: 'allowed',
        },
        lensId: 'sales-default', lensVersion: 'v0.1',
      },
      targets: [{ accountId: COMPTE, relevance: 0.8 }],
      evidence: [
        {
          id: 'ev_fund', accountId: COMPTE, type: 'recent_funding', scope: 'account',
          temporality: 'dated_event', occurredAt: '2026-09-01T00:00:00.000Z',
          observedAt: '2026-09-04T00:00:00.000Z', assertionType: 'fact',
          confidence: 0.95, source: { provider: 'smoke-fixture' },
        },
        {
          id: 'ev_jobs', accountId: COMPTE, type: 'sales_hiring', scope: 'account',
          temporality: 'dated_event', occurredAt: '2026-09-01T00:00:00.000Z',
          observedAt: '2026-09-04T00:00:00.000Z', assertionType: 'fact',
          confidence: 0.6, source: { provider: 'smoke-fixture' },
        },
      ],
    }
    const v = validateEvalCase(cas)
    if (v.ok === false) throw new Error(JSON.stringify(v.errors))
    expect(runEvalCase(v.case).situations.map((s) => s.type)).not.toContain('sales_scale_up')
  })

  it('le plancher est déclaré par le pack et vaut exactement 0.70', () => {
    expect(MIN_CONTRIBUTOR_CONFIDENCE).toBe(0.7)
  })

  it('la provenance de version dit la vérité : alias v0.4, pas un héritage v0.3', () => {
    expect(SITUATION_RULE_VERSION).toBe('v0.4')
  })
})
