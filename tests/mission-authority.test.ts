// SEC-004_MISSION_EXEC_AUTHORITY_V0_001 — PLANNER ≠ CONTROLLER (MA-01…MA-28).
//
// Verrouille les quatre séparations du ticket :
//   approbation demandée ≠ accordée ≠ exécution ≠ complétion.
// Une Mission du navigateur est une ENTRÉE ; le serveur reconstruit le contrat,
// la création est create-only, l'approbation est un objet serveur lié et
// consommé une seule fois, et l'exécution revalide tout.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etat = vi.hoisted(() => ({
  session: { tenant: { id: 'ws_a', kind: 'client' }, actorId: 'alice@a.fr' } as any,
  store: new Map<string, any>(),
  persisted: [] as Array<{ op: string; kind: string; id: string; ws: string; data?: any }>,
  runStepCalls: [] as any[],
  runStepImpl: async () => ({ result: 'exécuté (double de test)', context: {} }),
  insertFails: false,
  readOverride: null as null | { ok: false } | { ok: true; value: any },
  workspacePolicy: { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } } as any,
}))

const cle = (kind: string, ws: string, id: string) => `${kind}|${ws}|${id}`

vi.mock('../lib/prospector/tenant', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/tenant')>()),
  resolveTenantFromRequest: async () => etat.session?.tenant ?? null,
  resolveActorFromRequest: async () => etat.session,
}))

// JS-020 — la politique d'espace stricte est doublée : externalAI explicite
// permis par défaut dans ces suites (l'outil forgé est enrich_companies).
vi.mock('../lib/supabase/workspaces', () => ({
  getWorkspacePermissionsStrict: async () => etat.workspacePolicy,
}))

vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => {},
  getKey: () => null,
}))

vi.mock('../lib/prospector/missionTools', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/missionTools')>()),
  runStep: async (...a: any[]) => {
    etat.runStepCalls.push(a)
    return etat.runStepImpl()
  },
}))

vi.mock('../lib/supabase/store', () => ({
  listItems: async (kind: string, ws: string) =>
    [...etat.store.entries()].filter(([k]) => k.startsWith(`${kind}|${ws}|`)).map(([, v]) => v),
  getItemStrict: async (kind: string, id: string, ws: string) =>
    etat.readOverride ?? { ok: true, value: etat.store.get(cle(kind, ws, id)) ?? null },
  upsertItem: async (kind: string, id: string, data: any, ws: string) => {
    etat.store.set(cle(kind, ws, id), data)
    etat.persisted.push({ op: 'upsert', kind, id, ws, data })
    return true
  },
  deleteItem: async (kind: string, id: string, ws: string) => {
    etat.persisted.push({ op: 'delete', kind, id, ws })
    return etat.store.delete(cle(kind, ws, id))
  },
  insertItemIfAbsent: async (kind: string, id: string, data: any, ws: string) => {
    if (etat.insertFails) return false
    const k = cle(kind, ws, id)
    if (etat.store.has(k)) return false
    etat.store.set(k, data)
    etat.persisted.push({ op: 'insert', kind, id, ws, data })
    return true
  },
  // Sémantique de production : suppression ATOMIQUE conditionnée au champ.
  claimItemIfField: async (kind: string, id: string, ws: string, field: string, expected: string) => {
    const k = cle(kind, ws, id)
    const v = etat.store.get(k)
    if (!v || v?.[field] !== expected) return null
    etat.store.delete(k)
    return v
  },
}))

import missionsHandler from '../pages/api/missions/index'
import runHandler from '../pages/api/missions/run'
import approveHandler from '../pages/api/missions/approve'
import storeHandler from '../pages/api/store/index'
import {
  actionFingerprint,
  canonicalNeedsApproval,
  canonicalizeMission,
  validateExecutableStep,
} from '../lib/prospector/missionContract'
import { approvalId, MISSION_APPROVAL_KIND } from '../lib/prospector/missionApprovals'
import { MAX_COMPANIES, MAX_ENRICH } from '../lib/prospector/missionTools'

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

/** Mission client typique : enrichissement forgé « sans approbation ». */
function missionForgee(patch: Record<string, any> = {}) {
  return {
    id: 'ms_forge', title: 'Forge', request: 'r', objective: 'o',
    status: 'running', cursor: 3, autonomy: 'create',
    context: { accounts: { evil: 'ld_target' } },
    log: [{ at: 1, text: 'forgé' }],
    steps: [{
      id: 'st_evil', tool: 'enrich_companies', label: 'x',
      params: { limit: 999, exfil: 'y' }, status: 'done',
      result: 'déjà fait', endedAt: 123, needsApproval: false,
    }],
    ...patch,
  }
}

