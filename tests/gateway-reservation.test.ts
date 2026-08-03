import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Lot C2a-2 — réservation budgétaire dans la passerelle Anthropic.
//
// Ce qui est verrouillé ici, dans l'ordre d'importance :
//   1. AUCUNE requête HTTP n'est émise sans réservation acquise ;
//   2. OBSERVE ne peut RIEN empêcher, jamais, par aucun chemin ;
//   3. `RELEASED` n'est accordé que sur preuve de non-facturation ;
//   4. une réponse payée n'est jamais détruite parce qu'un compteur a échoué.
//
// La couche Supabase est simulée : on teste la DÉCISION de la passerelle, pas le
// pilote PostgreSQL. Les RPC réelles sont couvertes par les tests d'intégration.

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

let anthropicPost: typeof import('../lib/prospector/llm')['anthropicPost']
let readToolShape: typeof import('../lib/prospector/llm')['readToolShape']
let fetchMock: ReturnType<typeof vi.fn>

const OK_BODY = {
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0 },
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
}

function httpOk(body: any = OK_BODY, status = 200) {
  return { ok: true, status, json: async () => body, text: async () => JSON.stringify(body) }
}
function httpErr(status: number, text = 'boom') {
  return { ok: false, status, json: async () => ({}), text: async () => text }
}

const BODY = () => ({
  model: 'claude-sonnet-5', max_tokens: 1000,
  messages: [{ role: 'user', content: 'bonjour' }],
})

beforeEach(async () => {
  vi.resetModules()
  reserve.mockReset().mockResolvedValue({ ok: true, state: 'reserved', engagedMicros: 0n, budgetMicros: 0n })
  settle.mockReset().mockResolvedValue({ ok: true })
  resolveReservation.mockReset().mockResolvedValue({ ok: true })

  fetchMock = vi.fn().mockResolvedValue(httpOk())
  ;(globalThis as any).fetch = fetchMock

  delete process.env.AI_BUDGET_RESERVATION
  delete process.env.AI_BUDGET_OBSERVE_LIMIT
  delete process.env.ANTHROPIC_BUDGET
  const g = globalThis as any
  if (!g.__prospectorKeys) g.__prospectorKeys = new Map()
  g.__prospectorKeys.clear()
  ;({ anthropicPost, readToolShape } = await import('../lib/prospector/llm'))
})
afterEach(() => {
  delete process.env.AI_BUDGET_RESERVATION
  delete process.env.AI_BUDGET_OBSERVE_LIMIT
  delete process.env.ANTHROPIC_BUDGET
})

// ── Mode OFF : le chemin historique, à l'octet près côté comptabilité ─────────
describe('mode OFF (défaut d\'exécution)', () => {
  it('drapeau absent → aucune RPC, la requête part quand même', async () => {
    const r = await anthropicPost('k', BODY())
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reserve).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
  })

  it('transport historique : aucun signal d\'annulation posé en OFF', async () => {
    // Le durcissement du transport ne fait pas partie de ce lot. OFF reste le
    // comportement historique, y compris son absence de délai maximal.
    await anthropicPost('k', BODY())
    expect(fetchMock.mock.calls[0][1].signal).toBeUndefined()
  })

  it('OBSERVE et ENFORCE posent en revanche un délai maximal', async () => {
    for (const mode of ['OBSERVE', 'ENFORCE']) {
      vi.resetModules()
      process.env.AI_BUDGET_RESERVATION = mode
      const g = globalThis as any; g.__prospectorKeys.clear()
      const m = await import('../lib/prospector/llm')
      fetchMock.mockClear()
      await m.anthropicPost('k', BODY())
      expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
    }
    delete process.env.AI_BUDGET_RESERVATION
  })

  it('valeur non reconnue → OFF, JAMAIS ENFORCE', async () => {
    for (const v of ['ON', 'true', '1', 'enforce ', 'OBSERVER', '']) {
      vi.resetModules()
      process.env.AI_BUDGET_RESERVATION = v
      const g = globalThis as any; g.__prospectorKeys.clear()
      const m = await import('../lib/prospector/llm')
      reserve.mockClear()
      await m.anthropicPost('k', BODY())
      // 'enforce ' et 'OBSERVER' ne doivent surtout pas armer quoi que ce soit.
      if (v === 'enforce ') expect(reserve).toHaveBeenCalled() // trim + upper : reconnu
      else expect(reserve).not.toHaveBeenCalled()
    }
  })
})

