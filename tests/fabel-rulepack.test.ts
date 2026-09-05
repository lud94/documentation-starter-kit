// FABEL-RULEPACK-001 — LE PREMIER VERTICAL NON-SALES.
//
// Ce fichier ne teste pas seulement des règles immobilières : il teste que le
// Decision Kernel universel accueille un second vertical sans rien apprendre de
// son métier, et sans que `sales-core` bouge d'un iota.
import { describe, it, expect } from 'vitest'

import { evaluateSituations } from '../lib/prospector/proactive/situationEngine'
import { evaluateEvidence } from '../lib/prospector/proactive/decisionKernel'
import { recommendationDecision } from '../lib/prospector/proactive/recommendationEngine'
import { eligibilityDecision } from '../lib/prospector/proactive/eligibility'
import { validateEvalCase, EVAL_SCHEMA_VERSION } from '../lib/prospector/proactive/eval/caseSchema'
import { runEvalCase } from '../lib/prospector/proactive/eval/runCase'
import { LENS_REGISTRY } from '../lib/prospector/proactive/lens/registry'
import { PACK_REGISTRY } from '../lib/prospector/proactive/packs/registry'
import { addMonthsUTC } from '../lib/prospector/proactive/packs/real-estate-fabel/aggregate'
import type { EvidenceEvent, Situation } from '../lib/prospector/proactive/types'
import type { SituationEvaluationContext } from '../lib/prospector/proactive/rulePack'
import { TEST_RECOMMENDATION_CONTEXT } from './helpers/proactiveContext'

const NOW = '2026-08-23T00:00:00.000Z'
const COMPTE = 'acc_fabel_1'

const CONTEXTE_FABEL = {
  contextId: 'fabel-technical',
  contextVersion: 'v0.1',
  role: 'broker',
  scope: { mode: 'workspace' as const },
  authorizedMotions: {
    prepare_outreach: 'allowed' as const,
    contact_prospect: 'allowed' as const,
    enrich_data: 'allowed' as const,
    schedule_reminder: 'allowed' as const,
  },
  lensId: 'fabel-broker' as const,
  lensVersion: 'v0.1',
}

function ev(
  id: string,
  type: string,
  patch: Partial<EvidenceEvent> & { occurredAt?: string; value?: any } = {},
): EvidenceEvent {
  const { occurredAt, ...reste } = patch as any
  return {
    id,
    accountId: COMPTE,
    type,
    scope: 'account',
    assertionType: 'fact',
    confidence: 0.9,
    source: { provider: 'fabel-crm' },
    ...(occurredAt
      ? { temporality: 'dated_event', occurredAt, observedAt: occurredAt }
      // ⚠️ Observation VOLONTAIREMENT ancienne. Une valeur tardive ferait
    // rejeter l'evidence par le no-hindsight dès qu'un test emploie un `now`
    // antérieur — ce qui s'est produit sur le cas PRE-WINDOW, et prouve au
    // passage que la garde temporelle du cœur mord réellement.
    : { temporality: 'undated_state', observedAt: '2025-02-01T00:00:00.000Z' }),
    ...reste,
  } as EvidenceEvent
}

function contexte(now = NOW): SituationEvaluationContext {
  return {
    now: new Date(now),
    accountId: COMPTE,
    relevance: 0.8,
    lensId: 'fabel-broker',
    lensVersion: 'v0.1',
  }
}

/** Exécute UNIQUEMENT le pack Fabel, comme le ferait sa lens. */
function fabel(evidence: EvidenceEvent[], now = NOW): Situation[] {
  return evaluateSituations(evidence, contexte(now), ['real-estate-fabel'])
}

function typesDe(situations: Situation[]): string[] {
  return situations.map((s) => s.type).sort()
}

