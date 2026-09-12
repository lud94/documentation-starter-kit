import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  estimateBreakdown, estimateMicros,
  INCOMPLETE_WEB_FETCH_CONTENT, INCOMPLETE_UNKNOWN_SERVER_TOOL,
} from '../lib/prospector/money'
import { budgetMode, observeLimit, enforceBudget } from '../lib/prospector/budgetMode'

// Lot C2a-2 — correction du modèle de coût des outils serveur, et lecture des
// deux variables de mode. Aucun appel réseau, aucune base.

const BASE = { model: 'claude-sonnet-5', maxTokens: 0, bodyBytes: 0 }

describe('web_search et web_fetch ne se facturent pas pareil', () => {
  it('web_search : max_uses × tarif par recherche', () => {
    const e = estimateBreakdown({ ...BASE, webSearchMaxUses: 10 })
    expect(e.toolMicros).toBe(100_000n)   // 10 × 0,01 $
    expect(e.fetchContentMicros).toBe(0n)
    expect(e.complete).toBe(true)
  })

  it('web_fetch borné : tokens de contenu au tarif d\'ENTRÉE, aucun coût par usage', () => {
    const e = estimateBreakdown({ ...BASE, webFetchDeclared: true, webFetchMaxContentTokens: 30_000 })
    expect(e.toolMicros).toBe(0n)                 // pas de coût d'outil
    expect(e.fetchContentMicros).toBe(90_000n)    // 30k × 3 µUSD/1k (sonnet, entrée)
    expect(e.complete).toBe(true)
  })

  it('le cas signals.ts (10 recherches + 6 fetch) ne vaut PAS 16 × prix recherche', () => {
    const e = estimateBreakdown({
      ...BASE, webSearchMaxUses: 10, webFetchDeclared: true, webFetchMaxContentTokens: 0,
    })
    expect(e.toolMicros).toBe(100_000n)
    expect(e.toolMicros).not.toBe(160_000n)  // l'ancienne formule agrégée
  })

  it('web_fetch NON borné → estimation incomplète, composante nommée', () => {
    const e = estimateBreakdown({ ...BASE, webSearchMaxUses: 10, webFetchDeclared: true })
    expect(e.complete).toBe(false)
    expect(e.incomplete).toEqual([INCOMPLETE_WEB_FETCH_CONTENT])
    // La valeur reste 0, mais c'est `complete` qui porte la vérité — jamais le montant.
    expect(e.fetchContentMicros).toBe(0n)
    expect(e.toolMicros).toBe(100_000n)   // la part recherche reste, elle, estimée
  })

  it('web_fetch absent → complet, aucune composante manquante', () => {
    const e = estimateBreakdown({ ...BASE, webSearchMaxUses: 3 })
    expect(e.complete).toBe(true)
    expect(e.incomplete).toEqual([])
  })

  it('outil serveur non modélisé → incomplet, même si un montant est calculé', () => {
    const e = estimateBreakdown({ ...BASE, webSearchMaxUses: 4, unknownServerToolTypes: ['code_execution_x'] })
    expect(e.complete).toBe(false)
    expect(e.incomplete).toEqual([INCOMPLETE_UNKNOWN_SERVER_TOOL])
    // Le montant indicatif existe, mais il ne prétend plus majorer.
    expect(e.toolMicros).toBe(40_000n)
  })

  it('les deux causes d\'incomplétude se cumulent', () => {
    const e = estimateBreakdown({
      ...BASE, webFetchDeclared: true, unknownServerToolTypes: ['x'],
    })
    expect(e.incomplete).toEqual([INCOMPLETE_WEB_FETCH_CONTENT, INCOMPLETE_UNKNOWN_SERVER_TOOL])
  })

  it('liste vide d\'outils inconnus → toujours complet', () => {
    const e = estimateBreakdown({ ...BASE, webSearchMaxUses: 1, unknownServerToolTypes: [] })
    expect(e.complete).toBe(true)
  })

  it('les composantes s\'additionnent exactement au total', () => {
    const e = estimateBreakdown({
      model: 'claude-sonnet-5', maxTokens: 1000, bodyBytes: 3000,
      webSearchMaxUses: 4, webFetchDeclared: true, webFetchMaxContentTokens: 10_000,
    })
    expect(e.inputMicros + e.outputMicros + e.toolMicros + e.fetchContentMicros).toBe(e.totalMicros)
    expect(estimateMicros({
      model: 'claude-sonnet-5', maxTokens: 1000, bodyBytes: 3000,
      webSearchMaxUses: 4, webFetchDeclared: true, webFetchMaxContentTokens: 10_000,
    })).toBe(e.totalMicros)
  })

  it('serverToolMaxUses (hérité) reste traité comme des recherches web', () => {
    const ancien = estimateBreakdown({ ...BASE, serverToolMaxUses: 6 })
    const neuf = estimateBreakdown({ ...BASE, webSearchMaxUses: 6 })
    expect(ancien.totalMicros).toBe(neuf.totalMicros)
  })

  it('tout en bigint : aucun flottant ne traverse l\'estimation', () => {
    const e = estimateBreakdown({ model: 'claude-opus-5', maxTokens: 64_000, bodyBytes: 900_001, webSearchMaxUses: 3 })
    for (const v of [e.inputMicros, e.outputMicros, e.toolMicros, e.fetchContentMicros, e.totalMicros]) {
      expect(typeof v).toBe('bigint')
    }
  })
})

