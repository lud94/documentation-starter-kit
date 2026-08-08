import { describe, it, expect, beforeEach, vi } from 'vitest'

// Lot SEC-TG — Telegram est une PORTE D'ENTRÉE EXTERNE.
//
// Quatre défauts confirmés, tous du même genre : une autorité déduite au lieu
// d'être vérifiée.
//   1. `if (secret && header !== secret)` — un secret ABSENT faisait SAUTER la
//      vérification. N'importe qui connaissant l'URL pouvait forger une mise à
//      jour, se faire passer pour un chat appairé, et agir dans son espace ;
//   2. `callback_data: 'ok'` ne désigne rien. Un bouton d'un vieux message
//      confirmait l'action en attente du moment, quelle qu'elle soit ;
//   3. `listItems → find → deleteItem → execute` : deux rappels simultanés
//      exécutaient TOUS DEUX l'action ;
//   4. l'attente n'était liée à aucun espace : un chat ré-appairé exécutait
//      l'action de l'ancien client dans le nouveau.

// ── Magasin réel, avec les primitives atomiques déjà prouvées ───────────────
type Row = { kind: string; id: string; ws: string; data: any }
let rows: Row[] = []

const getItem = vi.fn(async (kind: string, id: string, ws: string) =>
  rows.find((r) => r.kind === kind && r.id === id && r.ws === ws)?.data ?? null)
const listItems = vi.fn(async (kind: string, ws: string) =>
  rows.filter((r) => r.kind === kind && r.ws === ws).map((r) => r.data))
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
// Compare-and-delete : la comparaison et la suppression sont indissociables.
const claimItemIfField = vi.fn(async (kind: string, id: string, ws: string, field: string, expected: string) => {
  await Promise.resolve()
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws
    && String(r.data?.[field]) === expected)
  return i < 0 ? null : rows.splice(i, 1)[0].data
})
const deleteExpired = vi.fn(async () => true)

const WORKSPACES: Record<string, any> = {
  ws_fabel: { id: 'ws_fabel', name: 'Fabel', status: 'active' },
  ws_client_b: { id: 'ws_client_b', name: 'Client B', status: 'active' },
}
const getWorkspaceById = vi.fn(async (id: string) => WORKSPACES[id] ?? null)

vi.mock('../lib/supabase/store', () => ({
  getItem: (...a: any[]) => (getItem as any)(...a),
  listItems: (...a: any[]) => (listItems as any)(...a),
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

import telegramHandler from '../pages/api/channels/telegram'
import {
  createPendingAction, consumePendingAction, cancelPendingAction, PENDING_TTL_MS,
} from '../lib/prospector/channelPending'

const NS = '_channels'
const SECRET = 'secret-de-webhook'
const CHAT = 4242
const CHAT_KEY = `tg:${CHAT}`

let sent: string[] = []
function mockRes() {
  const r: any = { statusCode: 0, body: undefined }
  r.status = (c: number) => { r.statusCode = c; return r }
  r.json = (b: any) => { r.body = b; return r }
  return r
}
const req = (body: any, headers: Record<string, string> = { 'x-telegram-bot-api-secret-token': SECRET }) =>
  ({ method: 'POST', headers, body, cookies: {}, query: {} } as any)

const message = (text: string) => ({ message: { chat: { id: CHAT }, text, from: { first_name: 'Léa' } } })
const callback = (data: string) => ({ callback_query: { id: 'cb1', data, message: { chat: { id: CHAT } } } })

/** Le chat est appairé à cet espace. */
const link = (ws: string) =>
  rows.push({ kind: 'pairlink', id: CHAT_KEY, ws: NS, data: { id: CHAT_KEY, ws, at: Date.now() } })

/** Dernier bouton de confirmation proposé par le bot. */
const lastConfirmId = () => {
  for (let i = fetchMock.mock.calls.length - 1; i >= 0; i--) {
    const body = JSON.parse(fetchMock.mock.calls[i][1]?.body || '{}')
    const cd = body?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data
    if (cd) return String(cd).split(':')[1]
  }
  return null
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  rows = []; sent = []
  vi.clearAllMocks()
  for (const k of Object.keys(KEYS)) delete KEYS[k]
  KEYS.TELEGRAM_BOT_TOKEN = 'bot-token'
  KEYS.TELEGRAM_WEBHOOK_SECRET = SECRET
  getWorkspaceById.mockImplementation(async (id: string) => WORKSPACES[id] ?? null)
  planJarvis.mockResolvedValue({ reply: 'Je vais écrire.', action: { type: 'write', target: 'lead_1' } })
  executeJarvis.mockResolvedValue('fait')
  fetchMock = vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init?.body || '{}')
    if (String(url).includes('sendMessage')) sent.push(String(body.text || ''))
    return { ok: true, json: async () => ({ ok: true }) }
  })
  ;(globalThis as any).fetch = fetchMock
})

