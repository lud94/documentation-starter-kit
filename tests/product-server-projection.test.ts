// PFV0-2A — PROJECTION SERVEUR GOUVERNÉE — tests comportementaux.
//
// Le magasin exercé est RÉEL (`lib/supabase/store` en repli mémoire) : le
// cloisonnement par espace et l'idempotence testés sont ceux du vrai magasin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase/client', () => ({
  supabase: () => null,
  supabaseConfigured: () => false,
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))
// PFV0-2A.1 — le magasin devient ESPIONNABLE : chaque export garde son
// implémentation réelle (repli mémoire), mais `listItemsStrict` est enveloppé
// dans un vi.fn pour simuler PAR TEST une indisponibilité de transport, puis
// être restauré (mockReset rétablit l'implémentation d'origine).
vi.mock('../lib/supabase/store', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, listItemsStrict: vi.fn(actual.listItemsStrict) }
})

import { readFileSync } from 'fs'
import { join } from 'path'
import { TEST_SITUATION_PROVENANCE } from './helpers/proactiveContext'
import {
  saveEvidence, saveSituation, saveRecommendation,
} from '../lib/prospector/proactive/persistence'
import type { EvidenceEvent, Recommendation, Situation } from '../lib/prospector/proactive/types'
import {
  canonicalEventId, saveCanonicalEvent, type CanonicalEvent,
} from '../lib/prospector/proactive/canonicalFact'
import {
  MONITORING_RUN_SCHEMA_VERSION, type MonitoringRunResultV0,
} from '../lib/prospector/monitoring/accountMonitor'
import { createAccountMonitor, persistRunResult } from '../lib/prospector/monitoring/monitoringStore'
import {
  buildTodayProjectionV0,
  buildCompanyWorkspaceProjectionV0,
  type ProjectionWindowV0,
} from '../lib/prospector/product/serverProjection'
import * as storeModule from '../lib/supabase/store'
import { PROACTIVE_KINDS } from '../lib/prospector/proactive/persistence'

const WS = 'ws_alpha'
const AUTRE_WS = 'ws_beta'
const ACCOUNT = 'acc_siren_123456789'
const AUTRE_ACCOUNT = 'acc_siren_987654321'
const WINDOW: ProjectionWindowV0 = {
  since: '2026-08-25T00:00:00.000Z',
  until: '2026-09-05T23:59:59.000Z',
}

function evidence(over: Partial<EvidenceEvent> & { id: string }): EvidenceEvent {
  return {
    accountId: ACCOUNT,
    scope: 'company',
    type: 'funding_round',
    value: 'Series B',
    source: { provider: 'prospector_crm', reference: 'x' },
    assertionType: 'fact',
    confidence: 0.9,
    temporality: 'dated_event',
    occurredAt: '2026-09-01T00:00:00.000Z',
    observedAt: '2026-09-02T08:00:00.000Z',
    ...over,
  } as EvidenceEvent
}

function situation(over: Partial<Situation> & { id: string; evidenceIds: string[] }): Situation {
  return {
    ...TEST_SITUATION_PROVENANCE,
    accountId: ACCOUNT,
    type: 'commercial_momentum_stalled',
    confidence: 0.8,
    relevance: 0.7,
    urgency: 0.5,
    rationale: 'Interprétation moteur : motif du pack reconnu.',
    ruleId: 'rule-x',
    ruleVersion: 'v0.1',
    createdAt: '2026-09-01T10:00:00.000Z',
    lastEvaluatedAt: '2026-09-02T10:00:00.000Z',
    ...over,
  } as Situation
}

function recommendation(over: Partial<Recommendation> & { id: string; situationId: string }): Recommendation {
  return {
    control: 'autonomous',
    controlReason: 'capacités accordées',
    requiredMotions: ['prepare_outreach'],
    contextId: 'test-sales',
    contextVersion: 'v0.1',
    accountId: ACCOUNT,
    decision: 'recommend',
    reason: 'Interprétation domaine : fenêtre pertinente.',
    whyNow: 'Ré-évaluation récente.',
    priority: 'medium',
    confidence: 0.7,
    play: 'engage_or_reengage',
    recommendedAction: 'Approche suggérée.',
    ruleId: 'rec-rule',
    ruleVersion: 'v0.1',
    createdAt: '2026-09-02T10:00:00.000Z',
    ...over,
  } as Recommendation
}

