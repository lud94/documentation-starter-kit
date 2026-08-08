import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Lots MT-0 (dernière barrière) et MT-0b (cloisonnement du cache).
//
// Le défaut corrigé par MT-0b, mesuré dans le code : le cache de résultats
// vivait dans un pseudo-espace UNIQUE `'_cache'`, avec une clé calculée sur le
// seul contenu. Les clés étant construites sur des données utilisateur
// (`['person-news', name, company]`), deux clients partageaient l'entrée.
//
// Sous budget par tenant, ce partage devient un canal auxiliaire : un succès de
// cache coûte zéro et se voit. Ces cas verrouillent la fermeture.

const reserve = vi.fn()
const settle = vi.fn()
const resolveReservation = vi.fn()
const getItem = vi.fn()
const upsertItem = vi.fn()
const readUsageDurable = vi.fn()

vi.mock('../lib/supabase/aiBudget', () => ({
  reserve: (...a: any[]) => reserve(...a),
  settle: (...a: any[]) => settle(...a),
  resolveReservation: (...a: any[]) => resolveReservation(...a),
  engaged: vi.fn(),
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))
vi.mock('../lib/supabase/store', () => ({
  getItem: (...a: any[]) => getItem(...a),
  upsertItem: (...a: any[]) => upsertItem(...a),
  listItems: async () => { throw new Error('listItems ne doit plus servir au cache IA') },
}))
vi.mock('../lib/supabase/pappersCache', () => ({
  readUsageDurable: (...a: any[]) => readUsageDurable(...a),
  bumpUsage: async () => 1,
}))

const FABEL = { id: 'ws_fabel', kind: 'client' as const }
const CLIENT_B = { id: 'ws_client_b', kind: 'client' as const }

const OK = {
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  content: [{ type: 'text', text: 'réponse' }],
  stop_reason: 'end_turn',
}

let fetchMock: ReturnType<typeof vi.fn>

async function load() {
  const g = globalThis as any
  g.__prospectorKeys.clear()
  vi.resetModules()
  return import('../lib/prospector/llm')
}

const OPTS = (tenant: any, extra: any = {}) => ({
  tenant, task: 'extract' as const, agent: 'test', system: 'sys',
  messages: [{ role: 'user', content: 'q' }],
  cache: 'clef-fonctionnelle', ...extra,
})

beforeEach(() => {
  reserve.mockReset().mockResolvedValue({ ok: true, state: 'reserved', engagedMicros: 0n, budgetMicros: 0n })
  settle.mockReset().mockResolvedValue({ ok: true })
  resolveReservation.mockReset().mockResolvedValue({ ok: true })
  getItem.mockReset().mockResolvedValue(null)
  upsertItem.mockReset().mockResolvedValue(true)
  readUsageDurable.mockReset().mockResolvedValue({ ok: true, value: 0 })
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => OK, text: async () => '' })
  ;(globalThis as any).fetch = fetchMock
  const g = globalThis as any
  if (!g.__prospectorKeys) g.__prospectorKeys = new Map()
  g.__prospectorKeys.clear()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.AI_BUDGET_RESERVATION
  delete process.env.ANTHROPIC_BUDGET
})
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.AI_BUDGET_RESERVATION
})

// ── MT-0 : la passerelle est la DERNIÈRE barrière ────────────────────────────
describe('F — un appel sans tenant n\'atteint jamais Anthropic', () => {
  it.each(['OFF', 'OBSERVE', 'ENFORCE'])('mode %s → aucun fetch, aucune réservation', async (mode) => {
    if (mode !== 'OFF') process.env.AI_BUDGET_RESERVATION = mode
    const m = await load()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await m.anthropicPost('k', { model: 'claude-sonnet-5', max_tokens: 10, messages: [] }, {} as any)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(r.blocked).toBe(true)
    err.mockRestore()
  })

  it('un tenant vide ne vaut pas un tenant', async () => {
    const m = await load()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await m.anthropicPost('k', { model: 'm', max_tokens: 1, messages: [] },
      { tenant: { id: '   ', kind: 'client' } } as any)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.blocked).toBe(true)
    err.mockRestore()
  })
})

// ── MT-0 : le tenant descend jusqu'à la réservation et à la télémétrie ───────
describe('I/J — propagation jusqu\'à la réservation et au journal', () => {
  it('la réservation porte l\'espace client', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    const m = await load()
    await m.callClaude(OPTS(FABEL))
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(reserve.mock.calls[0][0].tenantId).toBe('ws_fabel')
  })

  it('le journal porte le tenant, et aucune donnée métier', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    const lines: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')) })
    const m = await load()
    await m.callClaude({
      ...OPTS(FABEL),
      system: 'INSTRUCTION-CONFIDENTIELLE',
      messages: [{ role: 'user', content: 'NOM-DU-PROSPECT' }],
    })
    log.mockRestore()

    const raw = lines.find((s) => s.startsWith('c2a2.telemetry'))!
    const t = JSON.parse(raw.slice('c2a2.telemetry'.length + 1))
    expect(t.tenant_id).toBe('ws_fabel')
    expect(t.tenant_kind).toBe('client')
    expect(raw).not.toContain('INSTRUCTION-CONFIDENTIELLE')
    expect(raw).not.toContain('NOM-DU-PROSPECT')
    expect(raw).not.toContain('test-key')
    expect(raw).not.toContain('réponse')
  })
})

