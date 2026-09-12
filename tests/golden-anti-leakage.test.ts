// GOLDEN-SCHEMA-001a — PREUVE DE NON-FUITE DES LABELS.
//
// ── POURQUOI UN VALIDATEUR NE SUFFIT PAS ────────────────────────────────────
// « `expected` n'alimente pas `input` » n'est PAS vérifiable structurellement.
// Un validateur voit des VALEURS, jamais des DÉRIVATIONS : si quelqu'un
// recopiait une attente dans une pertinence, toutes les vérifications de forme
// passeraient au vert. Une version antérieure de ce contrat affirmait pourtant
// cette garantie comme « mécaniquement auditable » — elle ne l'était pas.
//
// ── LA PREUVE RÉELLEMENT DISPONIBLE : OBSERVATIONNELLE ──────────────────────
// On MUTE arbitrairement les blocs interdits et on exige une projection
// BYTE-IDENTIQUE. C'est la preuve la plus forte accessible sans analyse
// statique, et elle échoue bruyamment dès qu'une fuite est câblée — ce que le
// dernier `describe` de ce fichier démontre par un MUTANT, jamais conservé.
import { describe, expect, it } from 'vitest'

import {
  projectGoldenCase,
  serializeProjection,
} from '../lib/prospector/proactive/eval/goldenToEvalCase'
import { casSigne, clone } from './golden-fixtures'

/** Blocs que le projecteur n'a PAS le droit de lire. */
const BLOCS_INTERDITS = ['expected', 'legacyAssessment', 'caseStatus', 'provenance', 'rawSource']

function projection(golden: any): string {
  const r = projectGoldenCase(golden)
  if (r.ok === false) throw new Error(r.reason)
  return serializeProjection(r.evalCase)
}

describe('GOLDEN-SCHEMA-001a — non-fuite par mutation', () => {
  const reference = projection(casSigne())

  it('muter `expected` ne change RIEN à la projection', () => {
    const mutations = [
      (c: any) => {
        c.expected.situations.space_expansion.assertion = 'REQUIRED'
      },
      (c: any) => {
        c.expected.situations.space_expansion.assertion = 'UNSPECIFIED'
      },
      (c: any) => {
        c.expected.situations.space_contraction.assertion = 'FORBIDDEN'
      },
      (c: any) => {
        c.expected.situations.space_expansion.rationale = 'raison entièrement différente'
      },
      (c: any) => {
        c.expected.situations = {}
      },
    ]

    for (const muter of mutations) {
      const c = casSigne()
      muter(c)
      expect(projection(c)).toBe(reference)
    }
  })

  it('muter `legacyAssessment` ne change RIEN à la projection', () => {
    const mutations = [
      (c: any) => {
        c.legacyAssessment.items[0].status = 'SUPPORTED'
      },
      (c: any) => {
        c.legacyAssessment.items[0].scope = 'RAIL_R'
      },
      (c: any) => {
        c.legacyAssessment.items[0].rawRef = '/notes'
      },
      (c: any) => {
        c.legacyAssessment.items = []
      },
    ]

    for (const muter of mutations) {
      const c = casSigne()
      muter(c)
      expect(projection(c)).toBe(reference)
    }
  })

  it('muter `provenance` ne change RIEN à la projection', () => {
    const c = casSigne()
    c.provenance.materializationTicket = 'AUTRE-TICKET'
    c.provenance.adjudicatedOn = '2020-01-01'
    c.provenance.adjudicationProtocol = 'AUTRE-PROTOCOLE'
    expect(projection(c)).toBe(reference)
  })

  it('muter `rawSource` ne change RIEN à la projection', () => {
    // Un projecteur qui lirait l'archive y réintroduirait de l'I/O — interdit.
    const c = casSigne()
    c.rawSource.originalCaseId = 'GD-999'
    c.rawSource.datasetSha256 = '0'.repeat(64)
    c.rawSource.datasetPath = 'ailleurs.json'
    expect(projection(c)).toBe(reference)
  })

  it('muter `caseStatus` ne change RIEN à la projection', () => {
    const c = casSigne()
    c.caseStatus.state = 'BLOCKED'
    c.caseStatus.blockers = [{ kind: 'EVIDENCE_TYPE_GAP', note: 'inventé' }]
    expect(projection(c)).toBe(reference)
  })

  it('SUPPRIMER un bloc interdit ne change RIEN à la projection', () => {
    // Le test le plus direct : si le projecteur lisait le bloc, son absence le
    // ferait échouer ou changer de sortie.
    for (const bloc of BLOCS_INTERDITS) {
      const c = casSigne()
      delete c[bloc]
      expect(projection(c)).toBe(reference)
    }
  })
})

