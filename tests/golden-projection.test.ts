// GOLDEN-SCHEMA-001a — PROJECTION GOLDEN → EVALCASE.
//
// Ce que ces tests verrouillent : le Golden ne PERSISTE pas le cas d'exécution,
// il le DÉRIVE. Toute valeur runtime — horloge, pertinence, confiance, date
// d'observation, evidences — doit provenir d'`assumptions` et d'`adjudication`,
// jamais d'une copie stockée qui pourrait diverger.
import { describe, expect, it } from 'vitest'

import {
  projectGoldenCase,
  serializeProjection,
} from '../lib/prospector/proactive/eval/goldenToEvalCase'
import { validateEvalCase } from '../lib/prospector/proactive/eval/caseSchema'
import { validateGoldenCaseStructure } from '../lib/prospector/proactive/eval/goldenSchema'
import { runEvalCase } from '../lib/prospector/proactive/eval/runCase'
import { casSigne, casTypeManquant, clone } from './golden-fixtures'

function projeter(golden: any): any {
  const r = projectGoldenCase(golden)
  if (r.ok === false) throw new Error(r.reason)
  return r.evalCase
}

describe('GOLDEN-SCHEMA-001a — projection', () => {
  it('produit un cas accepté par le validateur DU RUNNER', () => {
    // ⚠️ Aucun second validateur d'EvalCase n'existe. Un cas Golden ne peut donc
    // pas être « valide » d'une manière que le runner refuserait.
    const validation = validateEvalCase(projeter(casSigne()))
    if (validation.ok === false) throw new Error(JSON.stringify(validation.errors, null, 2))
    expect(validation.ok).toBe(true)
  })

  it('le cas projeté s’exécute réellement dans le Decision Kernel', () => {
    const validation = validateEvalCase(projeter(casSigne()))
    if (validation.ok === false) throw new Error('cas invalide')
    const sortie = runEvalCase(validation.case)
    expect(sortie.evidence).toHaveLength(1)
    // Aucune assertion sur le VERDICT ici : ce lot construit l'infrastructure,
    // il ne signe aucune ground truth. La matérialisation appartient à
    // GOLDEN-MATERIALIZE-001.
    expect(Array.isArray(sortie.situations)).toBe(true)
  })

  it('DÉRIVE l’horloge, la pertinence, la confiance et la date d’observation', () => {
    const golden = casSigne()
    const projete = projeter(golden)

    expect(projete.now).toBe(golden.assumptions.now.value)
    expect(projete.targets[0].relevance).toBe(golden.assumptions.targetRelevance.value)
    expect(projete.evidence[0].confidence).toBe(golden.assumptions.evidenceConfidence.value)
    expect(projete.evidence[0].observedAt).toBe(golden.assumptions.observedAt.value)

    // Rien de tout cela n'est stocké dans le cas Golden.
    expect(JSON.stringify(golden.executionContext)).not.toContain('relevance')
    expect(JSON.stringify(golden.executionContext)).not.toContain('observedAt')
    expect(JSON.stringify(golden.executionContext)).not.toContain('confidence')
  })

  it('changer une constante de rejeu change TOUTE la projection', () => {
    // Preuve que la valeur est réellement dérivée, et non recopiée d'ailleurs.
    const golden = casSigne()
    golden.assumptions.targetRelevance.value = 0.25
    expect(projeter(golden).targets[0].relevance).toBe(0.25)
  })

  it('ne projette QUE les claims MAPPED', () => {
    const golden = casTypeManquant()
    golden.executability = 'EXECUTABLE'
    const projete = projeter(golden)
    expect(projete.evidence).toHaveLength(1)
    expect(projete.evidence[0].id).toBe('test-ev1')
  })

  it('projette un STATE en `undated_state`, SANS `occurredAt`', () => {
    const golden = casSigne()
    const claim = golden.adjudication.rawEvidence[0].claims[0]
    claim.temporalNature = 'STATE'
    delete claim.occurredAt

    const evidence = projeter(golden).evidence[0]
    expect(evidence.temporality).toBe('undated_state')
    // ⚠️ La clé est ABSENTE, pas `undefined` : `temporaliteCoherente` refuse une
    // date de survenue sur un état non daté, et un `undefined` explicite
    // survivrait à une sérialisation dans certains contextes.
    expect('occurredAt' in evidence).toBe(false)
  })

  it('ordonne les evidences de façon STABLE', () => {
    const golden = casSigne()
    const second = clone(golden.adjudication.rawEvidence[0])
    second.rawEvidenceId = 'TEST-ev0'
    second.claims[0].evidenceId = 'test-ev0'
    // Inséré APRÈS, mais son identifiant le place AVANT.
    golden.adjudication.rawEvidence.push(second)

    const ids = projeter(golden).evidence.map((e: any) => e.id)
    expect(ids).toEqual(['test-ev0', 'test-ev1'])
  })

  it('est déterministe — deux projections identiques byte-à-byte', () => {
    expect(serializeProjection(projeter(casSigne()))).toBe(
      serializeProjection(projeter(casSigne())),
    )
  })
})

describe('GOLDEN-SCHEMA-001a — refus de projection', () => {
  it('refuse un cas non exécutable, AVANT toute construction', () => {
    // Le point critique : les deux claims MAPPED de GD-025 s'exécuteraient au
    // vert. Un vert calculé sur un jeu de faits qu'on SAIT incomplet serait vrai
    // de la fixture et faux du monde.
    const r = projectGoldenCase(casTypeManquant())
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain('ADJUDICATED_NON_EXECUTABLE')
  })

  it('refuse une claim MAPPED dont la temporalité ne projette pas', () => {
    const golden = casSigne()
    const claim = golden.adjudication.rawEvidence[0].claims[0]
    claim.temporalPrecision = 'MONTH'
    delete claim.occurredAt

    const r = projectGoldenCase(golden)
    expect(r.ok).toBe(false)
    // Aucun jour n'est fabriqué pour rendre le cas exécutable.
    expect(r.ok === false && r.reason).toContain('MONTH')
  })

  it('refuse un cas Golden absent', () => {
    expect(projectGoldenCase(null).ok).toBe(false)
  })
})

describe('GOLDEN-SCHEMA-001a — cohérence validateur/projecteur', () => {
  it('un cas structurellement valide et EXECUTABLE se projette toujours', () => {
    const golden = casSigne()
    expect(validateGoldenCaseStructure(golden).ok).toBe(true)
    expect(projectGoldenCase(golden).ok).toBe(true)
  })
})
