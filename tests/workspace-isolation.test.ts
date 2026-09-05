import { describe, it, expect, beforeEach, vi } from 'vitest'

// Lot SEC-0 — isolation des espaces clients au niveau de l'API.
//
// LE DÉFAUT MESURÉ. `GET /api/workspaces` branchait sur la méthode AVANT
// d'appeler `isAdminRequest`, et le middleware n'exige qu'une session VALIDE.
// Un client Fabel authentifié obtenait donc la liste de TOUS les espaces :
// identifiants, noms, plans, emails clients, statuts, permissions. L'existence
// même de Client B est une information que Fabel ne doit pas obtenir.
//
// Ces cas verrouillent le contrat, et surtout sa forme : la projection est une
// LISTE BLANCHE. Le cas H le prouve en ajoutant un champ que personne n'a
// autorisé — c'est le seul cas qui parle de SEC-1 et MT-1 avant qu'ils existent.

const listWorkspaces = vi.fn()
const getWorkspaceById = vi.fn()
const createWorkspace = vi.fn()
const updateWorkspace = vi.fn()
const deleteWorkspace = vi.fn()
const setClientPassword = vi.fn()

vi.mock('../lib/supabase/workspaces', () => ({
  listWorkspaces: (...a: any[]) => listWorkspaces(...a),
  getWorkspaceById: (...a: any[]) => getWorkspaceById(...a),
  createWorkspace: (...a: any[]) => createWorkspace(...a),
  updateWorkspace: (...a: any[]) => updateWorkspace(...a),
  deleteWorkspace: (...a: any[]) => deleteWorkspace(...a),
  setClientPassword: (...a: any[]) => setClientPassword(...a),
}))

import wsHandler from '../pages/api/workspaces/index'
import activeHandler from '../pages/api/workspaces/active'
import { createSessionToken, SESSION_COOKIE } from '../lib/auth/session'
import { useTestSessionSecret, forgeSession, futureExp } from './helpers/session'
import { adminWorkspaceView, workspaceOption } from '../lib/prospector/workspaceView'

const ACTIVE_WS_COOKIE = 'ps_active_ws'

// Deux espaces réels. `client_password_hash` et un champ « futur » sont posés
// volontairement sur les objets rendus par la couche de persistance : c'est
// exactement ce qui arrivera quand SEC-1 et MT-1 ajouteront leurs colonnes.
const FABEL: any = {
  id: 'ws_fabel', name: 'Fabel', leads: 12, users: 3, plan: 'Pro',
  clientEmail: 'contact@fabel.fr', status: 'active',
  permissions: { messaging: true, leads: true, sequences: true, validate: true },
  hasClientAccess: true,
  client_password_hash: '$2a$10$CONDENSAT-QUI-NE-DOIT-JAMAIS-SORTIR',
  credential_ref: 'cred_SECRET_FUTUR',
  monthly_budget_micros: 100_000_000,
}
const CLIENT_B: any = {
  id: 'ws_client_b', name: 'Client B', leads: 4, users: 1, plan: 'Starter',
  clientEmail: 'contact@client-b.fr', status: 'active', hasClientAccess: false,
}

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

// SEC-AUTH-0 : plus aucun secret par défaut — la suite doit poser le sien.
useTestSessionSecret()

beforeEach(() => {
  useTestSessionSecret()
  listWorkspaces.mockReset().mockResolvedValue([FABEL, CLIENT_B])
  getWorkspaceById.mockReset().mockImplementation(async (id: string) =>
    [FABEL, CLIENT_B].find((w) => w.id === id) || null)
  createWorkspace.mockReset().mockResolvedValue(FABEL)
  updateWorkspace.mockReset().mockResolvedValue(FABEL)
  deleteWorkspace.mockReset().mockResolvedValue(true)
  setClientPassword.mockReset().mockResolvedValue(true)
})

// ── A — le défaut central ────────────────────────────────────────────────────
describe('A — un client n\'obtient jamais la liste globale', () => {
  it('GET /api/workspaces avec une session client → 403, aucune trace de Client B', async () => {
    const res = mockRes()
    await wsHandler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') }), res)
    expect(res.statusCode).toBe(403)
    // Ni la liste, ni un espace unique « de consolation » : rien.
    expect(res.body.workspaces).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('ws_client_b')
    expect(JSON.stringify(res.body)).not.toContain('Client B')
    // Le refus est prononcé AVANT toute lecture : la base n'est même pas touchée.
    expect(listWorkspaces).not.toHaveBeenCalled()
  })

  it('les mutations restent fermées au client (POST/PATCH/DELETE)', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const res = mockRes()
      await wsHandler(req(method, { [SESSION_COOKIE]: await clientSession('ws_fabel') },
        { id: 'ws_client_b', name: 'pirate', patch: { name: 'pirate' } }), res)
      expect(res.statusCode).toBe(403)
    }
    expect(createWorkspace).not.toHaveBeenCalled()
    expect(updateWorkspace).not.toHaveBeenCalled()
    expect(deleteWorkspace).not.toHaveBeenCalled()
  })

  it('aucune session → 403, jamais un repli sur admin', async () => {
    const res = mockRes()
    await wsHandler(req('GET', {}), res)
    expect(res.statusCode).toBe(403)
    expect(listWorkspaces).not.toHaveBeenCalled()
  })
})

