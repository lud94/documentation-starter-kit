import { describe, it, expect, beforeEach, vi } from 'vitest'

// Lot SEC-0c — suite d'ÉVASION DE TENANT, pilotée par sentinelles.
//
// ── LE PRINCIPE ──────────────────────────────────────────────────────────────
// Les tests précédents vérifient qu'une route passe le bon identifiant d'espace
// à la couche de données. C'est nécessaire, et insuffisant : ils ne prouvent
// rien sur ce qui SORT. Ici, la couche de données est un vrai magasin à deux
// tenants, chacun portant une valeur sentinelle unique. La règle est unique et
// mécanique :
//
//   connecté comme A, aucune réponse ne doit JAMAIS contenir la sentinelle de B
//   connecté comme B, aucune réponse ne doit JAMAIS contenir la sentinelle de A
//
// Et symétriquement pour les mutations : aucune écriture, aucune suppression
// dans l'espace d'autrui, quel que soit l'identifiant fourni.
//
// Le magasin est réel — même sémantique de clé `(kind, id, workspace_id)` que
// `prospector_store`. Un test qui simulerait la couche de données prouverait le
// simulacre ; celui-ci prouve le cloisonnement.

const TENANT_A = 'ws_fabel'
const TENANT_B = 'ws_client_b'
const SENTINEL_A = 'TENANT_A_SECRET_7392'
const SENTINEL_B = 'TENANT_B_SECRET_4911'

// ── Magasin à deux tenants, cloisonné par (kind, id, ws) comme la vraie table ─
type Row = { kind: string; id: string; ws: string; data: any }
let rows: Row[] = []
let leads: { id: string; ws: string; data: any }[] = []

const listItems = vi.fn(async (kind: string, ws: string) =>
  rows.filter((r) => r.kind === kind && r.ws === ws).map((r) => r.data))
const getItem = vi.fn(async (kind: string, id: string, ws: string) =>
  rows.find((r) => r.kind === kind && r.id === id && r.ws === ws)?.data ?? null)
const upsertItem = vi.fn(async (kind: string, id: string, data: any, ws: string) => {
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws)
  if (i >= 0) rows[i].data = data; else rows.push({ kind, id, ws, data })
  return true
})
const deleteItem = vi.fn(async (kind: string, id: string, ws: string) => {
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws)
  if (i >= 0) rows.splice(i, 1)
  return true
})
const listLeads = vi.fn(async (ws: string) => leads.filter((l) => l.ws === ws).map((l) => l.data))
const deleteLead = vi.fn(async (id: string, ws: string) => {
  const i = leads.findIndex((l) => l.id === id && l.ws === ws)
  if (i >= 0) leads.splice(i, 1)
  return true
})
// Reproduit le contrat durci de `upsertLeadChecked` : la table `prospector_leads`
// a une clé primaire sur `id` SEUL, donc la propriété doit être vérifiée.
const upsertLeadChecked = vi.fn(async (lead: any, ws: string) => {
  const existing = leads.find((l) => l.id === lead.id)
  if (existing && existing.ws !== ws) return { ok: false, reason: 'workspace_conflict' }
  if (existing) existing.data = lead
  else leads.push({ id: lead.id, ws, data: lead })
  return { ok: true }
})

const WORKSPACES: Record<string, any> = {
  [TENANT_A]: { id: TENANT_A, name: 'Fabel', status: 'active', permissions: { externalAI: true } },
  [TENANT_B]: { id: TENANT_B, name: 'Client B', status: 'active', permissions: { externalAI: false } },
}
const getWorkspaceById = vi.fn(async (id: string) => WORKSPACES[id] ?? null)

