// JS-013_ACCOUNT_MONITORING_MISSION_V0_001 — MONITORING DE COMPTE V0.
//
// Verrouille : la matrice rôle×action monitoring, le refus non-mutant, la
// cadence dérivée, les trois dimensions de résultat, la table de vérité de
// deriveBusinessAssessment (readiness incluse), les reçus PAR MONITEUR (dédup
// canonique ≠ consommation), le silence sans vérité synthétique, et les
// firewalls (signals.ts, vérité métier, provenance ≠ autorité).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etat = vi.hoisted(() => ({
  session: { tenant: { id: 'ws_a', kind: 'client' }, actorId: 'karine@a.fr' } as any,
  store: new Map<string, any>(),
  persisted: [] as Array<{ op: string; kind: string; id: string; ws: string; data?: any }>,
  workspacePolicy: { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } } as any,
  runtime: { producers: [] as any[], evaluator: null as any },
  // Injection de pannes du magasin (R1, Fix 3) : prédicats par (kind, id).
  failList: false,
  failGet: null as null | ((kind: string, id: string) => boolean),
  failUpsert: null as null | ((kind: string, id: string) => boolean),
  failInsert: null as null | ((kind: string, id: string) => boolean),
}))

const cle = (kind: string, ws: string, id: string) => `${kind}|${ws}|${id}`

vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveTenantFromRequest: async () => etat.session?.tenant ?? null,
  resolveActorFromRequest: async () => etat.session,
}))

vi.mock('../lib/supabase/workspaces', () => ({
  getWorkspacePermissionsStrict: async () => etat.workspacePolicy,
}))

vi.mock('../lib/supabase/store', () => ({
  listItems: async (kind: string, ws: string) =>
    [...etat.store.entries()].filter(([k]) => k.startsWith(`${kind}|${ws}|`)).map(([, v]) => v),
  getItemStrict: async (kind: string, id: string, ws: string) =>
    etat.failGet?.(kind, id)
      ? { ok: false }
      : { ok: true, value: etat.store.get(cle(kind, ws, id)) ?? null },
  upsertItem: async (kind: string, id: string, data: any, ws: string) => {
    if (etat.failUpsert?.(kind, id)) return false
    etat.store.set(cle(kind, ws, id), data)
    etat.persisted.push({ op: 'upsert', kind, id, ws, data })
    return true
  },
  deleteItem: async (kind: string, id: string, ws: string) => {
    etat.persisted.push({ op: 'delete', kind, id, ws })
    return etat.store.delete(cle(kind, ws, id))
  },
  insertItemIfAbsent: async (kind: string, id: string, data: any, ws: string) => {
    if (etat.failInsert?.(kind, id)) return false
    const k = cle(kind, ws, id)
    if (etat.store.has(k)) return false
    etat.store.set(k, data)
    etat.persisted.push({ op: 'insert', kind, id, ws, data })
    return true
  },
  claimItemIfField: async (kind: string, id: string, ws: string, field: string, expected: string) => {
    const k = cle(kind, ws, id)
    const v = etat.store.get(k)
    if (!v || v?.[field] !== expected) return null
    etat.store.delete(k)
    etat.persisted.push({ op: 'claim', kind, id, ws })
    return v
  },
  listItemsStrict: async (kind: string, ws: string) =>
    etat.failList
      ? { ok: false }
      : { ok: true, values: [...etat.store.entries()].filter(([k]) => k.startsWith(`${kind}|${ws}|`)).map(([, v]) => v) },
}))

// Le runtime par défaut de la route est REMPLACÉ par le runtime injecté du
// test — le module réel garde son défaut vide (aucun producteur en V0).
vi.mock('../lib/prospector/monitoring/monitoringRun', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/monitoring/monitoringRun')>()),
  defaultMonitoringRuntime: () => etat.runtime,
}))

import monitoringHandler from '../pages/api/monitoring/index'
import monitoringRunHandler from '../pages/api/monitoring/run'
import {
  cadenceEligibility,
  currentAdapterSupports,
  deriveBusinessAssessment,
  evaluationInputFingerprint,
  isValidOpaqueAccountRef,
  monitorIdFor,
  validateAccountMonitorInput,
} from '../lib/prospector/monitoring/accountMonitor'
import { executeMonitoringRun } from '../lib/prospector/monitoring/monitoringRun'
import {
  ACCOUNT_MONITOR_KIND,
  MONITORING_CLAIM_KIND,
  MONITORING_RUN_KIND,
  MONITOR_EVAL_RECEIPT_KIND,
  createAccountMonitor,
} from '../lib/prospector/monitoring/monitoringStore'
import { ACTION_REFS, evaluatePermission, isActionRef, ROLE_ACTION_POLICY } from '../lib/prospector/authz/permissionVerdict'
import { canonicalExecutiveEventId } from '../lib/prospector/proactive/canonicalFact'

async function appeler(handler: any, method: string, body?: any, query: any = {}) {
  const req: any = { method, body, query, cookies: {} }
  let status = 0
  let json: any = null
  const res: any = {
    status(c: number) { status = c; return res },
    json(b: any) { json = b; return res },
  }
  await handler(req, res)
  return { status, body: json }
}

const ROLE_DOC = (assignments: Record<string, string>) => ({
  schemaVersion: 'role-assignment-v0.1', revisionId: 'r-test',
  updatedAt: '2026-09-06T00:00:00.000Z', assignments,
})
const assigner = (assignments: Record<string, string>, ws = 'ws_a') =>
  etat.store.set(cle('workspace_role_assignment', ws, 'active'), ROLE_DOC(assignments))

const SIREN_REF = 'acc_siren_552100554'
const ASSIGNED = (roleKind: any) => ({ state: 'ASSIGNED', roleKind }) as any

const producteurOk = (observations: any[], over: Partial<any> = {}) => ({
  producerId: 'controlled-test-v0',
  requiresExternalAI: false,
  supports: (ref: string) => currentAdapterSupports(ref),
  produce: async ({ accountRef }: any) => ({ ok: true, accountRef, observations }),
  ...over,
})
const evaluateurFixe = (resultat: any, version = 'v1') => ({
  policyRef: { policyId: 'controlled-materiality', policyVersion: version },
  evaluate: () => resultat,
})
const evaluateurParRef = (table: Record<string, any>, version = 'v1') => ({
  policyRef: { policyId: 'controlled-materiality', policyVersion: version },
  evaluate: ({ canonicalRef }: any) => table[canonicalRef] ?? 'NOT_MATERIAL',
})

async function creerMoniteur(over: Partial<{ accountRef: string; lensId: any; minIntervalHours: number }> = {}) {
  const r = await createAccountMonitor({
    workspaceId: 'ws_a',
    accountRef: over.accountRef ?? SIREN_REF,
    lensId: over.lensId ?? 'sales-default',
    cadencePolicy: { kind: 'MIN_INTERVAL', minIntervalHours: over.minIntervalHours ?? 1 },
    createdByActorId: 'karine@a.fr',
    nowMs: Date.now(),
  })
  if (r.ok === false) throw new Error('fixture: create failed')
  return r.monitor
}

const moniteurEnBase = (id: string) => etat.store.get(cle(ACCOUNT_MONITOR_KIND, 'ws_a', id))
const runsEnBase = () => [...etat.store.entries()].filter(([k]) => k.startsWith(`${MONITORING_RUN_KIND}|`)).map(([, v]) => v)
const recusEnBase = () => [...etat.store.entries()].filter(([k]) => k.startsWith(`${MONITOR_EVAL_RECEIPT_KIND}|`)).map(([, v]) => v)

