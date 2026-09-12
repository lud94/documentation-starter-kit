// JS-020_PERMISSION_CONTROL_V0_001 — CONTRÔLE DE PERMISSION V0 (PC-01…PC-32).
//
// Verrouille l'équation d'autorité effective : acteur ∩ RoleKind canonique ∩
// capacité rôle×action ∩ politique d'espace stricte ∩ périmètre Mission ∩
// approbation canonique — et l'ORDRE : le verdict précède toute consommation
// d'approbation SEC-004. La visibilité UI n'est jamais une autorité.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const etat = vi.hoisted(() => ({
  session: { tenant: { id: 'ws_a', kind: 'client' }, actorId: 'alice@a.fr' } as any,
  store: new Map<string, any>(),
  persisted: [] as Array<{ op: string; kind: string; id: string; ws: string; data?: any }>,
  runStepCalls: [] as any[],
  readOverride: null as null | { ok: false } | { ok: true; value: any },
  workspacePolicy: { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } } as any,
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

vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => {},
  getKey: () => null,
}))

vi.mock('../lib/prospector/missionTools', async (orig) => ({
  ...(await orig<typeof import('../lib/prospector/missionTools')>()),
  runStep: async (...a: any[]) => { etat.runStepCalls.push(a); return { result: 'ok', context: {} } },
}))

vi.mock('../lib/supabase/store', () => ({
  listItems: async (kind: string, ws: string) =>
    [...etat.store.entries()].filter(([k]) => k.startsWith(`${kind}|${ws}|`)).map(([, v]) => v),
  getItemStrict: async (kind: string, id: string, ws: string) =>
    kind === 'workspace_role_assignment' && etat.readOverride
      ? etat.readOverride
      : { ok: true, value: etat.store.get(cle(kind, ws, id)) ?? null },
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
    return v
  },
}))

import permissionsHandler from '../pages/api/permissions'
import missionsHandler from '../pages/api/missions/index'
import runHandler from '../pages/api/missions/run'
import approveHandler from '../pages/api/missions/approve'
import storeHandler from '../pages/api/store/index'
import externalAiHandler from '../pages/api/config/external-ai'
import {
  ROLE_KINDS,
  validateAssignmentsInput,
} from '../lib/prospector/authz/roleAssignment'
import { resolveSalesRole } from '../lib/prospector/authz/roleAssignmentStore'
import {
  ACTION_REFS,
  actionRequiresExternalAI,
  buildAllowedActions,
  evaluatePermission,
  INTRINSIC_ADMIN_WORKSPACE_POLICY,
  isActionRef,
  ROLE_ACTION_POLICY,
} from '../lib/prospector/authz/permissionVerdict'
import { MISSION_APPROVAL_KIND } from '../lib/prospector/missionApprovals'
import { ROLE_CARDS } from '../lib/prospector/proactive/roles/roleCard'

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

const ASSIGNED = (roleKind: any) => ({ state: 'ASSIGNED', roleKind }) as any
const TOOL_ACTIONS = [
  'mission:source_companies', 'mission:import_companies', 'mission:resolve_dirigeants',
  'mission:enrich_companies', 'mission:create_list', 'mission:create_sequence',
] as const

const missionEnrich = (id = 'ms_p') => ({
  id, title: 't', request: 'r', objective: 'o',
  steps: [{ tool: 'enrich_companies', params: { limit: 5 } }],
})

beforeEach(() => {
  etat.session = { tenant: { id: 'ws_a', kind: 'client' }, actorId: 'alice@a.fr' }
  etat.store.clear()
  etat.persisted = []
  etat.runStepCalls = []
  etat.readOverride = null
  etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } }
})

describe('PC-01…PC-04 — résolution du rôle : quatre issues, toutes fermées', () => {
  it('PC-01 — document absent ⇒ SALES_ROLE_UNASSIGNED (résolveur, projection ET exécution)', async () => {
    expect(await resolveSalesRole('ws_a', 'alice@a.fr')).toEqual({ state: 'UNASSIGNED' })
    const proj = await appeler(permissionsHandler, 'GET')
    expect(proj.body.actorRole).toEqual({ state: 'UNASSIGNED' })
    const post = await appeler(missionsHandler, 'POST', { mission: missionEnrich() })
    expect(post.status).toBe(403)
    expect(post.body.state).toBe('SALES_ROLE_UNASSIGNED')
    expect(etat.store.has(cle('mission', 'ws_a', 'ms_p'))).toBe(false)
  })

  it('PC-02 — l’acteur A n’hérite JAMAIS du rôle de l’acteur B', async () => {
    assigner({ 'bob@a.fr': 'HEAD_OF_SALES' })
    expect(await resolveSalesRole('ws_a', 'alice@a.fr')).toEqual({ state: 'UNASSIGNED' })
    expect(await resolveSalesRole('ws_a', 'bob@a.fr')).toEqual({ state: 'ASSIGNED', roleKind: 'HEAD_OF_SALES' })
  })

  it('PC-03 — RoleKind inconnu dans le document ⇒ INVALID ⇒ BLOCKED typé', async () => {
    assigner({ 'alice@a.fr': 'sales_rep' })
    expect(await resolveSalesRole('ws_a', 'alice@a.fr')).toEqual({ state: 'INVALID' })
    const v = evaluatePermission({ role: { state: 'INVALID' }, action: 'mission:read' })
    expect(v).toMatchObject({ state: 'BLOCKED', reason: 'ROLE_ASSIGNMENT_INVALID' })
  })

  it('PC-04 — magasin d’affectation muet ⇒ UNAVAILABLE, DISTINCT de l’absence', async () => {
    etat.readOverride = { ok: false }
    expect(await resolveSalesRole('ws_a', 'alice@a.fr')).toEqual({ state: 'UNAVAILABLE' })
    const v = evaluatePermission({ role: { state: 'UNAVAILABLE' }, action: 'mission:read' })
    expect(v).toMatchObject({ state: 'BLOCKED', reason: 'ROLE_ASSIGNMENT_UNAVAILABLE' })
  })

  it('parité JS-006 — ROLE_KINDS runtime == clés du registre RoleCard (aucune redéfinition divergente)', () => {
    expect([...ROLE_KINDS].sort()).toEqual(Object.keys(ROLE_CARDS).sort())
  })
})

