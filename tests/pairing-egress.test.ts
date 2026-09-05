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
const insertItemIfAbsent = vi.fn(async (kind: string, id: string, data: any, ws: string) => {
  // Modélise un INSERT nu sous clé primaire : on cède la main AVANT de tester,
  // pour que plusieurs appelants concurrents observent bien la même absence —
  // c'est ce qui casserait une implémentation lecture-modification-écriture.
  await Promise.resolve()
  if (rows.some((r) => r.kind === kind && r.id === id && r.ws === ws)) return false
  rows.push({ kind, id, ws, data })
  return true
})
// Purge par ÂGE, comme le DELETE … WHERE updated_at < … de PostgreSQL.
const deleteExpired = vi.fn(async (kind: string, ws: string, olderThanIso: string) => {
  const cutoff = Date.parse(olderThanIso)
  rows = rows.filter((r) => !(r.kind === kind && r.ws === ws && (r.data?.at ?? 0) < cutoff))
  return true
})
// Point d'injection des courses : exécuté au DÉBUT de toute opération qui
// consomme le titulaire, quelle que soit l'implémentation. Il modélise « la
// rotation a été validée entre la lecture de R1 et sa suppression ».
let beforeHolderConsume: (() => void) | null = null
const runHook = () => { const h = beforeHolderConsume; beforeHolderConsume = null; h?.() }

// COMPARE-AND-DELETE : la comparaison et la suppression sont indissociables,
// comme le `DELETE … WHERE data->>champ = attendu RETURNING` de PostgreSQL.
const claimItemIfField = vi.fn(async (kind: string, id: string, ws: string, field: string, expected: string) => {
  await Promise.resolve()
  if (kind === 'pairactive') runHook()
  const i = rows.findIndex((r) => r.kind === kind && r.id === id && r.ws === ws
    && String(r.data?.[field]) === expected)
  if (i < 0) return null
  return rows.splice(i, 1)[0].data
})
const claimItem = vi.fn(async (kind: string, id: string, ws: string) => {
  // Une seule opération indivisible, comme le DELETE de PostgreSQL. On cède
  // volontairement la main AVANT, pour que l'ordonnanceur puisse entrelacer
  // les appelants — c'est justement ce qui cassait la version check-then-act.
  await Promise.resolve()
  if (kind === 'pairactive') runHook()
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
  claimItemIfField: (...a: any[]) => (claimItemIfField as any)(...a),
  upsertItem: (...a: any[]) => (upsertItem as any)(...a),
  deleteItem: (...a: any[]) => (deleteItem as any)(...a),
  claimItem: (...a: any[]) => (claimItem as any)(...a),
  insertItemIfAbsent: (...a: any[]) => (insertItemIfAbsent as any)(...a),
  deleteExpired: (...a: any[]) => (deleteExpired as any)(...a),
}))
vi.mock('../lib/supabase/workspaces', () => ({
  getWorkspaceById: (...a: any[]) => (getWorkspaceById as any)(...a),
  listWorkspaces: async () => Object.values(WORKSPACES),
}))

import {
  createPairingCode, redeemPairingCode, resolveChannelWs, pairingCode,
  MAX_FAILURES, CODE_DIGITS, FAILURE_WINDOW_MS,
} from '../lib/prospector/pairing'
import { decideExternalAiPolicy, loadExternalAiPolicy } from '../lib/prospector/externalAiPolicy'

const NS = '_channels'
const seed = (code: string, ws: string, at = Date.now()) =>
  rows.push({ kind: 'paircode', id: code, ws: NS, data: { id: code, ws, at } })