// Compare-and-delete : la propriété est vérifiée DANS la suppression, en une
// seule instruction. `unlinkChannel` s'appuie dessus depuis SEC-TG.
const claimItemIfField = vi.fn(async (kind: string, id: string, ws: string, field: string, expected: string) => {
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws
    && String(r.data?.[field]) === expected)
  return i < 0 ? null : rows.splice(i, 1)[0].data
})
vi.mock('../lib/supabase/store', () => ({
  listItems: (...a: any[]) => (listItems as any)(...a),
  getItem: (...a: any[]) => (getItem as any)(...a),
  upsertItem: (...a: any[]) => (upsertItem as any)(...a),
  deleteItem: (...a: any[]) => (deleteItem as any)(...a),
  claimItemIfField: (...a: any[]) => (claimItemIfField as any)(...a),
}))
vi.mock('../lib/supabase/leads', () => ({
  listLeads: (...a: any[]) => (listLeads as any)(...a),
  deleteLead: (...a: any[]) => (deleteLead as any)(...a),
  upsertLeadChecked: (...a: any[]) => (upsertLeadChecked as any)(...a),
}))
vi.mock('../lib/supabase/workspaces', () => ({
  getWorkspaceById: (...a: any[]) => (getWorkspaceById as any)(...a),
  listWorkspaces: async () => Object.values(WORKSPACES),
}))
vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => {},
  getKey: (n: string) => (n === 'ANTHROPIC_API_KEY' ? 'k' : n === 'TELEGRAM_BOT_TOKEN' ? 'tg' : ''),
  setKeys: async () => {}, hasKey: () => true, keySource: () => 'app', MANAGED_KEYS: [],
}))
// Le cerveau LLM RENVOIE les données qu'on lui donne : s'il pouvait voir la
// sentinelle de B, elle apparaîtrait dans la réponse. C'est volontaire.
vi.mock('../lib/prospector/jarvisAgent', () => ({
  planJarvis: vi.fn(async () => ({ reply: 'ok', action: null })),
  executeJarvis: vi.fn(async (_t: any, _a: any, ws: string) =>
    `contenu de ${ws} : ${rows.filter((r) => r.ws === ws).map((r) => JSON.stringify(r.data)).join(' ')}`),
  isWrite: () => false,
}))
vi.mock('../lib/prospector/missionTools', () => ({
  runStep: vi.fn(async () => ({ result: 'ok', context: {} })),
}))

import leadsHandler from '../pages/api/leads/index'
import storeHandler from '../pages/api/store/index'
import missionsHandler from '../pages/api/missions/index'
import chatHandler from '../pages/api/jarvis/chat'
import pairHandler from '../pages/api/channels/pair'
import wsHandler from '../pages/api/workspaces/index'
import activeHandler from '../pages/api/workspaces/active'
import meHandler from '../pages/api/auth/me'
import externalAiHandler from '../pages/api/config/external-ai'
import { createSessionToken, SESSION_COOKIE } from '../lib/auth/session'
import { useTestSessionSecret, forgeSession, futureExp } from './helpers/session'

const ACTIVE_WS_COOKIE = 'ps_active_ws'

function mockRes() {
  const r: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> }
  r.status = (c: number) => { r.statusCode = c; return r }
  r.json = (b: any) => { r.body = b; return r }
  r.setHeader = (k: string, v: string) => { r.headers[k] = v }
  r.end = () => r
  return r
}
const session = (ws: string) => createSessionToken(`user@${ws}.fr`, 3600, { role: 'client', ws })

/** Sérialisation complète d'une réponse — corps ET en-têtes. */
const seen = (res: any) => JSON.stringify(res.body ?? null) + JSON.stringify(res.headers ?? {})

// SEC-AUTH-0 : plus aucun secret par défaut — la suite doit poser le sien.
useTestSessionSecret()

