import { describe, it, expect, beforeEach, vi } from 'vitest'

// Lot SEC-0b — la frontière tenant sur les routes MÉTIER authentifiées.
//
// ── LES FAIL-OPEN MESURÉS ────────────────────────────────────────────────────
// Six routes résolvaient leur espace avec `activeWs()` / `activeWorkspace()`,
// deux copies locales d'une même forme :
//
//   const isAdmin = !claims || claims.role === 'admin' || !claims.role
//   return isAdmin ? (cookie || 'admin') : (claims?.ws || 'admin')
//
// Trois replis y cohabitaient :
//   1. AUCUNE SESSION valait administrateur ;
//   2. un CLIENT SANS ESPACE lisait et écrivait dans l'espace ADMIN ;
//   3. le cookie d'espace actif d'un admin n'était jamais vérifié en base —
//      un espace inexistant ou SUSPENDU devenait un espace de travail.
//
// `resolveTenantFromRequest` (MT-0) refusait déjà les trois. Ce lot en fait la
// seule racine de confiance des routes métier, et supprime les copies locales.

const listItems = vi.fn()
const upsertItem = vi.fn()
const deleteItem = vi.fn()
const listLeads = vi.fn()
const upsertLeadChecked = vi.fn()
const deleteLead = vi.fn()
const getWorkspaceById = vi.fn()
const supabaseFrom = vi.fn()
const supabaseConfigured = vi.fn()

vi.mock('../lib/supabase/store', () => ({
  listItems: (...a: any[]) => listItems(...a),
  upsertItem: (...a: any[]) => upsertItem(...a),
  deleteItem: (...a: any[]) => deleteItem(...a),
  getItem: vi.fn(),
}))
vi.mock('../lib/supabase/leads', () => ({
  listLeads: (...a: any[]) => listLeads(...a),
  upsertLeadChecked: (...a: any[]) => upsertLeadChecked(...a),
  deleteLead: (...a: any[]) => deleteLead(...a),
}))
vi.mock('../lib/supabase/workspaces', () => ({
  getWorkspaceById: (...a: any[]) => getWorkspaceById(...a),
  listWorkspaces: vi.fn(async () => []),
}))
vi.mock('../lib/supabase/client', () => ({
  supabase: () => ({ from: (...a: any[]) => supabaseFrom(...a) }),
  supabaseConfigured: (...a: any[]) => supabaseConfigured(...a),
}))
vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => {},
  getKey: (n: string) => (n === 'ANTHROPIC_API_KEY' ? 'test-key' : ''),
  setKeys: async () => {},
  hasKey: () => true,
  keySource: () => 'app',
  MANAGED_KEYS: [],
}))
// La passerelle LLM n'est pas le sujet : on l'immobilise pour que le refus
// tenant soit la SEULE raison possible d'un 403.
vi.mock('../lib/prospector/jarvisAgent', () => ({
  planJarvis: vi.fn(async () => ({ reply: 'ok', action: null })),
  executeJarvis: vi.fn(async () => 'fait'),
  isWrite: () => false,
}))
vi.mock('../lib/prospector/missionTools', () => ({
  runStep: vi.fn(async () => ({ result: 'ok', context: {} })),
}))

import leadsHandler from '../pages/api/leads/index'
import storeHandler from '../pages/api/store/index'
import missionsHandler from '../pages/api/missions/index'
import runHandler from '../pages/api/missions/run'
import chatHandler from '../pages/api/jarvis/chat'
import pairHandler from '../pages/api/channels/pair'
import dbCheckHandler from '../pages/api/config/db-check'
import { createSessionToken, SESSION_COOKIE } from '../lib/auth/session'

const ACTIVE_WS_COOKIE = 'ps_active_ws'

function mockRes() {
  const r: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> }
  r.status = (c: number) => { r.statusCode = c; return r }
  r.json = (b: any) => { r.body = b; return r }
  r.setHeader = (k: string, v: string) => { r.headers[k] = v }
  return r
}
const req = (method: string, cookies: Record<string, string> = {}, body?: any, query: any = {}) =>
  ({ method, cookies, body, query } as any)

const clientSession = (ws: string) => createSessionToken('client@fabel.fr', 3600, { role: 'client', ws })
const adminSession = () => createSessionToken('admin@smart.ai', 3600, { role: 'admin' })

/** Les six routes métier migrées, avec un appel GET/POST inoffensif chacune. */
const ROUTES: { name: string; handler: any; method: string; body?: any; query?: any }[] = [
  { name: 'leads', handler: leadsHandler, method: 'GET' },
  { name: 'store', handler: storeHandler, method: 'GET', query: { kind: 'sequence' } },
  { name: 'missions', handler: missionsHandler, method: 'GET' },
  { name: 'missions/run', handler: runHandler, method: 'POST', body: { id: 'm1' } },
  { name: 'jarvis/chat', handler: chatHandler, method: 'POST', body: { message: 'salut' } },
  { name: 'channels/pair', handler: pairHandler, method: 'GET' },
]

