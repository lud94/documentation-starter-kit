import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TELEMETRY_MARKER } from '../lib/prospector/telemetry'

// Lot C2a-2 — contrat de la télémétrie de calibration.
//
// Le point le plus important : `would_have_blocked` vaut `null` — jamais
// `false` — dès que la décision dépendrait d'un coût non borné. Un `false`
// fabriqué serait lu comme « cet appel serait passé », c'est-à-dire une
// autorisation implicite dérivée d'une inconnue.

const reserve = vi.fn()
const settle = vi.fn()
const resolveReservation = vi.fn()

vi.mock('../lib/supabase/aiBudget', () => ({
  reserve: (...a: any[]) => reserve(...a),
  settle: (...a: any[]) => settle(...a),
  resolveReservation: (...a: any[]) => resolveReservation(...a),
  engaged: vi.fn(),
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))

const T = { id: 'ws_test', kind: 'client' as const }

let lines: any[] = []
let logSpy: any

const OK_BODY = {
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 },
  content: [{ type: 'text', text: 'ok' }],
}
const BODY = () => ({
  model: 'claude-sonnet-5', max_tokens: 1000,
  messages: [{ role: 'user', content: 'bonjour' }],
})

async function load() {
  const g = globalThis as any
  g.__prospectorKeys.clear()
  vi.resetModules()
  return import('../lib/prospector/llm')
}

/** Dernière ligne de télémétrie émise, désérialisée. */
function last(): any {
  const l = lines.filter((s) => typeof s === 'string' && s.startsWith(TELEMETRY_MARKER))
  return JSON.parse(l[l.length - 1].slice(TELEMETRY_MARKER.length + 1))
}

beforeEach(() => {
  reserve.mockReset().mockResolvedValue({ ok: true, state: 'reserved', engagedMicros: 0n, budgetMicros: 0n })
  settle.mockReset().mockResolvedValue({ ok: true })
  resolveReservation.mockReset().mockResolvedValue({ ok: true })
  ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => OK_BODY, text: async () => '',
  })
  lines = []
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { lines.push(a.join(' ')) })
  const g = globalThis as any
  if (!g.__prospectorKeys) g.__prospectorKeys = new Map()
  g.__prospectorKeys.clear()
  delete process.env.AI_BUDGET_RESERVATION
  delete process.env.AI_BUDGET_OBSERVE_LIMIT
  delete process.env.ANTHROPIC_BUDGET
})
afterEach(() => {
  logSpy.mockRestore()
  delete process.env.AI_BUDGET_RESERVATION
  delete process.env.AI_BUDGET_OBSERVE_LIMIT
  delete process.env.ANTHROPIC_BUDGET
})

describe('émission', () => {
  it('mode OFF → aucune ligne', async () => {
    const m = await load()
    await m.anthropicPost('k', BODY(), { tenant: T })
    expect(lines.filter((s) => s.startsWith(TELEMETRY_MARKER))).toHaveLength(0)
  })

  it('une seule ligne par requête HTTP', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    const m = await load()
    await m.anthropicPost('k', BODY(), { tenant: T })
    expect(lines.filter((s) => s.startsWith(TELEMETRY_MARKER))).toHaveLength(1)
  })
})

describe('would_have_blocked — tri-état', () => {
  beforeEach(() => { process.env.AI_BUDGET_RESERVATION = 'OBSERVE' })

  it('seuil dépassé → true, SANS empêcher l\'appel', async () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = '0.000001'
    const m = await load()
    const r = await m.anthropicPost('k', BODY(), { tenant: T })
    expect(last().would_have_blocked).toBe(true)
    expect(r.ok).toBe(true)                                  // mesuré, pas empêché
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1)
  })

  it('seuil confortable → false', async () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = '100'
    const m = await load()
    await m.anthropicPost('k', BODY(), { tenant: T })
    expect(last().would_have_blocked).toBe(false)
  })

  it('estimation incomplète → null, JAMAIS false', async () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = '100'   // seuil confortable, donc « false » tentant
    const m = await load()
    await m.anthropicPost('k', {
      ...BODY(), tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 }],
    }, { tenant: T })
    const t = last()
    expect(t.would_have_blocked).toBeNull()
    expect(t.estimate_complete).toBe(false)
    expect(t.estimate_incomplete).toEqual(['web_fetch_content'])
    expect(t.web_fetch_max_content_tokens).toBeNull()
  })

  it('aucun seuil candidat → null', async () => {
    const m = await load()
    await m.anthropicPost('k', BODY(), { tenant: T })
    expect(last().would_have_blocked).toBeNull()
  })

  it('seuil candidat illisible → null', async () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = 'douze'
    const m = await load()
    await m.anthropicPost('k', BODY(), { tenant: T })
    expect(last().would_have_blocked).toBeNull()
  })
})