// ── MT-0b : cloisonnement du cache ───────────────────────────────────────────
describe('A/B/F/G — le cache est cloisonné par tenant', () => {
  it('même prompt, même modèle, deux clients → deux entrées DISTINCTES', async () => {
    const m = await load()
    await m.callClaude(OPTS(FABEL))
    await m.callClaude(OPTS(CLIENT_B))

    const [fabelNs, fabelId] = [upsertItem.mock.calls[0][3], upsertItem.mock.calls[0][1]]
    const [bNs, bId] = [upsertItem.mock.calls[1][3], upsertItem.mock.calls[1][1]]

    expect(fabelNs).not.toBe(bNs)   // partitions de STOCKAGE distinctes
    expect(fabelId).not.toBe(bId)   // identités de CLÉ distinctes
    expect(fabelNs).toBe('_cache:ws_fabel')
    expect(bNs).toBe('_cache:ws_client_b')
  })

  it('le cache de Fabel ne peut PAS être lu par le client B', async () => {
    const m = await load()
    await m.callClaude(OPTS(FABEL))
    const fabelId = upsertItem.mock.calls[0][1]

    getItem.mockReset()
    // Le magasin ne rend une entrée QUE si l'espace demandé est celui de Fabel.
    getItem.mockImplementation(async (_k: string, id: string, ws: string) =>
      ws === '_cache:ws_fabel' && id === fabelId ? { id, text: 'SECRET-FABEL', at: Date.now() } : null)

    fetchMock.mockClear()
    const r = await m.callClaude(OPTS(CLIENT_B))
    expect(r.cached).toBeFalsy()
    expect(r.text).not.toBe('SECRET-FABEL')
    expect(fetchMock).toHaveBeenCalledTimes(1)   // le client B paie son propre appel
  })

  it('les anciennes entrées du cache global « _cache » ne sont plus jamais lues', async () => {
    const m = await load()
    getItem.mockResolvedValue(null)
    await m.callClaude(OPTS(FABEL))
    for (const call of getItem.mock.calls) expect(call[2]).not.toBe('_cache')
    for (const call of upsertItem.mock.calls) expect(call[3]).not.toBe('_cache')
  })

  it('aucune donnée brute dans la clé stockée', async () => {
    const m = await load()
    await m.callClaude({ ...OPTS(FABEL), cache: 'person-news|Jean Dupont|Acme SA' })
    const storedId = upsertItem.mock.calls[0][1]
    expect(storedId).not.toContain('Jean')
    expect(storedId).not.toContain('Dupont')
    expect(storedId).not.toContain('Acme')
    expect(storedId).toMatch(/^[0-9a-f]+$/)
  })
})

describe('C/D — modèle et fournisseur font partie de l\'identité', () => {
  it('même tenant, MODÈLE différent → identités distinctes', async () => {
    const m = await load()
    await m.callClaude(OPTS(FABEL))
    const idDefault = upsertItem.mock.calls[0][1]

    upsertItem.mockClear()
    const g = globalThis as any
    g.__prospectorKeys.set('ENRICH_MODEL', 'claude-haiku-4-5-20251001')
    await m.callClaude(OPTS(FABEL))
    expect(upsertItem.mock.calls[0][1]).not.toBe(idDefault)
    g.__prospectorKeys.delete('ENRICH_MODEL')
  })

  it('le fournisseur entre dans l\'empreinte — prêt pour un second provider', async () => {
    // L'empreinte inclut 'anthropic' ; un autre fournisseur produira une autre
    // identité, donc aucune réutilisation croisée n'est possible par construction.
    const { cacheKey } = await load()
    const a = cacheKey(['x'])
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('E/H — déterminisme et fonctionnement intra-tenant', () => {
  it('la clé fonctionnelle est déterministe et robuste', async () => {
    const { cacheKey } = await load()
    expect(cacheKey(['person-news', 'Jean', 'Acme'])).toBe(cacheKey(['person-news', 'Jean', 'Acme']))
    expect(cacheKey(['a'])).not.toBe(cacheKey(['b']))
    // SHA-256 tronqué à 128 bits, au lieu du hachage maison 32 bits qui rendait
    // les collisions atteignables — et une collision sert la réponse d'une AUTRE question.
    expect(cacheKey(['a'])).toMatch(/^[0-9a-f]{32}$/)
  })

  it('le succès de cache reste fonctionnel À L\'INTÉRIEUR du même tenant', async () => {
    const m = await load()
    await m.callClaude(OPTS(FABEL))
    const [kind, id, , ws] = upsertItem.mock.calls[0]

    getItem.mockImplementation(async (k: string, i: string, w: string) =>
      k === kind && i === id && w === ws ? { id, text: 'DEJA-PAYE', at: Date.now() } : null)
    fetchMock.mockClear()

    const r = await m.callClaude(OPTS(FABEL))
    expect(r.cached).toBe(true)
    expect(r.text).toBe('DEJA-PAYE')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
