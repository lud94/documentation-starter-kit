import { describe, it, expect, beforeEach, vi } from 'vitest'

// Lot SEC-0d — appairage à usage unique réel, et egress fail-closed.
//
// Deux défauts, une même faute de raisonnement : traiter l'incertitude comme
// une autorisation.
//   • `listItems → find → deleteItem` : deux requêtes concurrentes lisaient le
//     même code avant que l'une ne le supprime, et toutes deux appairaient ;
//   • `.catch(() => ({ allowed: true }))` : une erreur réseau ouvrait l'egress.

// ── Magasin réel, avec suppression ATOMIQUE ─────────────────────────────────
// `claimItem` est modélisé comme un `DELETE … RETURNING` : la suppression et la
// lecture sont indissociables. Toute autre modélisation ferait passer le test
// pour de mauvaises raisons.
type Row = { kind: string; id: string; ws: string; data: any }
let rows: Row[] = []

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
const claimItem = vi.fn(async (kind: string, id: string, ws: string) => {
  // Une seule opération indivisible, comme le DELETE de PostgreSQL. On cède
  // volontairement la main AVANT, pour que l'ordonnanceur puisse entrelacer
  // les appelants — c'est justement ce qui cassait la version check-then-act.
  await Promise.resolve()
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws)
  if (i < 0) return null
  return rows.splice(i, 1)[0].data
})

const WORKSPACES: Record<string, any> = {
  ws_fabel: { id: 'ws_fabel', name: 'Fabel', status: 'active' },
  ws_suspendu: { id: 'ws_suspendu', name: 'Suspendu', status: 'suspended' },
}
const getWorkspaceById = vi.fn(async (id: string) => WORKSPACES[id] ?? null)

vi.mock('../lib/supabase/store', () => ({
  listItems: (...a: any[]) => (listItems as any)(...a),
  getItem: (...a: any[]) => (getItem as any)(...a),
  upsertItem: (...a: any[]) => (upsertItem as any)(...a),
  deleteItem: (...a: any[]) => (deleteItem as any)(...a),
  claimItem: (...a: any[]) => (claimItem as any)(...a),
}))
vi.mock('../lib/supabase/workspaces', () => ({
  getWorkspaceById: (...a: any[]) => (getWorkspaceById as any)(...a),
  listWorkspaces: async () => Object.values(WORKSPACES),
}))

import {
  createPairingCode, redeemPairingCode, resolveChannelWs, pairingCode,
  MAX_FAILURES, CODE_DIGITS,
} from '../lib/prospector/pairing'
import { decideExternalAiPolicy, loadExternalAiPolicy } from '../lib/prospector/externalAiPolicy'

const NS = '_channels'
const seed = (code: string, ws: string, at = Date.now()) =>
  rows.push({ kind: 'paircode', id: code, ws: NS, data: { id: code, ws, at } })

beforeEach(() => {
  rows = []
  vi.clearAllMocks()
  getWorkspaceById.mockImplementation(async (id: string) => WORKSPACES[id] ?? null)
})

// ── Entropie du code ────────────────────────────────────────────────────────
describe('le code est cryptographique, uniforme et assez long', () => {
  it('longueur fixe et chiffres uniquement', () => {
    for (let i = 0; i < 200; i++) expect(pairingCode()).toMatch(new RegExp(`^\\d{${CODE_DIGITS}}$`))
  })

  it('huit chiffres — l\'épuisement passe sous 0,05 % par fenêtre', () => {
    // 10 000 chats × 5 essais = 5 × 10⁴ tentatives.
    //   à 6 chiffres : 5 × 10⁴ / 10⁶ ≈ 5 %   — inacceptable
    //   à 8 chiffres : 5 × 10⁴ / 10⁸ = 0,05 %
    expect(CODE_DIGITS).toBe(8)
    const space = 9 * 10 ** (CODE_DIGITS - 1)
    expect((10_000 * MAX_FAILURES) / space).toBeLessThan(0.001)
  })

  it('aucune répétition sur un large tirage', () => {
    const seen = new Set(Array.from({ length: 3000 }, () => pairingCode()))
    expect(seen.size).toBe(3000)
  })

  it('utilise le générateur cryptographique, pas Math.random', () => {
    const rnd = vi.spyOn(Math, 'random')
    pairingCode()
    expect(rnd).not.toHaveBeenCalled()
    rnd.mockRestore()
  })
})

