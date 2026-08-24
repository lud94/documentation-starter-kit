// EVAL-RUNNER-001b — TESTS NÉGATIFS DU HARNESS GOLDEN.
//
// ⚠️ CHAQUE MÉTRIQUE EST PROUVÉE PAR SA VARIATION, JAMAIS PAR SA VALEUR VERTE.
// Le corpus pilote rend aujourd'hui un rapport entièrement vert. Un test qui se
// contenterait d'affirmer « ratio === 0 » passerait tout aussi bien si la
// métrique rendait `0` en dur. On part donc du corpus réel, on MUTE UNE seule
// chose, et on exige que le chiffre bouge dans le sens attendu.
//
// ⚠️ AUCUNE MUTATION N'ATTEINT LE DISQUE. `chargerCorpusGolden` lit les
// fixtures ; les mutations opèrent sur des COPIES en mémoire. Les Golden
// publiés ne sont jamais modifiés pour rendre une métrique verte — ni ici, ni
// ailleurs.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Compteur d'appels au Decision Kernel. Le module est enveloppé — jamais
// remplacé : les tests doivent mesurer le VRAI moteur, pas un simulacre.
const espion = vi.hoisted(() => ({ appels: 0 }))

vi.mock('../lib/prospector/proactive/decisionKernel', async (importOriginal) => {
  const reel = await importOriginal<typeof import('../lib/prospector/proactive/decisionKernel')>()
  return {
    ...reel,
    evaluateEvidence: (input: any) => {
      espion.appels += 1
      return reel.evaluateEvidence(input)
    },
  }
})

import { chargerCorpusGolden, type CorpusGolden } from '../lib/prospector/proactive/eval/goldenCorpus'
import {
  construireRapport,
  serializeGoldenReport,
} from '../lib/prospector/proactive/eval/report'
import {
  closedOracleAgreement,
  evidenceTraceability,
  forbiddenOvercallRate,
  observedOutsideOracle,
  ratio,
  requiredMissRate,
  slotsFermes,
  verifierCibleUnique,
  whyNowPresence,
  type ExecutedCase,
} from '../lib/prospector/proactive/eval/metrics'
import {
  projectGoldenCase,
  serializeProjection,
} from '../lib/prospector/proactive/eval/goldenToEvalCase'
import { runEvalCase, serializeEvalOutput } from '../lib/prospector/proactive/eval/runCase'
import { validateEvalCase } from '../lib/prospector/proactive/eval/caseSchema'

const RACINE = process.cwd()

function corpusFrais(): CorpusGolden {
  return chargerCorpusGolden(RACINE)
}

/** Copie profonde — aucune mutation ne doit fuir vers un autre test. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

function cas(corpus: CorpusGolden, caseId: string) {
  const trouve = corpus.cas.find((c) => c.caseId === caseId)
  if (!trouve) throw new Error(`Cas absent du corpus : ${caseId}`)
  return trouve
}

/** Corpus réel, mais dont un cas a été muté en mémoire. */
function corpusMute(caseId: string, muter: (golden: any) => void): CorpusGolden {
  const corpus = corpusFrais()
  const cible = cas(corpus, caseId)
  const copie = clone(cible.golden) as any
  muter(copie)
  return {
    ...corpus,
    cas: corpus.cas.map((c) => (c.caseId === caseId ? { ...c, golden: copie } : c)),
  }
}

beforeEach(() => {
  espion.appels = 0
})

// ── TÉMOIN ──────────────────────────────────────────────────────────────────

describe('EVAL-RUNNER-001b — témoin', () => {
  it('le corpus pilote est intègre et sans erreur de contrat', () => {
    const rapport = construireRapport(corpusFrais())
    expect(rapport.corpus.integrity.ok).toBe(true)
    expect(rapport.contractErrors).toEqual([])
    expect(rapport.sample.goldenCases).toBe(7)
    expect(rapport.sample.executableCases).toBe(4)
    expect(rapport.sample.blockedCases).toBe(3)
    expect(rapport.sample.closedExecutableAssertions).toBe(4)
    expect(rapport.metrics.closed_oracle_agreement.denominator).toBe(4)
    expect(rapport.metrics.required_miss_rate).toMatchObject({ numerator: 0, denominator: 2 })
    expect(rapport.metrics.forbidden_overcall_rate).toMatchObject({ numerator: 0, denominator: 2 })
    expect(rapport.observed_outside_oracle).toEqual([])
  })
})