beforeEach(() => {
  etat.session = { tenant: { id: 'ws_a', kind: 'client' }, actorId: 'karine@a.fr' }
  etat.store.clear()
  etat.persisted = []
  etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } }
  etat.runtime = { producers: [], evaluator: null }
  etat.failList = false
  etat.failGet = null
  etat.failUpsert = null
  etat.failInsert = null
  assigner({ 'karine@a.fr': 'ACCOUNT_MANAGER_KAM' })
})

// ═══ MATRICE RÔLES (A, C, D, E, AI–AL, AW) ══════════════════════════════════

describe('matrice rôle × action monitoring', () => {
  const ACTIONS = ['monitoring:read', 'monitoring:create', 'monitoring:stop', 'monitoring:run'] as const

  it('AI/AJ/AK — AE, AM/KAM et Head of Sales détiennent les QUATRE actions', () => {
    for (const roleKind of ['ACCOUNT_EXECUTIVE', 'ACCOUNT_MANAGER_KAM', 'HEAD_OF_SALES'] as const) {
      for (const action of ACTIONS) {
        expect(evaluatePermission({ role: ASSIGNED(roleKind), action }).state, `${roleKind}/${action}`).toBe('ALLOWED')
      }
    }
  })

  it('AL — SDR_BDR est refusé sur CHAQUE action AccountMonitor (CAPABILITY_FORBIDDEN)', () => {
    for (const action of ACTIONS) {
      const v = evaluatePermission({ role: ASSIGNED('SDR_BDR'), action })
      expect(v.state).toBe('BLOCKED')
      expect((v as any).reason).toBe('CAPABILITY_FORBIDDEN')
    }
    expect(ROLE_ACTION_POLICY.SDR_BDR.some((a) => a.startsWith('monitoring:'))).toBe(false)
  })

  it('AW — action monitoring inconnue et paire inconnue échouent fermé', () => {
    const v = evaluatePermission({ role: ASSIGNED('ACCOUNT_MANAGER_KAM'), action: 'monitoring:restart' })
    expect(v.state).toBe('BLOCKED')
    expect((v as any).reason).toBe('CAPABILITY_FORBIDDEN')
    // Le REGISTRE lui-même est fermé : une action monitoring inconnue n'est
    // pas une ActionRef — la table de rôles n'est pas la seule défense.
    expect(isActionRef('monitoring:restart')).toBe(false)
    expect(isActionRef('monitoring:resume')).toBe(false)
    expect(ACTION_REFS.filter((a) => a.startsWith('monitoring:'))).toEqual(
      ['monitoring:read', 'monitoring:create', 'monitoring:stop', 'monitoring:run'])
  })

  it('A — matrice via routes : KAM crée/lit/arrête ; création rendue par le serveur', async () => {
    const post = await appeler(monitoringHandler, 'POST', {
      accountRef: SIREN_REF, lensId: 'sales-default',
      cadencePolicy: { kind: 'MIN_INTERVAL', minIntervalHours: 24 },
    })
    expect(post.status).toBe(200)
    expect(post.body.monitor.status).toBe('ACTIVE')
    expect(post.body.monitor.desiredOutcome).toBe('SURFACE_MATERIAL_CHANGE')
    const get = await appeler(monitoringHandler, 'GET')
    expect(get.status).toBe(200)
    expect(get.body.monitors).toHaveLength(1)
    const stop = await appeler(monitoringHandler, 'PATCH', { monitorId: post.body.monitor.id, action: 'stop' })
    expect(stop.status).toBe(200)
    expect(stop.body.monitor.status).toBe('STOPPED')
  })

  it('B/AM — SDR refusé : ZÉRO mutation (ni moniteur, ni run, ni claim, ni reçu)', async () => {
    assigner({ 'karine@a.fr': 'SDR_BDR' })
    etat.persisted = []
    for (const [method, body] of [
      ['POST', { accountRef: SIREN_REF, lensId: 'sales-default', cadencePolicy: { kind: 'MIN_INTERVAL', minIntervalHours: 24 } }],
      ['GET', undefined],
      ['PATCH', { monitorId: 'mon_x', action: 'stop' }],
    ] as const) {
      const r = await appeler(monitoringHandler, method, body)
      expect(r.status).toBe(403)
      expect(r.body.reason).toBe('CAPABILITY_FORBIDDEN')
    }
    const run = await appeler(monitoringRunHandler, 'POST', { monitorId: 'mon_x' })
    expect(run.status).toBe(403)
    expect(etat.persisted).toEqual([])
  })

  it('F — rôle révoqué APRÈS création : run refusé, moniteur STRICTEMENT inchangé', async () => {
    const m = await creerMoniteur()
    const avant = JSON.parse(JSON.stringify(moniteurEnBase(m.id)))
    assigner({ 'karine@a.fr': 'SDR_BDR' }) // révocation de capacité
    etat.persisted = []
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('CAPABILITY_FORBIDDEN')
    expect(etat.persisted).toEqual([])
    expect(moniteurEnBase(m.id)).toEqual(avant)
    expect(runsEnBase()).toHaveLength(0)
    expect(recusEnBase()).toHaveLength(0)
  })

  it('AV — createdByActorId n’est JAMAIS une autorité : autre acteur non affecté refusé', async () => {
    const m = await creerMoniteur() // créé par karine (provenance)
    etat.session = { tenant: { id: 'ws_a', kind: 'client' }, actorId: 'inconnu@a.fr' }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(403)
    expect(r.body.state).toBe('SALES_ROLE_UNASSIGNED')
    // Et structurellement : la route ne lit jamais createdByActorId comme autorité.
    const fs = require('node:fs'); const path = require('node:path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'api', 'monitoring', 'run.ts'), 'utf8')
    expect(src.includes('createdByActorId')).toBe(false)
  })
})

// ═══ CONTRAT / IDENTITÉ LOGIQUE (Y, Z, U, V, S, T) ══════════════════════════

describe('contrat AccountMonitor et identité logique', () => {
  it('Y — accountRef OPAQUE accepté au contrat (aucune sémantique SIREN)', () => {
    expect(isValidOpaqueAccountRef('acc_uk_companieshouse_0123')).toBe(true)
    expect(isValidOpaqueAccountRef(SIREN_REF)).toBe(true)
    expect(isValidOpaqueAccountRef('')).toBe(false)
    expect(isValidOpaqueAccountRef('a\nb')).toBe(false)
    expect(isValidOpaqueAccountRef(' pad ')).toBe(false)
    expect(validateAccountMonitorInput({
      accountRef: 'acc_uk_companieshouse_0123', lensId: 'sales-default',
      cadencePolicy: { kind: 'MIN_INTERVAL', minIntervalHours: 24 },
    }).ok).toBe(true)
  })

  it('Z — l’adaptateur courant est SIREN-only : non supporté ⇒ TARGET_UNSUPPORTED_V0, zéro coercition', async () => {
    expect(currentAdapterSupports('acc_uk_companieshouse_0123')).toBe(false)
    expect(currentAdapterSupports(SIREN_REF)).toBe(true)
    const m = await creerMoniteur({ accountRef: 'acc_uk_companieshouse_0123' })
    etat.runtime = { producers: [producteurOk([])], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(200)
    expect(r.body.run.executionState).toBe('BLOCKED')
    expect(r.body.run.blockedReason).toBe('TARGET_UNSUPPORTED_V0')
    expect(r.body.run.businessAssessment).toBe('NOT_EVALUATED')
  })

  it('U — doublon logique ACTIVE : id dérivé + create-only ⇒ rejet déterministe 409', async () => {
    await creerMoniteur()
    const r = await appeler(monitoringHandler, 'POST', {
      accountRef: SIREN_REF, lensId: 'sales-default',
      cadencePolicy: { kind: 'MIN_INTERVAL', minIntervalHours: 4 },
    })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('monitor_already_exists')
    expect(r.body.monitorId).toBe(monitorIdFor('ws_a', SIREN_REF, 'sales-default'))
  })

  it('V — même compte, lens distinctes ⇒ deux moniteurs licites', async () => {
    await creerMoniteur({ lensId: 'sales-default' })
    const r = await appeler(monitoringHandler, 'POST', {
      accountRef: SIREN_REF, lensId: 'fabel-broker',
      cadencePolicy: { kind: 'MIN_INTERVAL', minIntervalHours: 24 },
    })
    expect(r.status).toBe(200)
    expect(monitorIdFor('ws_a', SIREN_REF, 'sales-default'))
      .not.toBe(monitorIdFor('ws_a', SIREN_REF, 'fabel-broker'))
  })

  it('S — stop explicite ⇒ STOPPED terminal ; run sur STOPPED ⇒ 409', async () => {
    const m = await creerMoniteur()
    const stop = await appeler(monitoringHandler, 'PATCH', { monitorId: m.id, action: 'stop' })
    expect(stop.status).toBe(200)
    expect(stop.body.monitor.stoppedByActorId).toBe('karine@a.fr')
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('monitor_not_active')
    const restop = await appeler(monitoringHandler, 'PATCH', { monitorId: m.id, action: 'stop' })
    expect(restop.status).toBe(409)
  })

  it('T — blocage temporaire (source/cible/évaluateur) : le moniteur RESTE ACTIVE', async () => {
    const m = await creerMoniteur()
    etat.runtime = {
      producers: [producteurOk([], { produce: async () => ({ ok: false, reason: 'SOURCE_UNAVAILABLE' }) })],
      evaluator: evaluateurFixe('NOT_MATERIAL'),
    }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(200)
    expect(['FAILED', 'BLOCKED']).toContain(r.body.run.executionState)
    expect(moniteurEnBase(m.id).status).toBe('ACTIVE')
  })
})

// ═══ CADENCE (AN, AO, AP, AQ) ═══════════════════════════════════════════════

describe('cadence dérivée — jamais persistée', () => {
  it('AN — trop tôt : ZÉRO acquisition, ZÉRO run/claim/reçu, ZÉRO mutation du moniteur', async () => {
    const m = await creerMoniteur({ minIntervalHours: 24 })
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', m.id), { ...moniteurEnBase(m.id), lastAttemptAt: new Date().toISOString() })
    const avant = JSON.parse(JSON.stringify(moniteurEnBase(m.id)))
    let produced = 0
    etat.runtime = {
      producers: [producteurOk([], { produce: async () => { produced++; return { ok: true, accountRef: SIREN_REF, observations: [] } } })],
      evaluator: evaluateurFixe('NOT_MATERIAL'),
    }
    etat.persisted = []
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(200)
    expect(r.body.eligible).toBe(false)
    expect(r.body.reason).toBe('NOT_ELIGIBLE_YET')
    expect(produced).toBe(0)
    expect(etat.persisted).toEqual([])
    expect(moniteurEnBase(m.id)).toEqual(avant)
  })

  it('AO — borne EXACTE de cadence : éligible (now === nextEligibleAt)', () => {
    const last = '2026-09-07T00:00:00.000Z'
    const cadence = { kind: 'MIN_INTERVAL' as const, minIntervalHours: 24 }
    const exact = new Date(Date.parse(last) + 24 * 3600_000)
    expect(cadenceEligibility({ cadencePolicy: cadence, lastAttemptAt: last }, exact).eligible).toBe(true)
    const troTot = new Date(exact.getTime() - 1)
    expect(cadenceEligibility({ cadencePolicy: cadence, lastAttemptAt: last }, troTot).eligible).toBe(false)
    expect(cadenceEligibility({ cadencePolicy: cadence, lastAttemptAt: undefined }, troTot).eligible).toBe(true)
  })

  it('AP — run ADMIS + échec source : lastAttemptAt AVANCE, lastSuccessAt NON', async () => {
    const m = await creerMoniteur()
    etat.runtime = {
      producers: [producteurOk([], { produce: async () => { throw new Error('down') } })],
      evaluator: evaluateurFixe('NOT_MATERIAL'),
    }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(200)
    expect(r.body.run.executionState).toBe('FAILED')
    const apres = moniteurEnBase(m.id)
    expect(apres.lastAttemptAt).toBeDefined()
    expect(apres.lastSuccessAt).toBeUndefined()
  })

  it('AQ — run complet réussi : lastAttemptAt ET lastSuccessAt avancent', async () => {
    const m = await creerMoniteur()
    etat.runtime = { producers: [producteurOk([])], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(200)
    const apres = moniteurEnBase(m.id)
    expect(apres.lastAttemptAt).toBeDefined()
    expect(apres.lastSuccessAt).toBeDefined()
  })
})

// ═══ TABLE DE VÉRITÉ (AC–AH, AR, AY–BA) — CONSTRUCTEUR PUR ══════════════════

describe('deriveBusinessAssessment — l’unique constructeur', () => {
  const base = { producersConfigured: 1, producersSucceeded: 1, evaluatorAvailable: true }

  it('AC — SUCCEEDED + COMPLETE + MATERIAL ⇒ MATERIAL_CHANGE_FOUND', () => {
    expect(deriveBusinessAssessment({ ...base, executionState: 'SUCCEEDED', coverageState: 'COMPLETE_FOR_CONFIGURED_PRODUCERS', evaluations: ['NOT_MATERIAL', 'MATERIAL'] })).toBe('MATERIAL_CHANGE_FOUND')
  })
  it('AD — SUCCEEDED + COMPLETE + NEEDS_REVIEW ⇒ NEEDS_REVIEW', () => {
    expect(deriveBusinessAssessment({ ...base, executionState: 'SUCCEEDED', coverageState: 'COMPLETE_FOR_CONFIGURED_PRODUCERS', evaluations: ['NOT_MATERIAL', 'NEEDS_REVIEW'] })).toBe('NEEDS_REVIEW')
  })
  it('AE — SUCCEEDED + COMPLETE + tout NOT_MATERIAL ⇒ NO_MATERIAL_CHANGE', () => {
    expect(deriveBusinessAssessment({ ...base, executionState: 'SUCCEEDED', coverageState: 'COMPLETE_FOR_CONFIGURED_PRODUCERS', evaluations: ['NOT_MATERIAL', 'NOT_MATERIAL'] })).toBe('NO_MATERIAL_CHANGE')
  })
  it('AF — PARTIAL + MATERIAL ⇒ MATERIAL_CHANGE_FOUND (la couverture RESTE partielle)', () => {
    expect(deriveBusinessAssessment({ ...base, executionState: 'PARTIAL', coverageState: 'PARTIAL', evaluations: ['MATERIAL'] })).toBe('MATERIAL_CHANGE_FOUND')
  })
  it('H/AG — PARTIAL sans matériel ⇒ JAMAIS NO_MATERIAL_CHANGE', () => {
    expect(deriveBusinessAssessment({ ...base, executionState: 'PARTIAL', coverageState: 'PARTIAL', evaluations: ['NEEDS_REVIEW'] })).toBe('NEEDS_REVIEW')
    expect(deriveBusinessAssessment({ ...base, executionState: 'PARTIAL', coverageState: 'PARTIAL', evaluations: ['NOT_MATERIAL'] })).toBe('NOT_EVALUATED')
    expect(deriveBusinessAssessment({ ...base, executionState: 'PARTIAL', coverageState: 'PARTIAL', evaluations: [] })).toBe('NOT_EVALUATED')
  })
  it('G/AH — FAILED / BLOCKED ⇒ NOT_EVALUATED (« rien trouvé » ≠ « rien changé »)', () => {
    expect(deriveBusinessAssessment({ ...base, executionState: 'FAILED', coverageState: 'NONE', evaluations: [] })).toBe('NOT_EVALUATED')
    expect(deriveBusinessAssessment({ ...base, executionState: 'BLOCKED', coverageState: 'NONE', evaluations: [] })).toBe('NOT_EVALUATED')
  })
  it('AR — observation VIDE mais readiness satisfaite ⇒ NO_MATERIAL_CHANGE', () => {
    expect(deriveBusinessAssessment({ ...base, executionState: 'SUCCEEDED', coverageState: 'COMPLETE_FOR_CONFIGURED_PRODUCERS', evaluations: [] })).toBe('NO_MATERIAL_CHANGE')
  })
  it('AY — ZÉRO producteur configuré ⇒ NOT_EVALUATED, JAMAIS le silence', () => {
    expect(deriveBusinessAssessment({ executionState: 'SUCCEEDED', coverageState: 'COMPLETE_FOR_CONFIGURED_PRODUCERS', evaluations: [], producersConfigured: 0, producersSucceeded: 0, evaluatorAvailable: true })).toBe('NOT_EVALUATED')
  })
  it('AZ — producteurs configurés mais AUCUNE exécution réussie ⇒ NOT_EVALUATED', () => {
    expect(deriveBusinessAssessment({ executionState: 'SUCCEEDED', coverageState: 'COMPLETE_FOR_CONFIGURED_PRODUCERS', evaluations: [], producersConfigured: 2, producersSucceeded: 0, evaluatorAvailable: true })).toBe('NOT_EVALUATED')
  })
  it('BA — évaluateur indisponible ⇒ JAMAIS NO_MATERIAL_CHANGE', () => {
    expect(deriveBusinessAssessment({ executionState: 'SUCCEEDED', coverageState: 'COMPLETE_FOR_CONFIGURED_PRODUCERS', evaluations: [], producersConfigured: 1, producersSucceeded: 1, evaluatorAvailable: false })).toBe('NOT_EVALUATED')
  })
})

// ═══ RUNNER — SILENCE, REÇUS, DÉDUP (I, J, K, L, M, N, O, AB, AS, AT, BB, BC, R) ═

describe('runner — silence honnête et consommation PAR MONITEUR', () => {
  it('I/BB/BC — run complet, zéro changement : NO_MATERIAL_CHANGE, télémétrie SEULE, aucune vérité synthétique', async () => {
    const m = await creerMoniteur()
    etat.runtime = { producers: [producteurOk([])], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(200)
    expect(r.body.run.businessAssessment).toBe('NO_MATERIAL_CHANGE')
    expect(r.body.run.executionState).toBe('SUCCEEDED')
    expect(r.body.run.coverageState).toBe('COMPLETE_FOR_CONFIGURED_PRODUCERS')
    // AT/BC — aucun objet de vérité métier émis : seuls les kinds opérationnels bougent.
    const kindsEcrits = new Set(etat.persisted.map((p) => p.kind))
    for (const k of kindsEcrits) {
      expect([ACCOUNT_MONITOR_KIND, MONITORING_RUN_KIND, MONITOR_EVAL_RECEIPT_KIND, MONITORING_CLAIM_KIND]).toContain(k)
    }
  })

  it('J/AS — évidence réelle NON matérielle : évaluée, reçue NOT_MATERIAL, silence — et la vérité canonique N’EST PAS supprimée', async () => {
    const m = await creerMoniteur()
    // La « vérité » canonique simulée existe déjà (admise par les chemins canoniques).
    etat.store.set(cle('proactive_canonical_event', 'ws_a', 'cev_1'), { id: 'cev_1' })
    etat.runtime = {
      producers: [producteurOk([{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }])],
      evaluator: evaluateurFixe('NOT_MATERIAL'),
    }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.body.run.businessAssessment).toBe('NO_MATERIAL_CHANGE')
    expect(r.body.run.canonicalRefsEvaluated).toEqual(['cev_1'])
    expect(recusEnBase()).toHaveLength(1)
    expect(recusEnBase()[0].materialityResult).toBe('NOT_MATERIAL')
    // AS — l'objet canonique est intact, jamais supprimé/altéré par le silence.
    expect(etat.store.get(cle('proactive_canonical_event', 'ws_a', 'cev_1'))).toEqual({ id: 'cev_1' })
  })

  it('K — même moniteur + même empreinte ⇒ SKIP (une seule évaluation)', async () => {
    const m = await creerMoniteur()
    const obs = [{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }]
    let evaluations = 0
    const evaluateur = {
      policyRef: { policyId: 'controlled-materiality', policyVersion: 'v1' },
      evaluate: () => { evaluations++; return 'NOT_MATERIAL' as const },
    }
    etat.runtime = { producers: [producteurOk(obs)], evaluator: evaluateur }
    await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    // 2e run : cadence remise à éligible.
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', m.id), { ...moniteurEnBase(m.id), lastAttemptAt: undefined })
    const r2 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(evaluations).toBe(1) // pas de ré-évaluation
    expect(r2.body.run.canonicalRefsSkippedAlreadyEvaluated).toEqual(['cev_1'])
    expect(recusEnBase()).toHaveLength(1)
  })

  it('L — événement canonique EXISTANT jamais évalué par CE moniteur ⇒ évalué (dédup canonique ≠ consommation)', async () => {
    // Le moniteur A a évalué cev_1 ; le moniteur B (autre lens) le rencontre : il ÉVALUE.
    const mA = await creerMoniteur({ lensId: 'sales-default' })
    const mB = await creerMoniteur({ lensId: 'fabel-broker' })
    const obs = [{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }]
    etat.runtime = { producers: [producteurOk(obs)], evaluator: evaluateurFixe('NOT_MATERIAL') }
    await appeler(monitoringRunHandler, 'POST', { monitorId: mA.id })
    const rB = await appeler(monitoringRunHandler, 'POST', { monitorId: mB.id })
    expect(rB.body.run.canonicalRefsEvaluated).toEqual(['cev_1'])
    expect(rB.body.run.canonicalRefsSkippedAlreadyEvaluated).toEqual([])
    expect(recusEnBase()).toHaveLength(2) // un reçu PAR moniteur
  })

  it('M — évidence NOUVELLE/renforcée sur le même événement ⇒ empreinte différente ⇒ ré-évaluation, sans dupliquer la vérité', async () => {
    const m = await creerMoniteur()
    etat.runtime = { producers: [producteurOk([{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }])], evaluator: evaluateurFixe('NOT_MATERIAL') }
    await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', m.id), { ...moniteurEnBase(m.id), lastAttemptAt: undefined })
    // Nouvelle évidence (conflictuelle/renforcée) sur le MÊME canonicalRef.
    etat.runtime = { producers: [producteurOk([{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1', 'ev_2'] }])], evaluator: evaluateurParRef({ cev_1: 'MATERIAL' }) }
    const r2 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r2.body.run.canonicalRefsEvaluated).toEqual(['cev_1'])
    expect(r2.body.run.businessAssessment).toBe('MATERIAL_CHANGE_FOUND')
    expect(recusEnBase()).toHaveLength(2) // deux ÉTATS d'évaluation, une seule vérité canonique
  })

  it('N — version de politique de matérialité changée ⇒ ré-évaluation', async () => {
    const m = await creerMoniteur()
    const obs = [{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }]
    etat.runtime = { producers: [producteurOk(obs)], evaluator: evaluateurFixe('NOT_MATERIAL', 'v1') }
    await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', m.id), { ...moniteurEnBase(m.id), lastAttemptAt: undefined })
    etat.runtime = { producers: [producteurOk(obs)], evaluator: evaluateurFixe('NOT_MATERIAL', 'v2') }
    const r2 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r2.body.run.canonicalRefsEvaluated).toEqual(['cev_1'])
    expect(recusEnBase()).toHaveLength(2)
    // Le fingerprint est bien sensible à la version — preuve directe.
    const f1 = evaluationInputFingerprint({ evidenceRefs: ['ev_1'], materialityPolicyId: 'p', materialityPolicyVersion: 'v1', lensVersion: 'v0.1' })
    const f2 = evaluationInputFingerprint({ evidenceRefs: ['ev_1'], materialityPolicyId: 'p', materialityPolicyVersion: 'v2', lensVersion: 'v0.1' })
    expect(f1).not.toBe(f2)
  })

  it('O/AB — MATERIAL sans Situation : le run ne crée AUCUNE Situation, aucune contradiction', async () => {
    const m = await creerMoniteur()
    etat.runtime = {
      producers: [producteurOk([{ canonicalRef: 'cev_cfo', evidenceRefs: ['ev_1'] }])],
      evaluator: evaluateurFixe('MATERIAL'),
    }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.body.run.businessAssessment).toBe('MATERIAL_CHANGE_FOUND')
    expect(r.body.run.canonicalRefsMaterial).toEqual(['cev_cfo'])
    // AUCUN kind de Situation/Signal écrit par le monitoring.
    expect(etat.persisted.every((p) => !/situation|signal/i.test(p.kind))).toBe(true)
    expect(moniteurEnBase(m.id).lastMaterialChangeAt).toBeDefined()
  })

  it('R — claim : deux runs concurrents pour le MÊME moniteur ⇒ un seul traite', async () => {
    const m = await creerMoniteur()
    let started = 0
    const lent = producteurOk([], {
      produce: async () => { started++; await new Promise((r) => setTimeout(r, 30)); return { ok: true, accountRef: SIREN_REF, observations: [] } },
    })
    etat.runtime = { producers: [lent], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const monitor = moniteurEnBase(m.id)
    const [a, b] = await Promise.all([
      executeMonitoringRun(monitor, etat.runtime as any, Date.now()),
      executeMonitoringRun(monitor, etat.runtime as any, Date.now()),
    ])
    const outcomes = [a, b]
    expect(outcomes.filter((o) => o.ok === true)).toHaveLength(1)
    expect(outcomes.filter((o) => o.ok === false && o.reason === 'CLAIM_HELD')).toHaveLength(1)
    expect(started).toBe(1)
  })
})

// ═══ LECTURE, FIREWALLS STRUCTURELS (Q, AU, X, AX, P, W, C) ═════════════════

describe('READ ≠ RUN et firewalls structurels', () => {
  it('Q/AU — GET /monitoring : aucun producteur, aucune évaluation, aucune mutation', async () => {
    const m = await creerMoniteur()
    let produced = 0; let evaluated = 0
    etat.runtime = {
      producers: [producteurOk([], { produce: async () => { produced++; return { ok: true, accountRef: SIREN_REF, observations: [] } } })],
      evaluator: { policyRef: { policyId: 'p', policyVersion: 'v1' }, evaluate: () => { evaluated++; return 'NOT_MATERIAL' as const } },
    }
    const avant = JSON.parse(JSON.stringify(moniteurEnBase(m.id)))
    etat.persisted = []
    const r = await appeler(monitoringHandler, 'GET')
    expect(r.status).toBe(200)
    expect(produced).toBe(0)
    expect(evaluated).toBe(0)
    expect(etat.persisted).toEqual([])
    expect(moniteurEnBase(m.id)).toEqual(avant)
  })

  it('X — signals.ts (découverte large) n’est PAS un producteur de monitoring : verrou structurel', () => {
    const fs = require('node:fs'); const path = require('node:path')
    for (const f of ['monitoringRun.ts', 'monitoringStore.ts', 'accountMonitor.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'prospector', 'monitoring', f), 'utf8')
      expect(src.includes("from '../signals'"), f).toBe(false)
      expect(src.includes('searchSignals'), f).toBe(false)
      expect(src.includes('thesis'), f).toBe(false)
    }
    const run = fs.readFileSync(path.join(__dirname, '..', 'pages', 'api', 'monitoring', 'run.ts'), 'utf8')
    expect(run.includes('signals')).toBe(false)
  })

  it('AX — les kinds opérationnels du monitoring n’entrent PAS dans la vérité métier (structurel)', () => {
    const fs = require('node:fs'); const path = require('node:path')
    const base = path.join(__dirname, '..', 'lib', 'prospector', 'proactive')
    for (const f of ['situationEngine.ts', 'decisionKernel.ts', 'recommendationEngine.ts', 'signalBridge.ts', 'persistence.ts']) {
      const src = fs.readFileSync(path.join(base, f), 'utf8')
      for (const kind of ['account_monitor', 'monitoring_run', 'monitor_eval_receipt', 'monitoring_claim']) {
        expect(src.includes(kind), `${f} lit ${kind}`).toBe(false)
      }
    }
    // Et le magasin générique ne les expose pas.
    const store = fs.readFileSync(path.join(__dirname, '..', 'pages', 'api', 'store', 'index.ts'), 'utf8')
    expect(store.includes('account_monitor')).toBe(false)
    expect(store.includes('monitoring_run')).toBe(false)
  })

  it('P/W — temporel et identité canonique : occurredAt intact, familles sans collision + fusion FUNDING documentée', () => {
    // P — le runner ne touche jamais occurredAt : structurel.
    const fs = require('node:fs'); const path = require('node:path')
    const run = fs.readFileSync(path.join(__dirname, '..', 'lib', 'prospector', 'monitoring', 'monitoringRun.ts'), 'utf8')
    expect(run.includes('occurredAt')).toBe(false)
    // W — deux nominations distinctes le même jour ⇒ ids DISTINCTS (personne/fonction dans l'identité).
    const a = canonicalExecutiveEventId('ws_a', 'EXECUTIVE_APPOINTMENT', SIREN_REF, 'FINANCE', 'name:jean@' + SIREN_REF, '2026-09-01')
    const b = canonicalExecutiveEventId('ws_a', 'EXECUTIVE_APPOINTMENT', SIREN_REF, 'FINANCE', 'name:paul@' + SIREN_REF, '2026-09-01')
    expect(a).not.toBe(b)
  })

  it('C — Head of Sales : les quatre actions passent aussi par les routes', async () => {
    assigner({ 'karine@a.fr': 'HEAD_OF_SALES' })
    const post = await appeler(monitoringHandler, 'POST', {
      accountRef: SIREN_REF, lensId: 'sales-default',
      cadencePolicy: { kind: 'MIN_INTERVAL', minIntervalHours: 24 },
    })
    expect(post.status).toBe(200)
    etat.runtime = { producers: [producteurOk([])], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const run = await appeler(monitoringRunHandler, 'POST', { monitorId: post.body.monitor.id })
    expect(run.status).toBe(200)
    const stop = await appeler(monitoringHandler, 'PATCH', { monitorId: post.body.monitor.id, action: 'stop' })
    expect(stop.status).toBe(200)
  })

  it('D/E — AE et AM/KAM exécutent un run', async () => {
    for (const roleKind of ['ACCOUNT_EXECUTIVE', 'ACCOUNT_MANAGER_KAM']) {
      etat.store.clear(); etat.persisted = []
      assigner({ 'karine@a.fr': roleKind })
      const m = await creerMoniteur()
      etat.runtime = { producers: [producteurOk([])], evaluator: evaluateurFixe('NOT_MATERIAL') }
      const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
      expect(r.status, roleKind).toBe(200)
      expect(r.body.run.businessAssessment).toBe('NO_MATERIAL_CHANGE')
    }
  })

  it('AA — l’évaluateur de matérialité est injectable et PUR (aucun appel sans injection)', async () => {
    const m = await creerMoniteur()
    // Runtime par défaut du module RÉEL : zéro producteur, zéro évaluateur.
    const reel = await vi.importActual<typeof import('../lib/prospector/monitoring/monitoringRun')>('../lib/prospector/monitoring/monitoringRun')
    const defaut = reel.defaultMonitoringRuntime()
    expect(defaut.producers).toHaveLength(0)
    expect(defaut.evaluator).toBeNull()
    // AY par la voie runtime : zéro producteur configuré ⇒ NOT_EVALUATED.
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r.status).toBe(200)
    expect(r.body.run.businessAssessment).toBe('NOT_EVALUATED')
    expect(r.body.run.blockedReason).toBe('NO_CONFIGURED_PRODUCER')
  })

  it('externalAI — exigé UNIQUEMENT si un producteur configuré le déclare', async () => {
    const m = await creerMoniteur()
    etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: false } }
    // Producteur sans IA externe : la politique ne s'applique pas.
    etat.runtime = { producers: [producteurOk([])], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const ok = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(ok.status).toBe(200)
    // Producteur déclarant l'IA externe : refus strict AVANT admission.
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', m.id), { ...moniteurEnBase(m.id), lastAttemptAt: undefined })
    const avant = JSON.parse(JSON.stringify(moniteurEnBase(m.id)))
    etat.persisted = []
    etat.runtime = { producers: [producteurOk([], { requiresExternalAI: true })], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const refus = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(refus.status).toBe(403)
    expect(refus.body.reason).toBe('WORKSPACE_POLICY_DENIED')
    expect(etat.persisted).toEqual([])
    expect(moniteurEnBase(m.id)).toEqual(avant)
  })
})

// ═══ R1 FIX 1 — SIDECARS FORCE/TEMPOREL DANS LE RUNTIME (BD–BG) ═════════════

describe('R1 Fix 1 — EvidenceStrength / TemporalAuthority câblés de bout en bout', () => {
  const S_INT = { kind: 'INTERNAL_RECORD' } as any
  const S_EXT = { kind: 'EXTERNAL_CONFIRMED_CANONICAL' } as any
  const reeligible = async (id: string) =>
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', id), { ...moniteurEnBase(id), lastAttemptAt: undefined })

  it('BD — MÊMES refs, FORCE d’évidence changée ⇒ empreinte change ⇒ ré-évaluation, second reçu', async () => {
    const m = await creerMoniteur()
    const obs1 = [{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'], evidenceStrengthByRef: { ev_1: S_INT } }]
    etat.runtime = { producers: [producteurOk(obs1)], evaluator: evaluateurFixe('NOT_MATERIAL') }
    await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(recusEnBase()).toHaveLength(1)
    await reeligible(m.id)
    const obs2 = [{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'], evidenceStrengthByRef: { ev_1: S_EXT } }]
    etat.runtime = { producers: [producteurOk(obs2)], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r2 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r2.body.run.canonicalRefsEvaluated).toEqual(['cev_1'])
    expect(r2.body.run.canonicalRefsSkippedAlreadyEvaluated).toEqual([])
    expect(recusEnBase()).toHaveLength(2)
  })

  it('BE — MÊMES refs, AUTORITÉ TEMPORELLE changée ⇒ ré-évaluation, second reçu', async () => {
    const m = await creerMoniteur()
    const obs1 = [{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'], temporalAuthorityByRef: { ev_1: { kind: 'DATED', occurredAt: '2026-01-01' } as any } }]
    etat.runtime = { producers: [producteurOk(obs1)], evaluator: evaluateurFixe('NOT_MATERIAL') }
    await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    await reeligible(m.id)
    const obs2 = [{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'], temporalAuthorityByRef: { ev_1: { kind: 'DATED', occurredAt: '2026-06-01' } as any } }]
    etat.runtime = { producers: [producteurOk(obs2)], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r2 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r2.body.run.canonicalRefsEvaluated).toEqual(['cev_1'])
    expect(recusEnBase()).toHaveLength(2)
  })

  it('BF — état d’évaluation STRICTEMENT identique (refs+force+temporel+versions) ⇒ reçu réutilisé, évaluateur sauté', async () => {
    const m = await creerMoniteur()
    const obs = [{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'], evidenceStrengthByRef: { ev_1: S_INT }, temporalAuthorityByRef: { ev_1: { kind: 'DATED', occurredAt: '2026-01-01' } as any } }]
    let evaluations = 0
    const evaluateur = { policyRef: { policyId: 'p', policyVersion: 'v1' }, evaluate: () => { evaluations++; return 'NOT_MATERIAL' as const } }
    etat.runtime = { producers: [producteurOk(obs)], evaluator: evaluateur }
    await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    await reeligible(m.id)
    const r2 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(evaluations).toBe(1)
    expect(r2.body.run.canonicalRefsSkippedAlreadyEvaluated).toEqual(['cev_1'])
    expect(recusEnBase()).toHaveLength(1)
  })

  it('BG — l’évaluateur reçoit EXACTEMENT les sidecars entrés dans l’empreinte', async () => {
    const m = await creerMoniteur()
    const forces = { ev_1: S_EXT }
    const temporels = { ev_1: { kind: 'DATED', occurredAt: '2026-03-01' } as any }
    const recu: any[] = []
    const evaluateur = {
      policyRef: { policyId: 'p', policyVersion: 'v1' },
      evaluate: (input: any) => { recu.push(input); return 'NOT_MATERIAL' as const },
    }
    etat.runtime = {
      producers: [producteurOk([{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'], evidenceStrengthByRef: forces, temporalAuthorityByRef: temporels }])],
      evaluator: evaluateur,
    }
    await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(recu).toHaveLength(1)
    expect(recu[0].evidenceStrengthByRef).toEqual(forces)
    expect(recu[0].temporalAuthorityByRef).toEqual(temporels)
    // Et l'empreinte est bien SENSIBLE à ces mêmes sidecars.
    const base = { evidenceRefs: ['ev_1'], materialityPolicyId: 'p', materialityPolicyVersion: 'v1', lensVersion: 'v0.1' }
    const f0 = evaluationInputFingerprint(base as any)
    const fS = evaluationInputFingerprint({ ...base, evidenceStrengthByRef: forces } as any)
    const fT = evaluationInputFingerprint({ ...base, temporalAuthorityByRef: temporels } as any)
    expect(new Set([f0, fS, fT]).size).toBe(3)
  })
})

// ═══ R1 FIX 2 — STOPPED IRRÉVERSIBLE / BAIL PARTAGÉ (BH–BL, BS) ═════════════

describe('R1 Fix 2 — un STOP commité ne peut JAMAIS être ressuscité', () => {
  it('BH — RUN périmé (objet ACTIVE) après STOP commité : STOPPED final, zéro producteur, zéro lastAttemptAt', async () => {
    const m = await creerMoniteur()
    const stale = JSON.parse(JSON.stringify(moniteurEnBase(m.id))) // ACTIVE périmé
    const stop = await appeler(monitoringHandler, 'PATCH', { monitorId: m.id, action: 'stop' })
    expect(stop.status).toBe(200)
    let produced = 0
    etat.runtime = { producers: [producteurOk([], { produce: async () => { produced++; return { ok: true, accountRef: SIREN_REF, observations: [] } } })], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r = await executeMonitoringRun(stale, etat.runtime as any, Date.now())
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe('MONITOR_STOPPED')
    expect(produced).toBe(0)
    const final = moniteurEnBase(m.id)
    expect(final.status).toBe('STOPPED')
    expect(final.lastAttemptAt).toBeUndefined()
  })

  it('BI/BS — RUN détient le bail ⇒ STOP rend un conflit typé ; après libération, STOP réussit', async () => {
    const m = await creerMoniteur()
    let liberer!: () => void
    const blocage = new Promise<void>((res) => { liberer = res })
    etat.runtime = {
      producers: [producteurOk([], { produce: async () => { await blocage; return { ok: true, accountRef: SIREN_REF, observations: [] } } })],
      evaluator: evaluateurFixe('NOT_MATERIAL'),
    }
    const runEnVol = executeMonitoringRun(moniteurEnBase(m.id), etat.runtime as any, Date.now())
    await new Promise((r) => setTimeout(r, 10)) // le run acquiert le bail
    const conflit = await appeler(monitoringHandler, 'PATCH', { monitorId: m.id, action: 'stop' })
    expect(conflit.status).toBe(409)
    expect(conflit.body.error).toBe('monitor_busy')
    expect(moniteurEnBase(m.id).status).toBe('ACTIVE') // STOP n'a RIEN écrasé
    liberer()
    const fini = await runEnVol
    expect(fini.ok).toBe(true)
    const stop = await appeler(monitoringHandler, 'PATCH', { monitorId: m.id, action: 'stop' })
    expect(stop.status).toBe(200)
    expect(moniteurEnBase(m.id).status).toBe('STOPPED')
  })

  it('BJ — STOP détient le bail ⇒ RUN concurrent ne mute RIEN', async () => {
    const m = await creerMoniteur()
    const avant = JSON.parse(JSON.stringify(moniteurEnBase(m.id)))
    // Un bail non expiré détenu par le STOP.
    etat.store.set(cle(MONITORING_CLAIM_KIND, 'ws_a', `mclaim_${m.id}`),
      { monitorId: m.id, leaseToken: 't_stop', claimedAt: Date.now(), expiresAt: Date.now() + 600_000 })
    etat.runtime = { producers: [producteurOk([])], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r = await executeMonitoringRun(moniteurEnBase(m.id), etat.runtime as any, Date.now())
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe('CLAIM_HELD')
    expect(moniteurEnBase(m.id)).toEqual(avant) // ni status, ni horodatages
  })

  it('BK — AUCUNE écriture d’horodatage ne peut réécrire STOPPED → ACTIVE', async () => {
    const m = await creerMoniteur()
    await appeler(monitoringHandler, 'PATCH', { monitorId: m.id, action: 'stop' })
    const { persistMonitorTimestamps } = await vi.importActual<any>('../lib/prospector/monitoring/monitoringStore')
    const r = await persistMonitorTimestamps('ws_a', m.id, { lastAttemptAt: new Date().toISOString() }, Date.now())
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('MONITOR_STOPPED')
    expect(moniteurEnBase(m.id).status).toBe('STOPPED')
  })

  it('BH-bis — la CADENCE est revalidée sous bail sur l’état COURANT, jamais sur l’objet périmé', async () => {
    const m = await creerMoniteur({ minIntervalHours: 24 })
    const stale = JSON.parse(JSON.stringify(moniteurEnBase(m.id))) // sans lastAttemptAt
    // Un run vient de s'exécuter : la ligne COURANTE porte un lastAttemptAt frais.
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', m.id), { ...moniteurEnBase(m.id), lastAttemptAt: new Date().toISOString() })
    let produced = 0
    etat.runtime = { producers: [producteurOk([], { produce: async () => { produced++; return { ok: true, accountRef: SIREN_REF, observations: [] } } })], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r = await executeMonitoringRun(stale, etat.runtime as any, Date.now())
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe('NOT_ELIGIBLE_YET')
    expect(produced).toBe(0)
    expect(runsEnBase()).toHaveLength(0)
  })

  it('BL — re-lecture post-bail STRICTE : magasin muet ⇒ échec typé, zéro producteur, zéro écriture périmée', async () => {
    const m = await creerMoniteur()
    const avant = JSON.parse(JSON.stringify(moniteurEnBase(m.id)))
    etat.failGet = (kind) => kind === ACCOUNT_MONITOR_KIND
    let produced = 0
    etat.runtime = { producers: [producteurOk([], { produce: async () => { produced++; return { ok: true, accountRef: SIREN_REF, observations: [] } } })], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r = await executeMonitoringRun(moniteurEnBase(m.id), etat.runtime as any, Date.now())
    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe('STORE_FAILURE')
    expect((r as any).stage).toBe('monitor_reread')
    expect(produced).toBe(0)
    etat.failGet = null
    expect(moniteurEnBase(m.id)).toEqual(avant)
  })
})

// ═══ R1 FIX 2-BIS — REPRISE ATOMIQUE D'UN BAIL EXPIRÉ (BM–BR) ═══════════════

describe('R1 Fix 2-bis — reprise de bail expiré : AU PLUS UN propriétaire', () => {
  const CLAIM_ID = 'mclaim_mon_x'
  const poserBail = (leaseToken: string, expiresAt: number) =>
    etat.store.set(cle(MONITORING_CLAIM_KIND, 'ws_a', CLAIM_ID),
      { monitorId: 'mon_x', leaseToken, claimedAt: 0, expiresAt })

  it('BM/BN — deux contendants sur le MÊME bail expiré : exactement UN propriétaire', async () => {
    const { acquireMonitorOperationLease } = await vi.importActual<any>('../lib/prospector/monitoring/monitoringStore')
    poserBail('t_old', Date.now() - 1)
    const [a, b] = await Promise.all([
      acquireMonitorOperationLease('ws_a', 'mon_x', Date.now()),
      acquireMonitorOperationLease('ws_a', 'mon_x', Date.now()),
    ])
    const gagnants = [a, b].filter((r: any) => r.ok === true)
    expect(gagnants).toHaveLength(1)
    expect([a, b].filter((r: any) => r.ok === false && r.reason === 'CLAIM_HELD')).toHaveLength(1)
    // Le bail installé porte le jeton du gagnant, pas t_old.
    const enBase = etat.store.get(cle(MONITORING_CLAIM_KIND, 'ws_a', CLAIM_ID))
    expect(enBase.leaseToken).toBe((gagnants[0] as any).leaseToken)
    expect(enBase.leaseToken).not.toBe('t_old')
  })

  it('BO — bail FRAIS : deux acquisitions concurrentes ⇒ un seul propriétaire', async () => {
    const { acquireMonitorOperationLease } = await vi.importActual<any>('../lib/prospector/monitoring/monitoringStore')
    const [a, b] = await Promise.all([
      acquireMonitorOperationLease('ws_a', 'mon_x', Date.now()),
      acquireMonitorOperationLease('ws_a', 'mon_x', Date.now()),
    ])
    expect([a, b].filter((r: any) => r.ok === true)).toHaveLength(1)
  })

  it('BP — bail NON expiré : zéro reprise, jeton intact', async () => {
    const { acquireMonitorOperationLease } = await vi.importActual<any>('../lib/prospector/monitoring/monitoringStore')
    poserBail('t_vivant', Date.now() + 600_000)
    const r = await acquireMonitorOperationLease('ws_a', 'mon_x', Date.now())
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('CLAIM_HELD')
    expect(etat.store.get(cle(MONITORING_CLAIM_KIND, 'ws_a', CLAIM_ID)).leaseToken).toBe('t_vivant')
  })

  it('BQ — suppression de l’ancien bail gagnée MAIS remplacement perdu ⇒ AUCUNE propriété', async () => {
    const { acquireMonitorOperationLease } = await vi.importActual<any>('../lib/prospector/monitoring/monitoringStore')
    poserBail('t_old', Date.now() - 1)
    // Toute INSERTION de bail échoue : le contendant peut gagner la
    // suppression de l'ancien bail, jamais installer le remplaçant.
    etat.failInsert = (kind) => kind === MONITORING_CLAIM_KIND
    const r = await acquireMonitorOperationLease('ws_a', 'mon_x', Date.now())
    etat.failInsert = null
    expect(r.ok).toBe(false) // la suppression seule N'EST PAS la propriété
    expect(etat.store.has(cle(MONITORING_CLAIM_KIND, 'ws_a', CLAIM_ID))).toBe(false) // l'ancien a bien été retiré
  })

  it('BR — génération de bail : l’ancien jeton ne peut pas voler le bail remplaçant', async () => {
    const { acquireMonitorOperationLease } = await vi.importActual<any>('../lib/prospector/monitoring/monitoringStore')
    poserBail('t_old', Date.now() - 1)
    const gagnant = await acquireMonitorOperationLease('ws_a', 'mon_x', Date.now())
    expect(gagnant.ok).toBe(true)
    // Un ancien contendant qui n'a observé QUE t_old tente la reprise
    // conditionnelle sur ce jeton : l'instance a changé, il échoue.
    const { claimItemIfField } = await import('../lib/supabase/store')
    const vol = await claimItemIfField('monitoring_claim', CLAIM_ID, 'ws_a', 'leaseToken', 't_old')
    expect(vol).toBeNull()
    expect(etat.store.get(cle(MONITORING_CLAIM_KIND, 'ws_a', CLAIM_ID)).leaseToken).toBe(gagnant.leaseToken)
  })
})

// ═══ R1 FIX 3 / 3-BIS — FAIL CLOSED + ORDRE RÉSULTAT→REÇUS (BT–CE) ══════════

describe('R1 Fix 3 — le magasin du monitoring échoue FERMÉ', () => {
  it('BT/BU — GET : panne de collection ⇒ 503, JAMAIS un 200 vide ; collection vide réelle ⇒ 200 []', async () => {
    etat.failList = true
    const panne = await appeler(monitoringHandler, 'GET')
    expect(panne.status).toBe(503)
    expect(panne.body.error).toBe('store_unavailable')
    expect(panne.body.monitors).toBeUndefined()
    etat.failList = false
    const vide = await appeler(monitoringHandler, 'GET')
    expect(vide.status).toBe(200)
    expect(vide.body.monitors).toEqual([])
  })

  it('BV — échec d’écriture de lastAttemptAt après bail ⇒ zéro producteur, échec typé, bail libéré', async () => {
    const m = await creerMoniteur()
    etat.failUpsert = (kind) => kind === ACCOUNT_MONITOR_KIND
    let produced = 0
    etat.runtime = { producers: [producteurOk([], { produce: async () => { produced++; return { ok: true, accountRef: SIREN_REF, observations: [] } } })], evaluator: evaluateurFixe('NOT_MATERIAL') }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    etat.failUpsert = null
    expect(r.status).toBe(503)
    expect(r.body.stage).toBe('admission_timestamp')
    expect(produced).toBe(0)
    expect(etat.store.has(cle(MONITORING_CLAIM_KIND, 'ws_a', `mclaim_${m.id}`))).toBe(false) // bail libéré
    expect(runsEnBase()).toHaveLength(0)
  })

  it('BW/CE — lecture de reçu indisponible ⇒ « inconnu » ≠ « absent » : échec typé, évaluateur non appelé, moniteur ACTIVE', async () => {
    const m = await creerMoniteur()
    etat.failGet = (kind) => kind === MONITOR_EVAL_RECEIPT_KIND
    let evaluated = 0
    etat.runtime = {
      producers: [producteurOk([{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }])],
      evaluator: { policyRef: { policyId: 'p', policyVersion: 'v1' }, evaluate: () => { evaluated++; return 'NOT_MATERIAL' as const } },
    }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    etat.failGet = null
    expect(r.status).toBe(503)
    expect(r.body.stage).toBe('receipt_lookup')
    expect(evaluated).toBe(0)
    expect(r.body.run?.businessAssessment).toBeUndefined() // aucun faux silence
    expect(moniteurEnBase(m.id).status).toBe('ACTIVE')
  })

  it('BY/CB/CC — échec d’écriture du RÉSULTAT ⇒ pas de succès, AUCUN reçu durable ; le run suivant RÉ-ÉVALUE', async () => {
    const m = await creerMoniteur()
    etat.failUpsert = (kind) => kind === MONITORING_RUN_KIND
    let evaluations = 0
    const evaluateur = { policyRef: { policyId: 'p', policyVersion: 'v1' }, evaluate: () => { evaluations++; return 'MATERIAL' as const } }
    etat.runtime = { producers: [producteurOk([{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }])], evaluator: evaluateur }
    const r1 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r1.status).toBe(503)
    expect(r1.body.stage).toBe('run_result_write')
    expect(recusEnBase()).toHaveLength(0) // CB — pas de consommation durable
    const apres = moniteurEnBase(m.id)
    expect(apres.lastSuccessAt).toBeUndefined()
    expect(apres.lastMaterialChangeAt).toBeUndefined()
    // CC — panne levée : la MÊME évaluation repart, rien n'a été perdu.
    etat.failUpsert = null
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', m.id), { ...moniteurEnBase(m.id), lastAttemptAt: undefined })
    const r2 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r2.status).toBe(200)
    expect(evaluations).toBe(2) // ré-évaluée, pas de faux skip
    expect(r2.body.run.businessAssessment).toBe('MATERIAL_CHANGE_FOUND')
    expect(recusEnBase()).toHaveLength(1)
  })

  it('BX/CD — échec d’écriture du REÇU après résultat durable ⇒ échec honnête ; le run suivant peut ré-évaluer', async () => {
    const m = await creerMoniteur()
    etat.failInsert = (kind) => kind === MONITOR_EVAL_RECEIPT_KIND
    let evaluations = 0
    const evaluateur = { policyRef: { policyId: 'p', policyVersion: 'v1' }, evaluate: () => { evaluations++; return 'MATERIAL' as const } }
    etat.runtime = { producers: [producteurOk([{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }])], evaluator: evaluateur }
    const r1 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r1.status).toBe(503)
    expect(r1.body.stage).toBe('receipt_write')
    expect(r1.body.run.businessAssessment).toBe('MATERIAL_CHANGE_FOUND') // le résultat EST durable et joint
    expect(runsEnBase()).toHaveLength(1)
    expect(recusEnBase()).toHaveLength(0)
    // CD — panne levée : ré-évaluation possible, aucun surfaçage perdu.
    etat.failInsert = null
    etat.store.set(cle(ACCOUNT_MONITOR_KIND, 'ws_a', m.id), { ...moniteurEnBase(m.id), lastAttemptAt: undefined })
    const r2 = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    expect(r2.status).toBe(200)
    expect(evaluations).toBe(2)
    expect(recusEnBase()).toHaveLength(1)
  })

  it('BZ/CA — échec des horodatages de SYNTHÈSE ⇒ vérité durable, échec honnête, aucun horodatage prétendu', async () => {
    const m = await creerMoniteur()
    let ecrituresMoniteur = 0
    etat.failUpsert = (kind) => kind === ACCOUNT_MONITOR_KIND && ++ecrituresMoniteur > 1 // admission passe, synthèse échoue
    etat.runtime = { producers: [producteurOk([{ canonicalRef: 'cev_1', evidenceRefs: ['ev_1'] }])], evaluator: evaluateurFixe('MATERIAL') }
    const r = await appeler(monitoringRunHandler, 'POST', { monitorId: m.id })
    etat.failUpsert = null
    expect(r.status).toBe(503)
    expect(r.body.stage).toBe('summary_timestamp_write')
    expect(r.body.run.businessAssessment).toBe('MATERIAL_CHANGE_FOUND') // résultat + reçus durables
    expect(runsEnBase()).toHaveLength(1)
    expect(recusEnBase()).toHaveLength(1)
    const enBase = moniteurEnBase(m.id)
    expect(enBase.lastSuccessAt).toBeUndefined()       // rien de prétendu
    expect(enBase.lastMaterialChangeAt).toBeUndefined()
    expect(r.body.monitor).toBeUndefined()             // aucun moniteur mensonger rendu
  })
})