// ── CONCURRENCE — le cœur du lot ────────────────────────────────────────────
describe('usage unique RÉEL sous concurrence', () => {
  it('deux chats présentent le BON code simultanément → UN SEUL gagne', async () => {
    const { code } = await createPairingCode('ws_fabel')
    const [a, b] = await Promise.all([
      redeemPairingCode(code, 'tg:1', 'A'),
      redeemPairingCode(code, 'tg:2', 'B'),
    ])
    const winners = [a, b].filter((x) => x !== null)
    expect(winners).toHaveLength(1)
    // …et un seul lien existe réellement.
    const links = rows.filter((r) => r.kind === 'pairlink')
    expect(links).toHaveLength(1)
  })

  it('douze requêtes concurrentes sur le même code → exactement UNE gagne', async () => {
    const { code } = await createPairingCode('ws_fabel')
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => redeemPairingCode(code, `tg:${i}`, `chat ${i}`)))
    expect(results.filter((r) => r === 'ws_fabel')).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(11)
    expect(rows.filter((r) => r.kind === 'pairlink')).toHaveLength(1)
  })

  it('la SECONDE consommation séquentielle échoue', async () => {
    const { code } = await createPairingCode('ws_fabel')
    expect(await redeemPairingCode(code, 'tg:1')).toBe('ws_fabel')
    expect(await redeemPairingCode(code, 'tg:2')).toBeNull()
  })

  it('la réclamation est ATOMIQUE : jamais listItems puis deleteItem', async () => {
    const { code } = await createPairingCode('ws_fabel')
    await redeemPairingCode(code, 'tg:1')
    expect(claimItem).toHaveBeenCalledWith('paircode', code, NS)
    // Le chemin check-then-act ne doit plus exister du tout.
    for (const call of listItems.mock.calls) expect(call[0]).not.toBe('paircode')
    for (const call of deleteItem.mock.calls) expect(call[0]).not.toBe('paircode')
  })
})

// ── Anti-épuisement ─────────────────────────────────────────────────────────
describe('brute-force : quota par chat, refus uniforme', () => {
  it(`après ${MAX_FAILURES} échecs, même le BON code est refusé`, async () => {
    const { code } = await createPairingCode('ws_fabel')
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect(await redeemPairingCode('00000000', 'tg:pirate')).toBeNull()
    }
    // Le code est valide, le chat ne l'est plus.
    expect(await redeemPairingCode(code, 'tg:pirate')).toBeNull()
    // Et il n'a même pas été consommé : la victime peut encore s'en servir.
    expect(await redeemPairingCode(code, 'tg:honnete')).toBe('ws_fabel')
  })

  it('un chat saturé n\'est plus lu du tout — pas d\'oracle par effet de bord', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await redeemPairingCode('00000000', 'tg:pirate')
    claimItem.mockClear()
    await redeemPairingCode('12345678', 'tg:pirate')
    expect(claimItem).not.toHaveBeenCalled()
  })

  it('le quota est PAR CHAT : un chat honnête n\'est pas puni', async () => {
    const { code } = await createPairingCode('ws_fabel')
    for (let i = 0; i < MAX_FAILURES + 3; i++) await redeemPairingCode('00000000', 'tg:pirate')
    expect(await redeemPairingCode(code, 'tg:honnete')).toBe('ws_fabel')
  })

  it('un mauvais FORMAT compte aussi comme un échec', async () => {
    // Sinon le quota se contournerait en variant la longueur.
    for (let i = 0; i < MAX_FAILURES; i++) await redeemPairingCode('123', 'tg:pirate')
    const { code } = await createPairingCode('ws_fabel')
    expect(await redeemPairingCode(code, 'tg:pirate')).toBeNull()
  })

  it('la fenêtre expire et rend ses essais', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await redeemPairingCode('00000000', 'tg:pirate')
    // Le compteur est vieilli au-delà de la fenêtre.
    const c = rows.find((r) => r.kind === 'pairfail')!
    c.data.since = Date.now() - 20 * 60 * 1000
    const { code } = await createPairingCode('ws_fabel')
    expect(await redeemPairingCode(code, 'tg:pirate')).toBe('ws_fabel')
  })

  it('10 000 tentatives depuis un seul chat n\'aboutissent jamais', async () => {
    const { code } = await createPairingCode('ws_fabel')
    for (let i = 0; i < 200; i++) {
      const guess = String(10_000_000 + i)
      expect(await redeemPairingCode(guess, 'tg:pirate')).toBeNull()
    }
    // Le vrai code est resté intact et le chat est bloqué.
    expect(await redeemPairingCode(code, 'tg:pirate')).toBeNull()
    expect(rows.find((r) => r.kind === 'paircode' && r.id === code)).toBeTruthy()
  })
})