beforeEach(() => {
  rows = []
  beforeHolderConsume = null
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

  it('le tirage n\'est ni constant ni cyclique', () => {
    // ⚠️ CE CAS ÉTAIT INSTABLE, et c'est ma faute : il exigeait 3000 tirages
    // TOUS distincts dans un espace de 9·10⁷. Le paradoxe des anniversaires
    // donne ~3000²/(2·9·10⁷) ≈ 0,05 collision attendue, soit environ 5 % de
    // faux échecs. Un test de sécurité qui échoue une fois sur vingt sans
    // défaut apprend à ignorer les échecs — c'est pire que pas de test.
    //
    // La propriété réellement voulue est que le générateur ne rende pas une
    // constante ni une petite période. Le seuil ci-dessous est astronomiquement
    // loin du comportement aléatoire, et impossible à atteindre pour un
    // générateur dégénéré.
    const n = 3000
    const seen = new Set(Array.from({ length: n }, () => pairingCode()))
    expect(seen.size).toBeGreaterThan(n - 10)
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
    const { code } = (await createPairingCode('ws_fabel'))!
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
    const { code } = (await createPairingCode('ws_fabel'))!
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => redeemPairingCode(code, `tg:${i}`, `chat ${i}`)))
    expect(results.filter((r) => r === 'ws_fabel')).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(11)
    expect(rows.filter((r) => r.kind === 'pairlink')).toHaveLength(1)
  })

  it('la SECONDE consommation séquentielle échoue', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
    expect(await redeemPairingCode(code, 'tg:1')).toBe('ws_fabel')
    expect(await redeemPairingCode(code, 'tg:2')).toBeNull()
  })

  it('la réclamation est ATOMIQUE : jamais listItems puis deleteItem', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
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
    const { code } = (await createPairingCode('ws_fabel'))!
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
    const { code } = (await createPairingCode('ws_fabel'))!
    for (let i = 0; i < MAX_FAILURES + 3; i++) await redeemPairingCode('00000000', 'tg:pirate')
    expect(await redeemPairingCode(code, 'tg:honnete')).toBe('ws_fabel')
  })

  it('un mauvais FORMAT compte aussi comme un échec', async () => {
    // Sinon le quota se contournerait en variant la longueur.
    for (let i = 0; i < MAX_FAILURES; i++) await redeemPairingCode('123', 'tg:pirate')
    const { code } = (await createPairingCode('ws_fabel'))!
    expect(await redeemPairingCode(code, 'tg:pirate')).toBeNull()
  })

  it('F/G — une NOUVELLE fenêtre rend un quota neuf, et balaie l\'ancienne', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await redeemPairingCode('00000000', 'tg:pirate')
    expect(rows.filter((r) => r.kind === 'pairslot')).toHaveLength(MAX_FAILURES)

    // On avance dans la fenêtre suivante — le seau est `floor(now / WINDOW)`.
    const real = Date.now
    Date.now = () => real() + FAILURE_WINDOW_MS + 1000
    try {
      const { code } = (await createPairingCode('ws_fabel'))!
      expect(await redeemPairingCode(code, 'tg:pirate')).toBe('ws_fabel')
      // Nettoyage paresseux : les jetons de la fenêtre précédente sont partis,
      // sinon chaque chat laisserait une traînée de lignes à chaque fenêtre.
      const slots = rows.filter((r) => r.kind === 'pairslot')
      expect(slots).toHaveLength(1)
    } finally { Date.now = real }
  })

  it('10 000 tentatives depuis un seul chat n\'aboutissent jamais', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
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
    const { code } = (await createPairingCode('ws_fabel'))!
    getWorkspaceById.mockResolvedValue(null)
    expect(await redeemPairingCode(code, 'tg:1')).toBeNull()
    expect(await resolveChannelWs('tg:1')).toBeNull()
  })

  it('base indisponible → refus, jamais un appairage supposé', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
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

// ── SEC-0e — LE QUOTA EST-IL VRAI SOUS CONCURRENCE ? ────────────────────────
//
// SEC-0d comptait par lecture-modification-écriture : deux requêtes lisaient
// `n = 4`, écrivaient toutes deux `5`, et une tentative disparaissait. Le
// contrat « 5 par fenêtre » se contournait donc par le parallélisme — soit
// exactement l'attaque contre laquelle il existe.
//
// Ces cas mesurent le contrat, pas l'implémentation : ils comptent combien de
// tentatives ATTEIGNENT la phase protégée, c'est-à-dire combien touchent le
// code. `claimItem` n'est appelé qu'après réservation d'un jeton : son nombre
// d'appels EST la mesure.
describe('SEC-0e — quota atomique sous concurrence', () => {
  const reached = () => claimItem.mock.calls.filter((c) => c[0] === 'paircode').length

  it('A — 100 tentatives SIMULTANÉES sur un chat → exactement MAX_FAILURES passent', async () => {
    await Promise.all(Array.from({ length: 100 }, () => redeemPairingCode('00000000', 'tg:pirate')))
    expect(reached()).toBe(MAX_FAILURES)
  })

  it('B — 5 tentatives simultanées → au plus MAX_FAILURES', async () => {
    await Promise.all(Array.from({ length: 5 }, () => redeemPairingCode('00000000', 'tg:pirate')))
    expect(reached()).toBeLessThanOrEqual(MAX_FAILURES)
    expect(reached()).toBe(5)
  })

  it('C — 6 tentatives simultanées → une est refusée par le quota', async () => {
    await Promise.all(Array.from({ length: 6 }, () => redeemPairingCode('00000000', 'tg:pirate')))
    expect(reached()).toBe(MAX_FAILURES)
  })

  it('D — 50 tentatives réparties sur plusieurs vagues → quota inchangé', async () => {
    for (let wave = 0; wave < 5; wave++) {
      await Promise.all(Array.from({ length: 10 }, () => redeemPairingCode('00000000', 'tg:pirate')))
    }
    expect(reached()).toBe(MAX_FAILURES)
    // Et la comptabilité des jetons est exacte : ni plus, ni moins.
    expect(rows.filter((r) => r.kind === 'pairslot')).toHaveLength(MAX_FAILURES)
  })

  it('E — un chat saturé ne consomme pas le quota d\'un autre', async () => {
    await Promise.all(Array.from({ length: 100 }, () => redeemPairingCode('00000000', 'tg:pirate')))
    const { code } = (await createPairingCode('ws_fabel'))!
    expect(await redeemPairingCode(code, 'tg:honnete')).toBe('ws_fabel')
  })

  it('I — le BON code présenté après épuisement : refusé ET NON consommé', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
    await Promise.all(Array.from({ length: 100 }, () => redeemPairingCode('00000000', 'tg:pirate')))
    claimItem.mockClear()
    expect(await redeemPairingCode(code, 'tg:pirate')).toBeNull()
    // Le code n'a même pas été touché : son destinataire légitime peut encore
    // s'en servir. Un quota qui brûlerait le code ferait le travail de
    // l'attaquant à sa place.
    expect(claimItem).not.toHaveBeenCalled()
    expect(rows.find((r) => r.kind === 'paircode' && r.id === code)).toBeTruthy()
    expect(await redeemPairingCode(code, 'tg:legitime')).toBe('ws_fabel')
  })

  it('J — le BON code dans les MAX_FAILURES premières tentatives passe', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
    for (let i = 0; i < MAX_FAILURES - 1; i++) await redeemPairingCode('00000000', 'tg:chat')
    expect(await redeemPairingCode(code, 'tg:chat')).toBe('ws_fabel')
  })

  it('K — deux appels SIMULTANÉS avec le bon code → un seul lien final', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
    const r = await Promise.all([
      redeemPairingCode(code, 'tg:a'), redeemPairingCode(code, 'tg:b'),
    ])
    expect(r.filter((x) => x !== null)).toHaveLength(1)
    expect(rows.filter((x) => x.kind === 'pairlink')).toHaveLength(1)
  })

  it('le jeton est réservé AVANT toute lecture de code — aucune fuite temporelle', async () => {
    await Promise.all(Array.from({ length: 20 }, () => redeemPairingCode('00000000', 'tg:pirate')))
    // 20 tentatives, 5 seulement ont atteint le code.
    expect(insertItemIfAbsent.mock.calls.filter((c) => c[0] === 'pairslot').length).toBeGreaterThan(0)
    expect(reached()).toBe(MAX_FAILURES)
  })

  it('CROISSANCE BORNÉE — un chat ne laisse jamais plus de MAX_FAILURES jetons', async () => {
    for (let i = 0; i < 40; i++) await redeemPairingCode('00000000', 'tg:pirate')
    expect(rows.filter((r) => r.kind === 'pairslot')).toHaveLength(MAX_FAILURES)
  })
})