/** Toute opération métier — persistance ou lecture — sur l'une des six routes. */
const BUSINESS = () => [listItems, upsertItem, deleteItem, listLeads, upsertLeadChecked, deleteLead]

beforeEach(() => {
  listItems.mockReset().mockResolvedValue([])
  upsertItem.mockReset().mockResolvedValue(true)
  deleteItem.mockReset().mockResolvedValue(true)
  listLeads.mockReset().mockResolvedValue([])
  upsertLeadChecked.mockReset().mockResolvedValue({ ok: true })
  deleteLead.mockReset().mockResolvedValue(true)
  getWorkspaceById.mockReset().mockImplementation(async (id: string) => ({ id, name: id, status: 'active' }))
  supabaseConfigured.mockReset().mockReturnValue(true)
  supabaseFrom.mockReset().mockReturnValue({
    select: () => ({ limit: async () => ({ error: null }) }),
  })
})

// ── A — aucune session ───────────────────────────────────────────────────────
describe('A — aucune session : refus, et aucune opération métier', () => {
  it.each(ROUTES)('$name → 403', async ({ handler, method, body, query }) => {
    const res = mockRes()
    await handler(req(method, {}, body, query), res)
    expect(res.statusCode).toBe(403)
    for (const fn of BUSINESS()) expect(fn).not.toHaveBeenCalled()
  })

  it.each(ROUTES)('$name → jeton EXPIRÉ vaut absence de session', async ({ handler, method, body, query }) => {
    const expired = await createSessionToken('a@b.c', -10, { role: 'admin' })
    const res = mockRes()
    await handler(req(method, { [SESSION_COOKIE]: expired }, body, query), res)
    expect(res.statusCode).toBe(403)
    for (const fn of BUSINESS()) expect(fn).not.toHaveBeenCalled()
  })

  it.each(ROUTES)('$name → jeton FORGÉ vaut absence de session', async ({ handler, method, body, query }) => {
    const res = mockRes()
    await handler(req(method, { [SESSION_COOKIE]: 'forge.signature' }, body, query), res)
    expect(res.statusCode).toBe(403)
    for (const fn of BUSINESS()) expect(fn).not.toHaveBeenCalled()
  })
})

// ── B/C/E — le tenant du client est imposé, et rien ne le déplace ────────────
describe('B/C/E — l\'espace du client vient de sa session signée, uniquement', () => {
  it('B — leads : la session Fabel impose ws_fabel', async () => {
    const res = mockRes()
    await leadsHandler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') }), res)
    expect(res.statusCode).toBe(200)
    expect(listLeads).toHaveBeenCalledWith('ws_fabel')
    expect(res.body.workspace).toBe('ws_fabel')
  })

  it('B — store / missions / pair : même espace imposé', async () => {
    for (const [handler, query] of [[storeHandler, { kind: 'sequence' }], [missionsHandler, {}], [pairHandler, {}]] as any) {
      listItems.mockClear()
      const res = mockRes()
      await handler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') }, undefined, query), res)
      expect(res.statusCode).toBe(200)
      for (const call of listItems.mock.calls) {
        // `pair` lit un espace TECHNIQUE partagé puis filtre sur `ws` : sa
        // portée est vérifiée séparément, plus bas.
        if (call[1] !== '_channels') expect(call[1]).toBe('ws_fabel')
      }
    }
  })

  it('C — cookie ps_active_ws=Client B sur une session client Fabel → sans effet', async () => {
    const cookies = {
      [SESSION_COOKIE]: await clientSession('ws_fabel'),
      [ACTIVE_WS_COOKIE]: 'ws_client_b',
    }
    const res = mockRes()
    await leadsHandler(req('GET', cookies), res)
    expect(listLeads).toHaveBeenCalledWith('ws_fabel')

    listItems.mockClear()
    const res2 = mockRes()
    await storeHandler(req('GET', cookies, undefined, { kind: 'sequence' }), res2)
    expect(listItems).toHaveBeenCalledWith('sequence', 'ws_fabel')
    // Depuis SEC-0c la branche client vérifie AUSSI son espace en base — mais
    // toujours le SIEN. Le cookie ne détermine jamais l'espace interrogé.
    for (const call of getWorkspaceById.mock.calls) expect(call[0]).toBe('ws_fabel')
  })

  it('E — body/query workspace_id n\'ont aucune influence', async () => {
    const cookies = { [SESSION_COOKIE]: await clientSession('ws_fabel') }
    const hostile = { workspace_id: 'ws_client_b', ws: 'ws_client_b', workspace: 'ws_client_b', tenant: 'ws_client_b' }

    const res = mockRes()
    await leadsHandler(req('GET', cookies, hostile, hostile), res)
    expect(listLeads).toHaveBeenCalledWith('ws_fabel')

    listItems.mockClear()
    const res2 = mockRes()
    await storeHandler(req('GET', cookies, hostile, { kind: 'sequence', ...hostile }), res2)
    expect(listItems).toHaveBeenCalledWith('sequence', 'ws_fabel')

    upsertItem.mockClear()
    const res3 = mockRes()
    await missionsHandler(req('POST', cookies, { mission: { id: 'm1' }, ...hostile }), res3)
    expect(upsertItem).toHaveBeenCalledWith('mission', 'm1', expect.anything(), 'ws_fabel')
  })
})