// ── 1 — REQUIRED ABSENT ─────────────────────────────────────────────────────

describe('EVAL-RUNNER-001b — 1. REQUIRED absent fait monter required_miss_rate', () => {
  it('GD-006 : space_expansion FORBIDDEN → REQUIRED, non produit ⇒ 1 manque', () => {
    // GD-006 ne produit PAS space_expansion (c'est l'oracle signé). Exiger ce
    // type transforme donc un interdit respecté en un requis manqué.
    const rapport = construireRapport(
      corpusMute('GD-006', (g) => {
        g.expected.situations.space_expansion.assertion = 'REQUIRED'
      }),
    )
    expect(rapport.metrics.required_miss_rate).toMatchObject({
      numerator: 1,
      denominator: 3,
      direction: 'LOWER_IS_BETTER',
    })
    expect(rapport.metrics.required_miss_rate.failingCaseIds).toEqual(['GD-006'])
    // L'interdit disparaît du dénominateur : il n'est plus interdit.
    expect(rapport.metrics.forbidden_overcall_rate.denominator).toBe(1)
    expect(rapport.metrics.closed_oracle_agreement).toMatchObject({ numerator: 3, denominator: 4 })
  })
})

// ── 2 — FORBIDDEN PRÉSENT ───────────────────────────────────────────────────

describe('EVAL-RUNNER-001b — 2. FORBIDDEN présent fait monter forbidden_overcall_rate', () => {
  it('GD-026 : space_contraction REQUIRED → FORBIDDEN, produit ⇒ 1 excès', () => {
    const rapport = construireRapport(
      corpusMute('GD-026', (g) => {
        g.expected.situations.space_contraction.assertion = 'FORBIDDEN'
      }),
    )
    expect(rapport.metrics.forbidden_overcall_rate).toMatchObject({
      numerator: 1,
      denominator: 3,
      direction: 'LOWER_IS_BETTER',
    })
    expect(rapport.metrics.forbidden_overcall_rate.failingCaseIds).toEqual(['GD-026'])
    expect(rapport.metrics.required_miss_rate.denominator).toBe(1)
    expect(rapport.metrics.closed_oracle_agreement).toMatchObject({ numerator: 3, denominator: 4 })
  })
})

// ── 3 — UNSPECIFIED N'EST PAS UN NÉGATIF ────────────────────────────────────

describe('EVAL-RUNNER-001b — 3. UNSPECIFIED ne change QUE observed_outside_oracle', () => {
  it('GD-026 : REQUIRED → UNSPECIFIED sur un type produit', () => {
    const rapport = construireRapport(
      corpusMute('GD-026', (g) => {
        g.expected.situations.space_contraction.assertion = 'UNSPECIFIED'
      }),
    )

    // Le slot sort du calcul fermé — il n'est ni correct, ni incorrect.
    expect(rapport.metrics.closed_oracle_agreement).toMatchObject({ numerator: 3, denominator: 3 })
    expect(rapport.metrics.required_miss_rate).toMatchObject({ numerator: 0, denominator: 1 })

    // ⚠️ MUTANT ANTI-« UNSPECIFIED = FORBIDDEN ». Si le harness assimilait une
    // abstention à un interdit, la Situation PRODUITE ici compterait comme un
    // excès : dénominateur 3, numérateur 1. Elle ne compte pas.
    expect(rapport.metrics.forbidden_overcall_rate).toMatchObject({ numerator: 0, denominator: 2 })
    expect(rapport.metrics.forbidden_overcall_rate.failingCaseIds).toEqual([])

    // La seule trace est une observation SANS NOTE.
    expect(rapport.observed_outside_oracle).toEqual([
      { caseId: 'GD-026', situationType: 'space_contraction' },
    ])
    // Aucun slot noté ne subsiste pour ce type sur ce cas.
    expect(
      rapport.slots.some((s) => s.caseId === 'GD-026' && s.situationType === 'space_contraction'),
    ).toBe(false)
  })

  it('une abstention sur un type NON produit ne crée aucune observation', () => {
    const rapport = construireRapport(corpusFrais())
    // GD-006 porte deux UNSPECIFIED, aucun n'est produit.
    expect(rapport.observed_outside_oracle).toEqual([])
  })
})