async function seedMonitorAndRun(input: {
  ws: string
  accountRef: string
  runId: string
  materialRefs: readonly string[]
  assessment?: MonitoringRunResultV0['businessAssessment']
  finishedAt?: string
}): Promise<string> {
  const created = await createAccountMonitor({
    workspaceId: input.ws,
    accountRef: input.accountRef,
    lensId: 'sales-default' as any,
    cadencePolicy: { kind: 'MIN_INTERVAL', minIntervalHours: 24 },
    createdByActorId: 'tester',
    nowMs: Date.parse('2026-09-01T00:00:00.000Z'),
  })
  if (created.ok !== true) throw new Error('monitor seed failed')
  const run: MonitoringRunResultV0 = {
    schemaVersion: MONITORING_RUN_SCHEMA_VERSION,
    runId: input.runId,
    monitorId: created.monitor.id,
    workspaceId: input.ws,
    startedAt: '2026-09-02T07:00:00.000Z',
    finishedAt: input.finishedAt ?? '2026-09-02T08:00:00.000Z',
    executionState: 'SUCCEEDED',
    coverageState: 'COMPLETE_FOR_CONFIGURED_PRODUCERS',
    businessAssessment: input.assessment ?? 'MATERIAL_CHANGE_FOUND',
    producersConfigured: 1,
    producersSucceeded: 1,
    producersFailed: 0,
    canonicalRefsEvaluated: [...input.materialRefs],
    canonicalRefsMaterial: [...input.materialRefs],
    canonicalRefsSkippedAlreadyEvaluated: [],
    policyVersions: { lensVersion: 'v0.1' },
  }
  expect(await persistRunResult(run)).toBe(true)
  return created.monitor.id
}

async function seedCanonicalEvent(ws: string, accountId: string, day: string): Promise<string> {
  const id = canonicalEventId(ws, accountId, day)
  const ev: CanonicalEvent = {
    id, workspaceId: ws, type: 'FUNDING_ROUND', accountId,
    occurredAt: day, occurredAtPrecision: 'DAY',
    canonicalClaimKey: `FUNDING_ROUND|${accountId}|${day}`,
  }
  const ecrit = await saveCanonicalEvent(ev, ws)
  expect(ecrit.ok).toBe(true)
  return id
}

beforeEach(() => {
  const g = globalThis as any
  if (g.__prospectorStore) g.__prospectorStore.clear()
})