describe('PC-05/06/07 — écriture d’affectation : admin d’infrastructure seul, métadonnées serveur', () => {
  it('PC-05 — une session CLIENT ne peut PAS écrire les affectations', async () => {
    const r = await appeler(permissionsHandler, 'PUT', { assignments: { 'alice@a.fr': 'SDR_BDR' } })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('admin_session_required')
    expect(etat.persisted).toEqual([])
  })

  it('PC-06 — PUT admin : le SERVEUR possède schéma/revision/horodatage ; les métadonnées client sont ignorées', async () => {
    etat.session = { tenant: { id: 'ws_a', kind: 'admin' }, actorId: 'admin@smart.ai' }
    const r = await appeler(permissionsHandler, 'PUT', {
      assignments: { 'alice@a.fr': 'SDR_BDR', 'kim@a.fr': 'ACCOUNT_MANAGER_KAM' },
      schemaVersion: 'forgé', revisionId: 'forgé', updatedAt: 'forgé',
    })
    expect(r.status).toBe(200)
    const doc = etat.store.get(cle('workspace_role_assignment', 'ws_a', 'active'))
    expect(doc.schemaVersion).toBe('role-assignment-v0.1')
    expect(doc.revisionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(doc.revisionId).not.toBe('forgé')
    expect(Number.isFinite(Date.parse(doc.updatedAt))).toBe(true)
    expect(doc.assignments).toEqual({ 'alice@a.fr': 'SDR_BDR', 'kim@a.fr': 'ACCOUNT_MANAGER_KAM' })
    // Map malformée ⇒ 422, rien d'écrit.
    etat.persisted = []
    expect((await appeler(permissionsHandler, 'PUT', { assignments: { 'x@a.fr': 'CEO' } })).status).toBe(422)
    expect(etat.persisted).toEqual([])
    expect(validateAssignmentsInput({ '': 'SDR_BDR' })).toMatchObject({ ok: false })
  })

  it('PC-07 — un RoleKind dans le corps/la query n’affecte JAMAIS le verdict de l’acteur', async () => {
    const r = await appeler(missionsHandler, 'POST',
      { mission: missionEnrich(), roleKind: 'HEAD_OF_SALES', role: 'SDR_BDR' },
      { roleKind: 'SDR_BDR' })
    expect(r.status).toBe(403)
    expect(r.body.state).toBe('SALES_ROLE_UNASSIGNED')
  })
})

describe('PC-08/09/18/19/32 — pare-feux structurels des sources d’autorité', () => {
  const SOURCES = [
    'lib/prospector/authz/roleAssignment.ts',
    'lib/prospector/authz/roleAssignmentStore.ts',
    'lib/prospector/authz/permissionVerdict.ts',
    'pages/api/permissions.ts',
  ]
  const lire = (rel: string) => {
    const fs = require('node:fs')
    const path = require('node:path')
    return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8') as string
  }

  it('PC-08/09/32 — aucune source d’autorité parasite : ni contexte hérité, ni RoleCards, ni contrôle proactif', () => {
    for (const rel of SOURCES) {
      const src = lire(rel)
      for (const interdit of [
        'BusinessContextV0', 'salesV0Context', 'loadBusinessContext',
        'ROLE_CARDS', 'resolveRoleCard', 'autonomyDefaults',
        'resolveMotionControl', 'PLAY_MOTIONS', 'AUTHORIZED_MOTIONS',
        'COMMERCIAL_MOTIONS', 'resolveCommercialMotion',
      ]) {
        expect(src.includes(interdit), `${rel} mentionne « ${interdit} »`).toBe(false)
      }
    }
    // Et les routes d'exécution n'importent pas le contrôle proactif.
    for (const rel of ['pages/api/missions/run.ts', 'pages/api/missions/approve.ts', 'pages/api/missions/index.ts']) {
      expect(lire(rel).includes('resolveMotionControl'), rel).toBe(false)
    }
  })

  it('PC-18 — aucune autorité de propriété inventée (assignedTo/ASSIGNED_ONLY/ownerId absents)', () => {
    for (const rel of SOURCES) {
      const src = lire(rel)
      for (const interdit of ['assignedTo', 'ASSIGNED_ONLY', 'ownerId', 'assigneeId', 'OWNED_BOOK']) {
        expect(src.includes(interdit), `${rel} mentionne « ${interdit} »`).toBe(false)
      }
    }
  })

  it('PC-19 — DEFAULT_PERMISSIONS n’entre JAMAIS dans une décision d’autorité JS-020', () => {
    for (const rel of [...SOURCES, 'pages/api/config/external-ai.ts']) {
      expect(lire(rel).includes('DEFAULT_PERMISSIONS'), rel).toBe(false)
    }
  })
})

describe('PC-10/11 — admin d’infrastructure ≠ rôle Sales', () => {
  it('PC-10/11 — admin non affecté : jamais HEAD_OF_SALES, aucune exécution Sales', async () => {
    etat.session = { tenant: { id: 'ws_a', kind: 'admin' }, actorId: 'admin@smart.ai' }
    expect(await resolveSalesRole('ws_a', 'admin@smart.ai')).toEqual({ state: 'UNASSIGNED' })
    const post = await appeler(missionsHandler, 'POST', { mission: missionEnrich() })
    expect(post.status).toBe(403)
    expect(post.body.state).toBe('SALES_ROLE_UNASSIGNED')
    // L'inspection GET d'infrastructure reste, en LECTURE seule.
    expect((await appeler(missionsHandler, 'GET')).status).toBe(200)
    // Une fois EXPLICITEMENT affecté, l'admin exécute comme tout acteur.
    assigner({ 'admin@smart.ai': 'SDR_BDR' })
    const post2 = await appeler(missionsHandler, 'POST', { mission: missionEnrich() })
    expect(post2.status).toBe(200)
  })
})

describe('PC-12…PC-17 — politique rôle × action et périmètre', () => {
  it('PC-12/13 — SDR_BDR et ACCOUNT_EXECUTIVE : cycle de vie + six outils + lectures', () => {
    // JS-013 a étendu le registre avec monitoring:* (SDR exclu par gel) — la
    // propriété PC-12/13 d'origine porte sur les 13 actions mission+lecture ;
    // la matrice monitoring est verrouillée par tests/account-monitoring.
    const ACTIONS_JS020 = ACTION_REFS.filter((a) => !a.startsWith('monitoring:'))
    for (const roleKind of ['SDR_BDR', 'ACCOUNT_EXECUTIVE'] as const) {
      for (const action of ACTIONS_JS020) {
        const v = evaluatePermission({ role: ASSIGNED(roleKind), action, workspacePolicy: etat.workspacePolicy })
        expect(v.state, `${roleKind} ${action}`).toBe('ALLOWED')
      }
    }
  })

  it('PC-14/15 — AM/KAM et HEAD_OF_SALES : outils ACQUIRE actuels BLOQUÉS, lectures ouvertes', () => {
    for (const roleKind of ['ACCOUNT_MANAGER_KAM', 'HEAD_OF_SALES'] as const) {
      for (const action of TOOL_ACTIONS) {
        const v = evaluatePermission({ role: ASSIGNED(roleKind), action, workspacePolicy: etat.workspacePolicy })
        expect(v, `${roleKind} ${action}`).toMatchObject({ state: 'BLOCKED', reason: 'CAPABILITY_FORBIDDEN' })
      }
      for (const action of ['mission:read', 'read:leads', 'read:lists', 'read:sequences'] as const) {
        expect(evaluatePermission({ role: ASSIGNED(roleKind), action }).state, `${roleKind} ${action}`).toBe('ALLOWED')
      }
      expect(evaluatePermission({ role: ASSIGNED(roleKind), action: 'mission:create' }))
        .toMatchObject({ state: 'BLOCKED', reason: 'CAPABILITY_FORBIDDEN' })
    }
  })

  it('PC-16 — action INCONNUE ⇒ CAPABILITY_FORBIDDEN (registre fermé, aucune action d\u2019ENVOI)', () => {
    for (const inconnue of ['messaging:send', 'messaging:reply', 'messaging:generate', 'send_email', 'mission:exfiltrate', '', 'linkedin_send']) {
      expect(evaluatePermission({ role: ASSIGNED('SDR_BDR'), action: inconnue }))
        .toMatchObject({ state: 'BLOCKED', reason: 'CAPABILITY_FORBIDDEN' })
    }
    // B2B-1 : EXACTEMENT une action messaging (prepare) ; aucune action d'envoi.
    expect((ACTION_REFS as readonly string[]).filter((a) => a.startsWith('messaging'))).toEqual(['messaging:prepare'])
    expect((ACTION_REFS as readonly string[]).some((a) => a.includes('send'))).toBe(false)
  })

  describe('B2B-1 — messaging:prepare : autorité de GÉNÉRATION, jamais d\u2019envoi', () => {
    const POLICY = (permissions: any) => ({ ok: true, state: 'CONFIGURED', permissions }) as any
    const EXT_ON = POLICY({ externalAI: true, messaging: false, leads: false, sequences: false, validate: false })
    const EXT_OFF = POLICY({ externalAI: false, messaging: false, leads: false, sequences: false, validate: false })

    it('A/B/P — registre : messaging:prepare admis ; send/reply/generate refusés ; aucun send', () => {
      expect(isActionRef('messaging:prepare')).toBe(true)
      for (const refuse of ['messaging:send', 'messaging:reply', 'messaging:generate']) {
        expect(isActionRef(refuse), refuse).toBe(false)
      }
      expect((ACTION_REFS as readonly string[]).includes('messaging:send')).toBe(false)
    })

    it('C/D — SDR_BDR et ACCOUNT_EXECUTIVE + externalAI=true ⇒ ALLOWED (sans approbation intrinsèque)', () => {
      for (const roleKind of ['SDR_BDR', 'ACCOUNT_EXECUTIVE'] as const) {
        const v = evaluatePermission({ role: ASSIGNED(roleKind), action: 'messaging:prepare', workspacePolicy: EXT_ON })
        expect(v.state, roleKind).toBe('ALLOWED')
      }
    })

    it('E/F — AM/KAM et HEAD_OF_SALES ⇒ CAPABILITY_FORBIDDEN (pas de pré-autorisation)', () => {
      for (const roleKind of ['ACCOUNT_MANAGER_KAM', 'HEAD_OF_SALES'] as const) {
        expect(evaluatePermission({ role: ASSIGNED(roleKind), action: 'messaging:prepare', workspacePolicy: EXT_ON }), roleKind)
          .toMatchObject({ state: 'BLOCKED', reason: 'CAPABILITY_FORBIDDEN' })
        expect(ROLE_ACTION_POLICY[roleKind].includes('messaging:prepare' as any), roleKind).toBe(false)
      }
    })

    it('G/I/J/K/H — politique d\u2019espace STRICTE : seul externalAI=true explicite passe', () => {
      const sdr = ASSIGNED('SDR_BDR')
      expect(evaluatePermission({ role: sdr, action: 'messaging:prepare', workspacePolicy: EXT_OFF }))
        .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED' })                       // G
      expect(evaluatePermission({ role: sdr, action: 'messaging:prepare', workspacePolicy: { ok: true, state: 'NOT_CONFIGURED' } as any }))
        .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED' })                       // I
      expect(evaluatePermission({ role: sdr, action: 'messaging:prepare', workspacePolicy: { ok: true, state: 'INVALID' } as any }))
        .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED' })                       // J
      expect(evaluatePermission({ role: sdr, action: 'messaging:prepare', workspacePolicy: { ok: false, state: 'UNAVAILABLE' } as any }))
        .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_UNAVAILABLE' })                  // K
      expect(evaluatePermission({ role: ASSIGNED('ACCOUNT_EXECUTIVE'), action: 'messaging:prepare' }))
        .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_UNAVAILABLE' })                  // H
    })

    it('L — la politique intrinsèque de l\u2019espace admin (externalAI=true, indices hérités à false) reste compatible', () => {
      const v = evaluatePermission({ role: ASSIGNED('SDR_BDR'), action: 'messaging:prepare', workspacePolicy: INTRINSIC_ADMIN_WORKSPACE_POLICY })
      expect(v.state).toBe('ALLOWED')
      expect((INTRINSIC_ADMIN_WORKSPACE_POLICY as any).permissions.messaging).toBe(false)
    })

    it('M/N — le drapeau hérité messaging n\u2019est JAMAIS une autorité : ni permission, ni blocage', () => {
      // M — messaging=true n'autorise PAS quand externalAI=false.
      expect(evaluatePermission({ role: ASSIGNED('SDR_BDR'), action: 'messaging:prepare',
        workspacePolicy: POLICY({ externalAI: false, messaging: true, leads: true, sequences: true, validate: true }) }))
        .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED' })
      // N — messaging=false ne bloque PAS quand externalAI=true et rôle/action passent.
      expect(evaluatePermission({ role: ASSIGNED('ACCOUNT_EXECUTIVE'), action: 'messaging:prepare',
        workspacePolicy: POLICY({ externalAI: true, messaging: false, leads: false, sequences: false, validate: false }) }).state)
        .toBe('ALLOWED')
    })

    it('O — buildAllowedActions projette EXACTEMENT une entrée messaging:prepare, alignée sur le verdict', () => {
      const projSdr = buildAllowedActions(ASSIGNED('SDR_BDR'), EXT_ON)
      const entrees = projSdr.filter((a) => a.action === 'messaging:prepare')
      expect(entrees.length).toBe(1)
      expect(entrees[0].state).toBe('ALLOWED')
      const projSdrOff = buildAllowedActions(ASSIGNED('SDR_BDR'), EXT_OFF)
      expect(projSdrOff.find((a) => a.action === 'messaging:prepare'))
        .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED' })
      const projKam = buildAllowedActions(ASSIGNED('ACCOUNT_MANAGER_KAM'), EXT_ON)
      expect(projKam.find((a) => a.action === 'messaging:prepare'))
        .toMatchObject({ state: 'BLOCKED', reason: 'CAPABILITY_FORBIDDEN' })
    })

    it('approbation : messaging:prepare n\u2019exige PAS intrinsèquement SEC-004 (needsApproval non codé en dur)', () => {
      // L'exigence d'approbation reste un INTRANT canonique de l'appelant —
      // le verdict la respecte quand elle est fournie, sans la fabriquer.
      const v = evaluatePermission({ role: ASSIGNED('SDR_BDR'), action: 'messaging:prepare', workspacePolicy: EXT_ON, needsApproval: true })
      expect(v).toMatchObject({ state: 'APPROVAL_REQUIRED' })
    })
  })

  it('PC-17 — resourceScope est EXACTEMENT ALL_WORKSPACE sur tout verdict et toute projection', async () => {
    assigner({ 'alice@a.fr': 'SDR_BDR' })
    const v = evaluatePermission({ role: ASSIGNED('SDR_BDR'), action: 'mission:read' })
    expect(v.resourceScope).toEqual({ kind: 'ALL_WORKSPACE' })
    const proj = await appeler(permissionsHandler, 'GET')
    expect(proj.body.resourceScope).toEqual({ kind: 'ALL_WORKSPACE' })
    for (const a of proj.body.allowedActions) expect(a.resourceScope).toEqual({ kind: 'ALL_WORKSPACE' })
    // Cycle de vie Mission : verrouille aussi la table (mutant KAM/HoS).
    expect(ROLE_ACTION_POLICY.ACCOUNT_MANAGER_KAM).not.toContain('mission:enrich_companies')
    expect(ROLE_ACTION_POLICY.HEAD_OF_SALES).not.toContain('mission:import_companies')
  })
})

describe('PC-20…PC-24 — politique d’espace STRICTE (externalAI)', () => {
  const evalEnrich = (policy: any) => evaluatePermission({
    role: ASSIGNED('SDR_BDR'), action: 'mission:enrich_companies', workspacePolicy: policy,
  })

  it('PC-20 — externalAI === false ⇒ enrich BLOQUÉ', () => {
    expect(evalEnrich({ ok: true, state: 'CONFIGURED', permissions: { externalAI: false } }))
      .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED' })
  })

  it('PC-21 — politique ABSENTE (NOT_CONFIGURED) ⇒ enrich BLOQUÉ — l’absence n’est pas une décision', () => {
    expect(evalEnrich({ ok: true, state: 'NOT_CONFIGURED' }))
      .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED' })
    expect(evalEnrich({ ok: true, state: 'INVALID' }))
      .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_DENIED' })
    expect(evalEnrich(undefined)).toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_UNAVAILABLE' })
  })

  it('PC-22 — magasin de politique MUET ⇒ fail closed typé', () => {
    expect(evalEnrich({ ok: false, state: 'UNAVAILABLE' }))
      .toMatchObject({ state: 'BLOCKED', reason: 'WORKSPACE_POLICY_UNAVAILABLE' })
  })

  it('PC-23 — externalAI === true EXPLICITE ⇒ la porte passe (APPROVAL_REQUIRED, jamais un défaut)', () => {
    const v = evaluatePermission({
      role: ASSIGNED('SDR_BDR'), action: 'mission:enrich_companies',
      workspacePolicy: { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } as any },
      needsApproval: true,
    })
    expect(v.state).toBe('APPROVAL_REQUIRED')
  })

  it('PC-24 — source_companies n’exige PAS externalAI (politique muette sans effet)', () => {
    const v = evaluatePermission({
      role: ASSIGNED('SDR_BDR'), action: 'mission:source_companies',
      workspacePolicy: { ok: false, state: 'UNAVAILABLE' },
    })
    expect(v.state).toBe('ALLOWED')
  })

  it('PC-19 (réel) — le VRAI accesseur strict ne matérialise JAMAIS un blob absent en tout-vrai', async () => {
    // Module RÉEL (le mock de suite est contourné) ; repli mémoire du magasin
    // d'espaces : une ligne SANS blob doit rendre NOT_CONFIGURED, pas un
    // défaut permissif.
    ;(globalThis as any).__prospectorWs = [
      { id: 'ws_noblob', name: 'sans blob' },
      { id: 'ws_config', name: 'configuré', permissions: { messaging: true, leads: true, sequences: true, validate: true, externalAI: false } },
    ]
    const reel = await vi.importActual<typeof import('../lib/supabase/workspaces')>('../lib/supabase/workspaces')
    expect(await reel.getWorkspacePermissionsStrict('ws_noblob')).toEqual({ ok: true, state: 'NOT_CONFIGURED' })
    expect(await reel.getWorkspacePermissionsStrict('ws_absent')).toEqual({ ok: true, state: 'NOT_CONFIGURED' })
    const lu = await reel.getWorkspacePermissionsStrict('ws_config')
    expect(lu).toMatchObject({ ok: true, state: 'CONFIGURED' })
    if (lu.ok === true && lu.state === 'CONFIGURED') expect(lu.permissions.externalAI).toBe(false)
  })

  it('route /api/config/external-ai — strict : true explicite seul permet ; absent/false refusent ; muet ⇒ 503', async () => {
    etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } }
    expect((await appeler(externalAiHandler, 'GET')).body.allowed).toBe(true)
    etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: false } }
    expect((await appeler(externalAiHandler, 'GET')).body.allowed).toBe(false)
    etat.workspacePolicy = { ok: true, state: 'NOT_CONFIGURED' }
    expect((await appeler(externalAiHandler, 'GET')).body.allowed).toBe(false)
    etat.workspacePolicy = { ok: true, state: 'INVALID' }
    expect((await appeler(externalAiHandler, 'GET')).body.allowed).toBe(false)
    etat.workspacePolicy = { ok: false, state: 'UNAVAILABLE' }
    expect((await appeler(externalAiHandler, 'GET')).status).toBe(503)
  })
})

