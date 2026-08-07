import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Script utilitaire en JavaScript pur, importé pour éprouver le garde de
// publication sur des FIXTURES plutôt que sur le dépôt lui-même — sans quoi il
// faudrait rendre la branche volontairement rouge pour le tester.
import { auditExtension } from '../scripts/check-extension-origin.mjs'

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
// LECTURE STRICTE : trois issues distinctes, comme la vraie primitive.
//   { ok:true, value }  ligne présente
//   { ok:true, null }   la base a répondu, pas de ligne
//   { ok:false }        la base n'a pas répondu
const getItemStrict = vi.fn(async (kind: string, id: string, ws: string) => {
  const r = rows.find((x) => x.kind === kind && x.id === id && x.ws === ws)
  return { ok: true as const, value: r ? r.data : null }
})
const deleteItem = vi.fn(async () => true)

const WORKSPACES: Record<string, any> = {
  ws_fabel: { id: 'ws_fabel', name: 'Fabel', status: 'active' },
  ws_client_b: { id: 'ws_client_b', name: 'Client B', status: 'active' },
}
const getWorkspaceById = vi.fn(async (id: string) => WORKSPACES[id] ?? null)

vi.mock('../lib/supabase/store', () => ({
  listItems: (...a: any[]) => (listItems as any)(...a),
  getItem: (...a: any[]) => (getItem as any)(...a),
  getItemStrict: (...a: any[]) => (getItemStrict as any)(...a),
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
// `getTokenVersion` exige désormais une base CONFIGURÉE : sans elle, l'absence
// de ligne n'est plus une certitude, c'est une ignorance.
const supabaseConfigured = vi.fn(() => true)
vi.mock('../lib/supabase/client', () => ({
  supabaseConfigured: (...a: any[]) => (supabaseConfigured as any)(...a),
  supabase: () => null,
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
  supabaseConfigured.mockReturnValue(true)
  getItemStrict.mockImplementation(async (kind: string, id: string, ws: string) => {
    const r = rows.find((x) => x.kind === kind && x.id === id && x.ws === ws)
    return { ok: true as const, value: r ? r.data : null }
  })
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

  it('B — version non vérifiable → refus, jamais un repli sur 1', async () => {
    // ⚠️ CE CAS MENTAIT (lot SEC-EXT-0). Il simulait un `reject`, que
    // `listItems` ne produit JAMAIS : la vraie fonction absorbe les erreurs
    // Supabase et rend `[]`. Le test passait donc pendant que la production
    // repliait sur la version 1. On modélise maintenant ce que la base fait
    // réellement : elle répond « je ne sais pas ».
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    getItemStrict.mockResolvedValue({ ok: false } as any)
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

  it('U — permission d\'hôte : l\'origine EXACTE, jamais tout Internet', () => {
    // ⚠️ SEC-EXT-0 laissait `host_permissions: []`, et je l'avais présenté
    // comme le moindre privilège. C'était trop peu : MV3 EXIGE une permission
    // d'hôte pour un `fetch` cross-origin depuis le service worker — l'extension
    // n'aurait joint aucun backend. La bonne réponse n'est pas « rien », c'est
    // « exactement l'origine Prospector ».
    const m = manifest()
    expect(m.host_permissions).toHaveLength(1)
    expect(m.host_permissions[0]).toMatch(/^https:\/\/[^*]+\/\*$/)
    const effectifs = [
      ...(m.host_permissions || []), ...(m.permissions || []),
      ...((m.content_scripts || []).flatMap((c: any) => c.matches || [])),
    ]
    for (const v of effectifs) expect(String(v)).not.toContain('*/*')
  })

  it('U bis — le manifeste et config.js désignent LA MÊME origine', () => {
    // Deux déclarations manuelles indépendantes divergent tôt ou tard : soit
    // l'extension devient muette, soit la permission dépasse l'usage réel.
    const origin = read('config.js').match(/const PROSPECTOR_ORIGIN = '([^']+)'/)![1]
    expect(manifest().host_permissions[0]).toBe(`${origin}/*`)
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

// ── SEC-EXT-0.1 — les écarts entre mes assertions et le code réel ───────────
describe('SEC-EXT-0.1 — annulation, bouton périmé, storage, bornes', () => {
  const read = (f: string) => readFileSync(`extension/${f}`, 'utf8')
  const jarvisToken = () => tokenForWorkspace('ws_fabel', 'jarvis') as Promise<string>

  async function proposer() {
    const t = await jarvisToken()
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'ajoute Redsen' }), res)
    return { t, cid: res.body.confirmationId as string }
  }

  // ── §1 : version de jeton, NOT_FOUND ≠ ERROR ─────────────────────────────
  it('base OK sans ligne wsver → version initiale 1', async () => {
    expect(await getTokenVersion('ws_fabel')).toBe(1)
  })

  it('base OK avec wsver=7 → 7', async () => {
    rows.push({ kind: 'wsver', id: 'ws_fabel', ws: '_meta', data: { id: 'ws_fabel', v: 7 } })
    expect(await getTokenVersion('ws_fabel')).toBe(7)
  })

  it('base MUETTE → null, jamais 1', async () => {
    getItemStrict.mockResolvedValue({ ok: false } as any)
    expect(await getTokenVersion('ws_fabel')).toBeNull()
  })

  it('jeton v1 ET jeton v7 sont TOUS DEUX refusés quand la base est muette', async () => {
    const v1 = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    rows.push({ kind: 'wsver', id: 'ws_fabel', ws: '_meta', data: { id: 'ws_fabel', v: 7 } })
    const v7 = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    getItemStrict.mockResolvedValue({ ok: false } as any)
    expect(await resolveExtensionToken(v1, 'jarvis')).toBeNull()
    expect(await resolveExtensionToken(v7, 'jarvis')).toBeNull()
  })

  it('la version de B n\'influence pas celle de A', async () => {
    rows.push({ kind: 'wsver', id: 'ws_client_b', ws: '_meta', data: { id: 'ws_client_b', v: 9 } })
    expect(await getTokenVersion('ws_fabel')).toBe(1)
    expect(await getTokenVersion('ws_client_b')).toBe(9)
  })

  it('G — aucun listItems dans le chemin de résolution : lecture CIBLÉE', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    listItems.mockClear(); getItemStrict.mockClear()
    await resolveExtensionToken(t, 'jarvis')
    // On ne charge plus les versions de TOUS les espaces pour en lire une.
    for (const call of listItems.mock.calls) expect(call[0]).not.toBe('wsver')
    expect(getItemStrict).toHaveBeenCalledWith('wsver', 'ws_fabel', '_meta')
  })

  // ── §6 : annulation inter-tenants ────────────────────────────────────────
  it('A — Fabel annule SON attente → supprimée', async () => {
    const { t, cid } = await proposer()
    await agentHandler(withToken(t, { cancel: cid }), mockRes())
    expect(rows.filter((r) => r.kind === 'extpending')).toHaveLength(0)
  })

  it('B — DÉFAUT : Client B ne peut PLUS détruire l\'attente de Fabel', async () => {
    // `dropExtensionPending` recevait `ws` et l'IGNORAIT : un porteur de jeton
    // d'un autre espace connaissant le nonce provoquait un déni de service.
    const { cid } = await proposer()
    const autre = (await tokenForWorkspace('ws_client_b', 'jarvis'))!
    await agentHandler(withToken(autre, { cancel: cid }), mockRes())
    expect(rows.filter((r) => r.kind === 'extpending')).toHaveLength(1)
  })

  it('C — après la tentative de B, Fabel confirme toujours', async () => {
    const { t, cid } = await proposer()
    const autre = (await tokenForWorkspace('ws_client_b', 'jarvis'))!
    await agentHandler(withToken(autre, { cancel: cid }), mockRes())
    executeJarvis.mockClear()
    await agentHandler(withToken(t, { confirmationId: cid }), mockRes())
    expect(executeJarvis).toHaveBeenCalledTimes(1)
  })

  it('D — 20 annulations simultanées → une seule consommation', async () => {
    const { t, cid } = await proposer()
    await Promise.all(Array.from({ length: 20 }, () =>
      agentHandler(withToken(t, { cancel: cid }), mockRes())))
    expect(rows.filter((r) => r.kind === 'extpending')).toHaveLength(0)
  })

  it('E — confirm et cancel simultanés → UNE seule issue', async () => {
    const { t, cid } = await proposer()
    executeJarvis.mockClear()
    await Promise.all([
      ...Array.from({ length: 10 }, () => agentHandler(withToken(t, { confirmationId: cid }), mockRes())),
      ...Array.from({ length: 10 }, () => agentHandler(withToken(t, { cancel: cid }), mockRes())),
    ])
    expect(executeJarvis.mock.calls.length).toBeLessThanOrEqual(1)
    expect(rows.filter((r) => r.kind === 'extpending')).toHaveLength(0)
  })

  // ── §8 : bouton périmé ───────────────────────────────────────────────────
  it('le bouton capture SON identifiant dans sa closure, pas une globale', () => {
    // `let pendingId` partagé : cliquer sur le bouton d'une proposition A APRÈS
    // qu'une proposition B l'ait écrasé confirmait B — l'utilisateur validait
    // autre chose que ce qu'il avait sous les yeux.
    const c = read('content.js')
    expect(c).toContain('const confirmationId = d.confirmationId')
    expect(c).toContain('confirmAction(confirmationId)')
    expect(c).toContain('cancelAction(confirmationId)')
    // Plus aucune variable mutable partagée ne sert d'autorité.
    expect(c).not.toMatch(/let pendingId/)
    expect(c).not.toMatch(/confirmAction\(pendingId\)/)
  })

  it('deux propositions successives produisent DEUX identifiants distincts', async () => {
    const t = await jarvisToken()
    const a = mockRes(); const b = mockRes()
    await agentHandler(withToken(t, { message: 'un' }), a)
    await agentHandler(withToken(t, { message: 'deux' }), b)
    expect(a.body.confirmationId).not.toBe(b.body.confirmationId)
    // Et chacune reste consommable indépendamment : le serveur ne les confond pas.
    executeJarvis.mockClear()
    await agentHandler(withToken(t, { confirmationId: a.body.confirmationId }), mockRes())
    await agentHandler(withToken(t, { confirmationId: b.body.confirmationId }), mockRes())
    expect(executeJarvis).toHaveBeenCalledTimes(2)
  })

  // ── §10/§11/§12 : le storage ─────────────────────────────────────────────
  it('le storage est restreint aux CONTEXTES DE CONFIANCE', () => {
    const bg = read('background.js')
    expect(bg).toContain("accessLevel: 'TRUSTED_CONTEXTS'")
    expect(bg).toContain('chrome.runtime.onInstalled')
  })

  it('le content script ne touche plus DU TOUT au storage', () => {
    // L'assertion de SEC-EXT-0 — « il ne LIT pas les jetons » — portait sur le
    // code, pas sur la capacité : un content script atteint normalement le
    // storage de son extension. Il n'y accède plus, et ne le peut plus.
    // On regarde le CODE, pas les commentaires : celui d'à-côté cite justement
    // l'ancien `chrome.storage.local['token']`. Les blocs `/* … */` sont
    // retirés en entier — un filtre ligne à ligne les laissait passer.
    const code = read('content.js')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('chrome.storage')
  })

  it('aucun message ne permet de demander une clé arbitraire du storage', () => {
    const bg = read('background.js')
    expect(bg).toContain("msg?.type === 'ui.brand'")
    // La marque, et rien d'autre : pas de `settings.get(<nom>)` générique.
    expect(bg).toMatch(/storage\.local\.get\(\['brand'\]\)/)
    expect(bg).not.toMatch(/storage\.local\.get\(\[?msg/)
  })

  // ── §13 : bornes ─────────────────────────────────────────────────────────
  it('capture : les données métier sont TRONQUÉES, l\'URL est REFUSÉE', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'capture'))!
    const res = mockRes()
    await ingestHandler(withToken(t, { name: 'x'.repeat(5000), url: 'https://ok.fr' }), res)
    expect(res.statusCode).toBe(200)
    expect(identifyLead.mock.calls[0][1].name.length).toBeLessThanOrEqual(200)

    const res2 = mockRes()
    await ingestHandler(withToken(t, { name: 'ok', url: 'https://x.fr/' + 'a'.repeat(5000) }), res2)
    expect(res2.statusCode).toBe(413)
  })

  it('jarvis : une directive démesurée est REFUSÉE, jamais tronquée', async () => {
    // Tronquée en son milieu, elle deviendrait une instruction que
    // l'utilisateur n'a pas écrite — et elle serait tout de même facturée.
    const t = await jarvisToken()
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'z'.repeat(50_000) }), res)
    expect(res.statusCode).toBe(413)
    expect(planJarvis).not.toHaveBeenCalled()
  })

  it('jarvis : le TITRE est borné, sans refuser la requête', async () => {
    // ⚠️ CE CAS PORTAIT L'ANCIEN CONTRAT : il envoyait aussi une URL démesurée
    // et attendait qu'elle soit TRONQUÉE. SEC-EXT-0.1b la refuse — tronquée,
    // elle désignerait une autre ressource. Le titre, lui, reste tronqué.
    const t = await jarvisToken()
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'ok', title: 'T'.repeat(9000), url: 'https://x.fr' }), res)
    expect(res.statusCode).toBe(200)
    const ctx = planJarvis.mock.calls[0][2]
    expect(ctx.title.length).toBe(200)
    expect(ctx.url).toBe('https://x.fr')
  })

  // ── §14 : le contexte de page reste minimal ──────────────────────────────
  it('le content script ne transmet QUE la directive, l\'URL et le titre', () => {
    const c = read('content.js')
    expect(c).toContain('location.href')
    expect(c).toContain('document.title')
    // Ce qui est interdit, c'est de LIRE la page. Écrire sa propre interface
    // dans sa propre racine d'ombre (`root.innerHTML = …`) n'est pas du
    // scraping — l'assertion précédente était trop grossière et confondait les
    // deux. Ce lot ne doit ajouter aucune capacité d'extraction : SEC-AI les
    // traitera comme des capacités explicites.
    // `textContent = …` ÉCRIT dans notre propre interface : ce n'est pas une
    // lecture de la page, et l'inclure était une nouvelle imprécision de ma
    // part. La liste ne retient que ce qui LIT le document hôte.
    for (const interdit of [
      'document.body', 'documentElement.innerHTML', 'innerText',
      'document.cookie', 'localStorage', 'querySelectorAll', 'document.forms',
    ]) {
      expect(c).not.toContain(interdit)
    }
  })
})