describe('PFV0-2A §31 — Today, voie Situation', () => {
  it('A — évidence qualifiante persistée + Situation ⇒ UN candidat Situation', async () => {
    const e = evidence({ id: 'ev_1' })
    await saveEvidence(e, WS)
    await saveSituation(situation({ id: 'sit_1', evidenceIds: ['ev_1'] }), WS)
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    expect(r.ok).toBe(true)
    if (r.ok !== true) return
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].kind).toBe('NEW_OR_UPDATED_SITUATION')
    expect(r.candidates[0].changeRef).toBe('ev_1')
    expect(r.candidates[0].organizationRef).toBe(ACCOUNT)
  })

  it('B — Situation sans changement source dans la fenêtre ⇒ zéro candidat', async () => {
    await saveEvidence(evidence({ id: 'ev_old', occurredAt: '2025-01-01T00:00:00.000Z' } as any), WS)
    await saveSituation(situation({ id: 'sit_1', evidenceIds: ['ev_old'] }), WS)
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    expect(r.ok && r.candidates).toEqual([])
  })

  it('C — le rationale de la Situation ne devient JAMAIS whatChanged', async () => {
    await saveEvidence(evidence({ id: 'ev_1' }), WS)
    await saveSituation(situation({ id: 'sit_1', evidenceIds: ['ev_1'] }), WS)
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    expect(r.candidates[0].whatChanged.includes('Interprétation moteur')).toBe(false)
    expect(r.candidates[0].whatChanged).toContain('funding_round')
    expect(r.candidates[0].domainInterpretation).toContain('Interprétation moteur')
    // verrou de source : rationale n'alimente jamais whatChanged
    const src = readFileSync(join(__dirname, '../lib/prospector/product/serverProjection.ts'), 'utf8')
    const code = src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(/whatChanged:\s*(situation|s)\.(rationale|type)/.test(code)).toBe(false)
  })

  it('D — Recommendation seule ⇒ aucun candidat', async () => {
    await saveRecommendation(recommendation({ id: 'rec_1', situationId: 'sit_missing' }), WS)
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    expect(r.ok && r.candidates).toEqual([])
  })

  it('E — Recommendation liée ⇒ enrichit UN candidat (candidatePlay), jamais un second', async () => {
    await saveEvidence(evidence({ id: 'ev_1' }), WS)
    await saveSituation(situation({ id: 'sit_1', evidenceIds: ['ev_1'] }), WS)
    await saveRecommendation(recommendation({ id: 'rec_1', situationId: 'sit_1' }), WS)
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].candidatePlay?.recommendationRef).toBe('rec_1')
    expect(r.candidates[0].whatChanged.includes('Interprétation domaine')).toBe(false)
  })

  it('F — plusieurs changements factuels éligibles pour UNE Situation ⇒ itemRefs distincts', async () => {
    await saveEvidence(evidence({ id: 'ev_1' }), WS)
    await saveEvidence(evidence({ id: 'ev_2', type: 'executive_appointment', value: 'CFO', occurredAt: '2026-08-28T00:00:00.000Z' } as any), WS)
    await saveSituation(situation({ id: 'sit_1', evidenceIds: ['ev_1', 'ev_2'] }), WS)
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    expect(r.candidates).toHaveLength(2)
    expect(new Set(r.candidates.map((c) => c.itemRef)).size).toBe(2)
    expect(new Set(r.candidates.map((c) => c.changeRef))).toEqual(new Set(['ev_1', 'ev_2']))
  })

  it('J — un type domaine différent ne change pas la structure générique', async () => {
    await saveEvidence(evidence({ id: 'ev_1' }), WS)
    await saveSituation(situation({ id: 'sit_re', evidenceIds: ['ev_1'], type: 'space_expansion', rulePackId: 'real-estate-fabel', rulePackVersion: 'v0.1' } as any), WS)
    await saveSituation(situation({ id: 'sit_cy', evidenceIds: ['ev_1'], type: 'strong_signal_low_context' } as any), WS)
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    expect(r.candidates).toHaveLength(2)
    expect(Object.keys(r.candidates[0]).sort()).toEqual(Object.keys(r.candidates[1]).sort())
  })
})