describe('PC-25…PC-29 — le verdict PRÉCÈDE l’approbation ; la projection n’est pas une preuve', () => {
  async function missionEnPause() {
    assigner({ 'alice@a.fr': 'SDR_BDR' })
    await appeler(missionsHandler, 'POST', { mission: missionEnrich() })
    const r = await appeler(runHandler, 'POST', { id: 'ms_p' })
    expect(r.body.mission.status).toBe('paused')
    return etat.store.get(cle('mission', 'ws_a', 'ms_p'))
  }

  it('PC-25 — /approve refusé (rôle sans capacité) ⇒ AUCUN accord créé', async () => {
    await missionEnPause()
    assigner({ 'alice@a.fr': 'ACCOUNT_MANAGER_KAM' }) // rôle changé : capacité perdue
    const r = await appeler(approveHandler, 'POST', { missionId: 'ms_p', stepId: 'st_1' })
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('CAPABILITY_FORBIDDEN')
    expect([...etat.store.keys()].some((k) => k.startsWith(`${MISSION_APPROVAL_KIND}|`))).toBe(false)
  })

  it('PC-25b — cycle de vie PERMIS mais porte OUTIL refusée (politique) ⇒ /approve n’accorde RIEN', async () => {
    // SDR garde mission:approve ; c'est la porte OUTIL (externalAI) qui doit
    // refuser — la porte de cycle de vie ne la REMPLACE pas.
    await missionEnPause()
    etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: false } }
    const r = await appeler(approveHandler, 'POST', { missionId: 'ms_p', stepId: 'st_1' })
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('WORKSPACE_POLICY_DENIED')
    expect([...etat.store.keys()].some((k) => k.startsWith(`${MISSION_APPROVAL_KIND}|`))).toBe(false)
  })

  it('PC-26 — /run refusé (non affecté / capacité) ⇒ ZÉRO runStep', async () => {
    await missionEnPause()
    etat.store.delete(cle('workspace_role_assignment', 'ws_a', 'active'))
    const r = await appeler(runHandler, 'POST', { id: 'ms_p' })
    expect(r.status).toBe(403)
    expect(r.body.state).toBe('SALES_ROLE_UNASSIGNED')
    expect(etat.runStepCalls).toHaveLength(0)
  })

  it('PC-27 — CRITIQUE : politique/rôle révoqués APRÈS l’accord ⇒ refus AVANT consommation, accord INTACT', async () => {
    await missionEnPause()
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_p', stepId: 'st_1' })
    expect(ok.status).toBe(200)
    const grantKey = cle(MISSION_APPROVAL_KIND, 'ws_a', ok.body.approvalId)
    expect(etat.store.get(grantKey)).toBeDefined()

    // Révocation du RÔLE après l'accord.
    etat.store.delete(cle('workspace_role_assignment', 'ws_a', 'active'))
    let r = await appeler(runHandler, 'POST', { id: 'ms_p', approvalId: ok.body.approvalId })
    expect(r.status).toBe(403)
    expect(etat.runStepCalls).toHaveLength(0)
    expect(etat.store.get(grantKey)).toBeDefined() // l'accord n'est PAS brûlé

    // Rôle rétabli mais politique externalAI RETIRÉE après l'accord.
    assigner({ 'alice@a.fr': 'SDR_BDR' })
    etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: false } }
    r = await appeler(runHandler, 'POST', { id: 'ms_p', approvalId: ok.body.approvalId })
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('WORKSPACE_POLICY_DENIED')
    expect(etat.runStepCalls).toHaveLength(0)
    expect(etat.store.get(grantKey)).toBeDefined()

    // Politique rétablie : l'accord d'origine reste consommable — une fois.
    etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: true } }
    r = await appeler(runHandler, 'POST', { id: 'ms_p', approvalId: ok.body.approvalId })
    expect(r.status).toBe(200)
    expect(etat.runStepCalls).toHaveLength(1)
    expect(etat.store.get(grantKey)).toBeUndefined()
  })

  it('PC-28 — action autorisée MAIS à approbation : l’approbation SEC-004 exacte reste exigée', async () => {
    await missionEnPause()
    // Sans approvalId : pause — le rôle affecté ne dispense pas de l'accord.
    const sans = await appeler(runHandler, 'POST', { id: 'ms_p' })
    expect(sans.body.mission.status).toBe('paused')
    expect(etat.runStepCalls).toHaveLength(0)
  })

  it('PC-29 — un AllowedAction fourni par le client n’autorise RIEN', async () => {
    await missionEnPause()
    // KAM : mission:read PASSE la pré-porte R1-2, la capacité OUTIL refuse —
    // c'est bien la branche outil qu'un AllowedAction client ne peut pas court-circuiter.
    assigner({ 'alice@a.fr': 'ACCOUNT_MANAGER_KAM' })
    const r = await appeler(runHandler, 'POST', {
      id: 'ms_p',
      allowedAction: { action: 'mission:enrich_companies', state: 'ALLOWED', resourceScope: { kind: 'ALL_WORKSPACE' } },
      verdict: { state: 'ALLOWED' },
    })
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('CAPABILITY_FORBIDDEN')
    expect(etat.runStepCalls).toHaveLength(0)
  })
})