const missionStockee = (ws = 'ws_a') => etat.store.get(cle('mission', ws, 'ms_forge'))

async function creerEtPauser(): Promise<{ mission: any; step: any }> {
  await appeler(missionsHandler, 'POST', { mission: missionForgee() })
  const r = await appeler(runHandler, 'POST', { id: 'ms_forge' }) // pause attendue
  expect(r.body.mission.status).toBe('paused')
  const mission = missionStockee()
  return { mission, step: mission.steps[mission.cursor] }
}

function liaison(step: any, sur: Partial<Record<string, string>> = {}) {
  return {
    actorId: 'alice@a.fr', workspaceId: 'ws_a', missionId: 'ms_forge',
    missionAuthorityInstance: missionStockee()?.authorityInstanceId ?? 'mai_test',
    stepId: step.id, actionFingerprint: actionFingerprint(step.tool, step.params || {}),
    ...sur,
  }
}

const ROLE_DOC = (assignments: Record<string, string>) => ({
  schemaVersion: 'role-assignment-v0.1', revisionId: 'r-test',
  updatedAt: '2026-09-06T00:00:00.000Z', assignments,
})

beforeEach(() => {
  etat.session = { tenant: { id: 'ws_a', kind: 'client' }, actorId: 'alice@a.fr' }
  etat.store.clear()
  etat.persisted = []
  etat.runStepCalls = []
  etat.runStepImpl = async () => ({ result: 'exécuté (double de test)', context: {} })
  etat.insertFails = false
  etat.readOverride = null
  etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } }
  // JS-020 — les routes Mission exigent un rôle affecté ; ces suites testent
  // l'autorité SEC-004 en aval, donc les acteurs de test sont affectés.
  etat.store.set(cle('workspace_role_assignment', 'ws_a', 'active'),
    ROLE_DOC({ 'alice@a.fr': 'SDR_BDR', 'bob@a.fr': 'SDR_BDR' }))
  etat.store.set(cle('workspace_role_assignment', 'ws_b', 'active'),
    ROLE_DOC({ 'alice@a.fr': 'SDR_BDR' }))
})

describe('MA-01/02/03/04/28 — canonicalisation serveur', () => {
  it('MA-01/28 — enrich forgé needsApproval:false devient APPROBATION REQUISE (write/costly imposent)', () => {
    const c = canonicalizeMission(missionForgee(), 1000, 'mai_test_instance')
    if (c.ok === false) throw new Error(c.reason)
    expect(c.mission.steps[0].needsApproval).toBe(true)
    for (const tool of ['import_companies', 'resolve_dirigeants', 'enrich_companies', 'create_list', 'create_sequence'] as const) {
      expect(canonicalNeedsApproval(tool, false), tool).toBe(true)
    }
  })

  it('MA-27 — source_companies (lecture) reste sans approbation inhérente ; le souhait client DURCIT', () => {
    expect(canonicalNeedsApproval('source_companies', false)).toBe(false)
    expect(canonicalNeedsApproval('source_companies', true)).toBe(true) // durcir : oui
  })

  it('MA-02 — status/cursor/context/log/result/endedAt forgés ne survivent PAS', () => {
    const c = canonicalizeMission(missionForgee(), 5000, 'mai_test_instance')
    if (c.ok === false) throw new Error(c.reason)
    const m = c.mission
    expect(m.status).toBe('draft')
    expect(m.cursor).toBe(0)
    expect(m.context).toEqual({})
    expect(m.log).toEqual([])
    expect(m.createdAt).toBe(5000)
    expect(m.steps[0].status).toBe('pending')
    expect((m.steps[0] as any).result).toBeUndefined()
    expect((m.steps[0] as any).endedAt).toBeUndefined()
    expect(m.steps[0].id).toBe('st_1') // identifiant serveur, pas st_evil
  })

  it('MA-03 — outil inconnu ⇒ REFUS de toute la mission (jamais retiré en silence)', () => {
    const c = canonicalizeMission(missionForgee({
      steps: [{ tool: 'send_all_the_emails', params: {} }],
    }), 1, 'mai_test_instance')
    expect(c).toMatchObject({ ok: false, reason: 'unknown_tool' })
    // Et par la route : rien n'est persisté.
    return appeler(missionsHandler, 'POST', {
      mission: missionForgee({ steps: [{ tool: 'nope', params: {} }] }),
    }).then((r) => {
      expect(r.status).toBe(422)
      expect(etat.persisted).toEqual([])
    })
  })

  it('MA-04 — paramètres canonicalisés : bornes dures conservées, champs étrangers retirés', () => {
    const c = canonicalizeMission(missionForgee(), 1, 'mai_test_instance')
    if (c.ok === false) throw new Error(c.reason)
    expect(c.mission.steps[0].params).toEqual({ limit: MAX_ENRICH }) // 999 → 10, exfil retiré
    const s = canonicalizeMission({
      id: 'ms_2', steps: [{ tool: 'source_companies', params: { limit: 10000, sector: 'Tech', hack: 1 } }],
    }, 1, 'mai_test_instance')
    if (s.ok === false) throw new Error(s.reason)
    expect(s.mission.steps[0].params).toEqual({ limit: MAX_COMPANIES, sector: 'Tech' })
  })

  it('plus de 8 étapes ⇒ refus explicite', () => {
    const c = canonicalizeMission({
      id: 'ms_9', steps: Array.from({ length: 9 }, () => ({ tool: 'source_companies', params: {} })),
    }, 1, 'mai_test_instance')
    expect(c).toMatchObject({ ok: false, reason: 'too_many_steps' })
  })
})