// ── 4 — AUCUNE SITUATION PRODUITE ───────────────────────────────────────────

describe('EVAL-RUNNER-001b — 4. moteur muet : le dénominateur ne bouge pas', () => {
  it('4 assertions fermées, 2/2 requis manqués, 0/2 interdits dépassés', () => {
    const corpus = corpusFrais()
    // Sortie de moteur VIDE, appliquée aux mêmes cas exécutables.
    const muets: ExecutedCase[] = corpus.cas
      .filter((c) => c.golden.executability === 'EXECUTABLE')
      .map((c) => ({
        golden: c.golden,
        output: { evidence: [], situations: [], recommendations: [] },
      }))

    const slots = slotsFermes(muets)
    expect(slots).toHaveLength(4)
    expect(closedOracleAgreement(slots)).toMatchObject({ numerator: 2, denominator: 4, ratio: 0.5 })
    expect(requiredMissRate(slots)).toMatchObject({ numerator: 2, denominator: 2, ratio: 1 })
    expect(forbiddenOvercallRate(slots)).toMatchObject({ numerator: 0, denominator: 2, ratio: 0 })
    expect(observedOutsideOracle(muets)).toEqual([])
  })
})

// ── 5 — DÉNOMINATEUR NUL ────────────────────────────────────────────────────

describe('EVAL-RUNNER-001b — 5. dénominateur nul', () => {
  it('ratio vaut null, jamais NaN, jamais 1, jamais « 100 % »', () => {
    const r = ratio(0, 0, 'HIGHER_IS_BETTER', [], [])
    expect(r.ratio).toBeNull()
    expect(Number.isNaN(r.ratio as any)).toBe(false)
    expect(r).toMatchObject({ numerator: 0, denominator: 0 })
  })

  it('un ratio non nul reste un NOMBRE, jamais une chaîne formatée', () => {
    const r = ratio(1, 4, 'LOWER_IS_BETTER', [], [])
    expect(r.ratio).toBe(0.25)
    expect(typeof r.ratio).toBe('number')
    expect(Number.isFinite(r.ratio as number)).toBe(true)
  })

  it('les listes de cas sont triées et copiées, jamais aliasées', () => {
    const source = ['GD-027', 'GD-002']
    const r = ratio(1, 2, 'HIGHER_IS_BETTER', source, [])
    expect(r.supportingCaseIds).toEqual(['GD-002', 'GD-027'])
    expect(source).toEqual(['GD-027', 'GD-002'])
  })
})

// ── 6 — LES CAS BLOQUÉS NE TOUCHENT JAMAIS LE MOTEUR ────────────────────────

describe('EVAL-RUNNER-001b — 6. un cas bloqué n’exécute jamais le kernel', () => {
  it('corpus réduit aux 3 cas bloqués ⇒ 0 appel à evaluateEvidence', () => {
    const corpus = corpusFrais()
    const bloques = {
      ...corpus,
      cas: corpus.cas.filter((c) => c.golden.executability !== 'EXECUTABLE'),
    }
    expect(bloques.cas).toHaveLength(3)

    espion.appels = 0
    const rapport = construireRapport(bloques)
    expect(espion.appels).toBe(0)

    expect(rapport.sample.executableCases).toBe(0)
    expect(rapport.sample.closedExecutableAssertions).toBe(0)
    expect(rapport.metrics.closed_oracle_agreement.ratio).toBeNull()
    expect(rapport.metrics.blocked_case_fail_closed).toMatchObject({ numerator: 3, denominator: 3 })
  })

  it('témoin : le corpus complet appelle le kernel exactement 4 fois', () => {
    espion.appels = 0
    construireRapport(corpusFrais())
    expect(espion.appels).toBe(4)
  })
})

// ── 7 — BLOCKER FAUX OU MANQUANT ────────────────────────────────────────────