// ── B/C/D — aucune valeur fournie par l'appelant ne change d'espace ──────────
describe('B/C/D — le tenant du client est IMPOSÉ par sa session signée', () => {
  it('B — ?workspace_id=ws_client_b n\'a aucun effet', async () => {
    const res = mockRes()
    await wsHandler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') },
      undefined, { workspace_id: 'ws_client_b', id: 'ws_client_b', ws: 'ws_client_b' }), res)
    expect(res.statusCode).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('ws_client_b')
  })

  it('C — body.workspace_id = Client B n\'a aucun effet', async () => {
    const res = mockRes()
    await wsHandler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') },
      { workspace_id: 'ws_client_b', ws: 'ws_client_b', id: 'ws_client_b' }), res)
    expect(res.statusCode).toBe(403)
  })

  it('D — ps_active_ws = Client B sur une session client Fabel → sans effet', async () => {
    const res = mockRes()
    await activeHandler(req('GET', {
      [SESSION_COOKIE]: await clientSession('ws_fabel'),
      [ACTIVE_WS_COOKIE]: 'ws_client_b',
    }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.current).toBe('ws_fabel')
    expect(res.body.canSwitch).toBe(false)
    expect(res.body.options).toHaveLength(1)
    expect(res.body.options[0].id).toBe('ws_fabel')
    expect(JSON.stringify(res.body)).not.toContain('ws_client_b')
  })

  it('D bis — un client ne peut pas CHANGER l\'espace actif', async () => {
    const res = mockRes()
    await activeHandler(req('POST', { [SESSION_COOKIE]: await clientSession('ws_fabel') },
      { ws: 'ws_client_b' }), res)
    expect(res.statusCode).toBe(403)
    expect(res.headers['Set-Cookie']).toBeUndefined()
  })

  it('REPLI SUPPRIMÉ — une session client sans espace ne lit pas l\'espace admin', async () => {
    // `claims?.ws || 'admin'` rendait ici le nom de l'espace administrateur à un
    // client mal provisionné. Même classe de défaut que `activeWs()`, refusée
    // par MT-0 pour la dépense — elle vaut aussi pour la lecture.
    const res = mockRes()
    await activeHandler(req('GET', { [SESSION_COOKIE]: await clientSession('') }), res)
    expect(res.statusCode).toBe(403)
    expect(getWorkspaceById).not.toHaveBeenCalled()
  })
})