describe('R1-1 — espace PROPRE de l’admin : externalAI intrinsèque, par IDENTIFIANT seulement', () => {
  const sessionAdminPropre = () => {
    etat.session = { tenant: { id: 'admin', kind: 'admin' }, actorId: 'admin@smart.ai' }
    assigner({ 'admin@smart.ai': 'SDR_BDR' }, 'admin')
    // La politique STRICTE simulée est NOT_CONFIGURED : si le résultat était
    // tiré de la base, tout serait refusé — la permission vient de la règle
    // intrinsèque, pas d'une ligne persistée.
    etat.workspacePolicy = { ok: true, state: 'NOT_CONFIGURED' }
  }

  it('A–F — parcours complet dans l’espace admin, politique DB NOT_CONFIGURED', async () => {
    sessionAdminPropre()
    // A — la route external-ai garde son autorisation intrinsèque.
    expect((await appeler(externalAiHandler, 'GET')).body.allowed).toBe(true)
    // B — la projection ne rend PAS WORKSPACE_POLICY_DENIED pour enrich.
    const proj = await appeler(permissionsHandler, 'GET')
    const enrich = proj.body.allowedActions.find((a: any) => a.action === 'mission:enrich_companies')
    expect(enrich.state).toBe('ALLOWED')
    expect(enrich.reason).not.toBe('WORKSPACE_POLICY_DENIED')
    // C — création d'une mission enrich.
    const post = await appeler(missionsHandler, 'POST', { mission: missionEnrich('ms_adm') })
    expect(post.status).toBe(200)
    // D — run atteint la PAUSE d'approbation SEC-004 normale, pas un refus de politique.
    const pause = await appeler(runHandler, 'POST', { id: 'ms_adm' })
    expect(pause.status).toBe(200)
    expect(pause.body.mission.status).toBe('paused')
    expect(pause.body.awaiting).toBeDefined()
    // E — /approve rend un accord réel.
    const ok = await appeler(approveHandler, 'POST', { missionId: 'ms_adm', stepId: 'st_1' })
    expect(ok.status).toBe(200)
    expect(ok.body.approvalId).toMatch(/^apr_/)
    // F — /run avec l'accord exécute exactement une fois.
    const run = await appeler(runHandler, 'POST', { id: 'ms_adm', approvalId: ok.body.approvalId })
    expect(run.status).toBe(200)
    expect(etat.runStepCalls).toHaveLength(1)
  })

  it('l’exception suit l’IDENTIFIANT d’espace, JAMAIS le genre admin : dans ws_a, la politique CLIENT s’impose', async () => {
    etat.session = { tenant: { id: 'ws_a', kind: 'admin' }, actorId: 'admin@smart.ai' }
    assigner({ 'admin@smart.ai': 'SDR_BDR' })
    etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: false } }
    const post = await appeler(missionsHandler, 'POST', { mission: missionEnrich('ms_cli') })
    expect(post.status).toBe(200)
    const run = await appeler(runHandler, 'POST', { id: 'ms_cli' })
    expect(run.status).toBe(403)
    expect(run.body.reason).toBe('WORKSPACE_POLICY_DENIED')
    expect(etat.runStepCalls).toHaveLength(0)
  })
})