// ── Mode OBSERVE : mesurer sans jamais empêcher ───────────────────────────────
describe('mode OBSERVE — non bloquant par construction', () => {
  beforeEach(() => { process.env.AI_BUDGET_RESERVATION = 'OBSERVE' })

  it('transmet un plafond NUL au RPC : budget_exhausted est inatteignable', async () => {
    process.env.ANTHROPIC_BUDGET = '0.000001' // plafond ridicule, sans effet attendu
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    await m.anthropicPost('k', BODY())
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(reserve.mock.calls[0][0].budgetMicros).toBe(0n)
  })

  it('seuil candidat minuscule → l\'appel PART quand même, seul le journal le note', async () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = '0.000001'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', BODY())
    expect(r.ok).toBe(true)
    expect(r.blocked).toBeFalsy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('AI_BUDGET_OBSERVE_LIMIT illisible ne bloque rien', async () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = 'douze euros'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', BODY())
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('web_fetch sans max_content_tokens → l\'appel est AUTORISÉ en OBSERVE', async () => {
    const body: any = { ...BODY(), tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 }] }
    const r = await anthropicPost('k', body)
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ── Mode ENFORCE : le garde arme ──────────────────────────────────────────────
describe('mode ENFORCE', () => {
  beforeEach(() => { process.env.AI_BUDGET_RESERVATION = 'ENFORCE' })

  it('budget_exhausted → AUCUNE requête émise', async () => {
    reserve.mockResolvedValue({ ok: true, state: 'budget_exhausted', engagedMicros: 99n, budgetMicros: 1n })
    const r = await anthropicPost('k', BODY())
    expect(fetchMock).not.toHaveBeenCalled()          // l'assertion centrale du lot
    expect(r.blocked).toBe(true)
    expect(r.blockedReason).toBe('budget_exhausted')
  })

  it('échec technique de reserve() → fail-safe, aucune requête émise', async () => {
    reserve.mockResolvedValue({ ok: false, reason: 'PGRST202: fonction absente' })
    const r = await anthropicPost('k', BODY())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.blocked).toBe(true)
    expect(r.blockedReason).toBe('usage_unavailable')  // pas « budget épuisé »
  })

  it('état de réservation inattendu → refus, aucune requête émise', async () => {
    reserve.mockResolvedValue({ ok: true, state: 'integrity_error', engagedMicros: 0n, budgetMicros: 0n })
    const r = await anthropicPost('k', BODY())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.blocked).toBe(true)
  })

  it('ANTHROPIC_BUDGET illisible → ferme AVANT toute RPC', async () => {
    process.env.ANTHROPIC_BUDGET = '20 euros'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', BODY())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(r.blocked).toBe(true)
  })

  // ── Budget explicitement à zéro — P0 ───────────────────────────────────────
  // `readBudgetConfig` distingue « absent » de « 0 ». Le RPC, lui, lit 0 comme
  // « aucun plafond ». Confondre les deux transformerait un hard stop en
  // autorisation illimitée pour tout appelant direct d'anthropicPost.
  it('ANTHROPIC_BUDGET=0 → hard stop : aucun fetch, aucune RPC', async () => {
    process.env.ANTHROPIC_BUDGET = '0'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', BODY())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()      // le RPC ne doit PAS arbitrer ce cas
    expect(r.blocked).toBe(true)
    expect(r.blockedReason).toBe('budget_exhausted')
  })

  it.each(['0', '0.0', '0,000000', '0.000000'])(
    'ANTHROPIC_BUDGET=« %s » → hard stop', async (v) => {
      process.env.ANTHROPIC_BUDGET = v
      const g = globalThis as any; g.__prospectorKeys.clear()
      vi.resetModules()
      const m = await import('../lib/prospector/llm')
      const r = await m.anthropicPost('k', BODY())
      expect(fetchMock).not.toHaveBeenCalled()
      expect(r.blockedReason).toBe('budget_exhausted')
    })

  it('ANTHROPIC_BUDGET ABSENT → aucun plafond demandé : l\'appel part', async () => {
    // Le contraste avec le cas ci-dessus est tout l'objet de la correction.
    const r = await anthropicPost('k', BODY())
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reserve.mock.calls[0][0].budgetMicros).toBe(0n)
  })

  it('sonde type /api/ai/diagnose avec budget 0 → aucun appel émis', async () => {
    // Reproduit exactement la forme d'appel de la route de diagnostic, qui
    // n'est PAS couverte par C1 : elle n'passe pas par callClaude().
    process.env.ANTHROPIC_BUDGET = '0'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', {
      model: 'claude-sonnet-5', max_tokens: 64,
      messages: [{ role: 'user', content: 'Réponds juste: OK' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    }, { agent: 'diagnose', task: 'research' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.blocked).toBe(true)
  })

  it('transmet le plafond réel au RPC', async () => {
    process.env.ANTHROPIC_BUDGET = '2.50'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    await m.anthropicPost('k', BODY())
    expect(reserve.mock.calls[0][0].budgetMicros).toBe(2_500_000n)
  })
})

// ── Coût non bornable — la contrainte centrale de ce lot ──────────────────────
describe('estimation incomplète (web_fetch sans max_content_tokens)', () => {
  const withFetch = () => ({ ...BODY(), tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 }] } as any)

  it('ENFORCE + plafond positif → refusé, jamais traité comme correctement estimé', async () => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    process.env.ANTHROPIC_BUDGET = '5'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', withFetch())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(reserve).not.toHaveBeenCalled()
    expect(r.blocked).toBe(true)
    expect(r.blockedDetail).toContain('web_fetch_content')
  })

  it('ENFORCE SANS plafond → autorisé : aucune décision ne dépend du coût non borné', async () => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', withFetch())
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('le coût RÉEL est néanmoins réglé normalement', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    await m.anthropicPost('k', withFetch())
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0][1]).toBeGreaterThan(0n)
  })
})