// ── E/F — l'administration n'est pas dégradée ────────────────────────────────
describe('E/F — l\'Admin continue de fonctionner à l\'identique', () => {
  it('E — la liste globale reste servie à l\'admin', async () => {
    const res = mockRes()
    await wsHandler(req('GET', { [SESSION_COOKIE]: await adminSession() }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.workspaces).toHaveLength(2)
    expect(res.body.workspaces.map((w: any) => w.id)).toEqual(['ws_fabel', 'ws_client_b'])
    // Les champs dont `pages/admin.tsx` a réellement besoin sont bien là.
    const fabel = res.body.workspaces[0]
    expect(fabel).toMatchObject({
      id: 'ws_fabel', name: 'Fabel', leads: 12, users: 3, plan: 'Pro',
      clientEmail: 'contact@fabel.fr', status: 'active', hasClientAccess: true,
    })
    expect(fabel.permissions).toBeTruthy()
  })

  // ⚠️ RUPTURE VOULUE (SEC-AUTH-0) : ce test exigeait qu'une session sans rôle
  // « reste admin ». C'était la porte — la liste des espaces clients était
  // accessible à tout jeton signé dont le rôle manquait.
  it('E bis — une session sans rôle n\'est plus admin : la liste est refusée', async () => {
    const sansRole = await forgeSession({ sub: 'admin@smart.ai', exp: futureExp() })
    const res = mockRes()
    await wsHandler(req('GET', { [SESSION_COOKIE]: sansRole }), res)
    expect(res.statusCode).toBe(403)
    expect(res.body.workspaces).toBeUndefined()
  })

  it('F — le sélecteur d\'espace de l\'Admin est inchangé', async () => {
    const res = mockRes()
    await activeHandler(req('GET', {
      [SESSION_COOKIE]: await adminSession(), [ACTIVE_WS_COOKIE]: 'ws_client_b',
    }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.canSwitch).toBe(true)
    expect(res.body.current).toBe('ws_client_b')
    expect(res.body.options.map((o: any) => o.id)).toEqual(['admin', 'ws_fabel', 'ws_client_b'])
    // Le sélecteur ne publie que deux champs, même si l'objet en porte dix.
    for (const o of res.body.options) expect(Object.keys(o).sort()).toEqual(['id', 'name'])
  })

  it('F bis — l\'admin peut toujours changer d\'espace actif', async () => {
    const res = mockRes()
    await activeHandler(req('POST', { [SESSION_COOKIE]: await adminSession() },
      { ws: 'ws_fabel' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Set-Cookie']).toContain('ps_active_ws=ws_fabel')
  })
})

// ── G/H — la projection est une LISTE BLANCHE, pas une liste noire ───────────
describe('G/H — rien ne se publie sans avoir été nommé', () => {
  it('G — client_password_hash n\'apparaît dans AUCUNE réponse', async () => {
    const admin = mockRes()
    await wsHandler(req('GET', { [SESSION_COOKIE]: await adminSession() }), admin)
    const active = mockRes()
    await activeHandler(req('GET', { [SESSION_COOKIE]: await adminSession() }), active)

    for (const res of [admin, active]) {
      const raw = JSON.stringify(res.body)
      expect(raw).not.toContain('client_password_hash')
      expect(raw).not.toContain('CONDENSAT-QUI-NE-DOIT-JAMAIS-SORTIR')
      expect(raw).not.toContain('$2a$10$')
    }
  })

  it('H — un champ sensible ajouté en base ne sort PAS automatiquement', async () => {
    // `credential_ref` (SEC-1) et `monthly_budget_micros` (MT-1) sont posés sur
    // la ligne rendue par la persistance. Une liste noire les laisserait passer,
    // puisqu'elle ne les connaît pas. Une liste blanche ne le peut pas.
    const res = mockRes()
    await wsHandler(req('GET', { [SESSION_COOKIE]: await adminSession() }), res)
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('credential_ref')
    expect(raw).not.toContain('cred_SECRET_FUTUR')
    expect(raw).not.toContain('monthly_budget_micros')
    expect(raw).not.toContain('100000000')

    // Et l'ensemble des clés publiées est CLOS, pas seulement « sans les deux ».
    expect(Object.keys(res.body.workspaces[0]).sort()).toEqual([
      'clientEmail', 'hasClientAccess', 'id', 'leads', 'name',
      'permissions', 'plan', 'status', 'users',
    ])
  })

  it('H bis — les vues elles-mêmes ne copient jamais en bloc', async () => {
    expect(Object.keys(adminWorkspaceView(FABEL)).sort()).toEqual([
      'clientEmail', 'hasClientAccess', 'id', 'leads', 'name',
      'permissions', 'plan', 'status', 'users',
    ])
    expect(Object.keys(workspaceOption(FABEL))).toEqual(['id', 'name'])
    // Un statut inconnu ne se propage pas : il se normalise.
    expect(adminWorkspaceView({ ...FABEL, status: 'zombie' } as any).status).toBe('active')
  })
})

// ── I — l'énumération par les codes de réponse ───────────────────────────────
describe('I — un client ne peut pas TESTER l\'existence d\'un espace', () => {
  it('le refus est identique pour un espace existant et un espace inventé', async () => {
    const results: number[] = []
    for (const target of ['ws_client_b', 'ws_totalement_invente']) {
      const res = mockRes()
      await wsHandler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') },
        undefined, { id: target }), res)
      results.push(res.statusCode)
    }
    // Même code, même corps : aucun oracle d'existence.
    expect(results).toEqual([403, 403])
  })

  it('sans session, le sélecteur ne rend AUCUN espace', async () => {
    // `!claims` valait « admin » : une requête sans session obtenait
    // l'identifiant et le nom de tous les espaces. Le middleware rend ce cas
    // inatteignable — raison de plus pour ne pas s'y fier seule.
    for (const cookies of [{}, { [SESSION_COOKIE]: 'jeton.invalide' }]) {
      const res = mockRes()
      await activeHandler(req('GET', cookies), res)
      expect(res.statusCode).toBe(403)
      expect(res.body.options).toBeUndefined()
    }
    expect(listWorkspaces).not.toHaveBeenCalled()
  })

  it('le sélecteur d\'un client ne dépend pas des espaces des autres', async () => {
    // Même si la base rendait mille espaces, la branche client ne les lit pas.
    listWorkspaces.mockResolvedValue([FABEL, CLIENT_B])
    const res = mockRes()
    await activeHandler(req('GET', { [SESSION_COOKIE]: await clientSession('ws_fabel') }), res)
    expect(listWorkspaces).not.toHaveBeenCalled()
    expect(res.body.options).toHaveLength(1)
  })
})