describe('contenu de la ligne', () => {
  beforeEach(() => { process.env.AI_BUDGET_RESERVATION = 'OBSERVE' })

  it('porte les six mesures de calibration, corrélées par reservation_id', async () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = '100'
    const m = await load()
    await m.anthropicPost('k', {
      ...BODY(),
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 10 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6, max_content_tokens: 5000 },
      ],
    }, { tenant: T, agent: 'Veille · signaux', task: 'research' })
    const t = last()

    expect(t.reservation_id).toBe(reserve.mock.calls[0][0].id)   // clé de jointure
    expect(t.agent).toBe('Veille · signaux')
    expect(t.task).toBe('research')
    expect(t.model).toBe('claude-sonnet-5')

    // Estimation et composantes — en CHAÎNES décimales, jamais en flottants.
    expect(t.est_tool_micros).toBe('100000')            // 10 recherches, pas 16
    expect(t.est_fetch_content_micros).toBe('90000')    // 30k tokens × 3 µUSD/1k
    expect(t.estimate_complete).toBe(true)
    expect(BigInt(t.est_input_micros) + BigInt(t.est_output_micros)
      + BigInt(t.est_tool_micros) + BigInt(t.est_fetch_content_micros)).toBe(BigInt(t.estimate_micros))

    // Réglages à l'origine de l'estimation
    expect(t.max_tokens).toBe(1000)
    expect(t.web_search_max_uses).toBe(10)
    expect(t.web_fetch_max_uses).toBe(6)
    expect(t.web_fetch_max_content_tokens).toBe(30_000)
    expect(t.body_bytes).toBeGreaterThan(0)

    // Réalité mesurée
    expect(t.input_tokens).toBe(1000)
    expect(t.cache_read_input_tokens).toBe(200)
    expect(t.output_tokens).toBe(500)
    expect(t.web_searches).toBe(0)
    expect(t.settled_micros).toBe('10560')  // 3000 + 60 (cache à 10 %) + 7500

    expect(t.state).toBe('SETTLED')
    expect(t.outcome_code).toBe('http_200')
    expect(t.http_status).toBe(200)
    expect(typeof t.duration_ms).toBe('number')
  })

  it('aucune donnée métier : ni prompt, ni réponse, ni clé', async () => {
    // Marqueur distinctif pour le texte de réponse : « ok » serait un
    // sous-mot de `max_tokens` et l'assertion échouerait sur le nom d'un champ.
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ ...OK_BODY, content: [{ type: 'text', text: 'REPONSE-DU-MODELE' }] }),
    })
    const m = await load()
    await m.anthropicPost('SECRET-API-KEY', {
      ...BODY(),
      system: [{ type: 'text', text: 'INSTRUCTION CONFIDENTIELLE' }],
      messages: [{ role: 'user', content: 'NOM-DU-PROSPECT' }],
    }, { tenant: T })
    const raw = lines.find((s) => s.startsWith(TELEMETRY_MARKER))
    expect(raw).not.toContain('SECRET-API-KEY')
    expect(raw).not.toContain('INSTRUCTION CONFIDENTIELLE')
    expect(raw).not.toContain('NOM-DU-PROSPECT')
    expect(raw).not.toContain('REPONSE-DU-MODELE')
    // L'empreinte est présente, mais c'est un SHA-256 : opaque par construction.
    expect(last().fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  // ── Lot C2a-2c : DÉCLARÉ / RAPPORTÉ / RÉUSSI / EN ERREUR ────────────────────
  it('distingue les quatre faits sur les outils serveur', async () => {
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: async () => '',
      json: async () => ({
        usage: {
          input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200,
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
        },
        content: [
          { type: 'server_tool_use', id: 's1', name: 'web_search' },
          { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'x' }] },
          { type: 'web_search_tool_result', content: { error_code: 'too_many_requests' } },
          { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result',
            content: { source: { type: 'base64', media_type: 'application/pdf' } } } },
        ],
      }),
    })
    const m = await load()
    await m.anthropicPost('k', {
      ...BODY(),
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1 },
      ],
    }, { tenant: T })
    const t = last()

    expect(t.server_tools_declared).toEqual(['web_search_20250305', 'web_fetch_20260209'])
    expect(t.web_search_requests).toBe(2)          // fournisseur
    expect(t.web_fetch_requests).toBe(1)           // fournisseur
    expect(t.web_search_results_observed).toBe(1)  // succès
    expect(t.web_search_errors_observed).toBe(1)   // erreur
    expect(t.server_tool_error_codes).toEqual(['too_many_requests'])
    expect(t.web_fetch_results_observed).toBe(1)
    expect(t.web_fetch_binary_results).toBe(1)     // exposition PDF
    expect(t.server_tool_invocations).toBe(1)
  })

  it('compteur fournisseur absent → null, jamais 0', async () => {
    const m = await load()
    await m.anthropicPost('k', BODY(), { tenant: T })
    const t = last()
    expect(t.web_search_requests).toBeNull()
    expect(t.web_fetch_requests).toBeNull()
  })

  it('porte les deux listes, et l\'écart entre elles', async () => {
    const m = await load()
    await m.anthropicPost('k', {
      ...BODY(), tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    }, { tenant: T })
    const t = last()
    expect(t.estimate_unbounded).toEqual(['web_search_result_tokens'])
    expect(t.estimate_incomplete).toEqual([])
    expect(t.estimate_complete).toBe(true)   // porte ENFORCE inchangée
  })

  it('refus avant émission → state NOT_RESERVED, montants réels à null', async () => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    reserve.mockResolvedValue({ ok: false, reason: 'no_client' })
    const m = await load()
    await m.anthropicPost('k', BODY(), { tenant: T })
    const t = last()
    expect(t.state).toBe('NOT_RESERVED')
    expect(t.outcome_code).toBe('reserve_failed:no_client')
    expect(t.settled_micros).toBeNull()
    expect(t.input_tokens).toBeNull()
  })
})