describe('MA-05/06/07/08/09/10 — persistance create-only et pare-feu du magasin', () => {
  it('MA-05 — POST ne peut PAS remplacer l’état exécutable d’une mission existante', async () => {
    const r1 = await appeler(missionsHandler, 'POST', { mission: missionForgee() })
    expect(r1.status).toBe(200)
    const originale = missionStockee()
    const r2 = await appeler(missionsHandler, 'POST', {
      mission: missionForgee({ steps: [{ tool: 'source_companies', params: {} }] }),
    })
    expect(r2.status).toBe(409)
    expect(missionStockee()).toBe(originale) // byte-identique : rien remplacé
  })

  it('MA-06/07 — /api/store POST et DELETE mission sont REFUSÉS', async () => {
    const post = await appeler(storeHandler, 'POST', { kind: 'mission', item: missionForgee() })
    expect(post.status).toBe(403)
    const del = await appeler(storeHandler, 'DELETE', { kind: 'mission', id: 'ms_forge' })
    expect(del.status).toBe(403)
    expect(etat.persisted).toEqual([])
  })

  it('MA-08/09 — /api/store POST/DELETE des quatre kinds proactifs sont REFUSÉS', async () => {
    for (const kind of ['proactive_evidence', 'proactive_situation', 'proactive_recommendation', 'proactive_outcome']) {
      const post = await appeler(storeHandler, 'POST', { kind, item: { id: 'x' } })
      expect(post.status, kind).toBe(403)
      const del = await appeler(storeHandler, 'DELETE', { kind, id: 'x' })
      expect(del.status, kind).toBe(403)
    }
    expect(etat.persisted).toEqual([])
    // Et le kind d'approbation n'est NI lisible NI inscriptible ici.
    expect((await appeler(storeHandler, 'POST', { kind: MISSION_APPROVAL_KIND, item: { id: 'x' } })).status).toBe(400)
    expect((await appeler(storeHandler, 'GET', undefined, { kind: MISSION_APPROVAL_KIND })).status).toBe(400)
  })

  it('MA-10 — les lectures existantes restent compatibles (mission + proactifs lisibles, UI kinds écrivibles)', async () => {
    await appeler(missionsHandler, 'POST', { mission: missionForgee() })
    const lu = await appeler(storeHandler, 'GET', undefined, { kind: 'mission' })
    expect(lu.status).toBe(200)
    expect(lu.body.items).toHaveLength(1)
    expect((await appeler(storeHandler, 'GET', undefined, { kind: 'proactive_evidence' })).status).toBe(200)
    const seq = await appeler(storeHandler, 'POST', { kind: 'sequence', item: { id: 'sq_1' } })
    expect(seq.status).toBe(200)
    expect(seq.body.saved).toBe(1)
  })
})