// ── Expiration, espace invalide, absence d'oracle ───────────────────────────
describe('refus uniformes : rien ne distingue les causes', () => {
  it('code EXPIRÉ refusé, et tout de même consommé', async () => {
    seed('11111111', 'ws_fabel', Date.now() - 20 * 60 * 1000)
    expect(await redeemPairingCode('11111111', 'tg:1')).toBeNull()
    // Présenté une fois, il ne doit plus jamais l'être.
    expect(rows.find((r) => r.kind === 'paircode' && r.id === '11111111')).toBeUndefined()
  })

  it('espace SUSPENDU au moment du rachat → refus', async () => {
    seed('22222222', 'ws_suspendu')
    expect(await redeemPairingCode('22222222', 'tg:1')).toBeNull()
    expect(rows.filter((r) => r.kind === 'pairlink')).toHaveLength(0)
  })

  it('espace SUPPRIMÉ entre la génération et le rachat → refus', async () => {
    const { code } = await createPairingCode('ws_fabel')
    getWorkspaceById.mockResolvedValue(null)
    expect(await redeemPairingCode(code, 'tg:1')).toBeNull()
    expect(await resolveChannelWs('tg:1')).toBeNull()
  })

  it('base indisponible → refus, jamais un appairage supposé', async () => {
    const { code } = await createPairingCode('ws_fabel')
    getWorkspaceById.mockRejectedValue(new Error('db down'))
    expect(await redeemPairingCode(code, 'tg:1')).toBeNull()
  })

  it('inexistant, expiré, suspendu et saturé rendent TOUS la même valeur', async () => {
    seed('33333333', 'ws_fabel', Date.now() - 20 * 60 * 1000)
    seed('44444444', 'ws_suspendu')
    const causes = [
      await redeemPairingCode('99999999', 'tg:a'),   // inexistant
      await redeemPairingCode('33333333', 'tg:b'),   // expiré
      await redeemPairingCode('44444444', 'tg:c'),   // espace suspendu
      await redeemPairingCode('123', 'tg:d'),        // format
    ]
    expect(causes).toEqual([null, null, null, null])
  })
})

// ── EGRESS — la politique refuse par défaut ─────────────────────────────────
describe('B–F — toute incertitude sur la politique REFUSE l\'egress', () => {
  it.each([
    ['403 refus', false, { error: 'forbidden' }],
    ['503 indisponible', false, { error: 'policy_unavailable' }],
    ['500 corps vide', false, null],
    ['200 mais allowed absent', true, {}],
    ['200 mais allowed=false', true, { allowed: false, maskPii: false }],
    ['200 mais allowed="yes"', true, { allowed: 'yes', maskPii: false }],
    ['200 mais allowed=1', true, { allowed: 1 }],
    ['200 corps nul', true, null],
    ['200 corps non-objet', true, 'allowed'],
    ['200 tableau', true, [{ allowed: true }]],
  ])('%s → DENY', (_label, ok, body) => {
    expect(decideExternalAiPolicy(ok as boolean, body).state).toBe('denied')
  })

  it('D — erreur réseau → DENY, et aucune exception ne s\'échappe', async () => {
    const p = await loadExternalAiPolicy(async () => { throw new Error('offline') })
    expect(p.state).toBe('denied')
  })

  it('E — JSON malformé sur une réponse 200 → DENY', async () => {
    const p = await loadExternalAiPolicy(async () => ({
      ok: true, json: async () => { throw new SyntaxError('Unexpected token <') },
    }) as any)
    expect(p.state).toBe('denied')
  })

  it('un tableau contenant allowed:true ne vaut pas autorisation', () => {
    expect(decideExternalAiPolicy(true, [{ allowed: true }]).state).toBe('denied')
  })

  it('G/H — seul allowed===true autorise, et maskPii INCONNU vaut MASQUER', () => {
    expect(decideExternalAiPolicy(true, { allowed: true, maskPii: true }))
      .toEqual({ state: 'granted', maskPii: true })
    expect(decideExternalAiPolicy(true, { allowed: true, maskPii: false }))
      .toEqual({ state: 'granted', maskPii: false })
    // Absent, nul, ou d'un type inattendu ⇒ on masque.
    for (const v of [undefined, null, 'non', 0, {}]) {
      expect(decideExternalAiPolicy(true, { allowed: true, maskPii: v }))
        .toEqual({ state: 'granted', maskPii: true })
    }
  })
})