// ── SEC-0f — LE NAMESPACE PARTAGÉ `_channels` ──────────────────────────────
//
// Trois défauts confirmés, tous dans une ressource partagée par TOUS les
// clients : un code posé par UPSERT (donc écrasable), un nombre de codes actifs
// non borné, et un balayage de jetons qui ne nettoyait que la fenêtre w-1.
describe('SEC-0f — A : le code ne s\'écrase JAMAIS', () => {
  it('collision entre deux espaces → aucun écrasement, second code différent', async () => {
    // On force la collision : le générateur rend deux fois la même valeur.
    const seq = ['11112222', '11112222', '33334444']
    let i = 0
    const spy = vi.spyOn(crypto, 'getRandomValues')
    spy.mockImplementation(((buf: Uint32Array) => {
      const v = Number(seq[Math.min(i++, seq.length - 1)]) - 10_000_000
      buf[0] = v
      return buf
    }) as any)
    try {
      const a = (await createPairingCode('ws_fabel'))!
      const b = (await createPairingCode('ws_suspendu'))!
      expect(a.code).not.toBe(b.code)
      // La ligne du premier espace est INTACTE et pointe toujours vers lui.
      const first = rows.find((r) => r.kind === 'paircode' && r.id === a.code)!
      expect(first.data.ws).toBe('ws_fabel')
    } finally { spy.mockRestore() }
  })

  it('aucun upsert n\'est utilisé pour poser un code', async () => {
    await createPairingCode('ws_fabel')
    for (const call of upsertItem.mock.calls) expect(call[0]).not.toBe('paircode')
    expect(insertItemIfAbsent.mock.calls.some((c) => c[0] === 'paircode')).toBe(true)
  })

  it('collisions répétées → refus, jamais un écrasement', async () => {
    const spy = vi.spyOn(crypto, 'getRandomValues')
    spy.mockImplementation(((buf: Uint32Array) => { buf[0] = 12_345_678 - 10_000_000; return buf }) as any)
    try {
      expect(await createPairingCode('ws_fabel')).not.toBeNull()
      // Le même code sort systématiquement : cinq tentatives, puis refus.
      expect(await createPairingCode('ws_suspendu')).toBeNull()
      expect(rows.filter((r) => r.kind === 'paircode')).toHaveLength(1)
      expect(rows.find((r) => r.kind === 'paircode')!.data.ws).toBe('ws_fabel')
    } finally { spy.mockRestore() }
  })
})

