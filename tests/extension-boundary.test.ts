import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// Lot SEC-EXT-0 — le navigateur n'est jamais une autorité.
//
// Six défauts confirmés côté serveur, tous du même genre : une autorité
// acceptée depuis le client.
//   1. `APP_SESSION_SECRET || 'prospector-dev-secret'` — un littéral PUBLIC
//      signait les jetons. Lire ce fichier suffisait à en forger un ;
//   2. `getTokenVersion` rendait `1` sur panne — donc ressuscitait tous les
//      jetons de première génération, ceux qu'une régénération avait tués ;
//   3. `INGEST_TOKEN` global ouvrait l'espace `admin` depuis un navigateur ;
//   4. le credential était accepté dans `body.token` autant qu'en en-tête ;
//   5. `confirm: true` + `action` — L'ACTION VENAIT DU NAVIGATEUR ;
//   6. `Access-Control-Allow-Origin: *` sur des routes à credential.

type Row = { kind: string; id: string; ws: string; data: any }
let rows: Row[] = []

const listItems = vi.fn(async (kind: string, ws: string) =>
  rows.filter((r) => r.kind === kind && r.ws === ws).map((r) => r.data))
const upsertItem = vi.fn(async (kind: string, id: string, data: any, ws: string) => {
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws)
  if (i >= 0) rows[i].data = data; else rows.push({ kind, id, ws, data })
  return true
})
const insertItemIfAbsent = vi.fn(async (kind: string, id: string, data: any, ws: string) => {
  await Promise.resolve()
  if (rows.some((r) => r.kind === kind && r.id === id && r.ws === ws)) return false
  rows.push({ kind, id, ws, data }); return true
})
const claimItem = vi.fn(async (kind: string, id: string, ws: string) => {
  await Promise.resolve()
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws)
  return i < 0 ? null : rows.splice(i, 1)[0].data
})
const claimItemIfField = vi.fn(async (kind: string, id: string, ws: string, field: string, expected: string) => {
  await Promise.resolve()
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws
    && String(r.data?.[field]) === expected)
  return i < 0 ? null : rows.splice(i, 1)[0].data
})
const deleteExpired = vi.fn(async () => true)
const getItem = vi.fn(async () => null)
const deleteItem = vi.fn(async () => true)

const WORKSPACES: Record<string, any> = {
  ws_fabel: { id: 'ws_fabel', name: 'Fabel', status: 'active' },
  ws_client_b: { id: 'ws_client_b', name: 'Client B', status: 'active' },
}
const getWorkspaceById = vi.fn(async (id: string) => WORKSPACES[id] ?? null)

vi.mock('../lib/supabase/store', () => ({
  listItems: (...a: any[]) => (listItems as any)(...a),
  getItem: (...a: any[]) => (getItem as any)(...a),
  upsertItem: (...a: any[]) => (upsertItem as any)(...a),
  deleteItem: (...a: any[]) => (deleteItem as any)(...a),
  insertItemIfAbsent: (...a: any[]) => (insertItemIfAbsent as any)(...a),
  claimItem: (...a: any[]) => (claimItem as any)(...a),
  claimItemIfField: (...a: any[]) => (claimItemIfField as any)(...a),
  deleteExpired: (...a: any[]) => (deleteExpired as any)(...a),
}))
vi.mock('../lib/supabase/workspaces', () => ({
  getWorkspaceById: (...a: any[]) => (getWorkspaceById as any)(...a),
  listWorkspaces: async () => Object.values(WORKSPACES),
}))

const KEYS: Record<string, string> = {}
vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => {},
  getKey: (n: string) => KEYS[n] || '',
  setKeys: async () => {}, hasKey: () => true, keySource: () => 'app', MANAGED_KEYS: [],
}))