// ── Classification exhaustive des résultats ───────────────────────────────────
describe('classification', () => {
  beforeEach(() => { process.env.AI_BUDGET_RESERVATION = 'OBSERVE' })

  it('2xx avec usage → SETTLED au montant calculé', async () => {
    await anthropicPost('k', BODY())
    expect(settle).toHaveBeenCalledTimes(1)
    expect(resolveReservation).not.toHaveBeenCalled()
    // sonnet-5 : 1000 in × 3 µUSD/1k + 500 out × 15 µUSD/1k = 3000 + 7500
    expect(settle.mock.calls[0][1]).toBe(10_500n)
  })

  it('2xx au corps illisible → UNRESOLVED, jamais un faux zéro', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    await anthropicPost('k', BODY())
    expect(settle).not.toHaveBeenCalled()
    expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'UNRESOLVED', 'ok_unparseable')
  })

  it('2xx sans bloc usage → UNRESOLVED', async () => {
    fetchMock.mockResolvedValue(httpOk({ content: [] }))
    await anthropicPost('k', BODY())
    expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'UNRESOLVED', 'usage_missing')
  })

  it.each([400, 401, 403, 404, 422, 429])('HTTP %i → RELEASED (preuve de rejet à l\'admission)', async (status) => {
    fetchMock.mockResolvedValue(httpErr(status))
    const r = await anthropicPost('k', BODY())
    expect(r.ok).toBe(false)
    expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'RELEASED', `http_${status}`)
  })

  it.each([500, 502, 503, 529])('HTTP %i → UNRESOLVED (facturation indéterminée)', async (status) => {
    fetchMock.mockResolvedValue(httpErr(status))
    await anthropicPost('k', BODY())
    expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'UNRESOLVED', `http_${status}`)
  })

  // `status < 500 ⇒ RELEASED` était un intervalle, pas une preuve : il libérait
  // des statuts dont on ne sait rien. RELEASED se mérite, statut par statut.
  it.each([402, 405, 409, 418, 451, 499])(
    'HTTP %i non répertorié → UNRESOLVED, pas RELEASED', async (status) => {
      fetchMock.mockResolvedValue(httpErr(status))
      await anthropicPost('k', BODY())
      expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'UNRESOLVED', `http_${status}`)
    })

  it('aucun 4xx non répertorié ne produit jamais RELEASED', async () => {
    for (let s = 400; s < 500; s++) {
      resolveReservation.mockClear()
      fetchMock.mockResolvedValue(httpErr(s))
      await anthropicPost('k', BODY())
      const [, state] = resolveReservation.mock.calls[0]
      if ([400, 401, 403, 404, 413, 422, 429].includes(s)) expect(state).toBe('RELEASED')
      else expect(state).toBe('UNRESOLVED')
    }
  })

  it('timeout → UNRESOLVED', async () => {
    const e: any = new Error('timed out'); e.name = 'TimeoutError'
    fetchMock.mockRejectedValue(e)
    await expect(anthropicPost('k', BODY())).rejects.toThrow()
    expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'UNRESOLVED', 'timeout')
  })

  it('abort → UNRESOLVED', async () => {
    const e: any = new Error('aborted'); e.name = 'AbortError'
    fetchMock.mockRejectedValue(e)
    await expect(anthropicPost('k', BODY())).rejects.toThrow()
    expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'UNRESOLVED', 'aborted')
  })

  it('TypeError de transport → UNRESOLVED, PAS RELEASED', async () => {
    // Correction explicite du plan initial : un TypeError ne prouve pas que la
    // requête n'est jamais arrivée. Le lui accorder serait un faux zéro.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(anthropicPost('k', BODY())).rejects.toThrow()
    expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'UNRESOLVED', 'network')
  })

  it('aucune exception de transport ne produit jamais RELEASED', async () => {
    for (const name of ['TypeError', 'TimeoutError', 'AbortError', 'FooError']) {
      resolveReservation.mockClear()
      const e: any = new Error('x'); e.name = name
      fetchMock.mockRejectedValue(e)
      await expect(anthropicPost('k', BODY())).rejects.toThrow()
      expect(resolveReservation.mock.calls[0][1]).toBe('UNRESOLVED')
    }
  })
})