describe('SEC-0f — B : au plus UN code rachetable par espace', () => {
  it('une nouvelle génération INVALIDE l\'ancien code', async () => {
    const first = (await createPairingCode('ws_fabel'))!
    const second = (await createPairingCode('ws_fabel'))!
    expect(second.code).not.toBe(first.code)
    expect(await redeemPairingCode(first.code, 'tg:1')).toBeNull()
    expect(await redeemPairingCode(second.code, 'tg:2')).toBe('ws_fabel')
  })

  it('le titulaire est UNIQUE par construction — la clé primaire l\'impose', async () => {
    for (let i = 0; i < 20; i++) await createPairingCode('ws_fabel')
    expect(rows.filter((r) => r.kind === 'pairactive' && r.id === 'ws_fabel')).toHaveLength(1)
  })

  it('CONCURRENCE — deux générations simultanées : au plus UN code rachetable', async () => {
    const both = await Promise.all([createPairingCode('ws_fabel'), createPairingCode('ws_fabel')])
    const codes = both.filter(Boolean).map((r) => r!.code)
    // Chaque code produit est ensuite présenté par un chat distinct.
    const redeemed = []
    for (const c of codes) redeemed.push(await redeemPairingCode(c, `tg:${c}`))
    expect(redeemed.filter((x) => x === 'ws_fabel').length).toBeLessThanOrEqual(1)
    expect(rows.filter((r) => r.kind === 'pairactive')).toHaveLength(0)
  })

  it('CONCURRENCE — dix générations simultanées : au plus UN rachetable', async () => {
    const all = await Promise.all(Array.from({ length: 10 }, () => createPairingCode('ws_fabel')))
    const codes = all.filter(Boolean).map((r) => r!.code)
    let ok = 0
    for (const c of codes) if (await redeemPairingCode(c, `tg:${c}`) === 'ws_fabel') ok++
    expect(ok).toBeLessThanOrEqual(1)
  })

  it('les espaces ne se marchent pas dessus : chacun garde SON titulaire', async () => {
    const a = (await createPairingCode('ws_fabel'))!
    const b = (await createPairingCode('ws_suspendu'))!
    // Générer pour Fabel ne touche pas le code de l'autre espace.
    await createPairingCode('ws_fabel')
    expect(rows.find((r) => r.kind === 'paircode' && r.id === b.code)).toBeTruthy()
    expect(rows.find((r) => r.kind === 'paircode' && r.id === a.code)).toBeUndefined()
  })

  it('DoS — 200 générations ne laissent PAS 200 codes vivants', async () => {
    for (let i = 0; i < 200; i++) await createPairingCode('ws_fabel')
    // Un pointeur, un titulaire. La croissance est bornée par ESPACE, pas par
    // nombre d'appels : un client ne peut plus saturer le namespace partagé.
    expect(rows.filter((r) => r.kind === 'paircode')).toHaveLength(1)
    expect(rows.filter((r) => r.kind === 'pairactive')).toHaveLength(1)
  })
})