// ── D — le repli le plus dangereux ──────────────────────────────────────────
describe('D — un client SANS espace ne retombe jamais sur « admin »', () => {
  it.each(ROUTES)('$name → 403, et rien n\'est lu ni écrit', async ({ handler, method, body, query }) => {
    const res = mockRes()
    await handler(req(method, { [SESSION_COOKIE]: await clientSession('') }, body, query), res)
    expect(res.statusCode).toBe(403)
    for (const fn of BUSINESS()) {
      for (const call of fn.mock.calls) expect(call).not.toContain('admin')
      expect(fn).not.toHaveBeenCalled()
    }
  })
})

// ── F/G/H — l'administrateur, et la vérification de son espace actif ────────
describe('F/G/H — l\'admin travaille, mais son espace est VÉRIFIÉ', () => {
  it('F — admin sans cookie → son propre espace « admin », sans requête base', async () => {
    const res = mockRes()
    await leadsHandler(req('GET', { [SESSION_COOKIE]: await adminSession() }), res)
    expect(res.statusCode).toBe(200)
    expect(listLeads).toHaveBeenCalledWith('admin')
    // « admin » est ici une DÉCISION du résolveur, pas un repli : l'espace propre
    // de l'administrateur n'a pas de ligne en base, il est valide par construction.
    expect(getWorkspaceById).not.toHaveBeenCalled()
  })

  it('G — admin sélectionnant Client B (valide) → Client B', async () => {
    const res = mockRes()
    await leadsHandler(req('GET', {
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_client_b',
    }), res)
    expect(res.statusCode).toBe(200)
    expect(getWorkspaceById).toHaveBeenCalledWith('ws_client_b')
    expect(listLeads).toHaveBeenCalledWith('ws_client_b')
  })

  it('H — espace INEXISTANT → 403, jamais un repli sur « admin »', async () => {
    getWorkspaceById.mockResolvedValue(null)
    const res = mockRes()
    await leadsHandler(req('GET', {
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_invente',
    }), res)
    expect(res.statusCode).toBe(403)
    expect(listLeads).not.toHaveBeenCalled()
  })

  it('H — espace SUSPENDU → 403', async () => {
    getWorkspaceById.mockResolvedValue({ id: 'ws_client_b', status: 'suspended' })
    const res = mockRes()
    await storeHandler(req('GET', {
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_client_b',
    }, undefined, { kind: 'sequence' }), res)
    expect(res.statusCode).toBe(403)
    expect(listItems).not.toHaveBeenCalled()
  })

  it('H — base indisponible → 403 (fail closed), pas un espace deviné', async () => {
    getWorkspaceById.mockRejectedValue(new Error('db down'))
    const res = mockRes()
    await leadsHandler(req('GET', {
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_client_b',
    }), res)
    expect(res.statusCode).toBe(403)
    expect(listLeads).not.toHaveBeenCalled()
  })

  it('l\'admin ne peut pas revendiquer le tenant SYSTÈME par le cookie', async () => {
    const res = mockRes()
    await leadsHandler(req('GET', {
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: '_system',
    }), res)
    expect(res.statusCode).toBe(403)
    expect(listLeads).not.toHaveBeenCalled()
  })
})

