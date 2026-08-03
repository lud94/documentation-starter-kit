import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  countTokens, countTokensInputFromBody, COUNT_TOKENS_TIMEOUT_MS,
} from '../lib/prospector/tokenCount'
import { ANTHROPIC_COUNT_TOKENS_ENDPOINT, ANTHROPIC_ENDPOINT } from '../lib/prospector/llm'

// Lot C2a-2c — primitive de précomptage fournisseur.
//
// `fetch` est simulé de bout en bout : AUCUN appel Anthropic réel n'est émis
// par les tests automatiques, et aucun de ces cas ne dépense quoi que ce soit.
//
// Ce qui est verrouillé ici :
//   • la primitive vise le point de terminaison de COMPTAGE, jamais Messages ;
//   • aucune exception ne s'en échappe, quel que soit l'échec ;
//   • un `input_tokens` non entier est REFUSÉ plutôt que converti.

let fetchMock: ReturnType<typeof vi.fn>

const BODY = () => ({
  model: 'claude-sonnet-5',
  max_tokens: 1000,
  system: [{ type: 'text', text: 'sys' }],
  messages: [{ role: 'user', content: 'bonjour' }],
  output_config: { effort: 'low' },
})

function okCount(n: number) {
  return { ok: true, status: 200, json: async () => ({ input_tokens: n }), text: async () => '' }
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okCount(945))
  ;(globalThis as any).fetch = fetchMock
})