describe('SEC-0f — C : les jetons de fenêtres DISCONTINUES sont balayés', () => {
  const slotsOf = () => rows.filter((r) => r.kind === 'pairslot')

  it('DÉFAUT MESURÉ — fenêtres n, n+2, n+10 : plus rien ne survit au balayage', async () => {
    const real = Date.now
    const t0 = real()
    try {
      // Le chat consomme ses jetons dans trois fenêtres NON CONSÉCUTIVES.
      for (const offset of [0, 2, 10]) {
        Date.now = () => t0 + offset * FAILURE_WINDOW_MS
        for (let i = 0; i < MAX_FAILURES; i++) await redeemPairingCode('00000000', 'tg:pirate')
      }
      // L'ancien balayage ne nettoyait que w-1 : les fenêtres n et n+2 seraient
      // restées pour toujours.
      expect(slotsOf().length).toBe(3 * MAX_FAILURES)

      // La purge par ÂGE, déclenchée par une création de code, les emporte tous
      // sauf ceux encore utiles (deux fenêtres de marge).
      Date.now = () => t0 + 11 * FAILURE_WINDOW_MS
      await createPairingCode('ws_fabel')
      expect(slotsOf().length).toBe(MAX_FAILURES)   // seule la fenêtre n+10 subsiste
    } finally { Date.now = real }
  })

  it('la purge ne touche JAMAIS un jeton encore utile', async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await redeemPairingCode('00000000', 'tg:pirate')
    await createPairingCode('ws_fabel')
    // Le quota du chat reste épuisé : la purge n'a pas rendu d'essais.
    expect(slotsOf().length).toBe(MAX_FAILURES)
    const { code } = (await createPairingCode('ws_fabel'))!
    expect(await redeemPairingCode(code, 'tg:pirate')).toBeNull()
  })

  it('la purge est bornée à l\'espace technique — jamais un autre espace', async () => {
    await createPairingCode('ws_fabel')
    for (const call of deleteExpired.mock.calls) expect(call[1]).toBe(NS)
  })

  it('les pointeurs EXPIRÉS sont purgés, le titulaire courant ne l\'est pas', async () => {
    const real = Date.now
    const t0 = real()
    try {
      await createPairingCode('ws_fabel')
      Date.now = () => t0 + 60 * 60 * 1000        // une heure plus tard
      await createPairingCode('ws_suspendu')
      const codes = rows.filter((r) => r.kind === 'paircode')
      expect(codes).toHaveLength(1)               // seul le code frais subsiste
      expect(codes[0].data.ws).toBe('ws_suspendu')
    } finally { Date.now = real }
  })
})