// ── A/B/C — le secret du webhook ────────────────────────────────────────────
describe('A/B/C — le webhook n\'est traité que si le secret concorde', () => {
  it('A — DÉFAUT : secret ABSENT côté serveur → RIEN n\'est traité', async () => {
    // `if (secret && header !== secret)` sautait la vérification quand le
    // secret n'était pas configuré : n'importe qui connaissant l'URL pouvait
    // forger une mise à jour et agir dans l'espace d'un chat appairé.
    delete KEYS.TELEGRAM_WEBHOOK_SECRET
    link('ws_fabel')
    const res = mockRes()
    await telegramHandler(req(message('ajoute Redsen'), {}), res)
    expect(planJarvis).not.toHaveBeenCalled()
    expect(executeJarvis).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('A bis — jeton de bot absent → rien n\'est traité', async () => {
    delete KEYS.TELEGRAM_BOT_TOKEN
    link('ws_fabel')
    const res = mockRes()
    await telegramHandler(req(message('ajoute Redsen')), res)
    expect(planJarvis).not.toHaveBeenCalled()
  })

  it('B — secret INCORRECT → 401, aucun traitement', async () => {
    link('ws_fabel')
    const res = mockRes()
    await telegramHandler(req(message('ajoute Redsen'), { 'x-telegram-bot-api-secret-token': 'faux' }), res)
    expect(res.statusCode).toBe(401)
    expect(planJarvis).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('B bis — en-tête absent → 401', async () => {
    link('ws_fabel')
    const res = mockRes()
    await telegramHandler(req(message('salut'), {}), res)
    expect(res.statusCode).toBe(401)
  })

  it('le refus ne divulgue ni le secret ni l\'en-tête reçu', async () => {
    const res = mockRes()
    await telegramHandler(req(message('salut'), { 'x-telegram-bot-api-secret-token': 'sonde-1234' }), res)
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain('sonde-1234')
  })

  it('C — secret CORRECT → fonctionnement nominal', async () => {
    link('ws_fabel')
    const res = mockRes()
    await telegramHandler(req(message('ajoute Redsen')), res)
    expect(res.statusCode).toBe(200)
    expect(planJarvis).toHaveBeenCalledTimes(1)
    expect(lastConfirmId()).toMatch(/^[0-9a-f]{32}$/)
  })
})

// ── D/E/F/G/H/I/O — le bouton de confirmation ───────────────────────────────
describe('D–I/O — un bouton ne confirme qu\'UNE action précise', () => {
  async function proposer() {
    link('ws_fabel')
    await telegramHandler(req(message('ajoute Redsen')), mockRes())
    return lastConfirmId()!
  }

  it('D — identifiant inconnu → DENY, aucune exécution', async () => {
    await proposer()
    executeJarvis.mockClear()
    await telegramHandler(req(callback(`confirm:${'a'.repeat(32)}`)), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('E — confirmation EXPIRÉE → DENY', async () => {
    const cid = await proposer()
    const row = rows.find((r) => r.kind === 'tgpending')!
    row.data.expiresAt = Date.now() - 1000
    executeJarvis.mockClear()
    await telegramHandler(req(callback(`confirm:${cid}`)), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('F — REJEU du même bouton → une seule exécution', async () => {
    const cid = await proposer()
    executeJarvis.mockClear()
    await telegramHandler(req(callback(`confirm:${cid}`)), mockRes())
    await telegramHandler(req(callback(`confirm:${cid}`)), mockRes())
    expect(executeJarvis).toHaveBeenCalledTimes(1)
  })

  it('G — 20 confirmations SIMULTANÉES du même nonce → UNE exécution', async () => {
    const cid = await proposer()
    executeJarvis.mockClear()
    await Promise.all(Array.from({ length: 20 }, () =>
      telegramHandler(req(callback(`confirm:${cid}`)), mockRes())))
    expect(executeJarvis).toHaveBeenCalledTimes(1)
  })

  it('H — 10 confirm + 10 cancel simultanés → UNE seule issue gagnante', async () => {
    const cid = await proposer()
    executeJarvis.mockClear()
    const calls = [
      ...Array.from({ length: 10 }, () => telegramHandler(req(callback(`confirm:${cid}`)), mockRes())),
      ...Array.from({ length: 10 }, () => telegramHandler(req(callback(`cancel:${cid}`)), mockRes())),
    ]
    await Promise.all(calls)
    // Au plus une exécution, et l'attente n'existe plus.
    expect(executeJarvis.mock.calls.length).toBeLessThanOrEqual(1)
    expect(rows.filter((r) => r.kind === 'tgpending')).toHaveLength(0)
  })

  it('I — un VIEUX bouton n\'exécute ni son action ni la nouvelle', async () => {
    const ancien = await proposer()
    planJarvis.mockResolvedValue({ reply: 'Autre écriture.', action: { type: 'write', target: 'lead_2' } })
    await telegramHandler(req(message('supprime Acme')), mockRes())
    const nouveau = lastConfirmId()!
    expect(nouveau).not.toBe(ancien)

    executeJarvis.mockClear()
    await telegramHandler(req(callback(`confirm:${ancien}`)), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()

    // …et la nouvelle attente est intacte.
    await telegramHandler(req(callback(`confirm:${nouveau}`)), mockRes())
    expect(executeJarvis).toHaveBeenCalledTimes(1)
    expect(executeJarvis.mock.calls[0][1]).toEqual({ type: 'write', target: 'lead_2' })
  })

  it('O — callback_data trafiqué → DENY, la base n\'est même pas touchée', async () => {
    await proposer()
    executeJarvis.mockClear()
    claimItemIfField.mockClear()
    for (const bad of ['ok', 'no', 'confirm:', 'confirm:xyz', 'confirm:../../etc',
      `confirm:${'A'.repeat(32)}`, `execute:${'a'.repeat(32)}`, '']) {
      await telegramHandler(req(callback(bad)), mockRes())
    }
    expect(executeJarvis).not.toHaveBeenCalled()
    for (const call of claimItemIfField.mock.calls) expect(call[0]).not.toBe('tgpending')
  })
})

// ── J/K/L/M/N — le lien chat ↔ espace est revalidé à l'exécution ────────────
describe('J–N — une confirmation ne survit pas à un changement de propriétaire', () => {
  async function proposerPour(ws: string) {
    rows = []
    link(ws)
    await telegramHandler(req(message('ajoute Redsen')), mockRes())
    return lastConfirmId()!
  }

  it('J — attente de Fabel présentée depuis un AUTRE chat → DENY', async () => {
    const cid = await proposerPour('ws_fabel')
    executeJarvis.mockClear()
    await telegramHandler(req({
      callback_query: { id: 'x', data: `confirm:${cid}`, message: { chat: { id: 9999 } } },
    }), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()
    // L'attente du propriétaire légitime est INTACTE : un identifiant
    // intercepté ne détruit pas la confirmation d'autrui.
    expect(rows.filter((r) => r.kind === 'tgpending')).toHaveLength(1)
  })

  it('K — chat RÉ-APPAIRÉ vers Client B avant confirmation → DENY', async () => {
    const cid = await proposerPour('ws_fabel')
    const l = rows.find((r) => r.kind === 'pairlink')!
    l.data.ws = 'ws_client_b'          // le canal appartient désormais à Client B
    executeJarvis.mockClear()
    await telegramHandler(req(callback(`confirm:${cid}`)), mockRes())
    // Ni dans Fabel, ni dans Client B.
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('L — espace SUSPENDU avant confirmation → DENY', async () => {
    const cid = await proposerPour('ws_fabel')
    getWorkspaceById.mockResolvedValue({ id: 'ws_fabel', status: 'suspended' })
    executeJarvis.mockClear()
    await telegramHandler(req(callback(`confirm:${cid}`)), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('M — espace SUPPRIMÉ avant confirmation → DENY', async () => {
    const cid = await proposerPour('ws_fabel')
    getWorkspaceById.mockResolvedValue(null)
    executeJarvis.mockClear()
    await telegramHandler(req(callback(`confirm:${cid}`)), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('N — chat DÉLIÉ avant confirmation → DENY', async () => {
    const cid = await proposerPour('ws_fabel')
    const i = rows.findIndex((r) => r.kind === 'pairlink')
    rows.splice(i, 1)
    executeJarvis.mockClear()
    await telegramHandler(req(callback(`confirm:${cid}`)), mockRes())
    expect(executeJarvis).not.toHaveBeenCalled()
  })

  it('l\'espace exécuté est celui du LIEN, jamais une valeur du message', async () => {
    const cid = await proposerPour('ws_fabel')
    executeJarvis.mockClear()
    await telegramHandler(req({
      callback_query: {
        id: 'x', data: `confirm:${cid}`, message: { chat: { id: CHAT } },
        // Champs hostiles glissés dans la charge utile Telegram.
        workspace_id: 'ws_client_b', tenant: 'ws_client_b', role: 'admin',
      },
    }), mockRes())
    expect(executeJarvis).toHaveBeenCalledTimes(1)
    expect(executeJarvis.mock.calls[0][0]).toEqual({ id: 'ws_fabel', kind: 'client' })
    expect(executeJarvis.mock.calls[0][2]).toBe('ws_fabel')
  })
})

// ── P/Q/R/S — charge utile hostile, non-appairage, erreurs, redélivrance ────
describe('P/Q/R/S — charge utile non fiable, et robustesse', () => {
  it('P — workspace_id dans le message n\'a AUCUN effet', async () => {
    link('ws_fabel')
    planJarvis.mockResolvedValue({ reply: 'ok', action: null })
    await telegramHandler(req({
      message: {
        chat: { id: CHAT }, text: 'mes chiffres',
        workspace_id: 'ws_client_b', tenant_id: 'ws_client_b', permissions: { admin: true },
      },
    }), mockRes())
    expect(planJarvis.mock.calls[0][0]).toEqual({ id: 'ws_fabel', kind: 'client' })
  })

  it('Q — chat NON appairé → aucune action métier, aucun oracle d\'espace', async () => {
    await telegramHandler(req(message('mes chiffres')), mockRes())
    expect(planJarvis).not.toHaveBeenCalled()
    expect(executeJarvis).not.toHaveBeenCalled()
    // Aucun nom ni identifiant d'espace ne fuit vers un chat non autorisé.
    for (const t of sent) {
      expect(t).not.toContain('ws_fabel')
      expect(t).not.toContain('Fabel')
    }
  })

  it('Q bis — /start ne révèle ni le nom ni l\'identifiant de l\'espace', async () => {
    link('ws_fabel')
    await telegramHandler(req(message('/start')), mockRes())
    expect(sent.join(' ')).toContain('Déjà connecté')
    for (const t of sent) {
      expect(t).not.toContain('ws_fabel')
      expect(t).not.toContain('Fabel')
    }
  })

  it('R — exception interne → message générique, aucun détail sensible', async () => {
    link('ws_fabel')
    planJarvis.mockRejectedValue(new Error('relation "prospector_leads" does not exist at https://xyz.supabase.co'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await telegramHandler(req(message('ajoute Redsen')), mockRes())
    err.mockRestore()

    const raw = sent.join(' ')
    expect(raw).toContain('erreur interne')
    expect(raw).not.toContain('prospector_leads')
    expect(raw).not.toContain('supabase.co')
    expect(raw).not.toContain('relation')
  })

  it('S — REDÉLIVRANCE du même callback → une seule mutation', async () => {
    link('ws_fabel')
    await telegramHandler(req(message('ajoute Redsen')), mockRes())
    const cid = lastConfirmId()!
    executeJarvis.mockClear()
    // Telegram redélivre à l'identique quand le webhook a mis trop de temps.
    await Promise.all([
      telegramHandler(req(callback(`confirm:${cid}`)), mockRes()),
      telegramHandler(req(callback(`confirm:${cid}`)), mockRes()),
      telegramHandler(req(callback(`confirm:${cid}`)), mockRes()),
    ])
    expect(executeJarvis).toHaveBeenCalledTimes(1)
  })

  it('une LECTURE ne demande aucune confirmation et n\'écrit rien', async () => {
    link('ws_fabel')
    planJarvis.mockResolvedValue({ reply: 'Voici.', action: { type: 'read' } })
    await telegramHandler(req(message('mes chiffres')), mockRes())
    expect(rows.filter((r) => r.kind === 'tgpending')).toHaveLength(0)
    expect(lastConfirmId()).toBeNull()
  })
})

// ── Le module d'attente, isolément ──────────────────────────────────────────
describe('channelPending — le contrat de l\'attente', () => {
  it('l\'identifiant est cryptographique, 128 bits, et jamais dérivé', async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) {
      rows = []
      const cid = (await createPendingAction('tg:1', 'ws_fabel', { type: 'write' }))!
      expect(cid).toMatch(/^[0-9a-f]{32}$/)
      // Ni le chat, ni l'espace ne s'y retrouvent.
      expect(cid).not.toContain('1'.repeat(8))
      ids.add(cid)
    }
    expect(ids.size).toBe(200)
  })

  it('l\'attente porte le chat, l\'espace et l\'expiration', async () => {
    const cid = (await createPendingAction(CHAT_KEY, 'ws_fabel', { type: 'write' }))!
    const row = rows.find((r) => r.kind === 'tgpending')!.data
    expect(row).toMatchObject({ id: cid, chatKey: CHAT_KEY, ws: 'ws_fabel' })
    expect(row.expiresAt - row.at).toBe(PENDING_TTL_MS)
  })

  it('UNE seule attente par chat : la nouvelle efface l\'ancienne', async () => {
    const a = (await createPendingAction(CHAT_KEY, 'ws_fabel', { type: 'write', n: 1 }))!
    const b = (await createPendingAction(CHAT_KEY, 'ws_fabel', { type: 'write', n: 2 }))!
    expect(rows.filter((r) => r.kind === 'tgpending')).toHaveLength(1)
    expect(await consumePendingAction(a, CHAT_KEY)).toBeNull()
    expect((await consumePendingAction(b, CHAT_KEY))?.action).toEqual({ type: 'write', n: 2 })
  })

  it('la consommation depuis un AUTRE chat ne détruit pas l\'attente', async () => {
    const cid = (await createPendingAction(CHAT_KEY, 'ws_fabel', { type: 'write' }))!
    expect(await consumePendingAction(cid, 'tg:autre')).toBeNull()
    expect(rows.filter((r) => r.kind === 'tgpending')).toHaveLength(1)
    expect(await consumePendingAction(cid, CHAT_KEY)).toBeTruthy()
  })

  it('confirmer et annuler consomment la MÊME ressource', async () => {
    const cid = (await createPendingAction(CHAT_KEY, 'ws_fabel', { type: 'write' }))!
    expect(await cancelPendingAction(cid, CHAT_KEY)).toBe(true)
    expect(await consumePendingAction(cid, CHAT_KEY)).toBeNull()
  })

  it('20 consommations concurrentes → exactement UNE obtient l\'action', async () => {
    const cid = (await createPendingAction(CHAT_KEY, 'ws_fabel', { type: 'write' }))!
    const r = await Promise.all(Array.from({ length: 20 }, () => consumePendingAction(cid, CHAT_KEY)))
    expect(r.filter(Boolean)).toHaveLength(1)
  })

  it('la consommation d\'un ANCIEN bouton n\'efface pas le titulaire courant', async () => {
    const a = (await createPendingAction(CHAT_KEY, 'ws_fabel', { type: 'write', n: 1 }))!
    const b = (await createPendingAction(CHAT_KEY, 'ws_fabel', { type: 'write', n: 2 }))!
    await consumePendingAction(a, CHAT_KEY)   // ancien, déjà mort
    const holder = rows.find((r) => r.kind === 'tgpendingactive')
    expect(holder?.data.cid).toBe(b)
  })
})