describe('EVAL-RUNNER-001b — 7. fail-closed sur les blockers', () => {
  it('blocker supprimé ⇒ le contrôle échoue', () => {
    const rapport = construireRapport(
      corpusMute('GD-002', (g) => {
        g.caseStatus.blockers = []
      }),
    )
    expect(rapport.metrics.blocked_case_fail_closed).toMatchObject({ numerator: 2, denominator: 3 })
    expect(rapport.metrics.blocked_case_fail_closed.failingCaseIds).toEqual(['GD-002'])
    expect(rapport.integrityControls.blocked_fail_closed_failures).toHaveLength(1)
    // ⚠️ La preuve vient du VALIDATEUR CANONIQUE, pas d'un texte produit par une
    // seconde implémentation : `report.ts` ne dérive plus aucune identité de
    // blocage lui-même.
    expect(rapport.integrityControls.blocked_fail_closed_failures[0].reason).toContain(
      'blocker_inconsistent_with_claims',
    )
  })

  it('blocker attribué à la MAUVAISE claim ⇒ le contrôle échoue', () => {
    // Même `kind`, même evidence, mais un autre index de claim : un blocage
    // désigné à côté laisserait croire qu'en lever la cause nommée suffirait.
    const rapport = construireRapport(
      corpusMute('GD-002', (g) => {
        g.caseStatus.blockers[0].claimIndex = 99
      }),
    )
    expect(rapport.metrics.blocked_case_fail_closed).toMatchObject({ numerator: 2, denominator: 3 })
    expect(rapport.integrityControls.blocked_fail_closed_failures[0].caseId).toBe('GD-002')
    expect(rapport.integrityControls.blocked_fail_closed_failures[0].reason).toContain(
      'blocker_inconsistent_with_claims',
    )
  })

  it('AUCUN cas bloqué ne peut se projeter, même parfaitement formé par ailleurs', () => {
    // On prend un cas EXECUTABLE irréprochable et on ne change QUE
    // `executability`. La projection doit refuser sur ce seul motif.
    //
    // ⚠️ La seconde branche de `verifierFailClosed` — « la projection a RÉUSSI
    // sur un cas bloqué » — est de ce fait STRUCTURELLEMENT INATTEIGNABLE :
    // `projectGoldenCase` teste `executability` en PREMIÈRE opération, et
    // `verifierFailClosed` n'est appelée que pour un cas non exécutable. Elle
    // est conservée en défense en profondeur, et ce test documente pourquoi
    // aucun mutant ne peut l'atteindre : la seule façon de la déclencher serait
    // de supprimer la garde de `projectGoldenCase`, ce que le test suivant
    // interdit.
    const sain = clone(cas(corpusFrais(), 'GD-006').golden) as any
    sain.executability = 'ADJUDICATED_NON_EXECUTABLE'

    const projection = projectGoldenCase(sain)
    expect(projection.ok).toBe(false)
    expect((projection as any).reason).toContain('executability')

    // Et le moteur n'a jamais été sollicité.
    expect(espion.appels).toBe(0)
  })

  it('un cas bloqué reste hors du calcul fermé, oracle signé ou non', () => {
    // GD-002 porte un oracle FORBIDDEN signé. Être bloqué ne l'efface pas —
    // mais il ne produit aucun slot noté, faute d'exécution.
    const rapport = construireRapport(corpusFrais())
    expect(rapport.slots.some((s) => s.caseId === 'GD-002')).toBe(false)
    expect(rapport.metrics.blocked_case_fail_closed.supportingCaseIds).toContain('GD-002')
  })
})

// ── 8 — TRAÇABILITÉ DES EVIDENCES ───────────────────────────────────────────