// ── SEC-EXT-0.1b — les quatre derniers fail-open ────────────────────────────
describe('SEC-EXT-0.1b — configuration absente, storage, URL, release', () => {
  const read = (f: string) => readFileSync(`extension/${f}`, 'utf8')

  // ── §1 : Supabase NON CONFIGURÉ n'est pas une absence ────────────────────
  it('A — SUPABASE non configuré → getTokenVersion = null, jamais 1', async () => {
    // `getItemStrict` bascule sur son repli MÉMOIRE et rend `{ok:true,
    // value:null}` : vrai d'un cache local, FAUX d'une révocation. Une instance
    // démarrée sans base concluait « version 1 ».
    supabaseConfigured.mockReturnValue(false)
    expect(await getTokenVersion('ws_fabel')).toBeNull()
  })

  it('C/D — jetons v1 ET v7 refusés quand la base n\'est pas configurée', async () => {
    const v1 = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    rows.push({ kind: 'wsver', id: 'ws_fabel', ws: '_meta', data: { id: 'ws_fabel', v: 7 } })
    const v7 = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    supabaseConfigured.mockReturnValue(false)
    expect(await resolveExtensionToken(v1, 'jarvis')).toBeNull()
    expect(await resolveExtensionToken(v7, 'jarvis')).toBeNull()
    // Et aucun jeton ne peut plus être ÉMIS non plus.
    expect(await tokenForWorkspace('ws_fabel', 'jarvis')).toBeNull()
  })

  it('E — base configurée sans ligne wsver → version 1 reste correcte', async () => {
    supabaseConfigured.mockReturnValue(true)
    expect(await getTokenVersion('ws_fabel')).toBe(1)
  })

  it('la route refuse un jeton dès que la base n\'est pas configurée', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    supabaseConfigured.mockReturnValue(false)
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'x' }), res)
    expect(res.statusCode).toBe(401)
    expect(planJarvis).not.toHaveBeenCalled()
  })

  // ── §9/§11 : l'URL Jarvis est REFUSÉE, pas tronquée ──────────────────────
  it('A — URL de 2048 caractères → acceptée', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    const url = 'https://x.fr/' + 'a'.repeat(2048 - 13)
    expect(url.length).toBe(2048)
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'ok', url }), res)
    expect(res.statusCode).toBe(200)
    expect(planJarvis).toHaveBeenCalledTimes(1)
  })

  it('B–E — URL de 2049 → 413, aucun plan, aucun LLM, aucune attente', async () => {
    // Tronquée, elle désignerait une AUTRE ressource, et Jarvis l'aurait
    // traitée comme celle que l'utilisateur regardait.
    const t = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'ok', url: 'https://x.fr/' + 'a'.repeat(2049 - 13) }), res)
    expect(res.statusCode).toBe(413)
    expect(planJarvis).not.toHaveBeenCalled()
    expect(executeJarvis).not.toHaveBeenCalled()
    expect(rows.filter((r) => r.kind === 'extpending')).toHaveLength(0)
  })

  it('le TITRE reste tronqué : le couper ne le fait pas pointer ailleurs', async () => {
    const t = (await tokenForWorkspace('ws_fabel', 'jarvis'))!
    const res = mockRes()
    await agentHandler(withToken(t, { message: 'ok', title: 'T'.repeat(9000) }), res)
    expect(res.statusCode).toBe(200)
    expect(planJarvis.mock.calls[0][2].title.length).toBe(200)
  })

  // ── §4–§8 : le storage, fail-closed ──────────────────────────────────────
  it('l\'absence de l\'API est un ÉCHEC, jamais une dispense', () => {
    const bg = read('background.js')
    expect(bg).toContain("typeof chrome.storage.local.setAccessLevel !== 'function'")
    expect(bg).toContain('storageSecurityReady = false')
  })

  it('aucun credential n\'est lu tant que le verrou n\'est pas CONFIRMÉ', () => {
    const bg = read('background.js')
    // `credential()` et `callProspector()` passent tous deux par la garde.
    const credentialFn = bg.slice(bg.indexOf('async function credential('))
    expect(credentialFn.slice(0, 400)).toContain('await securityReady()')
    const callFn = bg.slice(bg.indexOf('async function callProspector('))
    expect(callFn.slice(0, 400)).toContain('await securityReady()')
  })

  it('le message d\'échec est générique et ne décrit aucune interne', () => {
    const bg = read('background.js')
    expect(bg).toContain('Extension de sécurité non initialisée')
  })

  it('E — ui.brand reste servi sans credential, choix explicite', () => {
    const bg = read('background.js')
    const brand = bg.slice(bg.indexOf("msg?.type === 'ui.brand'"), bg.indexOf("msg?.type === 'capture.lead'"))
    expect(brand).not.toContain('securityReady')
    expect(brand).toContain("get(['brand'])")
  })

  it('F — aucune réponse runtime ne rend un jeton', () => {
    const bg = read('background.js')
    expect(bg).not.toMatch(/sendResponse\([^)]*token(Capture|Jarvis)/)
    expect(bg).not.toMatch(/brand:\s*s\.token/)
  })

  it('§6 — le manifeste exige une version minimale de Chrome', () => {
    const m = JSON.parse(read('manifest.json'))
    expect(m.minimum_chrome_version).toBeTruthy()
  })
})