describe('R1-2 — /run : la porte mission:read PRÉCÈDE tout retour terminal', () => {
  const terminale = (status: 'done' | 'cancelled', id = 'ms_term') => {
    etat.store.set(cle('mission', 'ws_a', id), {
      id, title: 't', request: 'r', objective: 'o', status,
      autonomy: 'read_only', steps: [], assumptions: [], missing: [],
      context: {}, log: [], cursor: 0, createdAt: 1, authorityInstanceId: 'mai_t',
    })
  }

  it('acteur NON AFFECTÉ : une mission done/cancelled n’est PAS révélée par /run', async () => {
    for (const status of ['done', 'cancelled'] as const) {
      etat.store.clear()
      etat.runStepCalls = []
      terminale(status)
      const r = await appeler(runHandler, 'POST', { id: 'ms_term' })
      expect(r.status, status).toBe(403)
      expect(r.body.state).toBe('SALES_ROLE_UNASSIGNED')
      expect(r.body.mission).toBeUndefined() // AUCUN contenu de mission divulgué
      expect(etat.runStepCalls).toHaveLength(0)
    }
  })

  it('acteur AFFECTÉ : le retour terminal reste disponible, sans exécution', async () => {
    for (const status of ['done', 'cancelled'] as const) {
      etat.store.clear()
      etat.runStepCalls = []
      assigner({ 'alice@a.fr': 'SDR_BDR' })
      terminale(status)
      const r = await appeler(runHandler, 'POST', { id: 'ms_term' })
      expect(r.status, status).toBe(200)
      expect(r.body.mission.status).toBe(status)
      expect(etat.runStepCalls).toHaveLength(0)
    }
  })
})