describe('PFV0-2A §31 — Today, voie monitoring', () => {
  it('G — MATERIAL_CHANGE_FOUND + fait matériel résoluble ⇒ candidat monitoring factuel', async () => {
    const cev = await seedCanonicalEvent(WS, ACCOUNT, '2026-09-01')
    await seedMonitorAndRun({ ws: WS, accountRef: ACCOUNT, runId: 'run_1', materialRefs: [cev] })
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    expect(r.candidates).toHaveLength(1)
    expect(r.candidates[0].kind).toBe('MONITORING_MATERIAL_CHANGE')
    expect(r.candidates[0].organizationRef).toBe(ACCOUNT)
    expect(r.candidates[0].whatChanged).toBe('FUNDING_ROUND (événement du 2026-09-01)')
    expect(r.candidates[0].whatChanged).not.toBe('MATERIAL_CHANGE_FOUND')
    expect(r.candidates[0].domainAssessment).toBe('MATERIAL_CHANGE_FOUND')
  })

  it('H — MATERIAL_CHANGE_FOUND mais aucun fait résoluble ⇒ candidat OMIS', async () => {
    await seedMonitorAndRun({ ws: WS, accountRef: ACCOUNT, runId: 'run_1', materialRefs: ['cev_inconnu'] })
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    expect(r.ok && r.candidates).toEqual([])
  })

  it('I — verdicts non matériels ⇒ omis', async () => {
    const cev = await seedCanonicalEvent(WS, ACCOUNT, '2026-09-01')
    await seedMonitorAndRun({ ws: WS, accountRef: ACCOUNT, runId: 'run_1', materialRefs: [cev], assessment: 'NO_MATERIAL_CHANGE' })
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    expect(r.ok && r.candidates).toEqual([])
  })

  it('I-bis — run matériel HORS fenêtre ⇒ omis (horloge source finishedAt)', async () => {
    const cev = await seedCanonicalEvent(WS, ACCOUNT, '2026-09-01')
    await seedMonitorAndRun({ ws: WS, accountRef: ACCOUNT, runId: 'run_1', materialRefs: [cev], finishedAt: '2026-10-01T08:00:00.000Z' })
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    expect(r.ok && r.candidates).toEqual([])
  })
})

describe('PFV0-2A §32 — Company Workspace', () => {
  async function seedCompany() {
    await saveEvidence(evidence({ id: 'ev_1' }), WS)
    await saveEvidence(evidence({ id: 'ev_other', accountId: AUTRE_ACCOUNT }), WS)
    await saveSituation(situation({ id: 'sit_1', evidenceIds: ['ev_1'] }), WS)
    await saveSituation(situation({ id: 'sit_other', accountId: AUTRE_ACCOUNT, evidenceIds: ['ev_other'] }), WS)
    await saveRecommendation(recommendation({ id: 'rec_1', situationId: 'sit_1' }), WS)
  }

  it('A/B — vue clée par accountId canonique ; les données d’un AUTRE compte sont exclues', async () => {
    await seedCompany()
    const r = await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: ACCOUNT, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    expect(r.view.identity.organizationRef).toBe(ACCOUNT)
    expect(r.view.identity.accountHref).toBe(`/companies/${ACCOUNT}`)
    const texte = JSON.stringify(r.view)
    expect(texte.includes(AUTRE_ACCOUNT)).toBe(false)
    expect(texte.includes('sit_other')).toBe(false)
    expect(texte.includes('ev_other')).toBe(false)
  })

  it('C — les données d’un AUTRE espace sont exclues', async () => {
    await saveEvidence(evidence({ id: 'ev_b' }), AUTRE_WS)
    await saveSituation(situation({ id: 'sit_b', evidenceIds: ['ev_b'] }), AUTRE_WS)
    const today = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    expect(today.ok && today.candidates).toEqual([])
    const vue = await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: ACCOUNT, window: WINDOW })
    if (vue.ok !== true) throw new Error('unexpected')
    expect(JSON.stringify(vue.view).includes('sit_b')).toBe(false)
  })

  it('D/E/F — Situation reste Situation, évidence reste évidence, Recommendation reste Candidate Play', async () => {
    await seedCompany()
    const r = await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: ACCOUNT, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    expect(r.view.currentSituations).toHaveLength(1)
    expect(r.view.currentSituations[0].situationRef).toBe('sit_1')
    expect(r.view.currentSituations[0].situationType).toBe('commercial_momentum_stalled')
    expect(r.view.evidence.map((e) => e.evidenceRef)).toEqual(['ev_1'])
    expect(r.view.recentChanges).toHaveLength(1)
    expect(r.view.recentChanges[0].candidatePlay?.recommendationRef).toBe('rec_1')
    // La Recommendation n'apparaît NI comme situation NI comme évidence.
    expect(r.view.evidence.some((e) => e.evidenceRef === 'rec_1')).toBe(false)
  })

  it('G/H — observedHistory chronologique et adossé aux sources ; aucun champ prédictif', async () => {
    await seedCompany()
    const cev = await seedCanonicalEvent(WS, ACCOUNT, '2026-09-01')
    await seedMonitorAndRun({ ws: WS, accountRef: ACCOUNT, runId: 'run_1', materialRefs: [cev] })
    const r = await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: ACCOUNT, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    expect(r.view.observedHistory.map((h) => h.sourceRef)).toEqual(['run_1', 'sit_1'])
    const horloges = r.view.observedHistory.map((h) => Date.parse(h.observedAt))
    expect([...horloges].sort((a, b) => a - b)).toEqual(horloges)
    expect(Object.keys(r.view)).not.toContain('futureTrajectory')
    expect(r.view.domainAssessments).toEqual([
      { runRef: 'run_1', businessAssessment: 'MATERIAL_CHANGE_FOUND', observedAt: '2026-09-02T08:00:00.000Z' },
    ])
  })

  it('I/J/K — pas de PhysicalSite, pas de HVU, entreprise vide VALIDE', async () => {
    const r = await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: ACCOUNT, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    for (const clef of Object.keys(r.view)) {
      expect(/physicalSite|hvu|highValueUnknown/i.test(clef)).toBe(false)
    }
    expect(r.view.currentSituations).toEqual([])
    expect(r.view.evidence).toEqual([])
    expect(r.view.recentChanges).toEqual([])
    expect(r.view.observedHistory).toEqual([])
  })

  it('identité — accountId invalide ou vide ⇒ INVALID_INPUT (jamais un nom, jamais un lead)', async () => {
    for (const mauvais of ['', '  ', 'nom société\naffiché']) {
      const r = await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: mauvais, window: WINDOW })
      expect(r).toEqual({ ok: false, reason: 'INVALID_INPUT' })
    }
  })
})