beforeEach(() => {
  useTestSessionSecret()
  rows = [
    { kind: 'sequence', id: 'seq_a', ws: TENANT_A, data: { id: 'seq_a', note: SENTINEL_A } },
    { kind: 'sequence', id: 'seq_b', ws: TENANT_B, data: { id: 'seq_b', note: SENTINEL_B } },
    { kind: 'mission', id: 'm_a', ws: TENANT_A, data: { id: 'm_a', title: SENTINEL_A, steps: [], cursor: 0, log: [] } },
    { kind: 'mission', id: 'm_b', ws: TENANT_B, data: { id: 'm_b', title: SENTINEL_B, steps: [], cursor: 0, log: [] } },
    { kind: 'pairlink', id: 'tg:111', ws: TENANT_A, data: { id: 'tg:111', ws: TENANT_A, label: SENTINEL_A, at: 1 } },
    { kind: 'pairlink', id: 'tg:222', ws: '_channels', data: { id: 'tg:222', ws: TENANT_B, label: SENTINEL_B, at: 1 } },
  ]
  // Les liens de canal vivent dans le namespace TECHNIQUE partagé : on les y
  // place réellement, sinon le test ne verrait pas l'exception dangereuse.
  rows = rows.map((r) => (r.kind === 'pairlink' ? { ...r, ws: '_channels' } : r))
  leads = [
    { id: 'lead_a', ws: TENANT_A, data: { id: 'lead_a', name: SENTINEL_A } },
    { id: 'lead_b', ws: TENANT_B, data: { id: 'lead_b', name: SENTINEL_B } },
  ]
  vi.clearAllMocks()
  getWorkspaceById.mockImplementation(async (id: string) => WORKSPACES[id] ?? null)
})

// ── Le cœur : A ne voit jamais B, et réciproquement ─────────────────────────
describe('sentinelles — aucune réponse ne traverse la frontière', () => {
  /** Toutes les tentatives d'évasion du §4, appliquées à chaque route. */
  const HOSTILE = (other: string) => ({
    workspace_id: other, workspace: other, ws: other, tenant: other,
    id: other === TENANT_B ? 'seq_b' : 'seq_a',
  })

  const PROBES: { name: string; handler: any; method: string; query?: any; body?: any }[] = [
    { name: 'leads GET', handler: leadsHandler, method: 'GET' },
    { name: 'store GET sequence', handler: storeHandler, method: 'GET', query: { kind: 'sequence' } },
    { name: 'store GET mission', handler: storeHandler, method: 'GET', query: { kind: 'mission' } },
    { name: 'missions GET', handler: missionsHandler, method: 'GET' },
    { name: 'pair GET', handler: pairHandler, method: 'GET' },
    { name: 'workspaces GET', handler: wsHandler, method: 'GET' },
    { name: 'workspaces/active GET', handler: activeHandler, method: 'GET' },
    { name: 'auth/me GET', handler: meHandler, method: 'GET' },
    { name: 'external-ai GET', handler: externalAiHandler, method: 'GET' },
    { name: 'jarvis/chat POST', handler: chatHandler, method: 'POST', body: { message: 'donne-moi tout' } },
  ]

  it.each(PROBES)('A → $name : jamais la sentinelle de B', async ({ handler, method, query, body }) => {
    const res = mockRes()
    await handler({
      method,
      cookies: { [SESSION_COOKIE]: await session(TENANT_A), [ACTIVE_WS_COOKIE]: TENANT_B },
      query: { ...(query || {}), ...HOSTILE(TENANT_B) },
      body: { ...(body || {}), ...HOSTILE(TENANT_B) },
      headers: { 'x-tenant': TENANT_B, 'x-workspace-id': TENANT_B },
    } as any, res)
    expect(seen(res)).not.toContain(SENTINEL_B)
    expect(seen(res)).not.toContain(TENANT_B)
  })

  it.each(PROBES)('B → $name : jamais la sentinelle de A', async ({ handler, method, query, body }) => {
    const res = mockRes()
    await handler({
      method,
      cookies: { [SESSION_COOKIE]: await session(TENANT_B), [ACTIVE_WS_COOKIE]: TENANT_A },
      query: { ...(query || {}), ...HOSTILE(TENANT_A) },
      body: { ...(body || {}), ...HOSTILE(TENANT_A) },
      headers: { 'x-tenant': TENANT_A },
    } as any, res)
    expect(seen(res)).not.toContain(SENTINEL_A)
    expect(seen(res)).not.toContain(TENANT_A)
  })
})