describe('GOLDEN-SCHEMA-001a — constantes de rejeu strictes', () => {
  it('toute pertinence projetée vaut la constante déclarée', () => {
    const golden = casSigne()
    golden.executionContext.targets.push({ accountId: 'test-acct-2' })

    const r = projectGoldenCase(golden)
    if (r.ok === false) throw new Error(r.reason)

    for (const cible of (r.evalCase as any).targets) {
      expect(cible.relevance).toBe(golden.assumptions.targetRelevance.value)
    }
  })

  it('toute confiance et toute date d’observation projetées valent la constante', () => {
    const golden = casSigne()
    const second = clone(golden.adjudication.rawEvidence[0])
    second.rawEvidenceId = 'TEST-ev2'
    second.claims[0].evidenceId = 'test-ev2'
    golden.adjudication.rawEvidence.push(second)

    const r = projectGoldenCase(golden)
    if (r.ok === false) throw new Error(r.reason)

    const evidences = (r.evalCase as any).evidence
    expect(evidences).toHaveLength(2)
    for (const e of evidences) {
      expect(e.confidence).toBe(golden.assumptions.evidenceConfidence.value)
      expect(e.observedAt).toBe(golden.assumptions.observedAt.value)
    }
  })

  it('aucune valeur de RAIL R n’apparaît dans la projection', () => {
    // `lensFitExpected` est le vecteur de fuite historique : il vit dans le RAW,
    // il ne doit jamais atteindre `relevance`.
    const rendu = projection(casSigne())
    for (const interdit of ['lensFitExpected', 'primaryHypothesis', 'REQUIRED', 'FORBIDDEN']) {
      expect(rendu).not.toContain(interdit)
    }
  })
})

// ── PREUVE QUE CES TESTS MORDENT ────────────────────────────────────────────
//
// ⚠️ Un test de non-fuite qui passerait quoi qu'il arrive serait pire qu'absent :
// il donnerait l'illusion d'un contrôle. On câble donc ICI une fuite délibérée —
// un PROJECTEUR MUTANT, local à ce fichier, jamais exporté, jamais conservé
// ailleurs — et on exige que la comparaison byte-à-byte la DÉTECTE.

/** MUTANT : dérive la pertinence de `expected`. Existe pour être détecté. */
function projecteurMutant(golden: any): string {
  const r = projectGoldenCase(golden)
  if (r.ok === false) throw new Error(r.reason)

  const evalCase = r.evalCase as any
  const fuite = golden.expected?.situations?.space_expansion?.assertion === 'REQUIRED' ? 0.9 : 0.5
  evalCase.targets = evalCase.targets.map((t: any) => ({ ...t, relevance: fuite }))

  return serializeProjection(evalCase)
}

describe('GOLDEN-SCHEMA-001a — contrôle négatif', () => {
  it('un projecteur qui LIT `expected` est bien détecté', () => {
    const reference = projecteurMutant(casSigne())

    const mute = casSigne()
    mute.expected.situations.space_expansion.assertion = 'REQUIRED'

    // Le projecteur RÉEL est insensible…
    expect(projection(mute)).toBe(projection(casSigne()))
    // …le mutant, lui, ne l'est pas : la preuve mord.
    expect(projecteurMutant(mute)).not.toBe(reference)
  })
})