describe('EVAL-RUNNER-001b — 8. traçabilité des evidences', () => {
  const golden = { caseId: 'GD-XXX' } as any

  it('un evidenceId inconnu fait échouer le contrôle', () => {
    const r = evidenceTraceability([
      {
        golden,
        output: {
          evidence: [{ id: 'ev-1' } as any],
          situations: [{ id: 'sit-1', type: 't', evidenceIds: ['ev-9'] } as any],
          recommendations: [],
        },
      },
    ])
    expect(r.checked).toBe(1)
    expect(r.failures).toEqual([
      { caseId: 'GD-XXX', situationId: 'sit-1', evidenceId: 'ev-9', reason: 'unknown' },
    ])
  })

  it('une liste d’evidenceIds vide fait échouer le contrôle', () => {
    const r = evidenceTraceability([
      {
        golden,
        output: {
          evidence: [{ id: 'ev-1' } as any],
          situations: [{ id: 'sit-1', type: 't', evidenceIds: [] } as any],
          recommendations: [],
        },
      },
    ])
    expect(r.failures).toEqual([
      { caseId: 'GD-XXX', situationId: 'sit-1', evidenceId: '', reason: 'empty' },
    ])
  })

  it('témoin : le corpus réel est intégralement traçable', () => {
    const rapport = construireRapport(corpusFrais())
    expect(rapport.integrityControls.evidence_traceability.failures).toEqual([])
    expect(rapport.integrityControls.evidence_traceability.checked).toBeGreaterThan(0)
  })
})

// ── 9 — WHY-NOW ─────────────────────────────────────────────────────────────

describe('EVAL-RUNNER-001b — 9. présence du why-now', () => {
  const golden = { caseId: 'GD-XXX' } as any

  it('une recommandation « recommend » sans whyNow fait échouer le contrôle', () => {
    const r = whyNowPresence([
      {
        golden,
        output: {
          evidence: [],
          situations: [],
          recommendations: [{ id: 'r-1', decision: 'recommend', whyNow: '   ' } as any],
        },
      },
    ])
    expect(r.checked).toBe(1)
    expect(r.failures).toEqual([{ caseId: 'GD-XXX', recommendationId: 'r-1' }])
  })

  it('une décision NON « recommend » n’est pas comptée', () => {
    const r = whyNowPresence([
      {
        golden,
        output: {
          evidence: [],
          situations: [],
          recommendations: [{ id: 'r-1', decision: 'suppress', whyNow: '' } as any],
        },
      },
    ])
    expect(r).toEqual({ checked: 0, failures: [] })
  })
})

// ── 10 — `expected` N'ENTRE JAMAIS DANS LE CHEMIN DE DÉCISION ───────────────

describe('EVAL-RUNNER-001b — 10. muter `expected` ne change pas l’entrée du moteur', () => {
  it('projection et sortie kernel byte-identiques ; seule la comparaison bouge', () => {
    const corpus = corpusFrais()
    const original = cas(corpus, 'GD-026').golden as any

    const mute = clone(original)
    mute.expected.situations.space_contraction.assertion = 'FORBIDDEN'
    mute.expected.situations.space_contraction.rationale = 'Attente délibérément inversée.'

    const projeter = (g: any) => {
      const p = projectGoldenCase(g)
      if (p.ok === false) throw new Error(p.reason)
      const v = validateEvalCase(p.evalCase)
      if (v.ok === false) throw new Error(JSON.stringify(v.errors))
      return { projection: serializeProjection(p.evalCase), sortie: serializeEvalOutput(runEvalCase(v.case)) }
    }

    const a = projeter(original)
    const b = projeter(mute)
    expect(b.projection).toBe(a.projection)
    expect(b.sortie).toBe(a.sortie)

    // Et pourtant la métrique, elle, change.
    expect(construireRapport(corpus).metrics.forbidden_overcall_rate.numerator).toBe(0)
    expect(
      construireRapport(
        corpusMute('GD-026', (g) => {
          g.expected.situations.space_contraction.assertion = 'FORBIDDEN'
        }),
      ).metrics.forbidden_overcall_rate.numerator,
    ).toBe(1)
  })
})

// ── 11 — CHAMPS INDÉPENDANTS DE L'ATTENTE ───────────────────────────────────