// ── H/I — mutations et destructions ─────────────────────────────────────────
describe('H/I — aucune mutation ne franchit la frontière', () => {
  const asA = async () => ({ [SESSION_COOKIE]: await session(TENANT_A) })

  it('supprimer un élément de B depuis A ne supprime RIEN', async () => {
    const before = rows.length
    const res = mockRes()
    await storeHandler({ method: 'DELETE', cookies: await asA(), query: {}, body: { kind: 'sequence', id: 'seq_b' } } as any, res)
    expect(rows.find((r) => r.id === 'seq_b')).toBeTruthy()
    expect(rows).toHaveLength(before)
    // La suppression a bien été TENTÉE — dans l'espace de A, où l'id n'existe pas.
    for (const call of deleteItem.mock.calls) expect(call[2]).toBe(TENANT_A)
  })

  it('supprimer une mission de B depuis A ne supprime RIEN', async () => {
    const res = mockRes()
    await missionsHandler({ method: 'DELETE', cookies: await asA(), query: {}, body: { id: 'm_b' } } as any, res)
    expect(rows.find((r) => r.id === 'm_b')).toBeTruthy()
  })

  it('supprimer un lead de B depuis A ne supprime RIEN', async () => {
    const res = mockRes()
    await leadsHandler({ method: 'DELETE', cookies: await asA(), query: {}, body: { id: 'lead_b' } } as any, res)
    expect(leads.find((l) => l.id === 'lead_b')).toBeTruthy()
    expect(leads.find((l) => l.id === 'lead_b')!.ws).toBe(TENANT_B)
  })

  it('ÉCRASER un lead de B depuis A est refusé, et ne DÉPLACE pas la ligne', async () => {
    // `prospector_leads` a une clé primaire sur `id` SEUL : un upsert naïf
    // aurait réécrit `workspace_id` et volé la ligne.
    const res = mockRes()
    await leadsHandler({
      method: 'POST', cookies: await asA(), query: {},
      body: { lead: { id: 'lead_b', name: 'VOLE-PAR-A' } },
    } as any, res)
    const row = leads.find((l) => l.id === 'lead_b')!
    expect(row.ws).toBe(TENANT_B)
    expect(row.data.name).toBe(SENTINEL_B)
    expect(res.body.rejected?.[0]?.reason).toBe('workspace_conflict')
  })

  it('écrire dans le store de B depuis A écrit dans l\'espace de A', async () => {
    const res = mockRes()
    await storeHandler({
      method: 'POST', cookies: await asA(), query: {},
      body: { kind: 'sequence', item: { id: 'seq_b', note: 'INJECTE-PAR-A' } },
    } as any, res)
    // La ligne de B est intacte…
    expect(rows.find((r) => r.id === 'seq_b' && r.ws === TENANT_B)!.data.note).toBe(SENTINEL_B)
    // …et l'écriture a atterri chez A, sous le même identifiant. La clé
    // primaire composite rend les deux lignes indépendantes.
    expect(rows.find((r) => r.id === 'seq_b' && r.ws === TENANT_A)!.data.note).toBe('INJECTE-PAR-A')
  })

  it('G — délier le canal Telegram de B depuis A échoue', async () => {
    const res = mockRes()
    await pairHandler({ method: 'DELETE', cookies: await asA(), query: {}, body: { id: 'tg:222' } } as any, res)
    expect(res.body.ok).toBe(false)
    expect(rows.find((r) => r.id === 'tg:222')).toBeTruthy()
  })
})