describe('MA-11/12/13/23 — approbation demandée ≠ accordée ≠ exécution ≠ complétion', () => {
  it('MA-11 — run sans approbation ⇒ pause, AUCUNE exécution', async () => {
    await creerEtPauser()
    expect(etat.runStepCalls).toHaveLength(0)
    expect(missionStockee().steps[0].status).toBe('pending')
  })

  it('MA-13 — approve:true nu ne donne PLUS l’exécution', async () => {
    await creerEtPauser()
    const r = await appeler(runHandler, 'POST', { id: 'ms_forge', approve: true })
    expect(r.body.mission.status).toBe('paused')
    expect(etat.runStepCalls).toHaveLength(0)
  })

  it('MA-12/23 — /approve ACCORDE mais n’exécute rien ; approbation ≠ complétion', async () => {
    const { step } = await creerEtPauser()
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_forge', stepId: step.id })
    expect(ok.status).toBe(200)
    expect(ok.body.approvalId).toMatch(/^apr_/)
    // Rien n'a été exécuté ni terminé.
    expect(etat.runStepCalls).toHaveLength(0)
    const m = missionStockee()
    expect(m.steps[0].status).toBe('pending')
    expect(m.cursor).toBe(0)
    expect(m.status).toBe('paused')
    // L'approbation existe, à l'état granted — accordée, pas consommée.
    expect(etat.store.get(cle(MISSION_APPROVAL_KIND, 'ws_a', ok.body.approvalId)).state).toBe('granted')
    // Seule l'exécution réussie termine l'étape.
    const run = await appeler(runHandler, 'POST', { id: 'ms_forge', approvalId: ok.body.approvalId })
    expect(run.status).toBe(200)
    expect(etat.runStepCalls).toHaveLength(1)
    expect(missionStockee().steps[0].status).toBe('done')
  })

  it('échec de runStep ⇒ étape failed, jamais done (complétion honnête)', async () => {
    const { step } = await creerEtPauser()
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_forge', stepId: step.id })
    etat.runStepImpl = async () => { throw new Error('provider down') }
    const run = await appeler(runHandler, 'POST', { id: 'ms_forge', approvalId: ok.body.approvalId })
    expect(run.body.mission.steps[0].status).toBe('failed')
    expect(run.body.mission.status).toBe('failed')
  })
})