// ── §13/§15 : le garde de publication ───────────────────────────────────────
describe('SEC-EXT-0.1b — garde de build RELEASE', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ext-'))
  const fixture = (origin: string, hosts: string[], extra: any = {}) => {
    const d = mkdtempSync(join(tmp, 'f-'))
    writeFileSync(join(d, 'config.js'), `const PROSPECTOR_ORIGIN = '${origin}'\n`)
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({
      host_permissions: hosts, minimum_chrome_version: '102', ...extra,
    }))
    return d
  }

  it('A — placeholder en mode DÉVELOPPEMENT → accepté', () => {
    const d = fixture('https://app.prospector.example', ['https://app.prospector.example/*'])
    expect(auditExtension(d, { release: false }).erreurs).toEqual([])
  })

  it('B — placeholder en mode RELEASE → refusé', () => {
    const d = fixture('https://app.prospector.example', ['https://app.prospector.example/*'])
    const { erreurs } = auditExtension(d, { release: true })
    expect(erreurs.join(' ')).toContain('PLACEHOLDER')
  })

  it('C — origine réelle en mode RELEASE → acceptée', () => {
    // Domaine de fixture contrôlé, qui ne se termine PAS par `.example`.
    const d = fixture('https://app.prospector-test.invalid', ['https://app.prospector-test.invalid/*'])
    expect(auditExtension(d, { release: true }).erreurs).toEqual([])
  })

  it('D — motif générique → refusé dans les DEUX modes', () => {
    const d = fixture('https://app.prospector-test.invalid', ['https://*/*'])
    expect(auditExtension(d, { release: false }).erreurs.length).toBeGreaterThan(0)
    expect(auditExtension(d, { release: true }).erreurs.join(' ')).toContain('trop large')
  })

  it('E — config ≠ manifeste → refusé', () => {
    const d = fixture('https://app.prospector-test.invalid', ['https://autre.invalid/*'])
    expect(auditExtension(d, { release: false }).erreurs.join(' ')).toContain('host_permissions')
  })

  it('content_scripts déclaré → refusé', () => {
    const d = fixture('https://a.invalid', ['https://a.invalid/*'], { content_scripts: [{ matches: ['https://a.invalid/*'] }] })
    expect(auditExtension(d, { release: false }).erreurs.join(' ')).toContain('content_scripts')
  })

  it('minimum_chrome_version absent → refusé en RELEASE seulement', () => {
    const d = mkdtempSync(join(tmp, 'g-'))
    writeFileSync(join(d, 'config.js'), "const PROSPECTOR_ORIGIN = 'https://a.invalid'\n")
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({ host_permissions: ['https://a.invalid/*'] }))
    expect(auditExtension(d, { release: false }).erreurs).toEqual([])
    expect(auditExtension(d, { release: true }).erreurs.join(' ')).toContain('minimum_chrome_version')
  })
})