// ── Le règlement échoue : la réponse payée est rendue quand même ──────────────
describe('échec de règlement', () => {
  beforeEach(() => { process.env.AI_BUDGET_RESERVATION = 'OBSERVE' })

  it('settle() échoue → réponse rendue + repli UNRESOLVED', async () => {
    settle.mockResolvedValue({ ok: false, reason: 'db down' })
    const r = await anthropicPost('k', BODY())
    expect(r.ok).toBe(true)                 // jamais détruire un résultat payé
    expect(r.data.content[0].text).toBe('ok')
    expect(resolveReservation).toHaveBeenCalledWith(expect.any(String), 'UNRESOLVED', 'settle_failed')
  })

  it('settle() ET son repli échouent → réponse rendue, aucune exception', async () => {
    settle.mockResolvedValue({ ok: false, reason: 'db down' })
    resolveReservation.mockResolvedValue({ ok: false, reason: 'db down' })
    const r = await anthropicPost('k', BODY())
    expect(r.ok).toBe(true)
  })
})

// ── Lecture des outils : web_search ≠ web_fetch ───────────────────────────────
describe('readToolShape', () => {
  it('sépare les deux outils et ne somme pas leurs max_uses', () => {
    const s = readToolShape({ tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 10 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 },
    ] })
    expect(s.webSearchMaxUses).toBe(10)   // et non 16
    expect(s.webFetchMaxUses).toBe(6)
    expect(s.webFetchDeclared).toBe(true)
    expect(s.webFetchMaxContentTokens).toBeUndefined()  // non borné
  })

  it('max_content_tokens déclaré → borne = max_content_tokens × max_uses', () => {
    const s = readToolShape({ tools: [
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6, max_content_tokens: 5000 },
    ] })
    expect(s.webFetchMaxContentTokens).toBe(30_000)
  })

  it('un seul web_fetch non borné suffit à rendre l\'ensemble non estimable', () => {
    const s = readToolShape({ tools: [
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2, max_content_tokens: 1000 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 2 },
    ] })
    expect(s.webFetchMaxContentTokens).toBeUndefined()
  })

  it('max_uses absent → borne prudente ; outil client ignoré', () => {
    const s = readToolShape({ tools: [
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 'mon_outil', input_schema: {} },
    ] })
    expect(s.webSearchMaxUses).toBe(8)
  })

  it('outil serveur inconnu → signalé comme non modélisé', () => {
    const s = readToolShape({ tools: [{ type: 'code_execution_20990101', name: 'x', max_uses: 4 }] })
    expect(s.unknownServerToolTypes).toEqual(['code_execution_20990101'])
  })

  it('web_search et web_fetch ne sont PAS des types inconnus', () => {
    const s = readToolShape({ tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 1 },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1, max_content_tokens: 100 },
    ] })
    expect(s.unknownServerToolTypes).toEqual([])
  })

  it('aucun outil → tout à zéro, rien de déclaré', () => {
    const s = readToolShape({})
    expect(s).toEqual({
      webSearchMaxUses: 0, webFetchMaxUses: 0,
      webFetchDeclared: false, webFetchMaxContentTokens: undefined,
      unknownServerToolTypes: [],
      serverToolTypes: [], webSearchDeclared: false,   // ajoutés en C2a-2c
    })
  })
})