const planJarvis = vi.fn()
const executeJarvis = vi.fn()
vi.mock('../lib/prospector/jarvisAgent', () => ({
  planJarvis: (...a: any[]) => planJarvis(...a),
  executeJarvis: (...a: any[]) => executeJarvis(...a),
  isWrite: (a: any) => !!a && a.type === 'write',
}))
const identifyLead = vi.fn(async (..._a: any[]) => ({ kind: 'person', firstName: 'Léa', lastName: 'M', company: 'Acme' } as any))
vi.mock('../lib/prospector/identify', () => ({ identifyLead: (...a: any[]) => identifyLead(...a) }))
vi.mock('../lib/prospector/datagouv', () => ({ lookupByName: async () => ({ found: false }) }))
const upsertLeadChecked = vi.fn(async (_lead: any, _ws: string) => ({ ok: true }))
vi.mock('../lib/supabase/leads', () => ({
  upsertLeadChecked: (lead: any, ws: string) => upsertLeadChecked(lead, ws),
  listLeads: async () => [], deleteLead: async () => true,
}))

import agentHandler from '../pages/api/jarvis/agent'
import ingestHandler from '../pages/api/ingest/lead'
import { tokenForWorkspace, resolveExtensionToken, getTokenVersion } from '../lib/prospector/wstoken'
import { consumeExtensionPending, EXT_PENDING_TTL_MS } from '../lib/prospector/extensionGate'

const SECRET = 'un-vrai-secret-de-signature'

function mockRes() {
  const r: any = { statusCode: 0, body: undefined, headers: {} as Record<string, string> }
  r.status = (c: number) => { r.statusCode = c; return r }
  r.json = (b: any) => { r.body = b; return r }
  r.setHeader = (k: string, v: string) => { r.headers[k] = v }
  r.end = () => r
  return r
}
const req = (body: any, headers: Record<string, string> = {}) =>
  ({ method: 'POST', headers, body, cookies: {}, query: {} } as any)
const withToken = (t: string, body: any = {}, extra: Record<string, string> = {}) =>
  req(body, { 'x-ingest-token': t, ...extra })

beforeEach(() => {
  rows = []
  vi.clearAllMocks()
  for (const k of Object.keys(KEYS)) delete KEYS[k]
  process.env.APP_SESSION_SECRET = SECRET
  getWorkspaceById.mockImplementation(async (id: string) => WORKSPACES[id] ?? null)
  planJarvis.mockResolvedValue({ reply: 'Je vais écrire.', action: { type: 'write', target: 'lead_1' } })
  executeJarvis.mockResolvedValue('fait')
  listItems.mockImplementation(async (kind: string, ws: string) =>
    rows.filter((r) => r.kind === kind && r.ws === ws).map((r) => r.data))
})

// ── A/B — secret et version : aucun repli ───────────────────────────────────
describe('A/B — le jeton se ferme quand sa base de confiance manque', () => {
  it('A — DÉFAUT : sans APP_SESSION_SECRET, plus aucun jeton n\'est produit ni résolu', async () => {
    // Le repli `|| 'prospector-dev-secret'` signait avec un littéral PUBLIC :
    // lire le dépôt suffisait à forger un jeton pour l'espace de son choix.
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    delete process.env.APP_SESSION_SECRET
    expect(await tokenForWorkspace('ws_fabel', 'capture')).toBeNull()
    expect(await resolveExtensionToken(t, 'capture')).toBeNull()
  })

  it('B — DÉFAUT : version non vérifiable → refus, jamais un repli sur 1', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    listItems.mockRejectedValue(new Error('db down'))
    expect(await getTokenVersion('ws_fabel')).toBeNull()
    expect(await resolveExtensionToken(t, 'capture')).toBeNull()
    expect(await tokenForWorkspace('ws_fabel', 'capture')).toBeNull()
  })

  it('la révocation par version tue réellement l\'ancien jeton', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    expect(await resolveExtensionToken(t, 'capture')).toBe('ws_fabel')
    rows.push({ kind: 'wsver', id: 'ws_fabel', ws: '_meta', data: { id: 'ws_fabel', v: 2 } })
    expect(await resolveExtensionToken(t, 'capture')).toBeNull()
  })
})