// ── SEC-EXT-0.1c — version Chrome exacte, verrou d'exécution INCHANGÉ ────────
//
// La documentation officielle Chrome tranche le point laissé ouvert par le lot
// 0.1b : `StorageArea.setAccessLevel()` existe depuis **Chrome 102** et
// s'applique à `chrome.storage.local`. `"minimum_chrome_version": "111"` était
// donc trop restrictif — factuellement faux, pas dangereux : il excluait des
// navigateurs parfaitement capables de cloisonner leur stockage.
//
// ⚠️ CE QUI NE CHANGE PAS, ET C'EST L'ESSENTIEL. Le champ du manifeste n'est
// qu'une compatibilité préventive. La frontière reste le verrou d'exécution :
// `storageSecurityReady` vaut `false` par défaut, l'API absente est un ÉCHEC,
// l'API qui lève est un ÉCHEC, et aucun credential ne sort tant que le
// verrouillage n'est pas CONFIRMÉ. Les tests ci-dessous ne lisent plus le
// source : ils EXÉCUTENT `background.js` dans un faux navigateur et observent
// le comportement. Une assertion sur le texte du fichier ne prouve rien du
// comportement — c'est exactement l'erreur qui avait laissé passer le
// fail-open de `getTokenVersion`.
describe('SEC-EXT-0.1c — version minimale et verrou d\'exécution', () => {
  const read = (f: string) => readFileSync(`extension/${f}`, 'utf8')

  /** Charge `background.js` dans un service worker simulé. */
  const loadWorker = (api: 'ok' | 'absent' | 'throws') => {
    const store: Record<string, any> = {
      tokenCapture: 'pk_capture_ws_fabel_' + 'a'.repeat(40),
      tokenJarvis: 'pk_jarvis_ws_fabel_' + 'b'.repeat(40),
      brand: 'Smart AI',
    }
    const fetches: any[] = []
    let accessLevel: string | null = null
    let listener: any = null

    const local: any = {
      get: async (keys: string[]) =>
        Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
    }
    if (api === 'ok') local.setAccessLevel = async (o: any) => { accessLevel = o.accessLevel }
    if (api === 'throws') local.setAccessLevel = async () => { throw new Error('non supporté') }
    // `api === 'absent'` : la propriété n'existe tout simplement pas.

    const ctx: any = createContext({
      chrome: {
        runtime: {
          id: 'EXT_ID',
          onInstalled: { addListener: () => {} },
          onStartup: { addListener: () => {} },
          onMessage: { addListener: (f: any) => { listener = f } },
        },
        storage: { local },
      },
      fetch: async (url: string, init: any) => {
        fetches.push({ url, init })
        return { json: async () => ({ ok: true }) }
      },
      importScripts: (f: string) => runInContext(read(f), ctx),
      console,
    })
    ctx.self = ctx
    runInContext(read('background.js'), ctx)

    const send = (msg: any, senderId = 'EXT_ID') =>
      new Promise<any>((resolve) => { listener(msg, { id: senderId }, resolve) })

    return { send, fetches, level: () => accessLevel }
  }

  it('A — le manifeste exige Chrome 102, et le commentaire ne doute plus', () => {
    const m = JSON.parse(read('manifest.json'))
    expect(m.minimum_chrome_version).toBe('102')
    const c = String(m['//minimum_chrome_version'])
    // Le doute levé par la documentation officielle ne doit plus être documenté
    // comme un doute : ni « non vérifiée », ni « à confirmer », ni la
    // contradiction supposée entre les portées de stockage.
    expect(c).not.toMatch(/NON VERIFIEE|non vérifiée|A CONFIRMER|CONTREDISENT|contredis/i)
    expect(c).toContain('102')
    // Mais le champ ne doit pas non plus être présenté comme la garantie.
    expect(c).toMatch(/PAS LA FRONTIERE DE SECURITE/)
  })

  it('B — API setAccessLevel ABSENTE → aucun credential, aucun appel réseau', async () => {
    const w = loadWorker('absent')
    const r = await w.send({ type: 'capture.lead', url: 'https://x.fr', name: 'N' })
    expect(r.error).toContain('Extension de sécurité non initialisée')
    expect(w.fetches).toHaveLength(0)
    // Et rien du jeton n'a pu fuir dans la réponse.
    expect(JSON.stringify(r)).not.toContain('pk_')
  })

  it('C — API setAccessLevel qui LÈVE → aucun credential, aucun appel réseau', async () => {
    const w = loadWorker('throws')
    for (const type of ['capture.lead', 'jarvis.ask', 'jarvis.confirm', 'jarvis.cancel']) {
      const r = await w.send({ type, message: 'm', confirmationId: 'c' })
      expect(r.error).toContain('Extension de sécurité non initialisée')
    }
    expect(w.fetches).toHaveLength(0)
  })

  it('D — verrouillage CONFIRMÉ → TRUSTED_CONTEXTS, puis le credential part en en-tête', async () => {
    const w = loadWorker('ok')
    const r = await w.send({ type: 'jarvis.ask', message: 'salut' })
    expect(r).toEqual({ ok: true })
    expect(w.level()).toBe('TRUSTED_CONTEXTS')
    expect(w.fetches).toHaveLength(1)
    const { url, init } = w.fetches[0]
    expect(url).toBe('https://app.prospector.example/api/jarvis/agent')
    // Le credential voyage dans l'en-tête prévu, JAMAIS dans le corps.
    expect(init.headers['x-ingest-token']).toMatch(/^pk_jarvis_/)
    expect(init.body).not.toContain('pk_')
  })

  it('D bis — un émetteur étranger reste refusé, verrou ou pas', async () => {
    for (const api of ['ok', 'absent'] as const) {
      const w = loadWorker(api)
      const r = await w.send({ type: 'capture.lead', url: 'https://x.fr' }, 'AUTRE_EXT')
      expect(r).toEqual({ error: 'refusé' })
      expect(w.fetches).toHaveLength(0)
    }
  })

  it('non-régression — `ui.brand` reste servi sans verrou, et ne rend aucun jeton', async () => {
    const w = loadWorker('absent')
    const r = await w.send({ type: 'ui.brand' })
    expect(r).toEqual({ brand: 'Smart AI' })
    expect(JSON.stringify(r)).not.toContain('pk_')
  })

  it('E — le garde de publication reste VERT sur une build valide en 102', () => {
    const d = mkdtempSync(join(tmpdir(), 'ext102-'))
    writeFileSync(join(d, 'config.js'), "const PROSPECTOR_ORIGIN = 'https://app.prospector-test.invalid'\n")
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({
      host_permissions: ['https://app.prospector-test.invalid/*'],
      minimum_chrome_version: '102',
    }))
    expect(auditExtension(d, { release: true }).erreurs).toEqual([])
  })

  it('F — abaisser la version ne relâche AUCUNE autre règle de publication', () => {
    const d = mkdtempSync(join(tmpdir(), 'ext102-'))
    const build = (origin: string, hosts: string[], extra: any = {}) => {
      const x = mkdtempSync(join(d, 'b-'))
      writeFileSync(join(x, 'config.js'), `const PROSPECTOR_ORIGIN = '${origin}'\n`)
      writeFileSync(join(x, 'manifest.json'), JSON.stringify({
        host_permissions: hosts, minimum_chrome_version: '102', ...extra,
      }))
      return x
    }
    // placeholder
    expect(auditExtension(build('https://app.prospector.example', ['https://app.prospector.example/*']),
      { release: true }).erreurs.join(' ')).toContain('PLACEHOLDER')
    // motif générique
    expect(auditExtension(build('https://a.invalid', ['https://*/*']),
      { release: true }).erreurs.join(' ')).toContain('trop large')
    // divergence config / manifeste
    expect(auditExtension(build('https://a.invalid', ['https://autre.invalid/*']),
      { release: true }).erreurs.join(' ')).toContain('host_permissions')
    // deux permissions d'hôte au lieu d'une
    expect(auditExtension(build('https://a.invalid', ['https://a.invalid/*', 'https://b.invalid/*']),
      { release: true }).erreurs.join(' ')).toContain('host_permissions')
    // content_scripts global
    expect(auditExtension(build('https://a.invalid', ['https://a.invalid/*'],
      { content_scripts: [{ matches: ['https://a.invalid/*'] }] }),
      { release: true }).erreurs.join(' ')).toContain('content_scripts')
    // origine non HTTPS
    expect(auditExtension(build('http://a.invalid', ['http://a.invalid/*']),
      { release: true }).erreurs.join(' ')).toContain('non HTTPS')
  })
})