describe('PFV0-2A §33 — portabilité et pureté', () => {
  it('portabilité — Fabel-like et cyber : MÊME contrat structurel serveur', async () => {
    await saveEvidence(evidence({ id: 'ev_1' }), WS)
    await saveSituation(situation({ id: 'sit_re', evidenceIds: ['ev_1'], type: 'space_expansion', rulePackId: 'real-estate-fabel', rulePackVersion: 'v0.1' } as any), WS)
    await saveSituation(situation({ id: 'sit_cy', evidenceIds: ['ev_1'], type: 'strong_signal_low_context' } as any), WS)
    const r = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    if (r.ok !== true) throw new Error('unexpected')
    const [a, b] = r.candidates
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
  })

  it('firewall — la projection serveur n’importe ni capabilities.ts ni messaging ni React/Next, et ne branche sur aucune sémantique immobilière', () => {
    const src = readFileSync(join(__dirname, '../lib/prospector/product/serverProjection.ts'), 'utf8')
    const code = src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    for (const interdit of ['capabilities', "from 'react'", 'next/', "'../messaging", 'callClaude', 'Unipile', 'LEADS', 'icebreaker', 'Dossier']) {
      expect(code.includes(interdit), interdit).toBe(false)
    }
    expect(/office_move|immobili|square|lease|OFFICE_MOVE/i.test(code)).toBe(false)
    expect(/Date\.now|Math\.random/.test(code)).toBe(false)
  })

  it('fenêtre — invalide ⇒ INVALID_INPUT ; aucune fenêtre par défaut codée en dur', async () => {
    const inversee = { since: WINDOW.until, until: WINDOW.since }
    expect(await buildTodayProjectionV0({ workspaceId: WS, window: inversee })).toEqual({ ok: false, reason: 'INVALID_INPUT' })
    expect(await buildTodayProjectionV0({ workspaceId: '', window: WINDOW })).toEqual({ ok: false, reason: 'INVALID_INPUT' })
    const src = readFileSync(join(__dirname, '../lib/prospector/product/serverProjection.ts'), 'utf8')
    expect(/24\s*\*\s*60|SEVEN_DAYS|DEFAULT_WINDOW/i.test(src)).toBe(false)
  })
})