// ── C/D/E/F/G — portées ─────────────────────────────────────────────────────
describe('C–G — chaque jeton n\'ouvre QUE sa capacité', () => {
  it('C — jeton capture → ingest accepté, sur SON espace', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    const res = mockRes()
    await ingestHandler(withToken(t, { name: 'Léa', url: 'https://x.fr' }), res)
    expect(res.statusCode).toBe(200)
    expect(upsertLeadChecked.mock.calls[0][1]).toBe('ws_fabel')
  })

  it('D — jeton capture → Jarvis REFUSÉ', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'salut' }), res)
    expect(res.statusCode).toBe(401)
    expect(planJarvis).not.toHaveBeenCalled()
  })

  it('E — jeton jarvis → Jarvis accepté', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'salut' }), res)
    expect(res.statusCode).toBe(200)
    expect(planJarvis.mock.calls[0][0]).toEqual({ id: 'ws_fabel', kind: 'client' })
  })

  it('F — jeton jarvis → capture REFUSÉE', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    const res = mockRes()
    await ingestHandler(withToken(t, { name: 'Léa' }), res)
    expect(res.statusCode).toBe(401)
    expect(upsertLeadChecked).not.toHaveBeenCalled()
  })

  it('G — DÉFAUT : le jeton global d\'administration n\'ouvre plus rien', async () => {
    // `INGEST_TOKEN` rendait l'espace `admin` : un jeton unique, partagé, jamais
    // tourné, donnant l'espace de Smart AI depuis un navigateur client.
    KEYS.INGEST_TOKEN = 'jeton-global-admin'
    for (const [h, name] of [[ingestHandler, 'ingest'], [agentHandler, 'agent']] as any) {
      const res = mockRes()
      await h(withToken('jeton-global-admin', { name: 'x', message: 'x' }), res)
      expect(res.statusCode).toBe(401)
    }
    expect(upsertLeadChecked).not.toHaveBeenCalled()
    expect(planJarvis).not.toHaveBeenCalled()
  })

  it('l\'ancien format non porté est REFUSÉ, jamais dégradé en capture', async () => {
    expect(await resolveExtensionToken(`pk_ws_fabel_${'a'.repeat(32)}`, 'capture')).toBeNull()
  })

  it('une portée inventée ne signe rien', async () => {
    expect(await resolveExtensionToken(`pk_admin_ws_fabel_${'a'.repeat(40)}`, 'capture' as any)).toBeNull()
    expect(await tokenForWorkspace('ws_fabel', 'admin' as any)).toBeNull()
  })
})

// ── H/I/J — l'espace vient du jeton, jamais du corps ────────────────────────
describe('H/I/J — le navigateur ne choisit pas l\'espace', () => {
  it('H — jeton Client B → Client B, quoi que dise le corps', async () => {
    const t = (await tokenForWorkspace('ws_client_b', 'capture'))!
    const res = mockRes()
    await ingestHandler(withToken(t, {
      name: 'Léa', workspace_id: 'ws_fabel', tenant: 'ws_fabel', ws: 'ws_fabel',
    }), res)
    expect(upsertLeadChecked.mock.calls[0][1]).toBe('ws_client_b')
  })

  it('I — workspace_id dans le corps de Jarvis : aucune influence', async () => {
    const t = (await tokenForWorkspace('ws_client_b', 'jarvis'))!
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'x', workspace_id: 'ws_fabel', role: 'admin' }), res)
    expect(planJarvis.mock.calls[0][0]).toEqual({ id: 'ws_client_b', kind: 'client' })
  })

  it('J — DÉFAUT : `body.token` n\'est plus un credential', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    const res = mockRes()
    // Le jeton n'est fourni QUE dans le corps, comme le faisait l'extension.
    await ingestHandler(req({ name: 'Léa', token: t }), res)
    expect(res.statusCode).toBe(401)
    expect(upsertLeadChecked).not.toHaveBeenCalled()
  })

  it('espace suspendu → refus, même avec un jeton valide', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    getWorkspaceById.mockResolvedValue({ id: 'ws_fabel', status: 'suspended' })
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'x' }), res)
    expect(res.statusCode).toBe(403)
    expect(planJarvis).not.toHaveBeenCalled()
  })
})

