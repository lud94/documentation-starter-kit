import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Lot C1 — le garde-fou budgétaire doit être FAIL-SAFE.
//
// Le défaut corrigé (P0) : toute indisponibilité du compteur se traduisait par
// `spent = 0`, donc `blocked = false`, donc un appel payant autorisé. Ces cas
// verrouillent l'inverse — un budget positif configuré EXIGE une consommation
// lue durablement.
//
// La couche Supabase est simulée : on teste la DÉCISION du garde-fou, pas le
// pilote PostgreSQL. La lecture réelle est couverte par les tests d'intégration.

const readUsageDurable = vi.fn()
const writeAllowed = vi.fn()

// Seule `readUsageDurable` est simulée : `bumpUsage`/`getUsageAll` restent les
// vraies implémentations, sans quoi le cas « repli mémoire existant » ne
// prouverait rien (il testerait un doublure renvoyant 0).
vi.mock('../lib/supabase/pappersCache', async (orig) => ({
  ...(await orig<typeof import('../lib/supabase/pappersCache')>()),
  readUsageDurable: (...a: any[]) => readUsageDurable(...a),
}))
vi.mock('../lib/env', () => ({
  writeAllowed: (...a: any[]) => writeAllowed(...a),
}))

let budgetLeft: typeof import('../lib/prospector/llm')['budgetLeft']

beforeEach(async () => {
  vi.resetModules()
  readUsageDurable.mockReset()
  writeAllowed.mockReset().mockReturnValue(true) // cas nominal : écriture permise
  delete process.env.ANTHROPIC_BUDGET
  // Le coffre de clés lit d'abord son store mémoire : on le vide pour que
  // process.env fasse foi (même piège que tests/leads-isolation.test.ts —
  // remplacer l'objet sur globalThis ne suffit pas, le module en tient la référence).
  const g = globalThis as any
  if (!g.__prospectorKeys) g.__prospectorKeys = new Map()
  g.__prospectorKeys.clear()
  ;({ budgetLeft } = await import('../lib/prospector/llm'))
})
afterEach(() => { delete process.env.ANTHROPIC_BUDGET })

describe('budget non configuré', () => {
  it('absent → état explicite « non configuré », aucun blocage, aucune lecture', async () => {
    const g = await budgetLeft()
    expect(g.state).toBe('not_configured')
    expect(g.blocked).toBe(false)
    // Aucun plafond demandé : on ne va même pas interroger le compteur.
    expect(readUsageDurable).not.toHaveBeenCalled()
  })

  it('égal à zéro → identique à absent', async () => {
    process.env.ANTHROPIC_BUDGET = '0'
    const g = await budgetLeft()
    expect(g.state).toBe('not_configured')
    expect(g.blocked).toBe(false)
  })

  it('valeur illisible → traitée comme non configurée, jamais comme un plafond nul bloquant', async () => {
    process.env.ANTHROPIC_BUDGET = 'abc'
    const g = await budgetLeft()
    expect(g.state).toBe('not_configured')
    expect(g.blocked).toBe(false)
  })
})

describe('budget configuré et compteur lisible', () => {
  it('marge restante → autorisé', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    readUsageDurable.mockResolvedValue({ ok: true, value: 350 }) // 3,50 $
    const g = await budgetLeft()
    expect(g.state).toBe('available')
    expect(g.blocked).toBe(false)
    expect(g.spent).toBeCloseTo(3.5)
  })

  it('compteur absent en base (aucun appel encore) → autorisé, pas « indisponible »', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    readUsageDurable.mockResolvedValue({ ok: true, value: 0 })
    const g = await budgetLeft()
    expect(g.state).toBe('available')
    expect(g.spent).toBe(0)
  })

  it('plafond atteint → budget_exhausted, distinct de usage_unavailable', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    readUsageDurable.mockResolvedValue({ ok: true, value: 2000 })
    const g = await budgetLeft()
    expect(g.state).toBe('budget_exhausted')
    expect(g.blocked).toBe(true)
    expect(g.spent).toBe(20)
  })

  it('plafond dépassé → bloqué également', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    readUsageDurable.mockResolvedValue({ ok: true, value: 2500 })
    expect((await budgetLeft()).state).toBe('budget_exhausted')
  })
})

describe('indisponibilité du suivi — jamais interprétée comme spent = 0', () => {
  it('erreur de lecture Supabase → usage_unavailable, BLOQUÉ', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    readUsageDurable.mockResolvedValue({ ok: false, reason: 'db_error' })
    const g = await budgetLeft()
    expect(g.state).toBe('usage_unavailable')
    expect(g.blocked).toBe(true)
    expect(g.spent).toBeNull()          // aucun chiffre inventé
    expect(g.state).not.toBe('budget_exhausted') // motif distinct
  })

  it('Supabase absent → usage_unavailable, BLOQUÉ', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    readUsageDurable.mockResolvedValue({ ok: false, reason: 'no_client' })
    const g = await budgetLeft()
    expect(g.state).toBe('usage_unavailable')
    expect(g.blocked).toBe(true)
  })

  it('écriture de prospector_usage interdite par le contrat A2 → BLOQUÉ avant Anthropic', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    writeAllowed.mockReturnValue(false)
    readUsageDurable.mockResolvedValue({ ok: true, value: 0 }) // compteur pourtant lisible
    const g = await budgetLeft()
    expect(g.state).toBe('usage_unavailable')
    expect(g.blocked).toBe(true)
    // Le refus intervient AVANT toute lecture : un appel facturable ne doit pas
    // partir si sa dépense ne pourra pas être décomptée.
    expect(readUsageDurable).not.toHaveBeenCalled()
    expect(writeAllowed).toHaveBeenCalledWith('prospector_usage')
  })

  it('sans budget configuré, une écriture interdite ne bloque PAS', async () => {
    writeAllowed.mockReturnValue(false)
    const g = await budgetLeft()
    expect(g.state).toBe('not_configured')
    expect(g.blocked).toBe(false) // aucun plafond à protéger
  })
})

describe('le repli mémoire n’est jamais une source du garde budgétaire', () => {
  it('un compteur mémoire existant ne rend pas un compteur durable illisible acceptable', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    // Situation réelle : l'instance a déjà servi des appels, memUsage contient
    // une valeur — mais la table est inaccessible. L'ancienne implémentation
    // repartait de {} (ou de la mémoire) et autorisait. Ici : refus.
    const { bumpUsage, getUsage } = await import('../lib/supabase/pappersCache')
    await bumpUsage('ai:cents', 500)
    expect(await getUsage('ai:cents')).toBeGreaterThanOrEqual(500) // le repli mémoire EXISTE bien
    readUsageDurable.mockResolvedValue({ ok: false, reason: 'db_error' })

    const g = await budgetLeft()
    expect(g.blocked).toBe(true)
    expect(g.state).toBe('usage_unavailable')
    expect(g.spent).toBeNull()
  })

  it('readUsageDurable est la SEULE source consultée — getUsageAll n’est pas utilisée', async () => {
    process.env.ANTHROPIC_BUDGET = '20'
    readUsageDurable.mockResolvedValue({ ok: true, value: 100 })
    await budgetLeft()
    expect(readUsageDurable).toHaveBeenCalledTimes(1)
    expect(readUsageDurable).toHaveBeenCalledWith('ai:cents')
  })
})