describe('R1-3 — mission:approve est une AUTORITÉ de cycle de vie réelle', () => {
  it('acteur non affecté + mission FANTÔME : 403 typé, jamais 404 (aucun oracle d’existence)', async () => {
    const r = await appeler(approveHandler, 'POST', { missionId: 'ms_ghost', stepId: 'st_1' })
    expect(r.status).toBe(403)
    expect(r.body.state).toBe('SALES_ROLE_UNASSIGNED')
    // Aucune information de mission/étape ne fuit dans la réponse.
    expect(r.body.current).toBeUndefined()
  })

  it('verrou structurel : /approve évalue LES DEUX portes — cycle de vie PUIS outil — dans cet ordre', () => {
    const fs = require('node:fs')
    const path = require('node:path')
    const src = fs.readFileSync(path.join(__dirname, '..', 'pages', 'api', 'missions', 'approve.ts'), 'utf8') as string
    const iCycle = src.indexOf("action: 'mission:approve'")
    const iChargement = src.indexOf('missions.find')
    const iOutil = src.indexOf('mission:${step.tool}')
    expect(iCycle).toBeGreaterThan(-1)
    expect(iOutil).toBeGreaterThan(-1)
    // La porte de cycle de vie PRÉCÈDE le chargement de la mission, qui
    // précède la porte d'outil : l'outil ne REMPLACE pas mission:approve.
    expect(iCycle).toBeLessThan(iChargement)
    expect(iChargement).toBeLessThan(iOutil)
  })
})