// ── K–Q — l'action ne vient JAMAIS du navigateur ────────────────────────────
describe('K–Q — l\'action est stockée côté serveur, et consommée une fois', () => {
  const jarvisToken = () => tokenForWorkspace('ws_fabel', 'jarvis') as Promise<string>

  async function proposer() {
    const t = await jarvisToken()
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'ajoute Redsen' }), res)
    return { t, cid: res.body.confirmationId as string, res }
  }

  it('K — DÉFAUT CENTRAL : une action fournie par le client n\'est PAS exécutée', async () => {
    // La route acceptait `confirm: true` + `action` et exécutait cette action
    // telle quelle : n'importe quel porteur du jeton pouvait soumettre l'action
    // de son choix, sans qu'aucun plan ne l'ait proposée.
    const t = await jarvisToken()
    const res = mockRes()
    await agentHandler(withToken(t, {
      confirm: true, action: { type: 'write', target: 'TOUT_SUPPRIMER' },
    }), res)
    for (const call of executeJarvis.mock.calls) {
      expect(call[1]).not.toMatchObject({ target: 'TOUT_SUPPRIMER' })
    }
  })

  it('la proposition ne renvoie PAS l\'action, seulement un identifiant', async () => {
    const { res, cid } = await proposer()
    expect(cid).toMatch(/^[0-9a-f]{32}$/)
    expect(res.body.action).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('lead_1')
  })

  it('L — un identifiant valide exécute l\'action SERVEUR', async () => {
    const { t, cid } = await proposer()
    executeJarvis.mockClear()
    const res = mockRes()
    await agentHandler(withToken(t, { confirmationId: cid }), res)
    expect(executeJarvis).toHaveBeenCalledTimes(1)
    expect(executeJarvis.mock.calls[0][1]).toEqual({ type: 'write', target: 'lead_1' })
  })

  it('M — REJEU d\'une confirmation → refus', async () => {
    const { t, cid } = await proposer()
    executeJarvis.mockClear()
    await agentHandler(withToken(t, { confirmationId: cid }), mockRes())
    await agentHandler(withToken(t, { confirmationId: cid }), mockRes())
    expect(executeJarvis).toHaveBeenCalledTimes(1)
  })

  it('N — 20 confirmations SIMULTANÉES → UNE exécution', async () => {
    const { t, cid } = await proposer()
    executeJarvis.mockClear()
    await Promise.all(Array.from({ length: 20 }, () =>
      agentHandler(withToken(t, { confirmationId: cid }), mockRes())))
    expect(executeJarvis).toHaveBeenCalledTimes(1)
  })

  it('O — jeton RÉVOQUÉ avant la confirmation → refus', async () => {
    const { cid } = await proposer()
    rows.push({ kind: 'wsver', id: 'ws_fabel', ws: '_meta', data: { id: 'ws_fabel', v: 2 } })
    const perime = await jarvisToken()   // ancien jeton, version 1
    executeJarvis.mockClear()
    const res = mockRes()
    await agentHandler(req({ confirmationId: cid }, { 'x-ingest-token': perime.replace(/.$/, '0') }), res)
    expect(res.statusCode).toBe(401)
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('P — espace SUSPENDU avant la confirmation → refus', async () => {
    const { t, cid } = await proposer()
    getWorkspaceById.mockResolvedValue({ id: 'ws_fabel', status: 'suspended' })
    executeJarvis.mockClear()
    const res = mockRes()
    await agentHandler(withToken(t, { confirmationId: cid }), res)
    expect(res.statusCode).toBe(403)
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('une confirmation d\'un AUTRE espace ne détruit rien', async () => {
    const { cid } = await proposer()
    const autre = (await tokenForWorkspace('ws_client_b', 'jarvis'))!
    executeJarvis.mockClear()
    await agentHandler(withToken(autre, { confirmationId: cid }), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()
    // L'attente de Fabel est INTACTE.
    expect(rows.filter((r) => r.kind === 'extpending')).toHaveLength(1)
  })

  it('Q — identifiant malformé → aucune lecture de la base', async () => {
    const t = await jarvisToken()
    claimItemIfField.mockClear()
    for (const bad of ['../../etc', 'ZZZZ', 'a'.repeat(31), 'A'.repeat(32)]) {
      await agentHandler(withToken(t, { confirmationId: bad }), mockRes())
    }
    for (const call of claimItemIfField.mock.calls) expect(call[0]).not.toBe('extpending')
  })

  it('confirmation EXPIRÉE → refus', async () => {
    const { t, cid } = await proposer()
    const row = rows.find((r) => r.kind === 'extpending')!
    row.data.expiresAt = Date.now() - 1
    executeJarvis.mockClear()
    await agentHandler(withToken(t, { confirmationId: cid }), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('la TTL est de cinq minutes, et elle est portée par l\'attente', async () => {
    await proposer()
    const row = rows.find((r) => r.kind === 'extpending')!.data
    expect(row.expiresAt - row.at).toBe(EXT_PENDING_TTL_MS)
    expect(EXT_PENDING_TTL_MS).toBe(5 * 60 * 1000)
  })

  it('R — exception interne → réponse générique, aucun détail sensible', async () => {
    const t = await jarvisToken()
    planJarvis.mockRejectedValue(new Error('relation "prospector_leads" at https://xyz.supabase.co'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'x' }), res)
    err.mockRestore()
    const raw = JSON.stringify(res.body)
    expect(raw).toContain('erreur interne')
    expect(raw).not.toContain('prospector_leads')
    expect(raw).not.toContain('supabase.co')
  })
})

// ── CORS ────────────────────────────────────────────────────────────────────
describe('CORS — allowlist, jamais `*`', () => {
  it('DÉFAUT : plus aucune réponse ne porte `Access-Control-Allow-Origin: *`', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    const res = mockRes()
    await ingestHandler(withToken(t, { name: 'x' }), res)
    expect(res.headers['Access-Control-Allow-Origin']).not.toBe('*')
    expect(res.headers.Vary).toBe('Origin')
  })

  it('origine NON listée → 403, aucune opération métier', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    const res = mockRes()
    await ingestHandler(withToken(t, { name: 'x' }, { origin: 'https://evil.example' }), res)
    expect(res.statusCode).toBe(403)
    expect(upsertLeadChecked).not.toHaveBeenCalled()
  })

  it('origine listée → autorisée, et RÉFLÉCHIE telle quelle, jamais élargie', async () => {
    KEYS.EXTENSION_ORIGINS = 'chrome-extension://abcdef,chrome-extension://ghijkl'
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    const res = mockRes()
    await ingestHandler(withToken(t, { name: 'x' }, { origin: 'chrome-extension://abcdef' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Access-Control-Allow-Origin']).toBe('chrome-extension://abcdef')
  })

  it('sans en-tête Origin → accepté : ce n\'est pas une requête de page', async () => {
    // Le service worker MV3 n'émet pas d'`Origin` ; refuser casserait le canal
    // légitime sans rien protéger — CORS ne concerne que les pages.
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    const res = mockRes()
    await ingestHandler(withToken(t, { name: 'x' }), res)
    expect(res.statusCode).toBe(200)
  })
})

// ── U–AD — le paquet Chrome versionné ───────────────────────────────────────
describe('U–AD — l\'extension elle-même', () => {
  const read = (f: string) => readFileSync(`extension/${f}`, 'utf8')
  const manifest = () => JSON.parse(read('manifest.json'))

  it('U — plus aucune permission d\'hôte sur tout Internet', () => {
    const m = manifest()
    expect(m.host_permissions || []).toEqual([])
    // On vérifie les champs EFFECTIFS, pas le fichier entier : les clés `//…`
    // documentent justement le défaut corrigé et citent l'ancien motif.
    const effectifs = [
      ...(m.host_permissions || []), ...(m.permissions || []),
      ...((m.content_scripts || []).flatMap((c: any) => c.matches || [])),
    ]
    for (const v of effectifs) expect(String(v)).not.toContain('*/*')
  })

  it('V — plus aucun content script injecté automatiquement', () => {
    expect(manifest().content_scripts).toBeUndefined()
  })

  it('V bis — les permissions restent minimales', () => {
    expect(manifest().permissions.sort()).toEqual(['activeTab', 'scripting', 'storage'])
  })

  it('W — Jarvis n\'est injecté que sur un geste explicite, via activeTab', () => {
    const popup = read('popup.js')
    expect(popup).toContain('chrome.scripting.executeScript')
    expect(popup).toContain("files: ['content.js']")
    expect(popup).toContain('currentWindow: true')
  })

  it('X — le content script ne lit JAMAIS le credential', () => {
    const c = read('content.js')
    expect(c).not.toMatch(/storage\.local\.get\([^)]*token/i)
    expect(c).not.toContain('x-ingest-token')
    expect(c).not.toContain('fetch(')
  })

  it('Y — le jeton ne vit que dans le service worker', () => {
    const bg = read('background.js')
    expect(bg).toContain('x-ingest-token')
    // Aucun message ne renvoie le credential vers la page.
    expect(bg).not.toMatch(/sendResponse\([^)]*token/i)
    expect(read('content.js')).not.toContain('tokenJarvis')
  })

  it('Z — l\'origine Prospector n\'est plus saisissable', () => {
    expect(read('popup.html')).not.toContain('id="base"')
    expect(read('config.js')).toContain('ALLOWED_ORIGINS')
    // Une origine hors liste n'est pas appelable.
    expect(read('config.js')).toContain('ALLOWED_ORIGINS.includes(o) ? o : null')
  })

  it('AA/AB — le client ne renvoie jamais l\'action, seulement un identifiant', () => {
    const c = read('content.js')
    expect(c).toContain('jarvis.confirm')
    expect(c).toContain('confirmationId')
    expect(c).not.toContain('confirm: true')
    expect(c).not.toMatch(/action:\s*pending/)
  })

  it('AC — la racine d\'ombre est FERMÉE, et les clics programmés sont refusés', () => {
    const c = read('content.js')
    // Une seule racine d'ombre est créée, et elle est fermée. On regarde les
    // appels réels : le commentaire d'à-côté cite l'ancien `mode: 'open'`.
    const appels = c.match(/attachShadow\(\{[^}]*\}\)/g) || []
    expect(appels).toHaveLength(1)
    expect(appels[0]).toContain("mode: 'closed'")
    // `isTrusted` distingue un vrai clic d'un `button.click()` de la page.
    expect(c).toContain('isTrusted')
  })

  it('AD — la capture reste fonctionnelle, via le service worker', () => {
    const popup = read('popup.js')
    expect(popup).toContain('capture.lead')
    expect(popup).not.toContain('x-ingest-token')
    expect(read('background.js')).toContain('/api/ingest/lead')
  })

  it('le service worker refuse un message qui ne vient pas de l\'extension', () => {
    expect(read('background.js')).toContain('sender.id !== chrome.runtime.id')
  })
})