// ─────────────────────────────────────────────────────────────────────────────
describe('A. SPACE_EXPANSION — convergence exigée, jamais un signal seul', () => {
  // SIGNAL_TEMPORAL_WINDOW_V0_001 : la levee doit etre DANS la fenetre de 90 jours
  // de `space-expansion` (83 jours avant NOW) — une levee de 114 jours est
  // desormais legitimement exclue, et un test dedie le verifie plus bas.
  const FUND = ev('ev_fund', 'recent_funding', { occurredAt: '2026-06-01T00:00:00.000Z' })
  const SITE = ev('ev_site', 'site_expansion', { occurredAt: '2026-06-15T00:00:00.000Z' })
  const HEAD = ev('ev_head', 'headcount_acceleration', { occurredAt: '2026-06-01T00:00:00.000Z' })
  const JOBS = ev('ev_jobs', 'hiring_volume_surge', { occurredAt: '2026-06-05T00:00:00.000Z' })

  it('funding SEUL ⇒ aucune situation', () => {
    expect(fabel([FUND])).toEqual([])
  })

  it('hiring SEUL ⇒ aucune situation', () => {
    expect(fabel([JOBS])).toEqual([])
  })

  it('headcount SEUL ⇒ aucune situation', () => {
    expect(fabel([HEAD])).toEqual([])
  })

  it('site expansion SEUL ⇒ aucune situation', () => {
    expect(fabel([SITE])).toEqual([])
  })

  it('DEUX evidences de la MÊME famille ⇒ aucune situation', () => {
    // `headcount_acceleration` et `hiring_volume_surge` décrivent la même
    // campagne de recrutement vue sous deux angles. Les compter comme deux
    // familles serait un faux positif structurel.
    expect(fabel([HEAD, JOBS])).toEqual([])
  })

  it('deux familles dont une DYNAMIQUE ⇒ space_expansion', () => {
    const s = fabel([FUND, SITE])
    expect(typesDe(s)).toEqual(['space_expansion'])
    expect(s[0].rulePackId).toBe('real-estate-fabel')
    expect(s[0].lensId).toBe('fabel-broker')
  })

  it('CAPITAL seule ne peut PAS fournir le signal dynamique', () => {
    // Funding + pression déclarée : deux familles, mais F1 n'est pas dynamique
    // et F4 non plus. Le chemin A échoue donc — et le chemin B est écarté ici
    // parce que la déclaration n'est pas datée.
    const pression = ev('ev_cap', 'real_estate.capacity_pressure_reported')
    expect(fabel([FUND, pression])).toEqual([])
  })

  it('raccourci FIRST-PARTY explicite et daté ⇒ space_expansion', () => {
    const pression = ev('ev_cap', 'real_estate.capacity_pressure_reported', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      source: { provider: 'client-declared' },
    })
    expect(typesDe(fabel([pression]))).toEqual(['space_expansion'])
  })

  it('le raccourci EXIGE une source first-party', () => {
    const scrape = ev('ev_cap', 'real_estate.capacity_pressure_reported', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      source: { provider: 'scraper-public' },
    })
    expect(fabel([scrape])).toEqual([])
  })

  it('le raccourci EXIGE un `fact`, pas une inférence', () => {
    const inference = ev('ev_cap', 'real_estate.capacity_pressure_reported', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      assertionType: 'inference',
    })
    expect(fabel([inference])).toEqual([])
  })

  it('le raccourci EXIGE une date métier — un état non daté ne suffit pas', () => {
    expect(fabel([ev('ev_cap', 'real_estate.capacity_pressure_reported')])).toEqual([])
  })

  it('contradiction DATÉE plus récente ⇒ bloquée', () => {
    const cut = ev('ev_cut', 'workforce_contraction', { occurredAt: '2026-07-20T00:00:00.000Z' })
    expect(fabel([FUND, SITE, cut])).toEqual([])
  })

  it('contradiction NON DATÉE ⇒ bloquée (fail closed)', () => {
    // On ignore depuis quand elle est vraie ; la déclarer périmée serait
    // inventer son ancienneté.
    const cut = ev('ev_cut', 'workforce_contraction')
    expect(fabel([FUND, SITE, cut])).toEqual([])
  })

  it('contradiction DATÉE strictement PLUS ANCIENNE ⇒ ne bloque pas', () => {
    const vieuxCut = ev('ev_cut', 'workforce_contraction', {
      occurredAt: '2025-01-01T00:00:00.000Z',
    })
    expect(typesDe(fabel([FUND, SITE, vieuxCut]))).toEqual(['space_expansion'])
  })

  it('une evidence sous le seuil de famille ne compte PAS', () => {
    const siteFaible = ev('ev_site', 'site_expansion', {
      occurredAt: '2026-06-15T00:00:00.000Z',
      confidence: 0.65, // > 0.6 universel, < 0.70 seuil de famille
    })
    expect(fabel([FUND, siteFaible])).toEqual([])
  })

  it('`evidenceIds` contient EXACTEMENT les contributeurs réels', () => {
    const bruit = ev('ev_bruit', 'legal_pressure', {
      occurredAt: '2020-01-01T00:00:00.000Z',
    })
    const s = fabel([FUND, SITE, bruit])
    expect(s[0].evidenceIds.sort()).toEqual(['ev_fund', 'ev_site'])
    expect(s[0].evidenceIds).not.toContain('ev_bruit')
  })

  it('PLUSIEURS evidences d’un même type sont TOUTES conservées', () => {
    // Trois ouvertures de sites sont trois preuves du même mouvement.
    // `bestEvidenceByType` n'en aurait gardé qu'une.
    const s1 = ev('ev_s1', 'site_expansion', { occurredAt: '2026-04-01T00:00:00.000Z' })
    const s2 = ev('ev_s2', 'site_expansion', { occurredAt: '2026-05-01T00:00:00.000Z' })
    const s3 = ev('ev_s3', 'site_expansion', { occurredAt: '2026-06-01T00:00:00.000Z' })

    const s = fabel([FUND, s1, s2, s3])
    expect(s[0].evidenceIds.sort()).toEqual(['ev_fund', 'ev_s1', 'ev_s2', 'ev_s3'])
  })

  it('le rationale parle de pression POSSIBLE, jamais de besoin de bureaux', () => {
    const s = fabel([FUND, SITE])
    expect(s[0].rationale).toMatch(/possible/i)
    expect(s[0].rationale).not.toMatch(/besoin de bureaux/i)
  })

  it('recommandation : engage_or_reengage, autonome', () => {
    const s = fabel([FUND, SITE])
    const r = recommendationDecision(s[0], {
      now: new Date(NOW),
      businessContext: { ...TEST_RECOMMENDATION_CONTEXT, contextId: 'fabel-technical' },
    } as any)
    expect(r.decision).toBe('recommend')
    expect(r.play).toBe('engage_or_reengage')
    expect(r.control).toBe('autonomous')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B. SPACE_CONTRACTION — convergence, et aucun ratio RH → immobilier', () => {
  const DOWN = ev('ev_down', 'workforce_contraction', { occurredAt: '2026-06-01T00:00:00.000Z' })
  const REORG = ev('ev_reorg', 'restructuring_announced', { occurredAt: '2026-06-10T00:00:00.000Z' })
  const COST = ev('ev_cost', 'cost_reduction_program', { occurredAt: '2026-06-05T00:00:00.000Z' })
  const DISTRESS = ev('ev_dist', 'financial_distress', { occurredAt: '2026-06-20T00:00:00.000Z' })

  it('cost reduction SEUL ⇒ aucune situation', () => {
    expect(fabel([COST])).toEqual([])
  })

  it('licenciements SEULS ⇒ aucune situation', () => {
    expect(fabel([DOWN])).toEqual([])
  })

  it('COST + DISTRESS ⇒ aucune situation — pas de changement organisationnel', () => {
    // Deux familles, mais ni G1 ni G2 : du discours de coûts et une difficulté
    // financière ne déplacent pas des mètres carrés.
    expect(fabel([COST, DISTRESS])).toEqual([])
  })

  it('workforce + restructuring ⇒ space_contraction', () => {
    expect(typesDe(fabel([DOWN, REORG]))).toEqual(['space_contraction'])
  })

  it('SENSIBLE ⇒ decision recommend MAIS control approval_required', () => {
    const s = fabel([DOWN, REORG, DISTRESS])
    const r = recommendationDecision(s[0], {
      now: new Date(NOW),
      businessContext: { ...TEST_RECOMMENDATION_CONTEXT, contextId: 'fabel-technical' },
    } as any)

    // L'orthogonalité que l'architecture existe pour permettre :
    // « ce compte mérite d'être examiné » ≠ « autorisé à contacter seul ».
    expect(r.decision).toBe('recommend')
    expect(r.control).toBe('approval_required')
    expect(r.controlReason).toMatch(/real-estate-fabel/)
  })

  it('le plancher s’applique MÊME avec toutes capacités accordées', () => {
    const s = fabel([DOWN, REORG])
    const r = recommendationDecision(s[0], {
      now: new Date(NOW),
      businessContext: {
        contextId: 'tout-permis',
        contextVersion: 'v0.1',
        authorizedMotions: {
          prepare_outreach: 'allowed',
          contact_prospect: 'allowed',
          enrich_data: 'allowed',
          schedule_reminder: 'allowed',
        },
      },
    } as any)
    expect(r.control).toBe('approval_required')
  })

  it('réduction de surface DÉCLARÉE ⇒ suffit seule', () => {
    const declaree = ev('ev_red', 'real_estate.space_reduction_reported', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      source: { provider: 'client-declared' },
    })
    expect(typesDe(fabel([declaree]))).toEqual(['space_contraction'])
  })

  it('AUCUN ratio RH → surface : ni magnitude ni pourcentage nulle part', () => {
    const s = fabel([DOWN, REORG])
    const serialise = JSON.stringify(s[0])

    expect(s[0].rationale).not.toMatch(/%/)
    expect(s[0].rationale).not.toMatch(/m²|m2|mètres carrés/i)
    // La Situation n'offre aucun champ de magnitude — vérifions qu'aucun n'a
    // été introduit en fraude.
    expect(serialise).not.toMatch(/"(surface|magnitude|squareMeters|ratio)"/)
  })

  it('contradiction positive plus récente ⇒ bloquée', () => {
    const site = ev('ev_site', 'site_expansion', { occurredAt: '2026-07-15T00:00:00.000Z' })
    expect(fabel([DOWN, REORG, site])).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('C. FLEX_REMOVE_WINDOW — une adresse n’est ni un contrat ni une durée', () => {
  const START = ev('ev_start', 'real_estate.occupancy_start_declared', {
    occurredAt: '2025-01-15T00:00:00.000Z',
    source: { provider: 'client-declared' },
    confidence: 0.95,
  })
  const DUREE = ev('ev_dur', 'real_estate.occupancy_duration_months_declared', {
    value: 24,
    source: { provider: 'client-declared' },
    confidence: 0.95,
  })

  it('occupation flex SEULE ⇒ AUCUNE situation', () => {
    const occ = ev('ev_occ', 'real_estate.flex_occupancy_observed', {
      assertionType: 'inference',
      source: { provider: 'scraper-public' },
    })
    expect(fabel([occ])).toEqual([])
  })

  it('plusieurs occupations constatées ⇒ toujours AUCUNE situation', () => {
    // L'ancienneté d'adresse est une DÉRIVATION, pas une observation : elle
    // n'est au mieux qu'une borne inférieure, jamais une date d'entrée.
    const o1 = ev('ev_o1', 'real_estate.flex_occupancy_observed', { assertionType: 'inference' })
    const o2 = ev('ev_o2', 'real_estate.flex_occupancy_observed', { assertionType: 'inference' })
    expect(fabel([o1, o2])).toEqual([])
  })

  it('start + duration NON first-party ⇒ aucune situation', () => {
    const s = ev('ev_start', 'real_estate.occupancy_start_declared', {
      occurredAt: '2025-01-15T00:00:00.000Z',
      source: { provider: 'annuaire-public' },
    })
    const d = ev('ev_dur', 'real_estate.occupancy_duration_months_declared', {
      value: 24,
      source: { provider: 'annuaire-public' },
    })
    expect(fabel([s, d])).toEqual([])
  })

  it('start + duration en INFERENCE ⇒ aucune situation', () => {
    const s = { ...START, assertionType: 'inference' } as EvidenceEvent
    const d = { ...DUREE, assertionType: 'inference' } as EvidenceEvent
    expect(fabel([s, d])).toEqual([])
  })

  it('start + duration first-party FACT ⇒ flex_remove_window', () => {
    const s = fabel([START, DUREE])
    expect(typesDe(s)).toEqual(['flex_remove_window'])
  })

  it('la fenêtre dérivée est correcte, et reste une INFERENCE', () => {
    const s = fabel([START, DUREE])[0]

    // 2025-01-15 + 24 mois = 2027-01-15 ; ouverture 6 mois avant.
    expect(s.anticipated?.at).toBe('2027-01-15T00:00:00.000Z')
    expect(s.anticipated?.actionWindowOpensAt).toBe('2026-07-15T00:00:00.000Z')

    // ⚠️ JAMAIS `fact` : la date de fin n'a pas été observée, elle est calculée.
    expect(s.anticipated?.assertionType).toBe('inference')
    expect(s.anticipated?.derivedFrom).toEqual(['ev_start', 'ev_dur'])
  })

  it('`derivedFrom` est un sous-ensemble de `evidenceIds`', () => {
    const s = fabel([START, DUREE])[0]
    for (const id of s.anticipated!.derivedFrom) {
      expect(s.evidenceIds).toContain(id)
    }
  })

  it('durée non entière, nulle ou négative ⇒ aucune situation', () => {
    for (const value of [0, -12, 12.5, '24', null]) {
      const d = { ...DUREE, value } as any
      expect(fabel([START, d])).toEqual([])
    }
  })

  it('PRE-WINDOW — la situation existe, la recommandation est no_action', () => {
    // `now` avant l'ouverture de la fenêtre (2026-07-15).
    const s = fabel([START, DUREE], '2026-03-01T00:00:00.000Z')
    expect(typesDe(s)).toEqual(['flex_remove_window'])

    const e = eligibilityDecision(s[0], { now: new Date('2026-03-01T00:00:00.000Z') })
    expect(e.eligible).toBe(false)
    expect(e.reason).toBe('anticipated_window_not_open')
    expect(e.blockedUntil).toBe('2026-07-15T00:00:00.000Z')
  })

  it('IN-WINDOW ⇒ recommend', () => {
    const s = fabel([START, DUREE])
    const e = eligibilityDecision(s[0], { now: new Date(NOW) })
    expect(e.eligible).toBe(true)
  })

  it('ÉCHÉANCE DÉPASSÉE ⇒ le pack ne fabrique AUCUNE nouvelle situation', () => {
    expect(fabel([START, DUREE], '2027-06-01T00:00:00.000Z')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('D. Arithmétique calendaire — mois réels, jamais 30 jours', () => {
  it('clamp de fin de mois', () => {
    expect(addMonthsUTC('2026-01-31T00:00:00.000Z', 1)).toBe('2026-02-28T00:00:00.000Z')
    expect(addMonthsUTC('2028-01-31T00:00:00.000Z', 1)).toBe('2028-02-29T00:00:00.000Z') // bissextile
    expect(addMonthsUTC('2026-03-31T00:00:00.000Z', 1)).toBe('2026-04-30T00:00:00.000Z')
  })

  it('l’heure est CONSERVÉE', () => {
    expect(addMonthsUTC('2026-01-31T13:45:12.345Z', 1)).toBe('2026-02-28T13:45:12.345Z')
  })

  it('franchit les années, dans les deux sens', () => {
    expect(addMonthsUTC('2025-11-15T00:00:00.000Z', 3)).toBe('2026-02-15T00:00:00.000Z')
    expect(addMonthsUTC('2026-02-15T00:00:00.000Z', -3)).toBe('2025-11-15T00:00:00.000Z')
  })

  it('n’est PAS une approximation de 30 jours', () => {
    // 24 × 30 j = 720 j → 2027-01-05. Le calcul calendaire donne le 15.
    const calendaire = addMonthsUTC('2025-01-15T00:00:00.000Z', 24)
    const approx = new Date(Date.parse('2025-01-15T00:00:00.000Z') + 720 * 86400000).toISOString()
    expect(calendaire).toBe('2027-01-15T00:00:00.000Z')
    expect(calendaire).not.toBe(approx)
  })

  it('entrées invalides ⇒ null (fail closed)', () => {
    expect(addMonthsUTC('jamais', 1)).toBeNull()
    expect(addMonthsUTC('2026-01-01T00:00:00.000Z', 1.5)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('E. Architecture — deux verticaux, un seul kernel', () => {
  it('les MÊMES evidences sont lisibles par les deux packs, distinctement', () => {
    const partagees = [
      ev('ev_fund', 'recent_funding', { occurredAt: '2026-06-01T00:00:00.000Z' }),
      ev('ev_head', 'headcount_acceleration', { occurredAt: '2026-06-01T00:00:00.000Z' }),
      ev('ev_site', 'site_expansion', { occurredAt: '2026-06-15T00:00:00.000Z' }),
    ]

    const vueSales = evaluateSituations(
      partagees,
      { ...contexte(), lensId: 'sales-default' },
      ['sales-core'],
    )
    const vueFabel = fabel(partagees)

    // Sales y voit une accélération commerciale, Fabel une pression d'espace.
    expect(typesDe(vueSales)).toEqual(['sales_scale_up'])
    expect(typesDe(vueFabel)).toEqual(['space_expansion'])

    // Identités DISTINCTES : `lensId` et `rulePackId` entrent dans l'identité.
    expect(vueSales[0].id).not.toBe(vueFabel[0].id)

    // Et la vérité n'a pas bougé : les evidences sont intactes.
    expect(partagees[0].type).toBe('recent_funding')
    expect(partagees[0].assertionType).toBe('fact')
  })

  it('`fabel-broker` n’exécute PAS `sales-core`', () => {
    expect(LENS_REGISTRY['fabel-broker'].rulePacks).toEqual(['real-estate-fabel'])
  })

  it('`sales-default` n’exécute PAS `real-estate-fabel`', () => {
    expect(LENS_REGISTRY['sales-default'].rulePacks).toEqual(['sales-core'])
  })

  it('une evidence Fabel n’active rien sous la lens Sales', () => {
    const occ = ev('ev_occ', 'real_estate.flex_occupancy_observed')
    expect(
      evaluateSituations(occ ? [occ] : [], { ...contexte(), lensId: 'sales-default' }, ['sales-core']),
    ).toEqual([])
  })

  it('les deux packs déclarent des `plays` exhaustifs', () => {
    for (const pack of Object.values(PACK_REGISTRY)) {
      for (const type of pack.declaredSituationTypes) {
        expect(pack.plays[type as keyof typeof pack.plays]).toBeTruthy()
      }
    }
  })

  it('le pack Fabel déclare EXACTEMENT 3 situations et 17 types d’evidence', () => {
    const pack = PACK_REGISTRY['real-estate-fabel']
    expect([...pack.declaredSituationTypes].sort()).toEqual([
      'flex_remove_window',
      'space_contraction',
      'space_expansion',
    ])
    expect(pack.declaredEvidenceTypes).toHaveLength(17)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('F. Runner LENS-AWARE — une evidence inerte est un cas INVALIDE', () => {
  function cas(lens: 'sales-default' | 'fabel-broker', type: string) {
    return {
      schemaVersion: EVAL_SCHEMA_VERSION,
      now: NOW,
      businessContext:
        lens === 'fabel-broker'
          ? CONTEXTE_FABEL
          : { ...CONTEXTE_FABEL, lensId: 'sales-default', contextId: 'sales-technical' },
      targets: [{ accountId: COMPTE, relevance: 0.8 }],
      evidence: [ev('ev_1', type, { occurredAt: '2026-06-01T00:00:00.000Z' })],
    }
  }

  function codes(input: unknown): string[] {
    const v = validateEvalCase(input)
    if (v.ok === false) return v.errors.map((e) => e.code)
    return []
  }

  it('lens sales-default + evidence real_estate.* ⇒ INVALIDE', () => {
    expect(codes(cas('sales-default', 'real_estate.flex_occupancy_observed')))
      .toContain('evidence_type_inactive_for_lens')
  })

  it('lens fabel-broker + evidence Sales ⇒ INVALIDE', () => {
    expect(codes(cas('fabel-broker', 'positive_reply')))
      .toContain('evidence_type_inactive_for_lens')
  })

  it('les types PARTAGÉS restent valides sous les DEUX lenses', () => {
    for (const type of ['recent_funding', 'headcount_acceleration']) {
      expect(codes(cas('sales-default', type))).not.toContain('evidence_type_inactive_for_lens')
      expect(codes(cas('fabel-broker', type))).not.toContain('evidence_type_inactive_for_lens')
    }
  })

  it('un type GLOBALEMENT inconnu garde `evidence_type_unknown`', () => {
    // Les deux refus doivent rester distincts : « je me suis trompé de nom »
    // n'est pas « je me suis trompé de lens ».
    const liste = codes(cas('fabel-broker', 'market_average_duration'))
    expect(liste).toContain('evidence_type_unknown')
    expect(liste).not.toContain('evidence_type_inactive_for_lens')
  })

  it('`market_average_duration` n’existe PAS au catalogue — et ne doit pas exister', () => {
    // Son unique usage possible serait de dériver une date de fin propre au
    // compte depuis une moyenne de marché, ce que le contrat interdit.
    for (const pack of Object.values(PACK_REGISTRY)) {
      expect(pack.declaredEvidenceTypes).not.toContain('market_average_duration')
    }
  })

  it('un cas Fabel complet s’exécute de bout en bout', () => {
    const complet = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      now: NOW,
      businessContext: CONTEXTE_FABEL,
      targets: [{ accountId: COMPTE, relevance: 0.8 }],
      evidence: [
        ev('ev_fund', 'recent_funding', { occurredAt: '2026-06-01T00:00:00.000Z' }),
        ev('ev_site', 'site_expansion', { occurredAt: '2026-06-15T00:00:00.000Z' }),
      ],
    }
    const v = validateEvalCase(complet)
    expect(v.ok).toBe(true)

    const sortie = runEvalCase((v as any).case)
    expect(typesDe(sortie.situations as Situation[])).toEqual(['space_expansion'])
    expect(sortie.recommendations[0].decision).toBe('recommend')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('G. Le kernel reste ignorant du métier immobilier', () => {
  it('aucun vocabulaire immobilier dans les fichiers du cœur', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    const CŒUR = [
      'types.ts', 'ruleKit.ts', 'situationEngine.ts', 'decisionKernel.ts',
      'recommendationEngine.ts', 'eligibility.ts', 'validators.ts',
      'motions.ts', 'rulePack.ts', 'catalog.ts', 'orchestrator.ts',
    ]
    // `lease` est absent de la liste : le mot n'apparaît pas, mais `release`
    // le contiendrait. On teste des termes non ambigus.
    const INTERDITS = [/\boffice\b/i, /\bcoworking\b/i, /\bflex\b/i, /real.?estate/i, /\bbroker\b/i, /\bm²/]

    for (const fichier of CŒUR) {
      const source = readFileSync(
        join(process.cwd(), 'lib/prospector/proactive', fichier),
        'utf8',
      )
      for (const motif of INTERDITS) {
        expect(source, `${fichier} contient ${motif}`).not.toMatch(motif)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('H. Contradictions temporelles — bloquer sans devenir un veto éternel', () => {
  // ⚠️ L'ÉQUILIBRE À TENIR. Une contradiction doit bloquer tant qu'elle est
  // pertinente, mais un fait de 2024 ne doit pas interdire éternellement toute
  // interprétation d'un compte. Une règle qui ne sait pas oublier finit par ne
  // plus rien produire, et devient invisible plutôt que prudente.

  it('EXPANSION — vieille restructuration + croissance récente ⇒ expansion possible', () => {
    const s = fabel([
      ev('ev_reorg', 'restructuring_announced', { occurredAt: '2024-01-01T00:00:00.000Z' }),
      ev('ev_head', 'headcount_acceleration', { occurredAt: '2026-06-01T00:00:00.000Z' }),
      ev('ev_site', 'site_expansion', { occurredAt: '2026-06-15T00:00:00.000Z' }),
    ])
    expect(typesDe(s)).toEqual(['space_expansion'])
    // La contradiction dépassée n'est PAS un contributeur.
    expect(s[0].evidenceIds).not.toContain('ev_reorg')
  })

  it('CONTRACTION — vieille expansion + contraction récente ⇒ contraction possible', () => {
    const s = fabel([
      ev('ev_site', 'site_expansion', { occurredAt: '2024-01-01T00:00:00.000Z' }),
      ev('ev_down', 'workforce_contraction', { occurredAt: '2026-06-01T00:00:00.000Z' }),
      ev('ev_reorg', 'restructuring_announced', { occurredAt: '2026-06-10T00:00:00.000Z' }),
    ])
    expect(typesDe(s)).toEqual(['space_contraction'])
    expect(s[0].evidenceIds).not.toContain('ev_site')
  })

  it('MÊME horodatage ⇒ la contradiction BLOQUE', () => {
    // Égalité incluse : à date égale, rien ne permet d'affirmer que le signal
    // positif est postérieur. Fail closed.
    expect(
      fabel([
        ev('ev_reorg', 'restructuring_announced', { occurredAt: '2026-06-15T00:00:00.000Z' }),
        ev('ev_head', 'headcount_acceleration', { occurredAt: '2026-06-01T00:00:00.000Z' }),
        ev('ev_site', 'site_expansion', { occurredAt: '2026-06-15T00:00:00.000Z' }),
      ]),
    ).toEqual([])
  })

  it('une contradiction NON DATÉE mais EXPIRÉE ne devient PAS un veto éternel', () => {
    // Le cœur l'écarte AVANT le pack (`evidenceIsUsable` : now ≥ expiresAt).
    // Le pack n'a donc aucune règle d'oubli à écrire — et ne doit surtout pas
    // en écrire une, qui divergerait de celle du moteur.
    const s = fabel([
      ev('ev_reorg', 'restructuring_announced', { expiresAt: '2026-01-01T00:00:00.000Z' }),
      ev('ev_head', 'headcount_acceleration', { occurredAt: '2026-06-01T00:00:00.000Z' }),
      ev('ev_site', 'site_expansion', { occurredAt: '2026-06-15T00:00:00.000Z' }),
    ])
    expect(typesDe(s)).toEqual(['space_expansion'])
  })

  it('une contradiction NON DATÉE et NON expirée bloque toujours', () => {
    expect(
      fabel([
        ev('ev_reorg', 'restructuring_announced'),
        ev('ev_head', 'headcount_acceleration', { occurredAt: '2026-06-01T00:00:00.000Z' }),
        ev('ev_site', 'site_expansion', { occurredAt: '2026-06-15T00:00:00.000Z' }),
      ]),
    ).toEqual([])
  })

  it('aucun positif DATÉ ⇒ toute contradiction datée bloque (fail closed)', () => {
    // Sans point de comparaison, on ne peut pas affirmer qu'elle est dépassée.
    expect(
      fabel([
        ev('ev_reorg', 'restructuring_announced', { occurredAt: '2020-01-01T00:00:00.000Z' }),
        ev('ev_head', 'headcount_acceleration'),
        ev('ev_site', 'site_expansion'),
      ]),
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('I. Le raccourci first-party ne contourne PAS le seuil sensible', () => {
  // ⚠️ DÉFAUT RÉEL CORRIGÉ ICI. Le raccourci filtrait sur le seuil de FAMILLE
  // (0.70), alors que le chemin de convergence exige 0.75 pour une
  // `space_contraction`. Une déclaration à 0.70 produisait donc une situation
  // sensible que la convergence aurait refusée. Être déclarée par le compte
  // rend une information plus crédible — jamais moins exigeante.

  function reduction(confidence: number) {
    return ev('ev_red', 'real_estate.space_reduction_reported', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      source: { provider: 'client-declared' },
      confidence,
    })
  }

  it('0.70 ⇒ AUCUNE situation', () => {
    expect(fabel([reduction(0.7)])).toEqual([])
  })

  it('0.749 ⇒ AUCUNE situation', () => {
    expect(fabel([reduction(0.749)])).toEqual([])
  })

  it('0.75 ⇒ space_contraction, et approval_required', () => {
    const s = fabel([reduction(0.75)])
    expect(typesDe(s)).toEqual(['space_contraction'])

    const r = recommendationDecision(s[0], {
      now: new Date(NOW),
      businessContext: { ...TEST_RECOMMENDATION_CONTEXT, contextId: 'fabel-technical' },
    } as any)
    expect(r.decision).toBe('recommend')
    expect(r.control).toBe('approval_required')
  })

  it('les DEUX chemins de contraction exigent le même seuil', () => {
    // Convergence à 0.74 : refusée elle aussi. Les deux portes sont à la même
    // hauteur, ce qui est précisément l'invariant.
    expect(
      fabel([
        ev('ev_down', 'workforce_contraction', { occurredAt: '2026-06-01T00:00:00.000Z', confidence: 0.74 }),
        ev('ev_reorg', 'restructuring_announced', { occurredAt: '2026-06-10T00:00:00.000Z', confidence: 0.74 }),
      ]),
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('J. FLEX — aucun appariement ambigu, aucun cross-pairing', () => {
  // ⚠️ DÉFAUT RÉEL CORRIGÉ ICI. Le code prenait le DERNIER début et la DERNIÈRE
  // durée. Sur un compte ayant déclaré deux occupations, il appariait donc le
  // début du contrat A avec la durée du contrat B, et produisait une échéance
  // qui n'a jamais existé — étiquetée `inference`, avec un `derivedFrom`
  // parfaitement traçable. Une date fausse, impeccablement auditée.
  //
  // `EvidenceEvent` ne porte AUCUNE clé de corrélation : ni contrat, ni
  // relation, ni site. Rien ne permet donc d'affirmer qu'un début et une durée
  // décrivent le même engagement. Faute de clé métier, la seule position
  // honnête est de refuser l'ambiguïté.

  const start = (id: string, occurredAt: string) =>
    ev(id, 'real_estate.occupancy_start_declared', {
      occurredAt,
      source: { provider: 'client-declared' },
      confidence: 0.95,
    })

  const duree = (id: string, value: number) =>
    ev(id, 'real_estate.occupancy_duration_months_declared', {
      value,
      source: { provider: 'client-declared' },
      confidence: 0.95,
    })

  it('UNE paire unique ⇒ flex_remove_window', () => {
    const s = fabel([start('s1', '2025-01-15T00:00:00.000Z'), duree('d1', 24)])
    expect(typesDe(s)).toEqual(['flex_remove_window'])
    expect(s[0].anticipated?.at).toBe('2027-01-15T00:00:00.000Z')
  })

  it('DEUX débuts + UNE durée ⇒ AUCUNE situation', () => {
    expect(
      fabel([
        start('s1', '2024-01-15T00:00:00.000Z'),
        start('s2', '2025-06-15T00:00:00.000Z'),
        duree('d1', 24),
      ]),
    ).toEqual([])
  })

  it('UN début + DEUX durées ⇒ AUCUNE situation', () => {
    expect(
      fabel([start('s1', '2025-01-15T00:00:00.000Z'), duree('d1', 24), duree('d2', 36)]),
    ).toEqual([])
  })

  it('DEUX + DEUX ⇒ AUCUNE situation', () => {
    expect(
      fabel([
        start('s1', '2024-01-15T00:00:00.000Z'),
        start('s2', '2025-06-15T00:00:00.000Z'),
        duree('d1', 24),
        duree('d2', 36),
      ]),
    ).toEqual([])
  })

  it('les candidats NON QUALIFIANTS ne créent pas d’ambiguïté', () => {
    // Un second début non first-party n'est pas un candidat : il ne doit donc
    // pas faire échouer un appariement par ailleurs unique.
    const tiers = ev('s_tiers', 'real_estate.occupancy_start_declared', {
      occurredAt: '2024-01-15T00:00:00.000Z',
      source: { provider: 'annuaire-public' },
    })
    const s = fabel([start('s1', '2025-01-15T00:00:00.000Z'), duree('d1', 24), tiers])
    expect(typesDe(s)).toEqual(['flex_remove_window'])
    expect(s[0].evidenceIds.sort()).toEqual(['d1', 's1'])
  })
})