describe('EVAL-RUNNER-001b — 11. legacyAssessment / provenance / rawSource n’entrent pas', () => {
  it('les muter ne change NI la projection NI la sortie du moteur NI les métriques', () => {
    const corpus = corpusFrais()
    const original = cas(corpus, 'GD-027').golden as any

    const mute = clone(original)
    mute.provenance.reviewer = 'quelqu’un d’autre'
    mute.rawSource.datasetVersion = 'v9.9-inventée'
    if (Array.isArray(mute.legacyAssessment?.items) && mute.legacyAssessment.items.length > 0) {
      mute.legacyAssessment.items[0].rationale = 'Texte historique réécrit.'
    }

    const projeter = (g: any) => {
      const p = projectGoldenCase(g)
      if (p.ok === false) throw new Error(p.reason)
      const v = validateEvalCase(p.evalCase)
      if (v.ok === false) throw new Error(JSON.stringify(v.errors))
      return { projection: serializeProjection(p.evalCase), sortie: serializeEvalOutput(runEvalCase(v.case)) }
    }

    const a = projeter(original)
    const b = projeter(mute)
    expect(b.projection).toBe(a.projection)
    expect(b.sortie).toBe(a.sortie)

    const avant = construireRapport(corpus)
    const apres = construireRapport(
      corpusMute('GD-027', (g) => {
        g.provenance.reviewer = 'quelqu’un d’autre'
        g.rawSource.datasetVersion = 'v9.9-inventée'
      }),
    )
    expect(apres.metrics).toEqual(avant.metrics)
    expect(apres.slots).toEqual(avant.slots)
  })
})

// ── 12 — MULTI-CIBLE : REFUSER, JAMAIS DEVINER ──────────────────────────────

describe('EVAL-RUNNER-001b — 12. un cas multi-cible est REFUSÉ', () => {
  it('verifierCibleUnique rend une erreur de contrat', () => {
    const golden = clone(cas(corpusFrais(), 'GD-026').golden) as any
    golden.executionContext.targets.push({ accountId: 'gd026-second' })
    const err = verifierCibleUnique(golden)
    expect(err).not.toBeNull()
    expect(err!.code).toBe('golden_metric_multi_target_unsupported')
  })

  it('le rapport enregistre l’erreur et n’exécute PAS le cas', () => {
    espion.appels = 0
    const rapport = construireRapport(
      corpusMute('GD-026', (g) => {
        g.executionContext.targets.push({ accountId: 'gd026-second' })
      }),
    )
    expect(rapport.contractErrors).toHaveLength(1)
    expect(rapport.contractErrors[0]).toMatchObject({
      caseId: 'GD-026',
      code: 'golden_metric_multi_target_unsupported',
    })
    // Le cas n'est ni exécuté, ni compté, ni deviné.
    expect(espion.appels).toBe(3)
    expect(rapport.sample.executableCases).toBe(3)
    expect(rapport.slots.some((s) => s.caseId === 'GD-026')).toBe(false)
  })

  it('zéro cible est refusé au même titre que deux', () => {
    const golden = clone(cas(corpusFrais(), 'GD-026').golden) as any
    golden.executionContext.targets = []
    expect(verifierCibleUnique(golden)?.code).toBe('golden_metric_multi_target_unsupported')
  })
})

// ── 13 — DÉTERMINISME ───────────────────────────────────────────────────────

describe('EVAL-RUNNER-001b — 13. déterminisme', () => {
  it('deux exécutions complètes rendent un JSON byte-identique', () => {
    const a = serializeGoldenReport(construireRapport(corpusFrais()))
    const b = serializeGoldenReport(construireRapport(corpusFrais()))
    expect(b).toBe(a)
  })

  it('la sortie ne contient ni horodatage machine, ni NaN, ni Infinity, ni pourcentage', () => {
    const json = serializeGoldenReport(construireRapport(corpusFrais()))
    expect(json).not.toMatch(/NaN|Infinity/)
    expect(json).not.toMatch(/"\d+(\.\d+)?%"/)
    // Le temps de rejeu vient du corpus, pas de l'horloge.
    const rapport = construireRapport(corpusFrais())
    expect(rapport.corpus.replayNow).toBe(
      (cas(corpusFrais(), 'GD-002').golden as any).assumptions.now.value,
    )
  })

  it('les clés du rapport sont triées', () => {
    const json = serializeGoldenReport(construireRapport(corpusFrais()))
    const racine = Object.keys(JSON.parse(json))
    expect(racine).toEqual([...racine].sort())
  })
})