describe('R1-4 — REFUS DE PERMISSION ⇒ ZÉRO mutation de la mission (R1.1)', () => {
  // Mission DRAFT (jamais en pause) : si le refus mutait, on le verrait —
  // statut, curseur, étape, contexte, journal, et toute écriture persistée.
  const creerDraft = async () => {
    const post = await appeler(missionsHandler, 'POST', { mission: missionEnrich('ms_d') })
    expect(post.status).toBe(200)
    const avant = JSON.parse(JSON.stringify(etat.store.get(cle('mission', 'ws_a', 'ms_d'))))
    expect(avant.status).toBe('draft')
    etat.persisted = [] // on isole les écritures de la tentative REFUSÉE
    return avant
  }

  it('A — refus par CAPACITÉ (KAM) : mission draft strictement intacte, rien persisté', async () => {
    assigner({ 'alice@a.fr': 'SDR_BDR' })
    const avant = await creerDraft()
    // Bascule KAM : mission:read PASSE, l'outil enrich est CAPABILITY_FORBIDDEN.
    assigner({ 'alice@a.fr': 'ACCOUNT_MANAGER_KAM' })
    etat.persisted = []
    const r = await appeler(runHandler, 'POST', { id: 'ms_d' })
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('CAPABILITY_FORBIDDEN')
    expect(etat.runStepCalls).toHaveLength(0)
    // Aucune consommation d'approbation (aucune n'existe, aucune tentée).
    expect(etat.persisted.filter((p) => p.kind === MISSION_APPROVAL_KIND)).toEqual([])
    // ZÉRO écriture mission : le refus ne persiste RIEN.
    expect(etat.persisted.filter((p) => p.kind === 'mission')).toEqual([])
    // La mission stockée est PROFONDÉMENT égale à l'état d'avant la tentative.
    expect(etat.store.get(cle('mission', 'ws_a', 'ms_d'))).toEqual(avant)
    expect(etat.store.get(cle('mission', 'ws_a', 'ms_d')).status).toBe('draft')
  })

  it('B — refus par POLITIQUE D’ESPACE (externalAI=false) : mission draft strictement intacte', async () => {
    assigner({ 'alice@a.fr': 'SDR_BDR' })
    const avant = await creerDraft()
    etat.workspacePolicy = { ok: true, state: 'CONFIGURED', permissions: { externalAI: false } }
    const r = await appeler(runHandler, 'POST', { id: 'ms_d' })
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe('WORKSPACE_POLICY_DENIED')
    expect(etat.runStepCalls).toHaveLength(0)
    expect(etat.persisted.filter((p) => p.kind === MISSION_APPROVAL_KIND)).toEqual([])
    expect(etat.persisted.filter((p) => p.kind === 'mission')).toEqual([])
    expect(etat.store.get(cle('mission', 'ws_a', 'ms_d'))).toEqual(avant)
    expect(etat.store.get(cle('mission', 'ws_a', 'ms_d')).status).toBe('draft')
  })
})