describe('MA-14…MA-21 — liaison exacte, usage unique, atomicité', () => {
  it('MA-14 — l’approbation de l’acteur A ne s’exécute pas sous l’acteur B', async () => {
    const { step } = await creerEtPauser()
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_forge', stepId: step.id })
    etat.session = { tenant: { id: 'ws_a', kind: 'client' }, actorId: 'bob@a.fr' }
    const r = await appeler(runHandler, 'POST', { id: 'ms_forge', approvalId: ok.body.approvalId })
    expect(r.status).toBe(403)
    expect(etat.runStepCalls).toHaveLength(0)
    // Et l'approbation d'Alice n'a PAS été brûlée par la tentative de Bob :
    // l'identifiant attendu de Bob est différent, rien n'a été consommé.
    expect(etat.store.get(cle(MISSION_APPROVAL_KIND, 'ws_a', ok.body.approvalId))).toBeDefined()
  })

  it('MA-15 — l’approbation de l’espace A ne s’exécute pas dans l’espace B', async () => {
    const { step } = await creerEtPauser()
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_forge', stepId: step.id })
    // Même mission recréée dans ws_b, même acteur : l'identifiant lié à ws_b
    // diffère, l'approbation de ws_a est introuvable depuis ws_b.
    etat.session = { tenant: { id: 'ws_b', kind: 'client' }, actorId: 'alice@a.fr' }
    await appeler(missionsHandler, 'POST', { mission: missionForgee() })
    await appeler(runHandler, 'POST', { id: 'ms_forge' }) // pause dans ws_b
    const r = await appeler(runHandler, 'POST', { id: 'ms_forge', approvalId: ok.body.approvalId })
    expect(r.status).toBe(403)
    expect(etat.runStepCalls).toHaveLength(0)
  })

  it('MA-16/17/R2 — liaison mission, étape et INSTANCE : toute variation change l’identifiant attendu', async () => {
    const { step } = await creerEtPauser()
    const base = liaison(step)
    expect(approvalId({ ...base })).not.toBe(approvalId({ ...base, missionId: 'ms_autre' }))
    expect(approvalId({ ...base })).not.toBe(approvalId({ ...base, stepId: 'st_2' }))
    expect(approvalId({ ...base })).not.toBe(approvalId({ ...base, actorId: 'bob@a.fr' }))
    expect(approvalId({ ...base })).not.toBe(approvalId({ ...base, workspaceId: 'ws_b' }))
    expect(approvalId({ ...base })).not.toBe(approvalId({ ...base, actionFingerprint: 'autre' }))
    // R2 — même acteur/espace/missionId/étape/params, INSTANCE différente ⇒
    // identifiant différent, et le record de A ne matche pas la liaison de B.
    expect(approvalId({ ...base })).not.toBe(approvalId({ ...base, missionAuthorityInstance: 'mai_autre' }))
    const { approvalRecordMatches } = await import('../lib/prospector/missionApprovals')
    const recordA = {
      schemaVersion: 'mission-approval-v0.1', state: 'granted',
      actorId: base.actorId, workspaceId: base.workspaceId, missionId: base.missionId,
      missionAuthorityInstance: base.missionAuthorityInstance,
      stepId: base.stepId, tool: step.tool, actionFingerprint: base.actionFingerprint,
      grantedAt: new Date(1).toISOString(),
    }
    expect(approvalRecordMatches(recordA, { ...base, tool: step.tool } as any)).toBe(true)
    expect(approvalRecordMatches(recordA, { ...base, tool: step.tool, missionAuthorityInstance: 'mai_autre' } as any)).toBe(false)
  })

  it('MA-18 — paramètres/outil modifiés APRÈS approbation ⇒ empreinte différente ⇒ refus', async () => {
    const { step } = await creerEtPauser()
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_forge', stepId: step.id })
    // L'action exécutable change (params mutés dans la ligne persistée).
    const m = missionStockee()
    m.steps[0].params = { limit: 1 }
    etat.store.set(cle('mission', 'ws_a', 'ms_forge'), m)
    const r = await appeler(runHandler, 'POST', { id: 'ms_forge', approvalId: ok.body.approvalId })
    expect(r.status).toBe(403)
    expect(etat.runStepCalls).toHaveLength(0)
    // L'empreinte est insensible à l'ORDRE des clés, sensible aux VALEURS.
    expect(actionFingerprint('source_companies', { sector: 'Tech', limit: 5 }))
      .toBe(actionFingerprint('source_companies', { limit: 5, sector: 'Tech' }))
    expect(actionFingerprint('source_companies', { limit: 5 }))
      .not.toBe(actionFingerprint('source_companies', { limit: 6 }))
    expect(actionFingerprint('create_list', { name: 'x' }))
      .not.toBe(actionFingerprint('create_sequence', { name: 'x' }))
  })

  it('MA-19 — usage UNIQUE : la même approbation ne s’exécute pas deux fois', async () => {
    const { step } = await creerEtPauser()
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_forge', stepId: step.id })
    const un = await appeler(runHandler, 'POST', { id: 'ms_forge', approvalId: ok.body.approvalId })
    expect(un.status).toBe(200)
    expect(etat.runStepCalls).toHaveLength(1)
    // La mission n'a qu'une étape : elle est done — mais même en forçant une
    // relecture de la même approbation, elle est CONSOMMÉE (absente du store).
    expect(etat.store.get(cle(MISSION_APPROVAL_KIND, 'ws_a', ok.body.approvalId))).toBeUndefined()
  })

  it('MA-20 — double consommation concurrente : au plus UNE réussit (claim atomique)', async () => {
    const { consumeApproval } = await import('../lib/prospector/missionApprovals')
    const { step } = await creerEtPauser()
    await appeler(approveHandler, 'POST', { missionId: 'ms_forge', stepId: step.id })
    const attendu = { ...liaison(step), tool: step.tool }
    const presente = approvalId(attendu)
    const [a, b] = await Promise.all([
      consumeApproval(attendu, presente), consumeApproval(attendu, presente),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
  })

  it('MA-21/R1-4 — incertitude RÉELLE du magasin : chaque cas ferme (A–E)', async () => {
    const { grantApproval, consumeApproval } = await import('../lib/prospector/missionApprovals')
    const l = { ...liaison({ id: 'st_1', tool: 'enrich_companies', params: { limit: 5 } }), tool: 'enrich_companies' }

    // A — insert refusé + relecture stricte MUETTE ⇒ ok:false, jamais « déjà accordé ».
    etat.insertFails = true
    etat.readOverride = { ok: false }
    expect(await grantApproval(l, 1000)).toEqual({ ok: false, reason: 'store_write_failed' })

    // B — insert refusé + relecture rend NULL (aucune ligne) ⇒ ok:false.
    etat.readOverride = { ok: true, value: null }
    expect(await grantApproval(l, 1000)).toEqual({ ok: false, reason: 'store_write_failed' })

    // C — insert refusé + ligne existante MALFORMÉE ou à la MAUVAISE liaison
    //     ⇒ ok:false, PAS alreadyGranted (R1-2 : l'état seul ne prouve rien).
    etat.readOverride = { ok: true, value: { state: 'granted' } } // malformée
    expect(await grantApproval(l, 1000)).toEqual({ ok: false, reason: 'store_write_failed' })
    etat.readOverride = {
      ok: true,
      value: {
        schemaVersion: 'mission-approval-v0.1', state: 'granted',
        actorId: 'mallory@a.fr', workspaceId: 'ws_a', missionId: l.missionId,
        stepId: l.stepId, tool: l.tool, actionFingerprint: l.actionFingerprint,
        grantedAt: new Date(1).toISOString(),
      },
    } // mauvais acteur sous le bon identifiant
    expect(await grantApproval(l, 1000)).toEqual({ ok: false, reason: 'store_write_failed' })

    // D — ligne existante EXACTEMENT conforme ⇒ alreadyGranted, original intact.
    etat.insertFails = false
    etat.readOverride = null
    const g1 = await grantApproval(l, 1000)
    const g2 = await grantApproval(l, 2000)
    if (g1.ok === false || g2.ok === false) throw new Error('grants attendus')
    expect(g2.alreadyGranted).toBe(true)
    expect(etat.store.get(cle(MISSION_APPROVAL_KIND, 'ws_a', g1.approvalId)).grantedAt)
      .toBe(new Date(1000).toISOString())

    // E — claim rendu nul (rien à consommer / magasin muet) ⇒ fail closed.
    etat.store.delete(cle(MISSION_APPROVAL_KIND, 'ws_a', g1.approvalId))
    expect((await consumeApproval(l, approvalId(l))).ok).toBe(false)
  })

  it('R1-5 — approvalId FAUX présenté à /run : 403, rien d’exécuté, accord légitime INTACT puis consommable', async () => {
    const { step } = await creerEtPauser()
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_forge', stepId: step.id })
    // 5 — identifiant faux.
    const faux = await appeler(runHandler, 'POST', { id: 'ms_forge', approvalId: 'apr_wrong' })
    expect(faux.status).toBe(403)
    expect(faux.body.error).toBe('approval_id_mismatch')
    expect(etat.runStepCalls).toHaveLength(0)
    const m = missionStockee()
    expect(m.status).toBe('paused')
    expect(m.cursor).toBe(0)
    expect(m.steps[0].status).toBe('pending')
    // L'accord légitime n'a PAS été brûlé par l'identifiant faux.
    expect(etat.store.get(cle(MISSION_APPROVAL_KIND, 'ws_a', ok.body.approvalId))).toBeDefined()
    // 7/8 — le VRAI identifiant exécute exactement une fois et consomme l'accord.
    const vrai = await appeler(runHandler, 'POST', { id: 'ms_forge', approvalId: ok.body.approvalId })
    expect(vrai.status).toBe(200)
    expect(etat.runStepCalls).toHaveLength(1)
    expect(missionStockee().steps[0].status).toBe('done')
    expect(etat.store.get(cle(MISSION_APPROVAL_KIND, 'ws_a', ok.body.approvalId))).toBeUndefined()
  })
})

describe('R2 — liaison à l’INSTANCE de mission (rejeu périmé après delete + recréation)', () => {
  const missionDeuxEtapes = (id = 'ms_replay') => ({
    id, title: 'Replay', request: 'r', objective: 'o',
    steps: [
      { tool: 'source_companies', params: { limit: 5 } },
      { tool: 'import_companies', params: {} },
    ],
  })
  const stockee = (id = 'ms_replay') => etat.store.get(cle('mission', 'ws_a', id))

  it('R2-7 — un accord non consommé d’une mission SUPPRIMÉE n’autorise JAMAIS sa recréation homonyme', async () => {
    // A — Mission A : source (lecture) puis import (écriture, approbation).
    await appeler(missionsHandler, 'POST', { mission: missionDeuxEtapes() })
    const instanceA = stockee().authorityInstanceId
    expect(instanceA).toMatch(/^mai_/)
    await appeler(runHandler, 'POST', { id: 'ms_replay' })       // exécute source
    const pause = await appeler(runHandler, 'POST', { id: 'ms_replay' }) // pause sur import
    expect(pause.body.mission.status).toBe('paused')
    expect(pause.body.mission.cursor).toBe(1)

    // B — approbation de l'étape import, NON consommée.
    const okA = await appeler(approveHandler, 'POST', { missionId: 'ms_replay', stepId: 'st_2' })
    expect(okA.status).toBe(200)
    const oldApprovalId = okA.body.approvalId

    // C — DELETE de la mission A par la route dédiée ; l'accord subsiste.
    await appeler(missionsHandler, 'DELETE', { id: 'ms_replay' })
    expect(stockee()).toBeUndefined()
    expect(etat.store.get(cle(MISSION_APPROVAL_KIND, 'ws_a', oldApprovalId))).toBeDefined()

    // D — Mission B : MÊME id client, mêmes étapes, mêmes outils/params.
    await appeler(missionsHandler, 'POST', { mission: missionDeuxEtapes() })
    const instanceB = stockee().authorityInstanceId
    expect(instanceB).toMatch(/^mai_/)
    expect(instanceB).not.toBe(instanceA)

    // E — B avance jusqu'à la MÊME étape d'approbation.
    etat.runStepCalls = []
    await appeler(runHandler, 'POST', { id: 'ms_replay' })
    const pauseB = await appeler(runHandler, 'POST', { id: 'ms_replay' })
    expect(pauseB.body.mission.status).toBe('paused')
    etat.runStepCalls = []

    // F — l'accord PÉRIMÉ de A est présenté à B : refus total.
    const rejoue = await appeler(runHandler, 'POST', { id: 'ms_replay', approvalId: oldApprovalId })
    expect(rejoue.status).toBe(403)
    expect(rejoue.body.error).toBe('approval_id_mismatch')
    expect(etat.runStepCalls).toHaveLength(0)
    const b = stockee()
    expect(b.status).toBe('paused')
    expect(b.cursor).toBe(1)
    expect(b.steps[1].status).toBe('pending')

    // G — approbation NORMALE de B : identifiant NEUF, exactement une exécution.
    const okB = await appeler(approveHandler, 'POST', { missionId: 'ms_replay', stepId: 'st_2' })
    expect(okB.body.approvalId).not.toBe(oldApprovalId)
    const run = await appeler(runHandler, 'POST', { id: 'ms_replay', approvalId: okB.body.approvalId })
    expect(run.status).toBe(200)
    expect(etat.runStepCalls).toHaveLength(1)
    expect(stockee().steps[1].status).toBe('done')
  })

  it('R2-8 — un authorityInstanceId FORGÉ par le client ne survit pas à la canonicalisation', async () => {
    const r = await appeler(missionsHandler, 'POST', {
      mission: { ...missionDeuxEtapes('ms_forgery'), authorityInstanceId: 'mai_attacker' },
    })
    expect(r.status).toBe(200)
    const m = etat.store.get(cle('mission', 'ws_a', 'ms_forgery'))
    expect(m.authorityInstanceId).not.toBe('mai_attacker')
    expect(m.authorityInstanceId).toMatch(/^mai_[0-9a-f-]{36}$/) // valeur serveur (UUID)
    expect(r.body.mission.authorityInstanceId).toBe(m.authorityInstanceId)
  })

  it('R2-3 — mission HÉRITÉE sans instance : référence legacy déterministe, jamais confondue avec une instance aléatoire', async () => {
    const { missionAuthorityInstanceOf } = await import('../lib/prospector/missionContract')
    const heritee = { id: 'ms_old', createdAt: 1111 }
    const refA = missionAuthorityInstanceOf(heritee)
    expect(refA).toMatch(/^mai_legacy_[0-9a-f]{32}$/)
    expect(missionAuthorityInstanceOf(heritee)).toBe(refA) // déterministe
    expect(missionAuthorityInstanceOf({ id: 'ms_old', createdAt: 2222 })).not.toBe(refA)
    // Une mission neuve porte son instance explicite — le legacy ne s'applique pas.
    expect(missionAuthorityInstanceOf({ id: 'ms_old', createdAt: 1111, authorityInstanceId: 'mai_x' })).toBe('mai_x')
    // Une valeur non-string/blanche retombe sur le legacy — jamais fail open.
    expect(missionAuthorityInstanceOf({ id: 'ms_old', createdAt: 1111, authorityInstanceId: '  ' })).toBe(refA)
  })
})

describe('MA-22/24/25/26 — revalidation d’exécution et non-régressions', () => {
  it('MA-22/24 — étape persistée corrompue (outil inconnu / borne dépassée) refusée AVANT runStep', async () => {
    await appeler(missionsHandler, 'POST', { mission: missionForgee() })
    const m = missionStockee()
    m.steps[0] = { ...m.steps[0], tool: 'exfiltrate_everything' }
    etat.store.set(cle('mission', 'ws_a', 'ms_forge'), m)
    const r = await appeler(runHandler, 'POST', { id: 'ms_forge' })
    expect(r.status).toBe(422)
    expect(r.body.mission.status).toBe('failed')
    expect(etat.runStepCalls).toHaveLength(0)
    // Bornes revalidées à l'exécution, indépendamment de la création.
    expect(validateExecutableStep({ id: 'st_1', tool: 'enrich_companies', params: { limit: 999 } })).toBe(false)
    expect(validateExecutableStep({ id: 'st_1', tool: 'enrich_companies', params: { limit: 5 } })).toBe(true)
  })

  it('R1-3/R1-7 — pare-feu de params à l’EXÉCUTION : vocabulaire fermé, valeurs valides, héritage {} sûr', async () => {
    // Clé étrangère ⇒ inexécutable.
    expect(validateExecutableStep({ id: 's', tool: 'source_companies', params: { limit: 5, exfil: 'x' } })).toBe(false)
    expect(validateExecutableStep({ id: 's', tool: 'create_sequence', params: { name: 'x', workspace: 'other' } })).toBe(false)
    expect(validateExecutableStep({ id: 's', tool: 'import_companies', params: { anything: 1 } })).toBe(false)
    // Valeurs invalides ⇒ inexécutable.
    expect(validateExecutableStep({ id: 's', tool: 'enrich_companies', params: { limit: -1 } })).toBe(false)
    expect(validateExecutableStep({ id: 's', tool: 'enrich_companies', params: { limit: 2.5 } })).toBe(false)
    expect(validateExecutableStep({ id: 's', tool: 'source_companies', params: { sector: '   ' } })).toBe(false)
    expect(validateExecutableStep({ id: 's', tool: 'create_list', params: { name: '' } })).toBe(false)
    // Héritage : l'ABSENCE de clé reste exécutable (pas d'égalité d'octets).
    expect(validateExecutableStep({ id: 's', tool: 'source_companies', params: {} })).toBe(true)
    expect(validateExecutableStep({ id: 's', tool: 'source_companies', params: { limit: 20, sector: 'Tech' } })).toBe(true)
    expect(validateExecutableStep({ id: 's', tool: 'import_companies', params: {} })).toBe(true)
    // Et par la ROUTE : une ligne persistée avec clé étrangère ne s'exécute pas.
    await appeler(missionsHandler, 'POST', { mission: missionForgee() })
    const m = missionStockee()
    m.steps[0].params = { limit: 5, exfil: 'x' }
    etat.store.set(cle('mission', 'ws_a', 'ms_forge'), m)
    const r = await appeler(runHandler, 'POST', { id: 'ms_forge' })
    expect(r.status).toBe(422)
    expect(etat.runStepCalls).toHaveLength(0)
  })

  it('R1-9 — le protocole UI est le protocole sécurisé (pages/missions.tsx)', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'missions.tsx'), 'utf8') as string
    // L'ancien protocole a disparu.
    expect(src.includes('approve: true')).toBe(false)
    expect(src.includes('approve:true')).toBe(false)
    expect(/JSON\.stringify\(\{\s*id,\s*approve\s*\}\)/.test(src)).toBe(false)
    // Le nouveau protocole est présent : approve → approvalId → run.
    expect(src.includes("/api/missions/approve")).toBe(true)
    expect(src.includes('approvalId')).toBe(true)
    expect(/JSON\.stringify\(\{\s*missionId:\s*id,\s*stepId:\s*step\.id\s*\}\)/.test(src)).toBe(true)
    expect(/\{\s*id,\s*approvalId\s*\}/.test(src)).toBe(true)
    // Usage unique : l'identifiant est effacé après le premier run.
    expect(src.includes('approvalId = null')).toBe(true)
  })

  it('MA-24 (défense en profondeur) — le VRAI runStep refuse un outil inconnu en jetant', async () => {
    const reel = await vi.importActual<typeof import('../lib/prospector/missionTools')>('../lib/prospector/missionTools')
    await expect(reel.runStep(
      { id: 'ws_a', kind: 'client' } as any,
      { id: 'st_x', tool: 'unknown_tool' as any, label: '', params: {}, status: 'pending' },
      { context: {} } as any,
      'ws_a',
    )).rejects.toThrow()
  })

  it('MA-25 — les protections cross-espace des leads restent en place (writeLead → upsertLeadChecked, échec ⇒ throw)', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'prospector', 'missionTools.ts'), 'utf8') as string
    expect(src.includes('upsertLeadChecked')).toBe(true)
    expect(src.includes('workspace_conflict')).toBe(true)
    expect(src.includes('MissionWriteError')).toBe(true)
  })

  it('MA-26 — la sortie du planificateur reste persistable telle quelle (chemin produit intact)', async () => {
    // Forme EXACTE produite par /api/missions/plan à ce HEAD.
    const duPlanner = {
      id: 'ms_plan1', title: 'Prospection Tech Paris', request: 'trouve 20 boîtes tech à Paris',
      objective: 'Sourcer et importer', status: 'draft', autonomy: 'create',
      steps: [
        { id: 'st_1', tool: 'source_companies', label: 'Sourcer', params: { limit: 20, sector: 'Technology', location: 'Paris' }, status: 'pending', needsApproval: false },
        { id: 'st_2', tool: 'import_companies', label: 'Importer', params: {}, status: 'pending', needsApproval: true },
      ],
      assumptions: [], missing: [], context: {}, log: [], cursor: 0, createdAt: Date.now(),
    }
    const r = await appeler(missionsHandler, 'POST', { mission: duPlanner })
    expect(r.status).toBe(200)
    expect(r.body.mission.steps.map((s: any) => s.tool)).toEqual(['source_companies', 'import_companies'])
    expect(r.body.mission.steps[0].needsApproval).toBe(false) // lecture : pas d'approbation imposée
    expect(r.body.mission.steps[1].needsApproval).toBe(true)  // écriture : imposée
    // Et l'étape de lecture s'exécute SANS approbation (MA-27, chemin réel).
    const run = await appeler(runHandler, 'POST', { id: 'ms_plan1' })
    expect(run.status).toBe(200)
    expect(etat.runStepCalls).toHaveLength(1)
    expect(run.body.mission.cursor).toBe(1)
  })
})