// ── N/O/P/Q/R/S — les tenants spéciaux et les états dégradés ────────────────
describe('N/O/P/Q/R/S — admin, _system, inexistant, suspendu, session absente', () => {
  const ALL: [string, any, string, any][] = [
    ['leads', leadsHandler, 'GET', {}],
    ['store', storeHandler, 'GET', { kind: 'sequence' }],
    ['missions', missionsHandler, 'GET', {}],
    ['pair', pairHandler, 'GET', {}],
    ['external-ai', externalAiHandler, 'GET', {}],
  ]

  it('N — un client ne peut pas revendiquer l\'espace « admin »', async () => {
    for (const [, handler, method, query] of ALL) {
      const res = mockRes()
      await handler({ method, cookies: { [SESSION_COOKIE]: await session('admin') }, query, body: {} } as any, res)
      expect(res.statusCode).toBe(403)
    }
  })

  it('O — un client ne peut pas revendiquer « _system »', async () => {
    for (const [, handler, method, query] of ALL) {
      const res = mockRes()
      await handler({ method, cookies: { [SESSION_COOKIE]: await session('_system') }, query, body: {} } as any, res)
      expect(res.statusCode).toBe(403)
    }
  })

  it('P — espace INEXISTANT dans un jeton pourtant signé → refus', async () => {
    for (const [, handler, method, query] of ALL) {
      const res = mockRes()
      await handler({ method, cookies: { [SESSION_COOKIE]: await session('ws_fantome') }, query, body: {} } as any, res)
      expect(res.statusCode).toBe(403)
    }
  })

  it('Q — espace SUSPENDU pendant la vie de la session → refus IMMÉDIAT', async () => {
    getWorkspaceById.mockImplementation(async (id: string) =>
      id === TENANT_A ? { ...WORKSPACES[TENANT_A], status: 'suspended' } : WORKSPACES[id] ?? null)
    for (const [, handler, method, query] of ALL) {
      const res = mockRes()
      await handler({ method, cookies: { [SESSION_COOKIE]: await session(TENANT_A) }, query, body: {} } as any, res)
      expect(res.statusCode).toBe(403)
    }
    expect(listLeads).not.toHaveBeenCalled()
    expect(listItems).not.toHaveBeenCalled()
  })

  it('base indisponible → refus, pas un espace supposé', async () => {
    getWorkspaceById.mockRejectedValue(new Error('db down'))
    const res = mockRes()
    await leadsHandler({ method: 'GET', cookies: { [SESSION_COOKIE]: await session(TENANT_A) }, query: {}, body: {} } as any, res)
    expect(res.statusCode).toBe(403)
    expect(listLeads).not.toHaveBeenCalled()
  })

  it.each([
    ['R — jeton forgé', 'charge.utile.forgee'],
    ['R — jeton expiré', ''],
    ['S — aucune session', undefined],
  ])('%s → refus partout, aucune donnée', async (_label, token) => {
    const value = token === '' ? await createSessionToken('x@y.z', -10, { role: 'client', ws: TENANT_A }) : token
    for (const [, handler, method, query] of ALL) {
      const res = mockRes()
      await handler({ method, cookies: value === undefined ? {} : { [SESSION_COOKIE]: value }, query, body: {} } as any, res)
      expect(res.statusCode).toBe(403)
      expect(seen(res)).not.toContain(SENTINEL_A)
      expect(seen(res)).not.toContain(SENTINEL_B)
    }
  })
})

// ── Oracle d'existence ──────────────────────────────────────────────────────
describe('aucune réponse ne révèle qu\'un espace ou une ressource existe', () => {
  it('espace inexistant et espace d\'autrui donnent la MÊME réponse', async () => {
    const a = mockRes(); const b = mockRes()
    await leadsHandler({ method: 'GET', cookies: { [SESSION_COOKIE]: await session('ws_fantome') }, query: {}, body: {} } as any, a)
    await leadsHandler({ method: 'GET', cookies: { [SESSION_COOKIE]: await session('admin') }, query: {}, body: {} } as any, b)
    expect(a.statusCode).toBe(b.statusCode)
    expect(a.body).toEqual(b.body)
  })

  it('ressource inexistante et ressource d\'autrui donnent la MÊME réponse', async () => {
    const cookies = { [SESSION_COOKIE]: await session(TENANT_A) }
    const a = mockRes(); const b = mockRes()
    await storeHandler({ method: 'DELETE', cookies, query: {}, body: { kind: 'sequence', id: 'seq_b' } } as any, a)
    await storeHandler({ method: 'DELETE', cookies, query: {}, body: { kind: 'sequence', id: 'seq_inexistante' } } as any, b)
    expect(a.statusCode).toBe(b.statusCode)
    expect(a.body).toEqual(b.body)
  })
})

// ── L — cache ───────────────────────────────────────────────────────────────
// Le cloisonnement du cache LLM est prouvé par `tests/tenant-gateway-cache.ts`
// (lot MT-0b) : partitions de stockage distinctes, identités de clé distinctes,
// et l'entrée d'un tenant illisible par l'autre. Il n'est pas redupliqué ici —
// `cacheDigest` n'est pas exporté, et l'exporter pour un test élargirait la
// surface publique de la passerelle sans rien prouver de plus.
