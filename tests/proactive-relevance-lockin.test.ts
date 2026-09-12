// ARCH-RULEPACK-001 — VERROU DE NON-RÉGRESSION SUR LA PERTINENCE.
//
// ── CE QUE CE FICHIER EXISTE POUR EMPÊCHER ──────────────────────────────────
// L'arrivée d'une `LensDefinition` munie d'une méthode `relevance()` crée une
// tentation évidente : brancher la lens sur le calcul de pertinence. Ce serait
// un CHANGEMENT DE POLITIQUE déguisé en refactor. La pertinence Sales provient
// aujourd'hui, et doit continuer de provenir, de deux sources et deux seules :
//
//     input.relevanceFor(cible)        si l'appelant en fournit une
//     sinon  max(Lead.score) / 100     du compte, agrégé par `buildIndex`
//
// `SALES_DEFAULT_LENS.relevance()` n'est appelée par AUCUN chemin du moteur.
// Le jour où quelqu'un la branchera, ces valeurs deviendront 0.5 et ce fichier
// deviendra rouge — ce qui est exactement le but.
//
// Les valeurs attendues ci-dessous ont été RELEVÉES sur la baseline `4fdcba5`
// (avant refactor) par exécution réelle, pas déduites par lecture du code.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../lib/supabase/client', () => ({
  supabase: () => null,
  supabaseConfigured: () => false,
}))
vi.mock('../lib/env', () => ({ writeAllowed: () => true }))

import type { Lead } from '../types/prospector'
import { evaluate } from '../lib/prospector/proactive/orchestrator'
import type { TaskSnapshot } from '../lib/prospector/proactive/dataBridge'
import { TEST_BUSINESS_CONTEXT } from './helpers/proactiveContext'

const NOW = new Date('2026-03-01T10:00:00.000Z')
const COMPLET: TaskSnapshot = { complete: true, openTaskLeadIds: [] }

function lead(score: number): Lead {
  return {
    id: 'ld_1',
    firstName: 'Alice',
    lastName: 'Martin',
    title: 'VP Sales',
    company: 'Acme SAS',
    siren: '552100554',
    score,
    temperature: 'hot',
    status: 'chaud',
    stage: 'in_sequence',
    email: 'alice@acme.test',
    phone: null,
  }
}

function run(l: Lead, patch: Record<string, unknown> = {}) {
  return evaluate({
    leads: [l],
    now: NOW,
    tasks: COMPLET,
    businessContext: TEST_BUSINESS_CONTEXT,
    ...patch,
  } as any)
}

describe('La pertinence reste dérivée de Lead.score, jamais de la lens', () => {
  // Valeurs mesurées sur `4fdcba5` ET sur le refactor : identiques.
  const ATTENDU = [
    { score: 90, relevance: 0.9, confidence: 0.85 },
    { score: 60, relevance: 0.6, confidence: 0.6 },
    { score: 20, relevance: 0.2, confidence: 0.2 },
  ]

  for (const cas of ATTENDU) {
    it(`Lead.score=${cas.score} ⇒ relevance=${cas.relevance}`, () => {
      const out = run(lead(cas.score))

      expect(out.situations).toHaveLength(1)
      expect(out.situations[0].relevance).toBe(cas.relevance)

      // La pertinence se propage jusqu'à la recommandation via la confiance.
      expect(out.recommendations).toHaveLength(1)
      expect(out.recommendations[0].confidence).toBe(cas.confidence)
      expect(out.recommendations[0].decision).toBe('recommend')
      expect(out.recommendations[0].priority).toBe('low')
    })
  }

  it('trois scores distincts produisent trois pertinences DISTINCTES', () => {
    // Le contrôle négatif qui compte vraiment : si la lens remplaçait le
    // calcul par une constante, les trois cas ci-dessus resteraient
    // individuellement « plausibles » mais s'effondreraient sur une seule
    // valeur. C'est cette dégénérescence qu'on interdit ici.
    const valeurs = ATTENDU.map((c) => run(lead(c.score)).situations[0].relevance)
    expect(new Set(valeurs).size).toBe(3)
    expect(valeurs).not.toContain(0.5)
  })

  it('`relevanceFor` fourni par l’appelant reste PRIORITAIRE sur Lead.score', () => {
    const out = run(lead(90), { relevanceFor: () => 0.3 })
    expect(out.situations[0].relevance).toBe(0.3)
  })

  it('la lens ne fournit AUCUNE pertinence au moteur', async () => {
    // Preuve directe plutôt que par convention : on espionne la méthode et on
    // vérifie qu'aucune évaluation ne l'appelle.
    const { SALES_DEFAULT_LENS } = await import(
      '../lib/prospector/proactive/lens/registry'
    )
    const espion = vi.spyOn(SALES_DEFAULT_LENS, 'relevance')

    run(lead(90))

    expect(espion).not.toHaveBeenCalled()
    espion.mockRestore()
  })
})