// ── SEC-0f.1 — LA CONSOMMATION DU TITULAIRE EST UN COMPARE-AND-DELETE ──────
//
// LA COURSE MESURÉE. `redeemPairingCode` lisait le titulaire puis le supprimait
// inconditionnellement :
//
//     R1  claimItem(paircode, OLD)     → obtient le pointeur
//     R1  getItem(pairactive, ws)      → lit { code: OLD }   ✔ concorde
//     R2  rotation : supprime OLD, pose NEW
//     R1  claimItem(pairactive, ws)    → supprime NEW !
//
// DEUX dégâts, pas un : le code OLD, pourtant RÉVOQUÉ, aboutit à un appairage ;
// et le titulaire NEW est détruit, donc le code fraîchement émis devient
// irrachetable pour son destinataire légitime.
//
// `beforeHolderConsume` injecte la rotation au DÉBUT de l'opération qui
// consomme le titulaire — c'est-à-dire exactement entre la lecture de R1 et sa
// suppression. Le crochet est neutre vis-à-vis de l'implémentation : il se
// déclenche aussi bien sur l'ancien `claimItem` que sur le nouveau
// compare-and-delete.
describe('SEC-0f.1 — rotation concurrente pendant un rachat', () => {
  const holders = () => rows.filter((r) => r.kind === 'pairactive')
  const holderCode = () => holders()[0]?.data?.code ?? null

  it('A — rachat sans rotation : le code courant gagne normalement', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
    expect(await redeemPairingCode(code, 'tg:1')).toBe('ws_fabel')
    expect(holders()).toHaveLength(0)   // le titre est consommé avec le code
  })

  it('B — rotation TERMINÉE avant le rachat : OLD refusé, NEW intact', async () => {
    const old = (await createPairingCode('ws_fabel'))!
    const neuf = (await createPairingCode('ws_fabel'))!
    expect(await redeemPairingCode(old.code, 'tg:1')).toBeNull()
    expect(holderCode()).toBe(neuf.code)
    expect(rows.filter((r) => r.kind === 'pairlink')).toHaveLength(0)
  })

  it('C — DÉFAUT : rotation glissée ENTRE la lecture et la suppression', async () => {
    const old = (await createPairingCode('ws_fabel'))!
    let neuf: { code: string } | null = null

    // La rotation est validée juste avant que R1 ne consomme le titulaire.
    beforeHolderConsume = () => {
      const i = rows.findIndex((r) => r.kind === 'pairactive' && r.id === 'ws_fabel')
      if (i >= 0) rows.splice(i, 1)
      const c = '99887766'
      rows.push({ kind: 'paircode', id: c, ws: NS, data: { id: c, ws: 'ws_fabel', at: Date.now() } })
      rows.push({ kind: 'pairactive', id: 'ws_fabel', ws: NS, data: { id: 'ws_fabel', code: c, at: Date.now() } })
      neuf = { code: c }
    }

    // 1. Le code RÉVOQUÉ ne doit PAS appairer.
    expect(await redeemPairingCode(old.code, 'tg:pirate')).toBeNull()
    expect(rows.filter((r) => r.kind === 'pairlink')).toHaveLength(0)
    // 2. Et surtout : le titulaire NEUF doit être INTACT.
    expect(holders()).toHaveLength(1)
    expect(holderCode()).toBe(neuf!.code)
    // 3. Donc le destinataire légitime peut encore s'en servir.
    expect(await redeemPairingCode(neuf!.code, 'tg:legitime')).toBe('ws_fabel')
  })

  it('D — OLD et NEW présentés concurremment après rotation : seul NEW gagne', async () => {
    const old = (await createPairingCode('ws_fabel'))!
    const neuf = (await createPairingCode('ws_fabel'))!
    const [a, b] = await Promise.all([
      redeemPairingCode(old.code, 'tg:a'), redeemPairingCode(neuf.code, 'tg:b'),
    ])
    expect(a).toBeNull()
    expect(b).toBe('ws_fabel')
    expect(rows.filter((r) => r.kind === 'pairlink')).toHaveLength(1)
  })

  it('E — deux rachats du MÊME code : un seul gagne', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
    const r = await Promise.all([
      redeemPairingCode(code, 'tg:a'), redeemPairingCode(code, 'tg:b'),
    ])
    expect(r.filter((x) => x === 'ws_fabel')).toHaveLength(1)
  })

  it('F — après un refus OLD, le titulaire NEUF est toujours là', async () => {
    const old = (await createPairingCode('ws_fabel'))!
    const neuf = (await createPairingCode('ws_fabel'))!
    for (let i = 0; i < 3; i++) await redeemPairingCode(old.code, `tg:${i}`)
    expect(holderCode()).toBe(neuf.code)
  })

  it('G — aucune interaction entre espaces : le titulaire de B est intact', async () => {
    const a = (await createPairingCode('ws_fabel'))!
    const b = (await createPairingCode('ws_suspendu'))!
    await createPairingCode('ws_fabel')                 // rotation chez Fabel
    expect(await redeemPairingCode(a.code, 'tg:1')).toBeNull()
    const bHolder = rows.find((r) => r.kind === 'pairactive' && r.id === 'ws_suspendu')
    expect(bHolder?.data.code).toBe(b.code)
  })

  it('H — base en panne pendant la consommation du titulaire → fail closed', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
    claimItemIfField.mockResolvedValueOnce(null as any)
    expect(await redeemPairingCode(code, 'tg:1')).toBeNull()
    expect(rows.filter((r) => r.kind === 'pairlink')).toHaveLength(0)
  })

  it('AUCUNE LECTURE PRÉALABLE — le titulaire n\'est jamais lu avant d\'être supprimé', async () => {
    const { code } = (await createPairingCode('ws_fabel'))!
    getItem.mockClear()
    await redeemPairingCode(code, 'tg:1')
    // C'est la propriété structurelle : plus de `getItem` sur le titulaire,
    // donc plus de fenêtre entre la comparaison et la suppression.
    for (const call of getItem.mock.calls) expect(call[0]).not.toBe('pairactive')
    expect(claimItemIfField).toHaveBeenCalledWith('pairactive', 'ws_fabel', NS, 'code', code)
  })
})
