import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Lot C2a-2 (correctif) — OBSERVE doit être non bloquant JUSQU'AU BOUT.
//
// Le défaut corrigé : `callClaude()` exécutait le garde C1 (`budgetLeft`) AVANT
// d'atteindre la passerelle. Un `ANTHROPIC_BUDGET` oublié refusait donc l'appel
// ici même, très en amont — la fenêtre d'observation aurait mesuré un trafic
// déjà écrêté, donc un taux de refus sous-estimé. C'est l'erreur dans le sens le
// plus dangereux pour une calibration : elle rend ENFORCE plus risqué qu'il n'y
// paraît.
//
// Ces cas passent par `callClaude()`, pas par `anthropicPost()` : c'est
// précisément le segment que les tests de passerelle ne voyaient pas.

const reserve = vi.fn()
const settle = vi.fn()
const resolveReservation = vi.fn()
const readUsageDurable = vi.fn()
const bumpUsage = vi.fn()

vi.mock('../lib/supabase/aiBudget', () => ({
  reserve: (...a: any[]) => reserve(...a),
  settle: (...a: any[]) => settle(...a),
  resolveReservation: (...a: any[]) => resolveReservation(...a),
  engaged: vi.fn(),
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))
vi.mock('../lib/supabase/pappersCache', () => ({
  readUsageDurable: (...a: any[]) => readUsageDurable(...a),
  bumpUsage: (...a: any[]) => bumpUsage(...a),
}))
// Cache de résultats neutralisé : on teste la DÉCISION, pas la mémoïsation.
vi.mock('../lib/supabase/store', () => ({
  listItems: async () => [],
  upsertItem: async () => undefined,
}))

let fetchMock: ReturnType<typeof vi.fn>

const OK = {
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  content: [{ type: 'text', text: 'bonjour' }],
  stop_reason: 'end_turn',
}

const OPTS = {
  task: 'chat' as const, agent: 'Jarvis', system: 'sys',
  messages: [{ role: 'user', content: 'salut' }],
}

async function load() {
  const g = globalThis as any
  g.__prospectorKeys.clear()
  vi.resetModules()
  return import('../lib/prospector/llm')
}

beforeEach(() => {
  reserve.mockReset().mockResolvedValue({ ok: true, state: 'reserved', engagedMicros: 0n, budgetMicros: 0n })
  settle.mockReset().mockResolvedValue({ ok: true })
  resolveReservation.mockReset().mockResolvedValue({ ok: true })
  bumpUsage.mockReset().mockResolvedValue(1)
  // Consommation TRÈS supérieure au plafond : C1 refuserait, s'il était consulté.
  readUsageDurable.mockReset().mockResolvedValue({ ok: true, value: 999_999 })

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
  delete process.env.ANTHROPIC_BUDGET
})

describe('OBSERVE neutralise C1 dans callClaude()', () => {
  it('budget C1 largement dépassé → l\'appel PART quand même', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    process.env.ANTHROPIC_BUDGET = '0.01'      // 9 999,99 $ déjà « consommés »
    const m = await load()
    const r = await m.callClaude(OPTS)

    expect(r.blocked).toBeFalsy()
    expect(r.text).toBe('bonjour')
    expect(fetchMock).toHaveBeenCalledTimes(1)   // la mesure n'est pas écrêtée
    expect(reserve).toHaveBeenCalledTimes(1)
  })

  it('C1 n\'est même pas consulté en OBSERVE', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    process.env.ANTHROPIC_BUDGET = '0.01'
    const m = await load()
    await m.callClaude(OPTS)
    expect(readUsageDurable).not.toHaveBeenCalled()
  })

  it('ANTHROPIC_BUDGET=0 ne bloque pas non plus en OBSERVE', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    process.env.ANTHROPIC_BUDGET = '0'
    const m = await load()
    const r = await m.callClaude(OPTS)
    expect(r.blocked).toBeFalsy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('mais la configuration incohérente est signalée', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    process.env.ANTHROPIC_BUDGET = '0.01'
    const m = await load()
    await m.callClaude(OPTS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_BUDGET'))
    warn.mockRestore()
  })
})

describe('OFF et ENFORCE conservent C1 — aucune régression du garde-fou', () => {
  it('OFF : budget dépassé → refus par C1, aucun appel', async () => {
    process.env.ANTHROPIC_BUDGET = '0.01'
    const m = await load()
    const r = await m.callClaude(OPTS)
    expect(r.blocked).toBe(true)
    expect(r.blockedReason).toBe('budget_exhausted')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readUsageDurable).toHaveBeenCalled()   // C1 bien consulté
  })

  it('ENFORCE : budget dépassé → refus par C1, aucun appel', async () => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    process.env.ANTHROPIC_BUDGET = '0.01'
    const m = await load()
    const r = await m.callClaude(OPTS)
    expect(r.blocked).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
  })

  it('ENFORCE : refus de la passerelle converti dans le contrat CallResult', async () => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    readUsageDurable.mockResolvedValue({ ok: true, value: 0 })   // C1 laisse passer
    reserve.mockResolvedValue({ ok: true, state: 'budget_exhausted', engagedMicros: 9n, budgetMicros: 1n })
    process.env.ANTHROPIC_BUDGET = '10'
    const m = await load()
    const r = await m.callClaude(OPTS)
    expect(r.blocked).toBe(true)
    expect(r.blockedReason).toBe('budget_exhausted')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── C2a-2c : OBSERVE strictement inchangé ─────────────────────────────────
  it('OBSERVE avec outils serveur → aucun précomptage, aucune variable requise', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    process.env.ANTHROPIC_BUDGET = '0.01'
    const m = await load()
    const r = await m.callClaude({
      ...OPTS,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 10 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
      ],
    })
    expect(r.blocked).toBeFalsy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Une seule requête, vers Messages : le précomptage n'est jamais appelé.
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('count_tokens')
    }
  })

  it('OFF : budget sain → appel normal, aucune RPC de réservation', async () => {
    readUsageDurable.mockResolvedValue({ ok: true, value: 0 })
    process.env.ANTHROPIC_BUDGET = '10'
    const m = await load()
    const r = await m.callClaude(OPTS)
    expect(r.text).toBe('bonjour')
    expect(reserve).not.toHaveBeenCalled()
  })
})