describe('lecture du mode et des seuils', () => {
  beforeEach(() => {
    delete process.env.AI_BUDGET_RESERVATION
    delete process.env.AI_BUDGET_OBSERVE_LIMIT
    delete process.env.ANTHROPIC_BUDGET
    const g = globalThis as any
    if (!g.__prospectorKeys) g.__prospectorKeys = new Map()
    g.__prospectorKeys.clear()
  })
  afterEach(() => {
    delete process.env.AI_BUDGET_RESERVATION
    delete process.env.AI_BUDGET_OBSERVE_LIMIT
    delete process.env.ANTHROPIC_BUDGET
  })

  it('défaut d\'exécution : OFF', () => {
    expect(budgetMode()).toBe('OFF')
  })

  it.each(['ON', 'true', '1', 'yes', 'OBSERVER', 'ENFORCED', 'off', ' '])(
    '« %s » → OFF, jamais ENFORCE', (v) => {
      process.env.AI_BUDGET_RESERVATION = v
      expect(budgetMode()).toBe('OFF')
    })

  it.each([['OBSERVE', 'OBSERVE'], ['observe', 'OBSERVE'], [' Enforce ', 'ENFORCE']])(
    '« %s » → %s', (v, expected) => {
      process.env.AI_BUDGET_RESERVATION = v
      expect(budgetMode()).toBe(expected)
    })

  it('seuil candidat valide → exploitable', () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = '1.25'
    expect(observeLimit()).toEqual({ ok: true, micros: 1_250_000n })
  })

  it('seuil candidat illisible → inexploitable, avec motif, mais 0 µUSD', () => {
    process.env.AI_BUDGET_OBSERVE_LIMIT = 'douze'
    const l = observeLimit()
    expect(l.ok).toBe(false)
    expect(l.micros).toBe(0n)
    expect(l.invalidReason).toBeTruthy()
  })

  it('seuil candidat absent → inexploitable, sans motif', () => {
    expect(observeLimit()).toEqual({ ok: false, micros: 0n })
  })

  // ⚠️ Les deux cas ci-dessous rendent tous deux `micros: 0n` et doivent
  // pourtant produire des comportements OPPOSÉS. C'est tout l'objet de la
  // distinction `configured` / `positive` / `zero` : le RPC lit 0 comme
  // « aucun plafond », alors qu'un 0 SAISI veut dire « aucune dépense ».
  it('ANTHROPIC_BUDGET absent → aucun plafond demandé', () => {
    expect(enforceBudget()).toEqual({
      ok: true, micros: 0n, configured: false, positive: false, zero: false,
    })
  })

  it('ANTHROPIC_BUDGET = 0 → plafond SAISI, hard stop', () => {
    process.env.ANTHROPIC_BUDGET = '0'
    expect(enforceBudget()).toEqual({
      ok: true, micros: 0n, configured: true, positive: false, zero: true,
    })
  })

  it('ANTHROPIC_BUDGET > 0 → plafond réel, ni zéro ni absent', () => {
    process.env.ANTHROPIC_BUDGET = '2.50'
    expect(enforceBudget()).toEqual({
      ok: true, micros: 2_500_000n, configured: true, positive: true, zero: false,
    })
  })

  it('ANTHROPIC_BUDGET illisible → fail closed, jamais un zéro trompeur', () => {
    process.env.ANTHROPIC_BUDGET = '20 euros'
    const b = enforceBudget()
    expect(b.ok).toBe(false)
    expect(b.zero).toBe(false)   // ne doit PAS se confondre avec le hard stop
  })

  it('ANTHROPIC_BUDGET illisible → lecture invalide (ferme côté appelant)', () => {
    process.env.ANTHROPIC_BUDGET = '20 euros'
    expect(enforceBudget().ok).toBe(false)
  })
})