// ── Un seul espace par requête, sur les deux routes LLM ─────────────────────
describe('routes LLM : l\'espace de PERSISTANCE est celui du tenant', () => {
  it('missions/run — le même espace sert au tenant et au magasin', async () => {
    const res = mockRes()
    await runHandler(req('POST', {
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_client_b',
    }, { id: 'm1' }), res)
    // Deux résolveurs coexistaient : `activeWs()` rendait le cookie SANS
    // vérification pour le magasin, pendant que le tenant, lui, était vérifié.
    expect(listItems).toHaveBeenCalledWith('mission', 'ws_client_b')
  })

  it('jarvis/chat — un refus tenant précède la lecture des réglages', async () => {
    const res = mockRes()
    await chatHandler(req('POST', {}, { message: 'salut' }), res)
    expect(res.statusCode).toBe(403)
    // Et surtout : pas de `{ off: true }`, qui aurait appris à un anonyme
    // qu'une clé Anthropic est ou n'est pas configurée.
    expect(res.body.off).toBeUndefined()
  })
})

// ── Appairage : un espace technique PARTAGÉ, donc à vérifier explicitement ──
describe('appairage — un client ne peut pas délier le canal d\'un autre espace', () => {
  const LINKS = [
    { id: 'telegram:111', ws: 'ws_fabel', at: 1 },
    { id: 'telegram:222', ws: 'ws_client_b', at: 1 },
  ]

  it('DÉFAUT CORRIGÉ — délier le canal de Client B depuis Fabel échoue', async () => {
    // `unlinkChannel(chatKey)` supprimait sans vérifier la propriété. Les liens
    // vivent dans l'espace technique `_channels`, où le cloisonnement du magasin
    // ne s'applique pas : un identifiant de conversation Telegram est numérique,
    // donc énumérable.
    listItems.mockResolvedValue(LINKS)
    const res = mockRes()
    await pairHandler(req('DELETE', { [SESSION_COOKIE]: await clientSession('ws_fabel') },
      { id: 'telegram:222' }), res)
    expect(res.body.ok).toBe(false)
    expect(deleteItem).not.toHaveBeenCalled()
  })

  it('délier SON PROPRE canal fonctionne toujours', async () => {
    listItems.mockResolvedValue(LINKS)
    const res = mockRes()
    await pairHandler(req('DELETE', { [SESSION_COOKIE]: await clientSession('ws_fabel') },
      { id: 'telegram:111' }), res)
    expect(res.body.ok).toBe(true)
    expect(deleteItem).toHaveBeenCalledWith('pairlink', 'telegram:111', '_channels')
  })

  it('un canal inexistant et un canal d\'autrui sont INDISCERNABLES', async () => {
    listItems.mockResolvedValue(LINKS)
    const res1 = mockRes(); const res2 = mockRes()
    const c = { [SESSION_COOKIE]: await clientSession('ws_fabel') }
    await pairHandler(req('DELETE', c, { id: 'telegram:222' }), res1)
    await pairHandler(req('DELETE', c, { id: 'telegram:999999' }), res2)
    expect(res1.statusCode).toBe(res2.statusCode)
    expect(res1.body).toEqual(res2.body)
  })

  it('la liste ne montre que les canaux de l\'espace', async () => {
    listItems.mockResolvedValue(LINKS)
    const res = mockRes()
    await pairHandler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') }), res)
    expect(res.body.channels.map((c: any) => c.id)).toEqual(['telegram:111'])
    expect(JSON.stringify(res.body)).not.toContain('ws_client_b')
  })
})

// ── I/J/K/L — db-check ──────────────────────────────────────────────────────
describe('I/J/K/L — db-check est réservé à l\'administrateur', () => {
  it('I — aucune session → 403', async () => {
    const res = mockRes()
    await dbCheckHandler(req('GET', {}), res)
    expect(res.statusCode).toBe(403)
  })

  it('J — session client → 403', async () => {
    const res = mockRes()
    await dbCheckHandler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') }), res)
    expect(res.statusCode).toBe(403)
    // Aucun nom de table, aucune colonne : l'inventaire technique ne fuit pas.
    expect(JSON.stringify(res.body)).not.toContain('prospector_')
    expect(JSON.stringify(res.body)).not.toContain('client_password_hash')
  })

  it('K — admin → comportement inchangé', async () => {
    const res = mockRes()
    await dbCheckHandler(req('GET', { [SESSION_COOKIE]: await adminSession() }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.configured).toBe(true)
    expect(res.body.results).toHaveLength(6)
    expect(res.body.results.every((r: any) => r.ok)).toBe(true)
  })

  it('L — sur refus, AUCUNE requête Supabase n\'est exécutée', async () => {
    for (const cookies of [{}, { [SESSION_COOKIE]: await clientSession('ws_fabel') }]) {
      const res = mockRes()
      await dbCheckHandler(req('GET', cookies), res)
      expect(res.statusCode).toBe(403)
    }
    expect(supabaseFrom).not.toHaveBeenCalled()
    // Le garde précède même la question « la base est-elle configurée ? ».
    expect(supabaseConfigured).not.toHaveBeenCalled()
  })
})