describe('PC-30/31 — frontières du magasin et de la lecture', () => {
  it('PC-30 — workspace_role_assignment est INACCESSIBLE via /api/store (GET/POST/DELETE)', async () => {
    expect((await appeler(storeHandler, 'GET', undefined, { kind: 'workspace_role_assignment' })).status).toBe(400)
    expect((await appeler(storeHandler, 'POST', { kind: 'workspace_role_assignment', item: { id: 'active' } })).status).toBe(400)
    expect((await appeler(storeHandler, 'DELETE', { kind: 'workspace_role_assignment', id: 'active' })).status).toBe(400)
    expect(etat.persisted).toEqual([])
  })

  it('PC-31 — GET /api/permissions : AUCUNE écriture, aucun LLM, aucune revalidation', async () => {
    assigner({ 'alice@a.fr': 'SDR_BDR' })
    etat.persisted = []
    const r = await appeler(permissionsHandler, 'GET')
    expect(r.status).toBe(200)
    expect(etat.persisted).toEqual([]) // zéro upsert/delete/insert
    // Verrou structurel : la chaîne d'autorité ne mentionne aucune frontière
    // d'acquisition (fetch/LLM/recapture).
    const fs = require('node:fs')
    const path = require('node:path')
    for (const rel of [
      'pages/api/permissions.ts',
      'lib/prospector/authz/roleAssignment.ts',
      'lib/prospector/authz/roleAssignmentStore.ts',
      'lib/prospector/authz/permissionVerdict.ts',
    ]) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8') as string
      for (const interdit of ['fetch(', 'callClaude', 'enrichCompanyWeb', 'lookupBySiren', 'lookupByName']) {
        expect(src.includes(interdit), `${rel} mentionne « ${interdit} »`).toBe(false)
      }
    }
  })
})

// ── PFV0-2A — read:accounts : autorité de LECTURE produit générique ─────────
describe('PFV0-2A — read:accounts', () => {
  it('RA-1 — registre : read:accounts admis ; aucune action accounts:write/delete', () => {
    expect(isActionRef('read:accounts')).toBe(true)
    for (const refuse of ['accounts:write', 'accounts:delete', 'attention:read', 'today:read']) {
      expect(isActionRef(refuse), refuse).toBe(false)
    }
  })

  it('RA-2 — les QUATRE rôles Sales canoniques sont autorisés', () => {
    for (const roleKind of ['SDR_BDR', 'ACCOUNT_EXECUTIVE', 'ACCOUNT_MANAGER_KAM', 'HEAD_OF_SALES'] as const) {
      const v = evaluatePermission({ role: ASSIGNED(roleKind), action: 'read:accounts' })
      expect(v.state, roleKind).toBe('ALLOWED')
      expect(ROLE_ACTION_POLICY[roleKind].includes('read:accounts' as any), roleKind).toBe(true)
    }
  })

  it('RA-3 — rôle inconnu/invalide/indisponible/non affecté ⇒ fail closed', () => {
    expect(evaluatePermission({ role: { state: 'UNASSIGNED' } as any, action: 'read:accounts' }).state)
      .toBe('SALES_ROLE_UNASSIGNED')
    expect(evaluatePermission({ role: { state: 'INVALID' } as any, action: 'read:accounts' }))
      .toMatchObject({ state: 'BLOCKED', reason: 'ROLE_ASSIGNMENT_INVALID' })
    expect(evaluatePermission({ role: { state: 'UNAVAILABLE' } as any, action: 'read:accounts' }))
      .toMatchObject({ state: 'BLOCKED', reason: 'ROLE_ASSIGNMENT_UNAVAILABLE' })
  })

  it('RA-4 — lecture pure : aucune exigence externalAI, aucune politique d’espace requise', () => {
    expect(actionRequiresExternalAI('read:accounts')).toBe(false)
    // Sans workspacePolicy fournie : ALLOWED quand même (l'action ne l'exige pas).
    expect(evaluatePermission({ role: ASSIGNED('HEAD_OF_SALES'), action: 'read:accounts' }).state).toBe('ALLOWED')
  })

  it('RA-5 — les drapeaux d’espace hérités (messaging/leads) ne sont JAMAIS l’autorité', () => {
    // Tous les drapeaux hérités à false : read:accounts reste ALLOWED — la
    // politique d'espace n'entre pas dans cette autorité de lecture.
    const policy = { ok: true, state: 'CONFIGURED', permissions: { messaging: false, leads: false, sequences: false, validate: false, externalAI: false } } as any
    expect(evaluatePermission({ role: ASSIGNED('SDR_BDR'), action: 'read:accounts', workspacePolicy: policy }).state).toBe('ALLOWED')
  })

  it('RA-6 — read:accounts n’accorde JAMAIS écriture/envoi/run', () => {
    // L'autorité est UNE action : détenir read:accounts ne change aucun autre
    // verdict. AM/KAM reste CAPABILITY_FORBIDDEN sur les outils ACQUIRE et sur
    // messaging:prepare ; SDR reste interdit de monitoring:run.
    expect(evaluatePermission({ role: ASSIGNED('ACCOUNT_MANAGER_KAM'), action: 'messaging:prepare', workspacePolicy: INTRINSIC_ADMIN_WORKSPACE_POLICY }))
      .toMatchObject({ state: 'BLOCKED', reason: 'CAPABILITY_FORBIDDEN' })
    expect(evaluatePermission({ role: ASSIGNED('SDR_BDR'), action: 'monitoring:run' }))
      .toMatchObject({ state: 'BLOCKED', reason: 'CAPABILITY_FORBIDDEN' })
    // Et le registre ne contient AUCUNE action d'écriture de comptes.
    expect((ACTION_REFS as readonly string[]).filter((a) => a.startsWith('accounts'))).toEqual([])
  })

  it('RA-7 — buildAllowedActions projette read:accounts ALLOWED pour un rôle affecté', () => {
    const actions = buildAllowedActions(ASSIGNED('ACCOUNT_EXECUTIVE'), INTRINSIC_ADMIN_WORKSPACE_POLICY)
    const ra = actions.find((a: any) => a.action === 'read:accounts')
    expect(ra?.state).toBe('ALLOWED')
  })
})