// ── PFV0-2A.1 — DISPONIBILITÉ STRICTE : VIDE ≠ SOURCE INDISPONIBLE ──────────
describe('PFV0-2A.1 — échec de source ⇒ SOURCE_UNAVAILABLE, jamais une fausse absence', () => {
  async function failTransportFor(kind: string) {
    const actual = await vi.importActual<typeof storeModule>('../lib/supabase/store')
    vi.mocked(storeModule.listItemsStrict).mockImplementation(async (k: any, ws: any) =>
      k === kind ? ({ ok: false } as any) : actual.listItemsStrict(k, ws))
  }

  afterEach(() => {
    // mockReset rétablit l'implémentation d'origine passée à vi.fn (vitest 3).
    vi.mocked(storeModule.listItemsStrict).mockReset()
  })

  async function seedNominal() {
    await saveEvidence(evidence({ id: 'ev_1' }), WS)
    await saveSituation(situation({ id: 'sit_1', evidenceIds: ['ev_1'] }), WS)
    await saveRecommendation(recommendation({ id: 'rec_1', situationId: 'sit_1' }), WS)
  }

  it('A — panne de transport Situations ⇒ Today SOURCE_UNAVAILABLE (jamais ok sans candidats)', async () => {
    await seedNominal()
    await failTransportFor(PROACTIVE_KINDS.situation)
    expect(await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW }))
      .toEqual({ ok: false, reason: 'SOURCE_UNAVAILABLE' })
  })

  it('B — ligne Situation MALFORMÉE persistée ⇒ Today SOURCE_UNAVAILABLE (jamais écartée en silence)', async () => {
    await seedNominal()
    const actual = await vi.importActual<typeof storeModule>('../lib/supabase/store')
    expect(await actual.upsertItem(PROACTIVE_KINDS.situation, 'sit_corrompue', { id: 'sit_corrompue' }, WS)).toBe(true)
    expect(await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW }))
      .toEqual({ ok: false, reason: 'SOURCE_UNAVAILABLE' })
  })

  it('C — panne de transport Recommendations ⇒ Today SOURCE_UNAVAILABLE (jamais un candidat sans son interprétation)', async () => {
    await seedNominal()
    await failTransportFor(PROACTIVE_KINDS.recommendation)
    expect(await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW }))
      .toEqual({ ok: false, reason: 'SOURCE_UNAVAILABLE' })
  })

  it('D — ligne Recommendation MALFORMÉE ⇒ Today SOURCE_UNAVAILABLE', async () => {
    await seedNominal()
    const actual = await vi.importActual<typeof storeModule>('../lib/supabase/store')
    expect(await actual.upsertItem(PROACTIVE_KINDS.recommendation, 'rec_corrompue', { id: 'rec_corrompue' }, WS)).toBe(true)
    expect(await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW }))
      .toEqual({ ok: false, reason: 'SOURCE_UNAVAILABLE' })
  })

  it('E — panne Situations ⇒ Company Workspace SOURCE_UNAVAILABLE (jamais currentSituations: [])', async () => {
    await seedNominal()
    await failTransportFor(PROACTIVE_KINDS.situation)
    expect(await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: ACCOUNT, window: WINDOW }))
      .toEqual({ ok: false, reason: 'SOURCE_UNAVAILABLE' })
  })

  it('F — panne Recommendations ⇒ Company Workspace SOURCE_UNAVAILABLE', async () => {
    await seedNominal()
    await failTransportFor(PROACTIVE_KINDS.recommendation)
    expect(await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: ACCOUNT, window: WINDOW }))
      .toEqual({ ok: false, reason: 'SOURCE_UNAVAILABLE' })
  })

  it('G — collection réellement VIDE reste VALIDE (ok:true, sections vides)', async () => {
    const today = await buildTodayProjectionV0({ workspaceId: WS, window: WINDOW })
    expect(today).toEqual({ ok: true, candidates: [] })
    const vue = await buildCompanyWorkspaceProjectionV0({ workspaceId: WS, accountId: ACCOUNT, window: WINDOW })
    if (vue.ok !== true) throw new Error('unexpected')
    expect(vue.view.currentSituations).toEqual([])
  })
})