describe('cible et transport', () => {
  it('vise le point de terminaison de comptage, JAMAIS Messages', async () => {
    await countTokens('k', { model: 'claude-sonnet-5', messages: [] })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(ANTHROPIC_COUNT_TOKENS_ENDPOINT)
    expect(url).not.toBe(ANTHROPIC_ENDPOINT)
    expect(String(url).endsWith('/count_tokens')).toBe(true)
  })

  it('pose un délai maximal', async () => {
    await countTokens('k', { model: 'claude-sonnet-5', messages: [] })
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
    expect(COUNT_TOKENS_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('rend le comptage fournisseur tel quel', async () => {
    const r = await countTokens('k', { model: 'claude-sonnet-5', messages: [] })
    expect(r).toEqual({ ok: true, inputTokens: 945, status: 200 })
  })
})

describe('aucune exception ne s\'échappe', () => {
  it('clé absente → refus sans requête', async () => {
    const r = await countTokens('', { model: 'claude-sonnet-5', messages: [] })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('modèle absent → refus sans requête', async () => {
    const r = await countTokens('k', { model: '', messages: [] })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no_model')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('erreur de transport → ok:false, jamais de throw', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const r = await countTokens('k', { model: 'claude-sonnet-5', messages: [] })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('transport')
  })

  it('timeout → ok:false', async () => {
    const e: any = new Error('t'); e.name = 'TimeoutError'
    fetchMock.mockRejectedValue(e)
    const r = await countTokens('k', { model: 'claude-sonnet-5', messages: [] })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('TimeoutError')
  })

  it('HTTP non 2xx → ok:false avec le statut', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) })
    const r = await countTokens('k', { model: 'claude-sonnet-5', messages: [] })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(429)
    expect(r.inputTokens).toBe(0)
  })

  it('corps illisible → ok:false', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('bad') } })
    const r = await countTokens('k', { model: 'claude-sonnet-5', messages: [] })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('unparseable')
  })

  it.each([[1.5], [-1], [null], ['945'], [undefined], [Number.MAX_SAFE_INTEGER + 2]])(
    'input_tokens = %s → REFUSÉ, jamais converti', async (v) => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ input_tokens: v }) })
      const r = await countTokens('k', { model: 'claude-sonnet-5', messages: [] })
      expect(r.ok).toBe(false)
      expect(r.inputTokens).toBe(0)
    })

  it('corps non sérialisable → ok:false sans requête', async () => {
    const cyclic: any = { model: 'claude-sonnet-5', messages: [] }
    cyclic.self = cyclic
    const r = await countTokens('k', cyclic)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('serialize')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('extraction depuis un corps Messages', () => {
  it('conserve les champs qui influent sur l\'entrée', () => {
    const i = countTokensInputFromBody(BODY())
    expect(i.model).toBe('claude-sonnet-5')
    expect(i.messages).toHaveLength(1)
    expect(i.system).toBeDefined()
  })

  it('exclut max_tokens — il borne la SORTIE et le schéma ne l\'accepte pas', () => {
    const i: any = countTokensInputFromBody(BODY())
    expect(i.max_tokens).toBeUndefined()
  })

  it('transmet les outils : c\'est ce qui rend l\'overhead de déclaration visible', () => {
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
    const i = countTokensInputFromBody({ ...BODY(), tools })
    expect(i.tools).toEqual(tools)
  })

  it('n\'invente pas de champs absents', () => {
    const i = countTokensInputFromBody({ model: 'm', messages: [] })
    expect(i.system).toBeUndefined()
    expect(i.tools).toBeUndefined()
    expect(i.thinking).toBeUndefined()
    expect(i.output_config).toBeUndefined()
    expect(i.tool_choice).toBeUndefined()
  })

  it('corps vide → forme exploitable, refusée en amont par countTokens', () => {
    const i = countTokensInputFromBody(null)
    expect(i).toEqual({ model: '', messages: [] })
  })
})

// ── Lot C2a-2c-1 : la requête précomptée doit être celle qui sera émise ───────
describe('output_config et tool_choice — défaut de contrat corrigé', () => {
  it('transmet output_config.effort — ce que callClaude envoie RÉELLEMENT', () => {
    // `callClaude()` pose `output_config = { effort: 'medium' | 'low' }` sur
    // tout modèle qui supporte `effort`. L'omettre faisait précompter une
    // requête différente de la requête réelle.
    const i = countTokensInputFromBody({ ...BODY(), output_config: { effort: 'medium' } })
    expect(i.output_config).toEqual({ effort: 'medium' })
  })

  it('transmet output_config.format quand il est présent', () => {
    const format = { type: 'json_schema', schema: { type: 'object', properties: {} } }
    const i = countTokensInputFromBody({ ...BODY(), output_config: { format } })
    expect(i.output_config).toEqual({ format })
  })

  it('transmet output_config complet, sans le remodeler', () => {
    const oc = { effort: 'low', format: { type: 'json_schema', schema: {} } }
    const i = countTokensInputFromBody({ ...BODY(), output_config: oc })
    expect(i.output_config).toEqual(oc)
  })

  it('transmet tool_choice quand il est présent', () => {
    const i = countTokensInputFromBody({ ...BODY(), tool_choice: { type: 'tool', name: 'web_search' } })
    expect(i.tool_choice).toEqual({ type: 'tool', name: 'web_search' })
  })

  it('le corps réel de callClaude est reproduit à l\'identique, max_tokens excepté', () => {
    // Forme exacte assemblée par callClaude pour une tâche `research`.
    const real = {
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'thèse' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
      output_config: { effort: 'medium' },
    }
    const i: any = countTokensInputFromBody(real)

    expect(i.model).toBe(real.model)
    expect(i.messages).toEqual(real.messages)
    expect(i.system).toEqual(real.system)          // cache_control imbriqué inclus
    expect(i.tools).toEqual(real.tools)
    expect(i.output_config).toEqual(real.output_config)
    expect(i.max_tokens).toBeUndefined()

    // Aucun champ hors du schéma du point de terminaison.
    const ACCEPTED = ['model', 'messages', 'system', 'tools', 'thinking', 'output_config', 'tool_choice']
    expect(Object.keys(i).every((k) => ACCEPTED.includes(k))).toBe(true)
  })

  it('ce qui est extrait part bien dans la requête de comptage', async () => {
    const input = countTokensInputFromBody({ ...BODY(), output_config: { effort: 'low' } })
    await countTokens('k', input)
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(sent.output_config).toEqual({ effort: 'low' })
    expect(sent.max_tokens).toBeUndefined()
  })
})