// ── C2a-2c : la politique ENFORCE n'a PAS changé ─────────────────────────────
// Ce lot ajoute des instruments (précomptage, observabilité, liste `unbounded`)
// sans toucher à la porte. Ces cas verrouillent l'absence de dérive.
describe('non-régression de la porte ENFORCE (C2a-2c)', () => {
  beforeEach(() => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    process.env.ANTHROPIC_BUDGET = '5'
  })

  const run = async (tools?: any[]) => {
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    return m.anthropicPost('k', tools ? { ...BODY(), tools } : BODY())
  }

  it('web_search seul → TOUJOURS autorisé sous plafond positif', async () => {
    // Les tokens de résultats sont non bornables et désormais déclarés comme
    // tels dans `unbounded` — cela NE DOIT PAS bloquer. Sinon ENFORCE
    // deviendrait inutilisable sur presque toute la surface IA.
    const r = await run([{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }])
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('web_fetch AVEC max_content_tokens → toujours autorisé', async () => {
    const r = await run([{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6, max_content_tokens: 5000 }])
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('web_fetch SANS max_content_tokens → toujours refusé', async () => {
    const r = await run([{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 6 }])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.blocked).toBe(true)
  })

  it('aucun appel de précomptage n\'est émis depuis la passerelle', async () => {
    // L'instrument est livré, sa politique ne l'est pas : rien ne doit toucher
    // /v1/messages/count_tokens dans le chemin de requête.
    await run([{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }])
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('count_tokens')
    }
  })
})

// ── Outil serveur non modélisé : refusé en ENFORCE sous plafond ───────────────
describe('outil serveur non modélisé', () => {
  const withUnknown = () => ({
    ...BODY(), tools: [{ type: 'code_execution_20990101', name: 'x', max_uses: 4 }],
  } as any)

  it('ENFORCE + plafond positif → refusé, l\'estimation n\'est pas un majorant', async () => {
    process.env.AI_BUDGET_RESERVATION = 'ENFORCE'
    process.env.ANTHROPIC_BUDGET = '5'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', withUnknown())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(r.blockedDetail).toContain('unknown_server_tool')
  })

  it('OBSERVE → autorisé, mais mesuré comme incomplet', async () => {
    process.env.AI_BUDGET_RESERVATION = 'OBSERVE'
    const g = globalThis as any; g.__prospectorKeys.clear()
    vi.resetModules()
    const m = await import('../lib/prospector/llm')
    const r = await m.anthropicPost('k', withUnknown())
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
