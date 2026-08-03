import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Lot C2a-2 (correctif) — /api/ai/diagnose ne doit JAMAIS présenter un refus
// budgétaire comme une incapacité de la clé, du modèle ou d'un outil.
//
// Le cas n'est pas théorique : la sonde `web_fetch` de cette route ne déclare
// pas `max_content_tokens`. En ENFORCE sous plafond positif elle est donc
// refusée pour estimation incomplète — et l'ancien verdict aurait annoncé
// « lecture d'article refusée », c'est-à-dire une conclusion fausse sur la clé
// Anthropic, qui n'a même pas été sollicitée.
//
// Cette route est aussi le seul appelant direct d'`anthropicPost()` : elle
// n'est pas couverte par C1, ce qui en fait le chemin exact où un
// `ANTHROPIC_BUDGET=0` pouvait être contourné.

const reserve = vi.fn()

vi.mock('../lib/supabase/aiBudget', () => ({
  reserve: (...a: any[]) => reserve(...a),
  settle: vi.fn().mockResolvedValue({ ok: true }),
  resolveReservation: vi.fn().mockResolvedValue({ ok: true }),
  engaged: vi.fn(),
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))
vi.mock('../lib/prospector/keystore', () => ({
  hydrateKeystore: async () => undefined,
  getKey: (n: string) => process.env[n] || '',
}))

let fetchMock: ReturnType<typeof vi.fn>

function res() {
  const o: any = { statusCode: 0, body: null, headers: {} }
  o.setHeader = (k: string, v: string) => { o.headers[k] = v }
  o.status = (c: number) => { o.statusCode = c; return o }
  o.json = (b: any) => { o.body = b; return o }
  return o
}

async function run() {
  vi.resetModules()
  const mod = await import('../pages/api/ai/diagnose')
  const r = res()
  await mod.default({} as any, r)
  return r.body
}

beforeEach(() => {
  reserve.mockReset().mockResolvedValue({ ok: true, state: 'reserved', engagedMicros: 0n, budgetMicros: 0n })
  fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 200, text: async () => '',
    json: async () => ({ usage: { input_tokens: 10, output_tokens: 5 }, content: [] }),
  })
  ;(globalThis as any).fetch = fetchMock
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.AI_BUDGET_RESERVATION
  delete process.env.ANTHROPIC_BUDGET
})
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.AI_BUDGET_RESERVATION
  delete process.env.ANTHROPIC_BUDGET
})

describe('budget explicitement à zéro', () => {
  it('ENFORCE + budget 0 → AUCUNE des quatre sondes n\'émet d\'appel', async () => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    process.env.ANTHROPIC_BUDGET = '0'
    const body = await run()

    expect(fetchMock).not.toHaveBeenCalled()   // l'assertion centrale
    expect(reserve).not.toHaveBeenCalled()
    expect(body.budgetBlocked).toBe(true)
    for (const t of Object.values(body.tests) as any[]) expect(t.blocked).toBe(true)
  })

  it('le verdict impute le refus au budget, pas à la clé ni au modèle', async () => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    process.env.ANTHROPIC_BUDGET = '0'
    const body = await run()

    expect(body.verdict).toContain('garde budgétaire')
    expect(body.verdict).toContain('n\'ont pas été testées')
    // Aucune des conclusions de capacité ne doit apparaître.
    expect(body.verdict).not.toContain('La clé ou le modèle sont en cause')
    expect(body.verdict).not.toContain('recherche web est refusée sur cette clé')
    expect(body.verdict).not.toContain('lecture d\'article refusée')
  })
})

describe('refus partiel — une seule sonde bloquée', () => {
  it('sonde web_fetch refusée (estimation incomplète) → jamais présentée comme une incapacité', async () => {
    // ENFORCE + plafond POSITIF : seule la sonde web_fetch est non estimable.
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    process.env.ANTHROPIC_BUDGET = '10'
    const body = await run()

    expect(body.budgetBlocked).toBe(true)
    expect(body.tests['lecture de page (web_fetch)'].blocked).toBe(true)
    expect(body.tests['appel simple'].blocked).toBeFalsy()   // celle-ci a bien tourné
    expect(body.verdict).toContain('lecture de page (web_fetch)')
    expect(body.verdict).toContain('garde budgétaire')
    // Le verdict de capacité aurait été faux : la clé n'a jamais été sollicitée.
    expect(body.verdict).not.toContain('la couverture sera plus faible')
  })
})

describe('non-régression : sans garde armé, le diagnostic reste un diagnostic', () => {
  it('OFF → les quatre sondes partent, verdict de capacité normal', async () => {
    const body = await run()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(body.budgetBlocked).toBe(false)
    expect(body.verdict).toContain('Tout est disponible')
  })

  it('OFF + échec réel de la clé → verdict de capacité, pas de budget', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid api key', json: async () => ({}) })
    const body = await run()
    expect(body.budgetBlocked).toBe(false)
    expect(body.verdict).toContain('La clé ou le modèle sont en cause')
  })
})
